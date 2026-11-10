import datetime as dt

import httpx
import pandas as pd
import py7zr
import pytest
import respx

from busskoll.ingest import koda
from tests.conftest import gtfs_zip, make_alert_feed, make_feed, make_vp_feed

RT = "https://api.koda.trafiklab.se/KoDa/api/v2/gtfs-rt/sl/TripUpdates"
STATIC = "https://api.koda.trafiklab.se/KoDa/api/v2/gtfs-static/sl"
DAY = dt.date(2026, 11, 4)  # a Wednesday; static comes from Monday 2026-11-02


def seven_z(tmp_path, files: dict[str, bytes]) -> bytes:
    p = tmp_path / "rt.7z"
    with py7zr.SevenZipFile(p, "w") as w:
        for name, data in files.items():
            w.writestr(data, name)
    return p.read_bytes()


@respx.mock
def test_download_polls_202_then_saves(tmp_path):
    respx.get(RT).mock(side_effect=[httpx.Response(202), httpx.Response(202), httpx.Response(200, content=b"ok")])
    sleeps = []
    with httpx.Client() as c:
        out = koda.download(c, RT, {}, tmp_path / "f", sleep=sleeps.append, poll_s=5)
    assert out.read_bytes() == b"ok" and sleeps == [5, 5]


@respx.mock
def test_download_retries_outages_but_not_bad_key(tmp_path):
    respx.get(RT).mock(side_effect=[httpx.Response(503), httpx.ConnectError("down"), httpx.Response(429),
                                    httpx.Response(200, content=b"ok")])
    with httpx.Client() as c:
        assert koda.download(c, RT, {}, tmp_path / "f", sleep=lambda s: None).read_bytes() == b"ok"
    respx.get(STATIC).mock(return_value=httpx.Response(401))
    with httpx.Client() as c, pytest.raises(httpx.HTTPStatusError):
        koda.download(c, STATIC, {}, tmp_path / "g", sleep=lambda s: None)


@respx.mock
def test_download_gives_up_when_never_ready(tmp_path):
    respx.get(RT).mock(return_value=httpx.Response(202))
    with httpx.Client() as c, pytest.raises(koda.NotReady):
        koda.download(c, RT, {}, tmp_path / "f", sleep=lambda s: None, poll_s=10, max_wait_s=30)


def test_compact_thins_snapshots_and_keeps_next_stops():
    rows = [(ts, "T1", "d", "v", seq, f"S{seq}", 1000 + 100 * seq, 0)
            for ts in (900, 915, 930) for seq in range(1, 10)]
    df = koda.compact(pd.DataFrame(rows, columns=["ts", "trip_id", "start_date", "vehicle_id", "stop_sequence",
                                                  "stop_id", "arrival_time", "delay"]))
    assert sorted(df["ts"].unique()) == [900, 930]  # 915 shares 900's 30 s bucket
    assert df.groupby("ts").size().tolist() == [koda.STOPS_AHEAD] * 2


@respx.mock
def test_backfill_is_resumable_and_skips_corrupt_hours(tmp_path, monkeypatch):
    monkeypatch.setattr(koda.time, "sleep", lambda s: None)
    good = seven_z(tmp_path, {
        "sl/a.pb": make_feed(1000, [{"trip_id": "T1", "stops": [(1, "S1", 1100, 30)]},
                                    {"trip_id": "T99", "stops": [(1, "S1", 1100, 0)]}]),
        "sl/readme.txt": b"not a feed",
    })

    def rt(request):
        h = request.url.params["hour"]
        return httpx.Response(202) if h == "11" else httpx.Response(200, content=good if h == "10" else b"corrupt")

    static = respx.get(STATIC).mock(return_value=httpx.Response(200, content=gtfs_zip()))
    rt_route = respx.get(RT).mock(side_effect=rt)
    root = tmp_path / "koda"
    koda.backfill(DAY, 1, root)

    assert static.calls.last.request.url.params["date"] == "2026-11-02"
    done = sorted(p.name for p in (root / "tripupdates" / "date=2026-11-04").glob("*.parquet"))
    assert done == ["hour=10.parquet"]  # the unready hour 11 and 22 corrupt hours are left for the next run
    df = pd.read_parquet(root / "tripupdates" / "date=2026-11-04" / "hour=10.parquet")
    assert df[["trip_id", "line", "delay"]].to_dict("records") == [{"trip_id": "T1", "line": "1", "delay": 30}]

    calls = rt_route.call_count
    koda.backfill(DAY, 1, root)  # rerun: hour 10 is skipped, static is cached
    rerun_hours = {c.request.url.params["hour"] for c in rt_route.calls[calls:]}
    assert rerun_hours == {f"{h:02d}" for h in range(24)} - {"10"} and static.call_count == 1


def test_safe_error_text_never_contains_the_key():
    req = httpx.Request("GET", RT, params={"key": "koda-test"})
    err = httpx.HTTPStatusError("boom " + str(req.url), request=req, response=httpx.Response(500, request=req))
    assert koda.safe(err) == "HTTPStatusError 500"
    assert "koda-test" not in koda.safe(httpx.ConnectError("x " + str(req.url), request=req))


@respx.mock
def test_backfill_vehicle_positions_and_alerts(tmp_path):
    vp = {f"sl/vp-{i:02d}.pb": make_vp_feed(1000 + i, [{"trip_id": "T1", "lat": 59.33, "lon": 18.06},
                                                      {"trip_id": "T99", "lat": 59.0, "lon": 18.0}])
          for i in range(7)}
    al = {f"sl/al-{i}.pb": make_alert_feed(t, {"a1": [("R1", "")]} if t < 1200 else {})
          for i, t in enumerate((1000, 1100, 1200))}
    respx.get(STATIC).mock(return_value=httpx.Response(200, content=gtfs_zip()))
    respx.get(RT.replace("TripUpdates", "VehiclePositions")).mock(
        return_value=httpx.Response(200, content=seven_z(tmp_path, vp)))
    root = tmp_path / "koda"
    with httpx.Client() as c:
        lines = koda.static_map(c, DAY, root)
        assert koda.backfill_hour(c, DAY, 8, lines, root, "VehiclePositions") == 3  # every 3rd of 7 files, T1 only
        respx.get(RT.replace("TripUpdates", "ServiceAlerts")).mock(
            return_value=httpx.Response(200, content=seven_z(tmp_path, al)))
        koda.backfill_hour(c, DAY, 8, lines, root, "ServiceAlerts")
    v = pd.read_parquet(koda.hour_path(root, DAY, 8, "VehiclePositions"))
    assert v["ts"].tolist() == [1000, 1003, 1006] and set(v["line"]) == {"1"}
    a = pd.read_parquet(koda.hour_path(root, DAY, 8, "ServiceAlerts"))
    assert a[["alert_id", "route_id", "first_seen", "last_seen"]].values.tolist() == [["a1", "R1", 1000, 1100]]
    assert set(pd.read_parquet(koda.static_paths(root, dt.date(2026, 11, 2))["stops"])["stop_id"]) == {"S1", "S2"}
