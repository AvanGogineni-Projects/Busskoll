"""Synthetic GTFS-RT / GTFS fixtures built in code (no real SL data is committed)."""
from __future__ import annotations

import io
import zipfile

import pytest
from google.transit import gtfs_realtime_pb2 as rt


def make_feed(header_ts: int, trips: list[dict]) -> bytes:
    """trips: {trip_id, start_date, vehicle, ts?, canceled?, stops: [(seq, stop_id, time, delay|None, rel?)]}"""
    msg = rt.FeedMessage()
    msg.header.gtfs_realtime_version = "2.0"
    msg.header.timestamp = header_ts
    for i, t in enumerate(trips):
        tu = msg.entity.add(id=str(i)).trip_update
        tu.trip.trip_id = t["trip_id"]
        tu.trip.start_date = t.get("start_date", "20261101")
        if t.get("canceled"):
            tu.trip.schedule_relationship = rt.TripDescriptor.CANCELED
        tu.vehicle.id = t.get("vehicle", "v1")
        if "ts" in t:
            tu.timestamp = t["ts"]
        for seq, stop_id, time, delay, *rel in t["stops"]:
            stu = tu.stop_time_update.add(stop_sequence=seq, stop_id=stop_id)
            stu.arrival.time = time
            if delay is not None:
                stu.arrival.delay = delay
            if rel:
                stu.schedule_relationship = rel[0]
    return msg.SerializeToString()


def gtfs_zip() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("gtfs/routes.txt", "route_id,route_short_name,route_type\nR1,1,700\nR4,4,3\nM1,1,401\nR9,99,700\n")
        z.writestr("gtfs/trips.txt", "route_id,service_id,trip_id\nR1,s,T1\nR4,s,T4\nM1,s,TM\nR9,s,T99\n")
        z.writestr("gtfs/stops.txt", "stop_id,stop_name,stop_lat,stop_lon\nS1,A,59.33,18.06\nS2,B,59.331,18.07\n")
    return buf.getvalue()


def make_vp_feed(header_ts: int, vehicles: list[dict]) -> bytes:
    """vehicles: {trip_id, lat, lon, ts?, vehicle?}"""
    msg = rt.FeedMessage()
    msg.header.gtfs_realtime_version = "2.0"
    msg.header.timestamp = header_ts
    for i, v in enumerate(vehicles):
        vp = msg.entity.add(id=str(i)).vehicle
        vp.trip.trip_id = v["trip_id"]
        vp.trip.start_date = v.get("start_date", "")  # SL leaves it empty
        vp.vehicle.id = v.get("vehicle", f"v{i}")
        vp.position.latitude, vp.position.longitude = v["lat"], v["lon"]
        vp.timestamp = v.get("ts", header_ts)
    return msg.SerializeToString()


def make_alert_feed(header_ts: int, alerts: dict[str, list[tuple[str, str]]]) -> bytes:
    """alerts: alert_id -> [(route_id, stop_id), ...]"""
    msg = rt.FeedMessage()
    msg.header.gtfs_realtime_version = "2.0"
    msg.header.timestamp = header_ts
    for aid, ents in alerts.items():
        a = msg.entity.add(id=aid).alert
        a.effect = rt.Alert.SIGNIFICANT_DELAYS
        for route_id, stop_id in ents:
            ie = a.informed_entity.add()
            if route_id:
                ie.route_id = route_id
            if stop_id:
                ie.stop_id = stop_id
    return msg.SerializeToString()


@pytest.fixture(autouse=True)
def _keys(monkeypatch):
    monkeypatch.setenv("TRAFIKLAB_RT_KEY", "rt-test")
    monkeypatch.setenv("KODA_KEY", "koda-test")
