import pandas as pd
import pytest

from busskoll.eval import backtest

ARRIVAL = {1: 100, 2: 200, 3: 300}
ACTUAL = {1: 10, 2: 20, 3: 30}


def history() -> pd.DataFrame:
    """One trip, 3 stops, snapshots every 30 s. SL over-predicts by 40 s until 30 s before
    arrival, then reports the true delay; a stop stays in the feed until 60 s after arrival."""
    rows = []
    for ts in range(0, 301, 30):
        for seq, arr in ARRIVAL.items():
            if arr >= ts - 60:
                d = ACTUAL[seq] if ts >= arr - 30 else ACTUAL[seq] + 40
                rows.append((ts, "T1", "20261101", "v1", seq, f"S{seq}", arr, d, "4"))
    return pd.DataFrame(rows, columns=["ts", "trip_id", "start_date", "vehicle_id", "stop_sequence", "stop_id",
                                       "arrival_time", "delay", "line"])


def test_ground_truth_is_last_report_and_rejects_unfinished_stops():
    df = history()
    df = pd.concat([df, df.iloc[[0]].assign(stop_sequence=9, arrival_time=5000)])  # seen once, far ahead
    t = backtest.ground_truth(df).set_index("stop_sequence")
    assert t["actual_delay"].to_dict() == ACTUAL
    assert t["known_at"].to_dict() == {1: 150, 2: 240, 3: 300}


def test_forecast_points_are_point_in_time_and_score_both_baselines():
    df = history()
    pts = backtest.forecast_points(df, backtest.ground_truth(df)).sort_values(["ts", "horizon"])
    got = list(zip(pts["ts"], pts["stop_sequence"], pts["horizon"], pts["persist_delay"], pts["sl_delay"]))
    # Persistence only uses a stop once its value is final (known_at + 30 s): at t=240 stop 2
    # arrived at 200 but is still in the feed, so persistence is still stop 1's 10 s.
    assert got == [(180, 2, 1, 10, 20), (180, 3, 2, 10, 70), (210, 3, 1, 10, 70),
                   (240, 3, 1, 10, 70), (270, 3, 1, 20, 30)]
    pers = (pts["persist_delay"] - pts["actual_delay"]).abs().mean()
    sl = (pts["sl_delay"] - pts["actual_delay"]).abs().mean()
    assert (pers, sl) == (16, 24)
    text = backtest.report(pts)
    assert "By horizon" in text and "Already running late" in text


def test_load_skips_empty_hours_and_backtest_runs_on_mixed_files(tmp_path):
    h = history()
    (tmp_path / "date=2026-11-01").mkdir()
    pd.DataFrame().to_parquet(tmp_path / "date=2026-11-01" / "hour=03.parquet")  # night hour, no buses
    h[h.ts < 150].astype({"trip_id": object}).to_parquet(tmp_path / "date=2026-11-01" / "hour=10.parquet")
    h[h.ts >= 150].to_parquet(tmp_path / "date=2026-11-01" / "hour=11.parquet")
    df = backtest.load(tmp_path)
    assert len(df) == len(h)
    pts = backtest.forecast_points(df, backtest.ground_truth(df))
    assert len(pts) == 5


def test_load_without_data_explains_what_to_run(tmp_path):
    with pytest.raises(SystemExit, match="busskoll.ingest.koda"):
        backtest.load(tmp_path)
