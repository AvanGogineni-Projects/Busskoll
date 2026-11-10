"""Resumable KoDa backfill: archived SL GTFS-RT -> compact parquet, one file per (feed, day, hour).

    python -m busskoll.ingest.koda --days 14            # TripUpdates, the 14 days before today, newest first
    python -m busskoll.ingest.koda --days 30 --end 2026-10-31
    python -m busskoll.ingest.koda --days 14 --feed VehiclePositions   # GPS of our lines, ~3 s apart
    python -m busskoll.ingest.koda --days 14 --feed ServiceAlerts      # alert presence intervals

KoDa answers 202 while it prepares an archive (per hour; the latest day lags) and 200 once
it is ready; archives are 7z and sometimes corrupt, and the service has outages. So every
(day, hour) is its own unit: a finished unit is a parquet file (written atomically), reruns
skip it, and an unready or failed unit is logged and left for the next run. Newest days first, so recent history lands first.
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import tempfile
import time
from pathlib import Path

import httpx
import pandas as pd

from busskoll import config
from busskoll.gtfs.static import tables_from_dir
from busskoll.ingest.archive import CorruptArchive, unpack
from busskoll.ingest.live import parse_alerts, parse_trip_updates, parse_vehicle_positions

BASE = "https://api.koda.trafiklab.se/KoDa/api/v2"
SNAPSHOT_EVERY_S = 30  # live feed refreshes every 15 s; 30 s halves storage, truth stays within ~30 s
STOPS_AHEAD = 6  # horizon 1-5 plus the stop being passed (that is where ground truth comes from)
PASSED_GRACE_S = 60  # keep a stop this long after its arrival so its final value is stored
VP_EVERY_N = 3  # VehiclePositions snapshots come ~1 s apart; every 3rd keeps arrivals within ~3 s
FEEDS = ("TripUpdates", "VehiclePositions", "ServiceAlerts")


class NotReady(Exception):
    """KoDa kept answering 202 for longer than we were willing to wait."""


def download(client: httpx.Client, url: str, params: dict, dest: Path, *, poll_s: float = 30,
             max_wait_s: float = 1200, retries: int = 4, sleep=None) -> Path:
    """GET until 200 (polling through 202), streaming the body to `dest`.
    Transport errors, 5xx and 429 are retried with backoff; other 4xx (bad key, no data) fail at once."""
    sleep = sleep or time.sleep  # looked up at call time so tests can patch it
    waited, attempt = 0.0, 0
    while True:
        try:
            with client.stream("GET", url, params=params) as r:
                if r.status_code == 202:
                    if waited >= max_wait_s:
                        raise NotReady(f"still preparing after {waited:.0f}s")
                    sleep(poll_s)
                    waited += poll_s
                    continue
                r.raise_for_status()
                tmp = dest.with_suffix(dest.suffix + ".part")
                with tmp.open("wb") as f:
                    for chunk in r.iter_bytes():
                        f.write(chunk)
                tmp.replace(dest)
                return dest
        except (httpx.TransportError, httpx.HTTPStatusError) as e:
            code = e.response.status_code if isinstance(e, httpx.HTTPStatusError) else None
            if code is not None and code < 500 and code != 429:
                raise
            attempt += 1
            if attempt > retries:
                raise
            sleep(min(poll_s * 2**attempt, 600))


def static_paths(root: Path, monday: dt.date) -> dict[str, Path]:
    """Cached static tables for one week: trips (the original `{monday}.parquet`), routes, stops."""
    d = root / "static"
    return {"trips": d / f"{monday}.parquet", "routes": d / f"{monday}-routes.parquet",
            "stops": d / f"{monday}-stops.parquet"}


def static_map(client: httpx.Client, day: dt.date, root: Path) -> dict[str, str]:
    """trip_id -> line for our lines, from the KoDa static GTFS of the Monday of `day`'s week.
    Also caches that week's routes and stop coordinates (see static_paths)."""
    # shortcut: one static version per ISO week; trips from a mid-week feed release are
    # dropped. Upgrade to per-day static if hourly row counts dip after a mid-week release.
    monday = day - dt.timedelta(days=day.weekday())
    paths = static_paths(root, monday)
    if not all(p.exists() for p in paths.values()):
        paths["trips"].parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory() as tmp:
            arc = download(client, f"{BASE}/gtfs-static/{config.OPERATOR}",
                           {"date": monday.isoformat(), "key": config.key("KODA_KEY")}, Path(tmp) / "static.arc")
            files_dir = Path(tmp) / "x"
            files_dir.mkdir()
            unpack(arc, files_dir)
            tables = tables_from_dir(files_dir)
        for name, path in paths.items():
            tmp_path = path.with_name(f"{path.name}.{os.getpid()}.tmp")  # backfills of two feeds may race here
            tables[name].to_parquet(tmp_path, index=False)
            tmp_path.replace(path)
    m = pd.read_parquet(paths["trips"])
    return dict(zip(m["trip_id"], m["line"]))


