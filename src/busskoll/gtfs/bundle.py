"""Build the timetable bundle the API serves from: the current SL static GTFS, cut down to our lines.

    python -m busskoll.gtfs.bundle                 # download from Trafiklab -> src/busskoll/assets/timetable.json
    python -m busskoll.gtfs.bundle --zip sl.zip    # from a local copy

SL's trip_ids change whenever SL republishes the timetable, so this is rebuilt daily by a
GitHub Action (.github/workflows/timetable.yml) and the commit redeploys the API.
"""
from __future__ import annotations

import argparse
import io
import json
import zipfile
from pathlib import Path

import httpx
import pandas as pd

from busskoll import config
from busskoll.gtfs.static import BUS_TYPES

URL = "https://opendata.samtrafiken.se/gtfs/{op}/{op}.zip"
OUT = Path(__file__).resolve().parents[1] / "assets" / "timetable.json"


def build(read, lines=config.LINES) -> dict:
    """read(name, **read_csv_kwargs) -> DataFrame for one GTFS file."""
    routes = read("routes.txt", dtype=str, usecols=["route_id", "route_short_name", "route_type"])
    routes = routes[routes["route_short_name"].isin(lines) & routes["route_type"].astype(int).isin(BUS_TYPES)]
    trips = read("trips.txt", dtype=str, usecols=["route_id", "trip_id", "trip_headsign", "shape_id"]).merge(
        routes.rename(columns={"route_short_name": "line"})[["route_id", "line"]], on="route_id")
    ours = set(trips["trip_id"])
    st = pd.concat(c[c["trip_id"].isin(ours)] for c in read(
        "stop_times.txt", dtype={"trip_id": str, "stop_id": str}, chunksize=1_000_000,
        usecols=["trip_id", "stop_id", "stop_sequence", "shape_dist_traveled"]))
    stops = read("stops.txt", dtype={"stop_id": str}, usecols=["stop_id", "stop_name", "stop_lat", "stop_lon"])
    names = dict(zip(stops["stop_id"], stops["stop_name"]))

    # SL leaves trip_headsign blank: use the name of the trip's final stop instead.
    last = st.sort_values("stop_sequence").groupby("trip_id")["stop_id"].last()
    trips["headsign"] = trips["trip_headsign"].where(trips["trip_headsign"].fillna("") != "",
                                                     trips["trip_id"].map(last).map(names)).fillna("")
    shape_ids = set(trips["shape_id"])
    pts = pd.concat(c[c["shape_id"].isin(shape_ids)] for c in read(
        "shapes.txt", dtype={"shape_id": str}, chunksize=1_000_000)).sort_values(["shape_id", "shape_pt_sequence"])

    # One stop list per shape, from its first trip: distance along the shape (metres) per stop.
    first = trips.drop_duplicates("shape_id")[["trip_id", "shape_id", "line", "headsign"]]
    calls = st.merge(first, on="trip_id").sort_values(["shape_id", "stop_sequence"])
    shapes = {}
    for sid, g in calls.groupby("shape_id"):
        p = pts[pts["shape_id"] == sid]
        shapes[sid] = {"line": g["line"].iloc[0], "headsign": g["headsign"].iloc[0],
                       "coords": [[round(x, 5), round(y, 5)] for x, y in zip(p["shape_pt_lon"], p["shape_pt_lat"])],
                       "stops": {s: round(float(d)) for s, d in zip(g["stop_id"], g["shape_dist_traveled"])}}
    lines_at = calls.groupby("stop_id")["line"].agg(lambda s: sorted(set(s)))
    used = stops[stops["stop_id"].isin(lines_at.index)]
    return {
        "trips": {t.trip_id: [t.line, t.shape_id, t.headsign] for t in trips.itertuples() if t.shape_id in shapes},
        "shapes": shapes,
        "stops": [{"stop_id": s.stop_id, "name": s.stop_name, "lat": round(s.stop_lat, 5), "lon": round(s.stop_lon, 5),
                   "lines": lines_at[s.stop_id]} for s in used.itertuples()],
        "alert_routes": dict(zip(routes["route_id"], routes["route_short_name"])),
    }


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--zip", type=Path, help="local GTFS zip instead of downloading")
    p.add_argument("--out", type=Path, default=OUT)
    a = p.parse_args(argv)
    if a.zip:
        data = a.zip.read_bytes()
    else:
        r = httpx.get(URL.format(op=config.OPERATOR), params={"key": config.key("TRAFIKLAB_STATIC_KEY")},
                      follow_redirects=True, timeout=300)
        if r.status_code != 200:  # never print the URL: it carries the key
            raise SystemExit(f"static GTFS download failed: HTTP {r.status_code}")
        data = r.content
    z = zipfile.ZipFile(io.BytesIO(data))
    bundle = build(lambda name, **kw: pd.read_csv(z.open(name), **kw))
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(bundle, separators=(",", ":"), ensure_ascii=False, sort_keys=True))
    print(f"{a.out}: {len(bundle['trips'])} trips, {len(bundle['shapes'])} shapes, {len(bundle['stops'])} stops, "
          f"{a.out.stat().st_size / 1e3:.0f} kB")


if __name__ == "__main__":
    main()
