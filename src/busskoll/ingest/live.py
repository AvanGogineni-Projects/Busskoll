"""Live GTFS-RT feeds from Trafiklab (GTFS Regional, operator `sl`) and the TripUpdates parser.

The same parser reads KoDa's archived .pb snapshots, so history and live data share one schema.
"""
from __future__ import annotations

from collections.abc import Collection

import httpx
import pandas as pd
from google.transit import gtfs_realtime_pb2

from busskoll import config

FEEDS = ("TripUpdates", "VehiclePositions", "ServiceAlerts")
# Only the /gtfs-rt/ path serves the realtime feeds.
URL = "https://opendata.samtrafiken.se/gtfs-rt/{operator}/{feed}.pb"

COLUMNS = ["ts", "trip_id", "start_date", "vehicle_id", "stop_sequence", "stop_id", "arrival_time", "delay"]
_SKIPPED = gtfs_realtime_pb2.TripUpdate.StopTimeUpdate.SKIPPED
_NO_DATA = gtfs_realtime_pb2.TripUpdate.StopTimeUpdate.NO_DATA


def fetch(feed: str, client: httpx.Client | None = None) -> bytes:
    """One realtime call (counts against the 30k/month Bronze quota)."""
    if feed not in FEEDS:
        raise ValueError(f"unknown feed {feed!r}")
    c = client or httpx.Client(timeout=20)
    try:
        r = c.get(URL.format(operator=config.OPERATOR, feed=feed), params={"key": config.key("TRAFIKLAB_RT_KEY")})
        r.raise_for_status()
        return r.content
    finally:
        if client is None:
            c.close()


def parse_trip_updates(pb: bytes, trip_ids: Collection[str] | None = None) -> pd.DataFrame:
    """One row per (trip, stop) prediction in a TripUpdates snapshot.

    ts is the trip update's own timestamp (falls back to the feed header). arrival_time is
    SL's predicted (or, once passed, actual) arrival in unix seconds; delay is seconds vs
    schedule. Stops that are skipped or carry no data are dropped. `trip_ids` filters early
    so a whole-region snapshot never becomes a whole-region DataFrame.
    """
    msg = gtfs_realtime_pb2.FeedMessage()
    msg.ParseFromString(pb)
    header_ts = msg.header.timestamp
    rows = []
    for ent in msg.entity:
        if not ent.HasField("trip_update"):
            continue
        tu = ent.trip_update
        if tu.trip.schedule_relationship == gtfs_realtime_pb2.TripDescriptor.CANCELED:
            continue
        if trip_ids is not None and tu.trip.trip_id not in trip_ids:
            continue
        ts = tu.timestamp or header_ts
        for stu in tu.stop_time_update:
            if stu.schedule_relationship in (_SKIPPED, _NO_DATA):
                continue
            ev = stu.arrival if stu.HasField("arrival") else stu.departure
            if not ev.time or not ev.HasField("delay"):
                continue  # need both: delay error == arrival-time error only if schedule is known
            rows.append((ts, tu.trip.trip_id, tu.trip.start_date, tu.vehicle.id, stu.stop_sequence,
                         stu.stop_id, ev.time, ev.delay))
    return pd.DataFrame(rows, columns=COLUMNS).astype(
        {"ts": "int64", "stop_sequence": "int32", "arrival_time": "int64", "delay": "int32"}
    )