def compact(df: pd.DataFrame) -> pd.DataFrame:
    """Keep one snapshot per trip per SNAPSHOT_EVERY_S and only the next STOPS_AHEAD stops."""
    if df.empty:
        return df
    df = df[df["arrival_time"] >= df["ts"] - PASSED_GRACE_S]
    key = ["trip_id", "start_date"]
    bucket = df["ts"] // SNAPSHOT_EVERY_S
    first_ts = df.groupby([*(df[k] for k in key), bucket])["ts"].transform("min")
    df = df[df["ts"] == first_ts].sort_values([*key, "ts", "stop_sequence"])
    return df[df.groupby([*key, "ts"]).cumcount() < STOPS_AHEAD].reset_index(drop=True)


def hour_path(root: Path, day: dt.date, hour: int, feed: str = "TripUpdates") -> Path:
    return root / feed.lower() / f"date={day}" / f"hour={hour:02d}.parquet"


def alert_intervals(df: pd.DataFrame) -> pd.DataFrame:
    """Snapshot rows -> one row per (alert, informed entity) with the first and last time it
    was in the feed this hour. An alert is active at t when first_seen <= t <= last_seen."""
    keys = ["alert_id", "route_id", "stop_id", "effect"]
    return df.groupby(keys, as_index=False).agg(first_seen=("ts", "min"), last_seen=("ts", "max"))


def backfill_hour(client: httpx.Client, day: dt.date, hour: int, lines: dict[str, str], root: Path,
                  feed: str = "TripUpdates") -> int:
    with tempfile.TemporaryDirectory() as tmp:
        # KoDa prepares archives hour by hour (the latest day lags), so a 202 hour is skipped
        # after a short wait and picked up by the next run, instead of blocking the whole backfill.
        arc = download(client, f"{BASE}/gtfs-rt/{config.OPERATOR}/{feed}",
                       {"date": day.isoformat(), "hour": f"{hour:02d}", "key": config.key("KODA_KEY")},
                       Path(tmp) / "rt.arc", poll_s=20, max_wait_s=60, retries=2)  # KoDa 503s recent hours for long
        files_dir = Path(tmp) / "x"
        files_dir.mkdir()
        pbs = [f for f in unpack(arc, files_dir) if f.suffix == ".pb"]  # sorted = chronological
        if feed == "VehiclePositions":
            pbs = pbs[::VP_EVERY_N]
        parts = []
        for pb in pbs:
            try:
                data = pb.read_bytes()
                parts.append(parse_trip_updates(data, lines.keys()) if feed == "TripUpdates"
                             else parse_vehicle_positions(data, lines.keys()) if feed == "VehiclePositions"
                             else parse_alerts(data))
            except Exception as e:  # noqa: BLE001 - one bad snapshot must not drop the hour
                print(f"  skip {pb.name}: {type(e).__name__}")
    df = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame()
    if not df.empty:
        if feed == "TripUpdates":
            df = compact(df)
        if feed == "ServiceAlerts":
            df = alert_intervals(df)
        else:
            df["line"] = df["trip_id"].map(lines)
    out = hour_path(root, day, hour, feed)
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(out.with_suffix(".tmp"), index=False)  # an empty file still marks the hour done
    out.with_suffix(".tmp").replace(out)
    return len(df)


def safe(e: Exception) -> str:
    """Error text for logs. httpx messages embed the request URL, which carries the API key."""
    if isinstance(e, httpx.HTTPStatusError):
        return f"HTTPStatusError {e.response.status_code}"
    return type(e).__name__ if isinstance(e, httpx.HTTPError) else f"{type(e).__name__}: {e}"


def days_newest_first(end: dt.date, days: int) -> list[dt.date]:
    return [end - dt.timedelta(days=i) for i in range(days)]


def backfill(end: dt.date, days: int, root: Path = config.DATA_DIR / "koda", feed: str = "TripUpdates") -> None:
    not_ready = 0
    with httpx.Client(timeout=120, follow_redirects=True) as client:
        for day in days_newest_first(end, days):
            todo = [h for h in range(24) if not hour_path(root, day, h, feed).exists()]
            if not todo:
                continue
            try:
                lines = static_map(client, day, root)
            except Exception as e:  # noqa: BLE001 - no static => skip the day, rerun retries
                print(f"{day}: static FAILED {safe(e)}")
                continue
            for h in todo:
                try:
                    print(f"{day} {h:02d}: {backfill_hour(client, day, h, lines, root, feed)} rows")
                except NotReady:
                    not_ready += 1
                    print(f"{day} {h:02d}: not ready at KoDa yet, skipped")
                except (CorruptArchive, httpx.HTTPError) as e:  # left for the next run
                    print(f"{day} {h:02d}: FAILED {safe(e)}")
    if not_ready:
        print(f"{not_ready} hours still being prepared by KoDa; rerun later to fetch them")


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--days", type=int, default=14)
    p.add_argument("--end", type=dt.date.fromisoformat, default=dt.date.today() - dt.timedelta(days=1))
    p.add_argument("--feed", choices=FEEDS, default="TripUpdates")
    a = p.parse_args(argv)
    backfill(a.end, a.days, feed=a.feed)


if __name__ == "__main__":
    main()
