import httpx
import respx
from google.transit import gtfs_realtime_pb2 as rt

from busskoll.ingest import live
from tests.conftest import make_alert_feed, make_feed, make_vp_feed

SKIPPED = rt.TripUpdate.StopTimeUpdate.SKIPPED


def test_parse_trip_updates_rows_and_filters():
    pb = make_feed(1000, [
        {"trip_id": "T1", "vehicle": "v7", "ts": 990, "stops": [
            (3, "S3", 1100, 45), (4, "S4", 1200, None), (5, "S5", 1300, 60, SKIPPED), (6, "S6", 1400, 50)]},
        {"trip_id": "T2", "canceled": True, "stops": [(1, "S1", 1100, 0)]},
        {"trip_id": "TX", "stops": [(1, "S1", 1100, 0)]},
    ])
    df = live.parse_trip_updates(pb, {"T1", "T2"})
    assert df.to_dict("records") == [
        {"ts": 990, "trip_id": "T1", "start_date": "20261101", "vehicle_id": "v7", "stop_sequence": 3,
         "stop_id": "S3", "arrival_time": 1100, "delay": 45},
        {"ts": 990, "trip_id": "T1", "start_date": "20261101", "vehicle_id": "v7", "stop_sequence": 6,
         "stop_id": "S6", "arrival_time": 1400, "delay": 50},
    ]


def test_parse_falls_back_to_header_timestamp_and_handles_empty():
    df = live.parse_trip_updates(make_feed(1000, [{"trip_id": "T1", "stops": [(1, "S1", 1100, 5)]}]))
    assert df["ts"].tolist() == [1000]
    assert live.parse_trip_updates(make_feed(1000, [])).empty


@respx.mock
def test_fetch_uses_rt_path_and_key():
    route = respx.get("https://opendata.samtrafiken.se/gtfs-rt/sl/TripUpdates.pb").mock(
        return_value=httpx.Response(200, content=b"pb"))
    assert live.fetch("TripUpdates") == b"pb"
    assert route.calls.last.request.url.params["key"] == "rt-test"


def test_parse_drops_stale_trip_updates():
    pb = make_feed(10_000, [{"trip_id": "OLD", "ts": 10_000 - live.STALE_S - 1, "stops": [(1, "S1", 9000, 0)]},
                            {"trip_id": "NEW", "ts": 10_000 - live.STALE_S, "stops": [(1, "S1", 10_100, 0)]}])
    assert live.parse_trip_updates(pb)["trip_id"].tolist() == ["NEW"]


def test_parse_vehicle_positions_keeps_our_fresh_fixes():
    pb = make_vp_feed(10_000, [{"trip_id": "T1", "lat": 59.3, "lon": 18.0, "ts": 9_990},
                               {"trip_id": "TX", "lat": 59.3, "lon": 18.0},
                               {"trip_id": "T4", "lat": 59.3, "lon": 18.0, "ts": 10_000 - live.STALE_S - 1}])
    df = live.parse_vehicle_positions(pb, {"T1", "T4"})
    assert df[["ts", "trip_id"]].to_dict("records") == [{"ts": 9_990, "trip_id": "T1"}]
    assert abs(df["lat"].iloc[0] - 59.3) < 1e-5


def test_parse_alerts_one_row_per_informed_entity():
    df = live.parse_alerts(make_alert_feed(500, {"a1": [("R1", ""), ("", "S9")], "a2": [("R4", "")]}))
    assert df[["ts", "alert_id", "route_id", "stop_id"]].values.tolist() == [
        [500, "a1", "R1", ""], [500, "a1", "", "S9"], [500, "a2", "R4", ""]]
