"""LightGBM that corrects SL's own prediction, plus an 80% range, with a walk-forward backtest.

    python -m busskoll.model          # -> reports/model_backtest.md

The model predicts the *residual* (actual delay - SL's predicted delay) from point-in-time
features, so it only has to learn where SL is systematically wrong. Quantile models for the
residual's 10th and 90th percentiles give the 80% range. Walk-forward by day: each test day
is predicted by models trained only on the days before it.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

from busskoll import config
from busskoll.eval.backtest import KEY, LATE_S, forecast_points, gps_truth, ground_truth, load, mae_table
from busskoll.ingest.koda import SNAPSHOT_EVERY_S

FEATURES = ["sl_delay", "sl_now", "persist_delay", "persist_age", "ahead_delay", "ahead_age", "eta_s",
            "horizon", "stop_sequence", "hour", "weekday", "line", "alerts_line", "alerts_stop"]
MIN_TRAIN_DAYS = 7
MAX_TRAIN_ROWS = 400_000  # consecutive 30 s snapshots are near-duplicates; a sample learns the same
QUANTILES = (0.1, 0.9)


def _count_active(t: np.ndarray, first: np.ndarray, last: np.ndarray) -> np.ndarray:
    """How many [first, last] intervals contain each t."""
    return np.searchsorted(np.sort(first), t, side="right") - np.searchsorted(np.sort(last), t, side="left")


def add_alert_counts(pts: pd.DataFrame, alerts: pd.DataFrame, routes: pd.DataFrame) -> pd.DataFrame:
    """alerts_line: alerts in the feed at t naming one of the line's routes; alerts_stop: naming the
    target stop. Presence in the feed at t is known at t (see live.parse_alerts)."""
    pts = pts.assign(alerts_line=0, alerts_stop=0)
    if alerts.empty:
        return pts
    by_line = alerts.merge(routes, on="route_id").drop_duplicates(["alert_id", "line", "first_seen"])
    for line, a in by_line.groupby("line"):
        m = pts["line"] == line
        pts.loc[m, "alerts_line"] = _count_active(pts.loc[m, "ts"].to_numpy(), a["first_seen"].to_numpy(),
                                                  a["last_seen"].to_numpy())
    by_stop = alerts[alerts["stop_id"] != ""].drop_duplicates(["alert_id", "stop_id", "first_seen"])
    wanted = by_stop[by_stop["stop_id"].isin(set(pts["stop_id"]))]
    for stop, a in wanted.groupby("stop_id"):
        m = pts["stop_id"] == stop
        pts.loc[m, "alerts_stop"] = _count_active(pts.loc[m, "ts"].to_numpy(), a["first_seen"].to_numpy(),
                                                  a["last_seen"].to_numpy())
    return pts


def features(tu: pd.DataFrame, truth: pd.DataFrame, alerts: pd.DataFrame, routes: pd.DataFrame,
             live: bool = False) -> pd.DataFrame:
    """Forecast points (see backtest.forecast_points) with every model input, all known at ts."""
    pts = forecast_points(tu, truth, live=live)
    pts["persist_age"] = pts["ts"] - pts["passed_at"]
    # SL's current delay estimate for this trip: its prediction for the very next stop.
    pts["sl_now"] = pts.sort_values("horizon").groupby([*KEY, "ts"])["sl_delay"].transform("first")
    pts["eta_s"] = pts["arrival_time"] - pts["ts"]

    # Bus ahead: the latest other trip of the same line already past the target stop at ts.
    # Like persistence, a stop's value only counts once it is final (known_at + one interval).
    where = tu.drop_duplicates([*KEY, "stop_sequence"])[[*KEY, "stop_sequence", "stop_id", "line"]]
    ahead = truth.merge(where, on=[*KEY, "stop_sequence"])
    ahead = ahead.assign(ahead_at=ahead["known_at"] + SNAPSHOT_EVERY_S).sort_values("ahead_at")[
        ["stop_id", "line", "ahead_at", "actual_delay"]].rename(columns={"actual_delay": "ahead_delay"})
    pts = pd.merge_asof(pts.sort_values("ts"), ahead, left_on="ts", right_on="ahead_at", by=["stop_id", "line"],
                        direction="backward")
    pts["ahead_age"] = pts["ts"] - pts["ahead_at"]

    local = pd.to_datetime(pts["ts"], unit="s", utc=True).dt.tz_convert("Europe/Stockholm")
    pts["hour"] = local.dt.hour + local.dt.minute / 60
    pts["weekday"] = local.dt.day_of_week
    pts["line"] = pd.Categorical(pts["line"], categories=list(config.LINES))  # same codes in every fold
    return add_alert_counts(pts, alerts, routes).reset_index(drop=True)


def fit(train: pd.DataFrame) -> dict:
    import lightgbm as lgb  # training-only dependency

    if len(train) > MAX_TRAIN_ROWS:
        train = train.sample(MAX_TRAIN_ROWS, random_state=0)
    X, resid = train[FEATURES], train["actual_delay"] - train["sl_delay"]
    params = {"learning_rate": 0.05, "num_leaves": 63, "min_data_in_leaf": 100, "verbose": -1, "seed": 0}
    data = lgb.Dataset(X, resid)
    models = {"point": lgb.train({**params, "objective": "l1"}, data, num_boost_round=400)}
    for q in QUANTILES:
        models[q] = lgb.train({**params, "objective": "quantile", "alpha": q}, data, num_boost_round=400)
    return models


def predict(models: dict, pts: pd.DataFrame) -> pd.DataFrame:
    X, sl = pts[FEATURES], pts["sl_delay"].to_numpy()
    lo, hi = (sl + models[q].predict(X) for q in QUANTILES)
    return pts.assign(model_delay=sl + models["point"].predict(X), lo=np.minimum(lo, hi), hi=np.maximum(lo, hi))


def walk_forward(pts: pd.DataFrame) -> pd.DataFrame:
    days = sorted(pts["day"].unique())
    out = []
    for i, d in enumerate(days):
        if i < MIN_TRAIN_DAYS:
            continue
        out.append(predict(fit(pts[pts["day"] < d]), pts[pts["day"] == d]))
    return pd.concat(out, ignore_index=True)


def _mae(p: pd.DataFrame, by: list[str]) -> str:
    err = p.assign(persistence=(p["persist_delay"] - p["actual_delay"]).abs(),
                   sl=(p["sl_delay"] - p["actual_delay"]).abs(),
                   model=(p["model_delay"] - p["actual_delay"]).abs(),
                   in_range=(p["actual_delay"] >= p["lo"]) & (p["actual_delay"] <= p["hi"]),
                   width=p["hi"] - p["lo"])
    g = err.groupby(by, observed=True) if by else err.assign(_all="all").groupby("_all")
    t = g.agg(n=("sl", "size"), mae_persistence_s=("persistence", "mean"), mae_sl_s=("sl", "mean"),
              mae_model_s=("model", "mean"), range80_coverage=("in_range", "mean"), range80_width_s=("width", "median"))
    t["model_vs_sl"] = (t["mae_model_s"] / t["mae_sl_s"] - 1).map("{:+.1%}".format)
    return "```\n" + t.round({"mae_persistence_s": 1, "mae_sl_s": 1, "mae_model_s": 1, "range80_coverage": 3,
                              "range80_width_s": 0}).to_string() + "\n```"


def report(results: dict[str, pd.DataFrame], baselines: dict[str, pd.DataFrame]) -> str:
    parts = ["# Model backtest (walk-forward by day, MAE in seconds)",
             "Model = LightGBM correction of SL's prediction; range = 10th-90th percentile (target coverage 0.80).",
             f"Each test day uses models trained only on earlier days (first {MIN_TRAIN_DAYS} days are training-only)."]
    for name, res in results.items():
        late = res[res["persist_delay"] >= LATE_S]
        parts += [f"## Truth: {name}",
                  f"Baselines on all days: forecast points {len(baselines[name]):,}",
                  mae_table(baselines[name], []),
                  f"Walk-forward test days {res['day'].min()} to {res['day'].max()}, points {len(res):,}",
                  "### Overall", _mae(res, []), "### By horizon", _mae(res, ["horizon"]),
                  f"### Already running late (persistence delay >= {LATE_S} s)", _mae(late, ["horizon"]),
                  "### By line", _mae(res, ["line"]), "### Folds (by day)", _mae(res, ["day"])]
    return "\n\n".join(parts) + "\n"


def scoreboard(res: pd.DataFrame) -> dict:
    """Walk-forward results -> the API's /v1/scoreboard body (without as_of)."""
    p = res.assign(err_sl=(res["sl_delay"] - res["actual_delay"]).abs(),
                   err_bk=(res["model_delay"] - res["actual_delay"]).abs())

    def block(g: pd.DataFrame) -> dict:
        by_h = g.groupby("horizon").agg(n=("err_sl", "size"), sl=("err_sl", "mean"), bk=("err_bk", "mean"))
        by_d = g.groupby("day").agg(sl=("err_sl", "mean"), bk=("err_bk", "mean"))
        return {"horizons": [{"h": int(h), "n": int(r.n), "mae_busskoll": round(float(r.bk), 1),
                              "mae_sl": round(float(r.sl), 1)} for h, r in by_h.iterrows()],
                "mae_busskoll": round(float(g["err_bk"].mean()), 1), "mae_sl": round(float(g["err_sl"].mean()), 1),
                "days_scored": len(by_d), "days_beat": int((by_d["bk"] < by_d["sl"]).sum())}

    return {"window_days": int(p["day"].nunique()), "overall": block(p),
            "lines": {str(line): block(g) for line, g in p.groupby("line", observed=True)}}


