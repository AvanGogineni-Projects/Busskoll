"""Export a dev-only JSON fixture for the dashboard from real KoDa history + static GTFS.

    python scripts/export_fixture.py --static data/koda/static/gtfs-2026-11-02 \
        --day 2026-11-03 --start 07:30 --minutes 60

Writes frontend/src/fixture.json:
  - routes: the main shape per (line, direction), from shapes.txt
  - stops:  every stop our trips in the window call at, with coordinates
  - trips:  each trip in the window: its stops (distance along the shape, scheduled time,
            actual arrival) and SL's prediction per stop at every stored snapshot
  - scoreboard: MAE by line and horizon over the whole backfill, from busskoll.eval.backtest.
            There is no model yet, so the "busskoll" column is the persistence baseline;
            the frontend's mock replays it in Busskoll's slot.

The frontend replays the window on a loop (src/mock.ts). The fixture is never served in
production: the app shows "offline" when the API is down (see useLive.ts).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from busskoll import config
from busskoll.eval.backtest import HORIZONS, KEY, forecast_points, ground_truth, load

# shortcut: backtest.forecast_points hits a str/object key clash in merge_asof under pandas 3's
# default string dtype; object strings sidestep it. Drop once backtest.py handles it.
pd.set_option("future.infer_string", False)

TZ = ZoneInfo("Europe/Stockholm")
R = 6_371_000.0


def local_xy(lon: np.ndarray, lat: np.ndarray, lat0: float) -> np.ndarray:
    """Equirectangular metres around lat0: exact enough at city scale."""
    k = np.pi / 180 * R
    return np.column_stack([lon * k * np.cos(np.radians(lat0)), lat * k])


def cumulative(xy: np.ndarray) -> np.ndarray:
    return np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(xy, axis=0).T))])


def project_along(shape_xy: np.ndarray, pts_xy: np.ndarray) -> np.ndarray:
    """Distance along the polyline of each point, taken in order and never going backwards,
    so a route that passes the same street twice still places each stop on the right pass."""
    cum = cumulative(shape_xy)
    a, b = shape_xy[:-1], shape_xy[1:]
    ab = b - a
    len2 = np.maximum((ab**2).sum(1), 1e-9)
    out, floor = [], 0.0
    for p in pts_xy:
        t = np.clip(((p - a) * ab).sum(1) / len2, 0, 1)
        d = np.hypot(*(a + ab * t[:, None] - p).T)
        along = cum[:-1] + t * np.sqrt(len2)
        d = np.where(along >= floor - 1, d, np.inf)  # 1 m slack for stops at the same spot
        i = int(np.argmin(d))
        floor = float(along[i])
        out.append(floor)
    return np.array(out)


def scoreboard(df: pd.DataFrame) -> dict:
    pts = forecast_points(df, ground_truth(df))
    pts = pts.assign(err_sl=(pts["sl_delay"] - pts["actual_delay"]).abs(),
                     err_bk=(pts["persist_delay"] - pts["actual_delay"]).abs())

    def block(p: pd.DataFrame) -> dict:
        by_h = p.groupby("horizon").agg(n=("err_sl", "size"), sl=("err_sl", "mean"), bk=("err_bk", "mean"))
        by_d = p.groupby("day").agg(sl=("err_sl", "mean"), bk=("err_bk", "mean"))
        return {
            "horizons": [{"h": int(h), "n": int(r.n), "mae_busskoll": round(r.bk, 1), "mae_sl": round(r.sl, 1)}
                         for h, r in by_h.iterrows()],
            "mae_busskoll": round(float(p["err_bk"].mean()), 1),
            "mae_sl": round(float(p["err_sl"].mean()), 1),
            "days_scored": len(by_d),
            "days_beat": int((by_d["bk"] < by_d["sl"]).sum()),
        }

    return {"window_days": int(pts["day"].nunique()), "overall": block(pts),
            "lines": {line: block(g) for line, g in pts.groupby("line")}}


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--static", type=Path, required=True, help="dir with routes/trips/shapes/stops.txt")
    p.add_argument("--day", type=dt.date.fromisoformat, required=True)
    p.add_argument("--start", default="07:30", help="local time, HH:MM")
    p.add_argument("--minutes", type=int, default=60)
    p.add_argument("--out", type=Path, default=Path("frontend/src/fixture.json"))
    a = p.parse_args(argv)

    df = load(config.DATA_DIR / "koda" / "tripupdates").drop_duplicates()
    t0 = int(dt.datetime.combine(a.day, dt.time.fromisoformat(a.start), TZ).timestamp())
    t1 = t0 + a.minutes * 60

    trips_txt = pd.read_csv(a.static / "trips.txt", dtype=str)
    stops_txt = pd.read_csv(a.static / "stops.txt", dtype={"stop_id": str})
    wanted = set(trips_txt.loc[trips_txt["trip_id"].isin(df["trip_id"].unique()), "shape_id"])
    shapes = pd.concat(c[c["shape_id"].isin(wanted)] for c in pd.read_csv(
        a.static / "shapes.txt", dtype={"shape_id": str}, chunksize=500_000)).sort_values(["shape_id", "shape_pt_sequence"])

    # Trips active in the window (any snapshot inside it), with their static shape + headsign.
    win = df[(df["ts"] >= t0) & (df["ts"] < t1)]
    active = win[KEY].drop_duplicates()
    rows = df.merge(active, on=KEY)
    meta = trips_txt.set_index("trip_id")
    lat0 = float(stops_txt["stop_lat"].mean())
    stop_xy = dict(zip(stops_txt["stop_id"], local_xy(stops_txt["stop_lon"].to_numpy(),
                                                     stops_txt["stop_lat"].to_numpy(), lat0)))
    shape_xy = {sid: local_xy(g["shape_pt_lon"].to_numpy(), g["shape_pt_lat"].to_numpy(), lat0)
                for sid, g in shapes.groupby("shape_id")}

    names = dict(zip(stops_txt["stop_id"], stops_txt["stop_name"]))
    truth = ground_truth(rows).set_index([*KEY, "stop_sequence"])
    trips, used_shapes, used_stops = [], {}, set()
    for (trip_id, start_date), g in rows.groupby(KEY):
        if trip_id not in meta.index or meta.at[trip_id, "shape_id"] not in shape_xy:
            continue
        sid = meta.at[trip_id, "shape_id"]
        calls = g.sort_values("ts").groupby("stop_sequence").agg(
            stop_id=("stop_id", "first"), arrival=("arrival_time", "last"), delay=("delay", "last"))
        calls = calls[calls["stop_id"].isin(stop_xy)]
        if len(calls) < 2:
            continue
        dist = project_along(shape_xy[sid], np.array([stop_xy[s] for s in calls["stop_id"]]))
        stops_out = []
        for (seq, c), d in zip(calls.iterrows(), dist):
            k = (trip_id, start_date, seq)
            actual = int(truth.at[k, "arrival_time"]) if k in truth.index else None
            stops_out.append({"seq": int(seq), "stop_id": c.stop_id, "dist_m": round(float(d)),
                              "scheduled": int(c.arrival - c.delay), "actual": actual})
            used_stops.add(c.stop_id)
        headsign = meta.at[trip_id, "trip_headsign"] if "trip_headsign" in meta.columns else None
        if not isinstance(headsign, str) or not headsign:  # SL leaves it blank: use the final stop
            headsign = names.get(calls["stop_id"].iloc[-1], "")
        # SL's prediction per (snapshot, stop) as [ts, seq, delay]: what SL said at each moment.
        snaps = g[["ts", "stop_sequence", "delay"]].drop_duplicates().sort_values(["ts", "stop_sequence"])
        trips.append({
            "trip_id": trip_id, "line": g["line"].iloc[0], "vehicle_id": g["vehicle_id"].iloc[-1],
            "headsign": headsign,
            "shape_id": sid, "stops": stops_out,
            "sl": snaps.to_numpy().astype(int).tolist(),
        })
        used_shapes.setdefault(sid, (g["line"].iloc[0], trips[-1]["headsign"]))

    routes: dict[str, list] = {}
    for sid, (line, headsign) in used_shapes.items():
        s = shapes[shapes["shape_id"] == sid]
        coords = [[round(x, 5), round(y, 5)] for x, y in zip(s["shape_pt_lon"], s["shape_pt_lat"])]
        routes.setdefault(line, []).append({"shape_id": sid, "headsign": headsign, "coords": coords})

    st = stops_txt[stops_txt["stop_id"].isin(used_stops)]
    lines_at = {}
    for t in trips:
        for s in t["stops"]:
            lines_at.setdefault(s["stop_id"], set()).add(t["line"])
    out = {
        "generated_from": f"KoDa {a.day} {a.start} +{a.minutes} min, static {a.static.name}",
        "window": [t0, t1],
        "routes": [{"line": k, "shapes": v} for k, v in sorted(routes.items())],
        "stops": [{"stop_id": r.stop_id, "name": r.stop_name, "lat": round(r.stop_lat, 5),
                   "lon": round(r.stop_lon, 5), "lines": sorted(lines_at[r.stop_id])} for r in st.itertuples()],
        "trips": trips,
        "scoreboard": scoreboard(df),
    }
    assert HORIZONS == 5
    a.out.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False))
    print(f"{a.out}: {len(trips)} trips, {len(st)} stops, {len(used_shapes)} shapes, "
          f"{a.out.stat().st_size / 1e3:.0f} kB")


if __name__ == "__main__":
    main()
