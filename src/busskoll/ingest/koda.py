"""Resumable KoDa backfill: archived SL TripUpdates -> compact parquet, one file per (day, hour).

    python -m busskoll.ingest.koda --days 14            # the 14 days before today, newest first
    python -m busskoll.ingest.koda --days 30 --end 2026-10-31

KoDa answers 202 while it prepares an archive and 200 once it is ready; archives are 7z
and sometimes corrupt, and the service has outages. So every (day, hour) is its own unit:
a finished unit is a parquet file (written atomically), reruns skip it, and a failed
unit is logged and left for the next run. Newest days first, so recent history lands first.
"""
from __future__ import annotations

import argparse
import datetime as dt
import tempfile
import time
from pathlib import Path

import httpx
import pandas as pd

from busskoll import config
from busskoll.gtfs.static import trip_lines_from_dir
from busskoll.ingest.archive import CorruptArchive, unpack
from busskoll.ingest.live import parse_trip_updates

BASE = "https://api.koda.trafiklab.se/KoDa/api/v2"
SNAPSHOT_EVERY_S = 30  # live feed refreshes every 15 s; 30 s halves storage, truth stays within ~30 s
STOPS_AHEAD = 6  # horizon 1-5 plus the stop being passed (that is where ground truth comes from)
PASSED_GRACE_S = 60  # keep a stop this long after its arrival so its final value is stored


class NotReady(Exception):
    """KoDa kept answering 202 for longer than we were willing to wait."""


def download(client: httpx.Client, url: str, params: dict, dest: Path, *, poll_s: float = 30,
             max_wait_s: float = 1200, retries: int = 4, sleep=time.sleep) -> Path:
    """GET until 200 (polling through 202), streaming the body to `dest`.
    Transport errors, 5xx and 429 are retried with backoff; other 4xx (bad key, no data) fail at once."""
    waited, attempt = 0.0, 0
    while True:
        try:
            with client.stream("GET", url, params=params) as r:
                if r.status_code == 202:
                    if waited >= max_wait_s:
                        raise NotReady(f"{url} still preparing after {waited:.0f}s")
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


def static_map(client: httpx.Client, day: dt.date, root: Path) -> dict[str, str]:
    """trip_id -> line for our lines, from the KoDa static GTFS of the Monday of `day`'s week."""
    # shortcut: one static version per ISO week; trips from a mid-week feed release are
    # dropped. Upgrade to per-day static if hourly row counts dip after a mid-week release.
    monday = day - dt.timedelta(days=day.weekday())
    out = root / "static" / f"{monday}.parquet"
    if not out.exists():
        out.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory() as tmp:
            arc = download(client, f"{BASE}/gtfs-static/{config.OPERATOR}",
                           {"date": monday.isoformat(), "key": config.key("KODA_KEY")}, Path(tmp) / "static.arc")
            files_dir = Path(tmp) / "x"
            files_dir.mkdir()
            unpack(arc, files_dir)
            m = trip_lines_from_dir(files_dir)
        m.to_parquet(out.with_suffix(".tmp"), index=False)
        out.with_suffix(".tmp").replace(out)
    m = pd.read_parquet(out)
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


def hour_path(root: Path, day: dt.date, hour: int) -> Path:
    return root / "tripupdates" / f"date={day}" / f"hour={hour:02d}.parquet"


def backfill_hour(client: httpx.Client, day: dt.date, hour: int, lines: dict[str, str], root: Path) -> int:
    with tempfile.TemporaryDirectory() as tmp:
        arc = download(client, f"{BASE}/gtfs-rt/{config.OPERATOR}/TripUpdates",
                       {"date": day.isoformat(), "hour": f"{hour:02d}", "key": config.key("KODA_KEY")},
                       Path(tmp) / "rt.arc")
        files_dir = Path(tmp) / "x"
        files_dir.mkdir()
        parts = []
        for pb in unpack(arc, files_dir):
            if pb.suffix != ".pb":
                continue
            try:
                parts.append(parse_trip_updates(pb.read_bytes(), lines.keys()))
            except Exception as e:  # noqa: BLE001 - one bad snapshot must not drop the hour
                print(f"  skip {pb.name}: {type(e).__name__}")
    df = compact(pd.concat(parts, ignore_index=True)) if parts else pd.DataFrame()
    if not df.empty:
        df["line"] = df["trip_id"].map(lines)
    out = hour_path(root, day, hour)
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(out.with_suffix(".tmp"), index=False)  # an empty file still marks the hour done
    out.with_suffix(".tmp").replace(out)
    return len(df)


def days_newest_first(end: dt.date, days: int) -> list[dt.date]:
    return [end - dt.timedelta(days=i) for i in range(days)]


def backfill(end: dt.date, days: int, root: Path = config.DATA_DIR / "koda") -> None:
    with httpx.Client(timeout=120, follow_redirects=True) as client:
        for day in days_newest_first(end, days):
            todo = [h for h in range(24) if not hour_path(root, day, h).exists()]
            if not todo:
                continue
            try:
                lines = static_map(client, day, root)
            except Exception as e:  # noqa: BLE001 - no static => skip the day, rerun retries
                print(f"{day}: static FAILED {type(e).__name__}: {e}")
                continue
            for h in todo:
                try:
                    print(f"{day} {h:02d}: {backfill_hour(client, day, h, lines, root)} rows")
                except (CorruptArchive, NotReady, httpx.HTTPError) as e:
                    print(f"{day} {h:02d}: FAILED {type(e).__name__}: {e}")


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--days", type=int, default=14)
    p.add_argument("--end", type=dt.date.fromisoformat, default=dt.date.today() - dt.timedelta(days=1))
    a = p.parse_args(argv)
    backfill(a.end, a.days)


if __name__ == "__main__":
    main()
