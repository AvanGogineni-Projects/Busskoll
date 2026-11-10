"""Static GTFS: which trip_ids belong to the bus lines we track.

SL's realtime TripUpdates identify trips by trip_id; the line (route_short_name)
only lives in the static routes.txt + trips.txt, so we join them once per feed version.
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd

from busskoll import config

# GTFS route_type for buses: 3 (basic) or 700-799 (extended "Bus Service").
BUS_TYPES = {3, *range(700, 800)}


def trip_lines(routes: pd.DataFrame, trips: pd.DataFrame, lines=config.LINES) -> pd.DataFrame:
    """trip_id -> line for bus routes whose short name is in `lines`."""
    r = routes[routes["route_short_name"].astype(str).isin(lines) & routes["route_type"].astype(int).isin(BUS_TYPES)]
    out = trips.merge(r[["route_id", "route_short_name"]], on="route_id")
    return out.rename(columns={"route_short_name": "line"})[["trip_id", "line"]].astype(str).drop_duplicates()


def _find(gtfs_dir: Path, name: str) -> Path:
    hits = list(gtfs_dir.rglob(name))
    if not hits:
        raise FileNotFoundError(f"{name} not found in static GTFS archive")
    return hits[0]


def tables_from_dir(gtfs_dir: Path, lines=config.LINES) -> dict[str, pd.DataFrame]:
    """From an unpacked GTFS archive (files at any depth):
    trips  (trip_id, line)  - trips of our bus lines
    routes (route_id, line) - their routes, to match ServiceAlerts
    stops  (stop_id, lat, lon) - every stop, for GPS arrival detection"""
    routes = pd.read_csv(_find(gtfs_dir, "routes.txt"), dtype=str, usecols=["route_id", "route_short_name", "route_type"])
    trips = pd.read_csv(_find(gtfs_dir, "trips.txt"), dtype=str, usecols=["trip_id", "route_id"])
    stops = pd.read_csv(_find(gtfs_dir, "stops.txt"), dtype={"stop_id": str},
                        usecols=["stop_id", "stop_lat", "stop_lon"])
    ours = routes[routes["route_short_name"].astype(str).isin(lines) & routes["route_type"].astype(int).isin(BUS_TYPES)]
    return {
        "trips": trip_lines(routes, trips, lines),
        "routes": ours.rename(columns={"route_short_name": "line"})[["route_id", "line"]].astype(str),
        "stops": stops.rename(columns={"stop_lat": "lat", "stop_lon": "lon"}),
    }


def trip_lines_from_dir(gtfs_dir: Path, lines=config.LINES) -> pd.DataFrame:
    return tables_from_dir(gtfs_dir, lines)["trips"]
