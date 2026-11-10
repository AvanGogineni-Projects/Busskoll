import numpy as np
import pytest
from fastapi.testclient import TestClient

from tests.conftest import make_alert_feed, make_feed

api = pytest.importorskip("busskoll.api")

T0 = 1_762_000_000  # snapshot time
# One tree that is a single leaf: the model always adds +30 s to SL's predicted delay.
PLUS_30 = {"feature": np.array([-1]), "threshold": np.array([0.0]), "left": np.array([0]), "right": np.array([0]),
           "default_left": np.array([False]), "missing": np.array([0]), "cat_mask": np.array([0]),
           "value": np.array([30.0]), "roots": np.array([0])}


@pytest.fixture
def client(monkeypatch):
    tt = {"trips": {"T1": ["1", "SH", "Mot centrum"], "T2": ["4", "SH4", "Ut"]},
          "shapes": {"SH": {"line": "1", "headsign": "Mot centrum", "coords": [[18.0, 59.3], [18.1, 59.3]],
                            "stops": {"S1": 0, "S2": 400, "S3": 900, "S4": 1500}},
                     "SH4": {"line": "4", "headsign": "Ut", "coords": [[18.0, 59.3], [18.0, 59.4]],
                             "stops": {"S3": 0, "S4": 700}}},
          "stops": [{"stop_id": s, "name": f"Stop {s}", "lat": 59.3, "lon": 18.0, "lines": ["1"]}
                    for s in ("S1", "S2", "S3", "S4")],
          "alert_routes": {"R1": "1"}}
    feed = make_feed(T0, [
        {"trip_id": "T1", "vehicle": "bus7", "ts": T0, "stops": [
            (1, "S1", T0 - 300, 60), (2, "S2", T0 - 120, 60), (3, "S3", T0 + 100, 60), (4, "S4", T0 + 300, 90)]},
        # hasn't passed a stop yet: no model input, so Busskoll falls back to SL's own time
        {"trip_id": "T2", "vehicle": "bus9", "ts": T0, "stops": [(1, "S3", T0 + 50, 0), (2, "S4", T0 + 400, 0)]},
        {"trip_id": "NOT_OURS", "ts": T0, "stops": [(1, "S1", T0 - 60, 0), (2, "S2", T0 + 60, 0)]},
    ])
    monkeypatch.setattr(api, "TT", tt)
    monkeypatch.setattr(api, "STOPS", {s["stop_id"]: s for s in tt["stops"]})
    monkeypatch.setattr(api, "MODELS", {"point": PLUS_30})
    monkeypatch.setattr(api, "LIVE", api._Live())
    calls = []
    monkeypatch.setattr(api.live, "fetch", lambda feed_name, c=None: calls.append(feed_name) or (
        feed if feed_name == "TripUpdates" else make_alert_feed(T0, {})))
    c = TestClient(api.app)
    c.calls = calls
    return c


def test_vehicles_use_the_model_for_scored_stops_and_sl_otherwise(client):
    r = client.get("/v1/vehicles")
    assert r.status_code == 200 and "s-maxage" in r.headers["cache-control"]
    v = {x["trip_id"]: x for x in r.json()["vehicles"]}
    assert set(v) == {"T1"}  # T2 has no passed stop, NOT_OURS isn't in the timetable
    t1 = v["T1"]
    assert t1["delay_s"] == 60 and t1["last_stop"]["stop_id"] == "S2" and t1["last_stop"]["dist_m"] == 400
    s3, s4 = t1["next_stops"]
    assert s3["sl"] == api._iso(T0 + 100) and s3["busskoll"] == api._iso(T0 + 100 + 30)  # SL + model's +30 s
    assert s4["scheduled"] == api._iso(T0 + 300 - 90) and s4["busskoll"] == api._iso(T0 + 300 + 30)
    assert [p["stop_id"] for p in t1["passed"]] == ["S1", "S2"]


def test_stop_detail_routes_and_caching_of_the_feed(client):
    a = client.get("/v1/stops/S3").json()
    assert [x["trip_id"] for x in a["arrivals"]] == ["T1"] and a["stop"]["name"] == "Stop S3"
    assert client.get("/v1/stops/nope").status_code == 404
    routes = client.get("/v1/routes").json()
    assert [r["line"] for r in routes["routes"]] == ["1", "4"] and len(routes["stops"]) == 4
    client.get("/v1/vehicles")
    assert client.calls.count("TripUpdates") == 1  # one feed call serves every endpoint until REFRESH_S
    assert "overall" in client.get("/v1/scoreboard").json()


def test_feed_outage_is_a_503_without_the_key(client, monkeypatch):
    import httpx

    def down(feed_name, c=None):
        raise httpx.ConnectError("https://opendata.samtrafiken.se/...?key=SECRET")

    monkeypatch.setattr(api.live, "fetch", down)
    r = client.get("/v1/vehicles")
    assert r.status_code == 503 and "SECRET" not in r.text and "cache-control" not in r.headers
