import pandas as pd

from busskoll import model

COLS = ["ts", "trip_id", "start_date", "vehicle_id", "stop_sequence", "stop_id", "arrival_time", "delay", "line"]


def trip(trip_id: str, start: int, delays: dict[int, int], bias: int = 40) -> list[tuple]:
    """Snapshots every 30 s; stop s is reached at start + 100*s + delay. SL over-predicts by
    `bias` until 30 s before arrival, then reports the truth (like backtest.history)."""
    rows = []
    arrive = {s: start + 100 * s for s in delays}
    for ts in range(start - 60, start + 100 * max(delays) + 61, 30):
        for s, arr in arrive.items():
            if arr >= ts - 60:
                d = delays[s] if ts >= arr - 30 else delays[s] + bias
                rows.append((ts, trip_id, "20261101", "v", s, f"S{s}", arr, d, "4"))
    return rows


def test_features_bus_ahead_is_point_in_time():
    tu = pd.DataFrame(trip("A", 0, {1: 50, 2: 60, 3: 70}) + trip("B", 120, {1: 0, 2: 10, 3: 20}), columns=COLS)
    truth = model.ground_truth(tu)
    pts = model.features(tu, truth, pd.DataFrame(), pd.DataFrame(columns=["route_id", "line"]))
    b = pts[(pts["trip_id"] == "B")].set_index(["ts", "stop_sequence"])
    # Trip A's stop 3 (arrival 300) is final at known_at=360 and counts from 390.
    assert pd.isna(b.loc[(360, 3), "ahead_delay"]) or b.loc[(360, 3), "ahead_at"] <= 360
    assert b.loc[(390, 3), "ahead_delay"] == 70 and b.loc[(390, 3), "ahead_age"] == 0
    assert (pts["ahead_at"].dropna() <= pts.loc[pts["ahead_at"].notna(), "ts"]).all()
    assert (pts["passed_at"] <= pts["ts"]).all()


def test_alert_counts_use_presence_at_ts():
    pts = pd.DataFrame({"ts": [100, 200, 300], "line": "1", "stop_id": ["S1", "S2", "S1"]})
    alerts = pd.DataFrame({"alert_id": ["a", "b"], "route_id": ["R1", ""], "stop_id": ["", "S1"],
                           "effect": 8, "first_seen": [150, 250], "last_seen": [250, 400]})
    out = model.add_alert_counts(pts, alerts, pd.DataFrame({"route_id": ["R1"], "line": ["1"]}))
    assert out["alerts_line"].tolist() == [0, 1, 0] and out["alerts_stop"].tolist() == [0, 0, 1]


def test_walk_forward_trains_only_on_earlier_days(monkeypatch):
    monkeypatch.setattr(model, "MIN_TRAIN_DAYS", 2)
    pts = pd.DataFrame({"day": pd.to_datetime(["2026-11-01", "2026-11-02", "2026-11-03"] * 200).date})
    seen = []
    monkeypatch.setattr(model, "fit", lambda train: seen.append(sorted(set(train["day"]))) or {})
    monkeypatch.setattr(model, "predict", lambda models, test: test)
    out = model.walk_forward(pts)
    assert [str(d) for d in seen[0]] == ["2026-11-01", "2026-11-02"]
    assert set(map(str, out["day"])) == {"2026-11-03"}


def test_fit_predict_learns_sl_bias_and_range_is_ordered():
    import numpy as np

    rng = np.random.default_rng(0)
    n = 4000
    pts = pd.DataFrame({f: rng.normal(size=n) for f in model.FEATURES})
    pts["line"] = pd.Categorical(rng.choice(["1", "4", "6"], n), categories=["1", "4", "6"])
    pts["sl_delay"] = rng.normal(60, 30, n)
    pts["actual_delay"] = pts["sl_delay"] - 40 + rng.normal(0, 5, n)  # SL is 40 s pessimistic
    res = model.predict(model.fit(pts), pts)
    assert abs((res["model_delay"] - res["actual_delay"]).abs().mean()) < 10
    assert (res["lo"] <= res["hi"]).all()
    cover = ((res["actual_delay"] >= res["lo"]) & (res["actual_delay"] <= res["hi"])).mean()
    assert 0.7 < cover < 0.9


def test_scoreboard_counts_days_beat_per_line_and_horizon():
    import datetime as dt
    d1, d2 = dt.date(2026, 11, 1), dt.date(2026, 11, 2)
    res = pd.DataFrame({"day": [d1, d1, d2, d2], "line": pd.Categorical(["1", "1", "1", "4"]),
                        "horizon": [1, 2, 1, 1], "actual_delay": [100, 100, 100, 100],
                        "sl_delay": [130, 130, 100, 160], "model_delay": [110, 110, 120, 100]})
    b = model.scoreboard(res)
    assert b["window_days"] == 2
    assert b["lines"]["1"]["days_scored"] == 2 and b["lines"]["1"]["days_beat"] == 1  # d1 beat, d2 lost
    assert b["lines"]["4"]["mae_busskoll"] == 0.0 and b["lines"]["4"]["mae_sl"] == 60.0
    assert [h["h"] for h in b["overall"]["horizons"]] == [1, 2]