def export(out: Path) -> None:
    """The served model and its scoreboard, both on SL's-last-report truth: live, the API only sees
    SL's feed, so persistence and the bus ahead come from SL's reports exactly as in this training."""
    from busskoll import trees

    tu, _, alerts, _, routes = load_inputs(config.DATA_DIR / "koda")
    pts = features(tu, ground_truth(tu), alerts, routes)
    board = scoreboard(walk_forward(pts))
    models = fit(pts)
    arrays = {f"{name}.{k}": v for name, m in models.items() for k, v in trees.to_arrays(m.dump_model()).items()}
    out.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(out / "model.npz", features=np.array(FEATURES), **arrays)
    (out / "scoreboard.json").write_text(json.dumps(board, indent=1))
    print(f"{out}: model.npz {(out / 'model.npz').stat().st_size / 1e6:.1f} MB, scoreboard {board['overall']}")


def load_inputs(root: Path) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    tu = load(root / "tripupdates")
    vp = load(root / "vehiclepositions")
    alert_files = sorted((root / "servicealerts").glob("date=*/hour=*.parquet"))
    alerts = pd.concat([d for d in (pd.read_parquet(f) for f in alert_files) if len(d)], ignore_index=True) \
        if alert_files else pd.DataFrame(columns=["alert_id", "route_id", "stop_id", "first_seen", "last_seen"])
    static = root / "static"
    stops = pd.concat([pd.read_parquet(f) for f in sorted(static.glob("*-stops.parquet"))]).drop_duplicates(
        "stop_id", keep="last")
    routes = pd.concat([pd.read_parquet(f) for f in sorted(static.glob("*-routes.parquet"))]).drop_duplicates()
    return tu, vp, alerts, stops, routes


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", type=Path, default=Path("reports/model_backtest.md"))
    p.add_argument("--export", type=Path, help="instead: write the served model + scoreboard to this dir")
    a = p.parse_args(argv)
    if a.export:
        return export(a.export)
    tu, vp, alerts, stops, routes = load_inputs(config.DATA_DIR / "koda")
    truths = {"GPS arrivals (independent)": gps_truth(tu, vp, stops), "SL's last report": ground_truth(tu)}
    results, baselines = {}, {}
    for name, truth in truths.items():
        pts = features(tu, truth, alerts, routes)
        baselines[name] = pts
        results[name] = walk_forward(pts)
        print(f"{name}: {len(pts):,} points, {len(results[name]):,} walk-forward test points")
    text = report(results, baselines)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(text)
    print(text)


if __name__ == "__main__":
    main()
