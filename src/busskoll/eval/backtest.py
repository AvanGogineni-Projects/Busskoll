"""Walk-forward backtest of the two baselines on backfilled KoDa history.

    python -m busskoll.eval.backtest                 # all days under data/koda/tripupdates

Each stored snapshot (time t, trip, next stops) is one forecast moment. For the next
1-5 stops we compare, against the delay the bus actually had at that stop:
  (a) persistence: the delay at the last stop the bus had already passed, as known at t
  (b) SL: the delay SL itself predicted for that stop in the snapshot at t
Folds are days (walk-forward): the baselines don't train, but the per-day split is the
same one the model will be trained/tested on, so the numbers stay comparable.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

from busskoll import config
from busskoll.ingest.koda import SNAPSHOT_EVERY_S

HORIZONS = 5
TRUTH_TOL_S = 60  # the last snapshot showing a stop must be at most this long before its arrival
LATE_S = 120  # "already running late": persistence delay of at least 2 min
KEY = ["trip_id", "start_date"]


def ground_truth(df: pd.DataFrame) -> pd.DataFrame:
    """Actual delay per (trip, stop): the stop's last reported value, kept only if that
    report came at (or within TRUTH_TOL_S before) the arrival, i.e. the bus was there.
    `known_at` is when that value became final, so it can only be used after that time."""
    last = df.sort_values("ts").groupby([*KEY, "stop_sequence"], as_index=False).last()
    last = last[last["arrival_time"] <= last["ts"] + TRUTH_TOL_S]
    return last.rename(columns={"delay": "actual_delay", "ts": "known_at"})[
        [*KEY, "stop_sequence", "actual_delay", "known_at", "arrival_time"]
    ]


ARRIVE_RADIUS_M = 30
TRIP_SPAN_S = 6 * 3600  # a fix belongs to a trip only within this long after the trip's start
EARTH_R = 6_371_000.0


def gps_truth(tu: pd.DataFrame, vp: pd.DataFrame, stops: pd.DataFrame) -> pd.DataFrame:
    """Actual delay per (trip, stop) from GPS, independent of SL's own reports: the arrival is
    the first fix of that trip within ARRIVE_RADIUS_M of the stop, and the delay is that minus
    the schedule (SL's arrival_time - delay, which is constant per stop). A trip's first stop
    is skipped: buses wait at the terminus with the trip already assigned. Same columns as
    ground_truth, so forecast_points takes either."""
    plan = (tu.assign(sched=tu["arrival_time"] - tu["delay"])
              .groupby([*KEY, "stop_sequence"], as_index=False).agg(stop_id=("stop_id", "first"), sched=("sched", "median")))
    plan = plan[plan["stop_sequence"] > plan.groupby(KEY)["stop_sequence"].transform("min")]
    plan = plan.merge(stops[["stop_id", "lat", "lon"]], on="stop_id")
    # SL's VehiclePositions leave start_date empty, so give each fix the start_date of the
    # same trip_id that had started (scheduled first stop, minus an hour of layover) by then.
    starts = (plan.groupby(KEY, as_index=False)["sched"].min().assign(t0=lambda s: (s["sched"] - 3600).astype("int64"))
                  .sort_values("t0")[["trip_id", "start_date", "t0"]])
    vp = pd.merge_asof(vp.drop(columns="start_date").sort_values("ts"), starts, left_on="ts", right_on="t0",
                       by="trip_id", direction="backward", tolerance=TRIP_SPAN_S).dropna(subset=["start_date"])
    fixes = {k: g for k, g in vp.groupby(KEY)}
    out = []
    for k, st in plan.groupby(KEY):
        g = fixes.get(k)
        if g is None:
            continue
        lat0 = np.radians(st["lat"].to_numpy(float))[:, None]
        dy = (np.radians(g["lat"].to_numpy(float))[None, :] - lat0) * EARTH_R
        dx = (np.radians(g["lon"].to_numpy(float))[None, :] - np.radians(st["lon"].to_numpy(float))[:, None]) \
            * np.cos(lat0) * EARTH_R
        near = np.hypot(dx, dy) <= ARRIVE_RADIUS_M  # stops x fixes
        hit = near.any(axis=1)
        arrival = g["ts"].to_numpy()[near.argmax(axis=1)]
        out.append(st.loc[hit, [*KEY, "stop_sequence", "sched"]].assign(arrival_time=arrival[hit]))
    if not out:
        return pd.DataFrame(columns=[*KEY, "stop_sequence", "actual_delay", "known_at", "arrival_time"])
    t = pd.concat(out, ignore_index=True)
    return t.assign(actual_delay=(t["arrival_time"] - t["sched"]).round().astype("int64"),
                    known_at=t["arrival_time"])[[*KEY, "stop_sequence", "actual_delay", "known_at", "arrival_time"]]


def forecast_points(df: pd.DataFrame, truth: pd.DataFrame, live: bool = False) -> pd.DataFrame:
    """One row per (snapshot t, trip, upcoming stop at horizon 1..HORIZONS) with both baselines.
    live=True keeps targets that haven't happened yet (no actual_delay): what the API serves."""
    up = df[df["arrival_time"] > df["ts"]].sort_values([*KEY, "ts", "stop_sequence"])
    up = up.assign(horizon=up.groupby([*KEY, "ts"]).cumcount() + 1)
    up = up[up["horizon"] <= HORIZONS].rename(columns={"delay": "sl_delay"})

    pts = up.merge(truth[[*KEY, "stop_sequence", "actual_delay", "known_at"]], on=[*KEY, "stop_sequence"],
                   how="left" if live else "inner")
    if not live:
        pts = pts[pts["known_at"] > pts["ts"]]  # the target must still be in the future at t

    # Persistence: the latest stop known to be passed at t. A stop's last report only proves
    # final once the next snapshot no longer updates it, so it counts from known_at + one interval.
    passed = truth.assign(passed_at=truth["known_at"] + SNAPSHOT_EVERY_S).sort_values("passed_at")[
        [*KEY, "passed_at", "actual_delay"]].rename(columns={"actual_delay": "persist_delay"})
    pts = pd.merge_asof(pts.sort_values("ts"), passed, left_on="ts", right_on="passed_at", by=KEY,
                        direction="backward")
    pts = pts.dropna(subset=["persist_delay"])  # trip hasn't passed a stop yet: no persistence forecast
    pts["day"] = pd.to_datetime(pts["ts"], unit="s", utc=True).dt.tz_convert("Europe/Stockholm").dt.date
    return pts


def mae_table(pts: pd.DataFrame, by: list[str]) -> str:
    err = pts.assign(persistence=(pts["persist_delay"] - pts["actual_delay"]).abs(),
                     sl=(pts["sl_delay"] - pts["actual_delay"]).abs())
    g = err.groupby(by) if by else err.assign(_all="all").groupby("_all")
    out = g.agg(n=("sl", "size"), mae_persistence_s=("persistence", "mean"), mae_sl_s=("sl", "mean"))
    return "```\n" + out.round(1).to_string() + "\n```"


def report(pts: pd.DataFrame) -> str:
    late = pts[pts["persist_delay"] >= LATE_S]
    parts = [
        "# Baseline backtest (MAE, seconds)",
        f"Days: {pts['day'].min()} to {pts['day'].max()}, forecast points: {len(pts):,}",
        "## Overall", mae_table(pts, []),
        "## By horizon (stops ahead)", mae_table(pts, ["horizon"]),
        f"## Already running late (persistence delay >= {LATE_S} s)", mae_table(late, ["horizon"]),
        "## By line", mae_table(pts, ["line"]),
        "## Walk-forward folds (by day)", mae_table(pts, ["day"]),
    ]
    return "\n\n".join(parts) + "\n"


def load(root: Path) -> pd.DataFrame:
    files = sorted(root.glob("date=*/hour=*.parquet"))
    if not files:
        raise SystemExit(f"no backfilled data under {root}; run python -m busskoll.ingest.koda first")
    # Hours with no buses are stored as empty, column-less files (they mark the hour done);
    # mixing them in would turn the key columns into a different string dtype.
    parts = [d for d in (pd.read_parquet(f) for f in files) if len(d)]
    return pd.concat(parts, ignore_index=True).astype({k: "str" for k in KEY})


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", type=Path, default=Path("reports/baselines.md"))
    a = p.parse_args(argv)
    df = load(config.DATA_DIR / "koda" / "tripupdates")
    text = report(forecast_points(df, ground_truth(df)))
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(text)
    print(text)


if __name__ == "__main__":
    main()
