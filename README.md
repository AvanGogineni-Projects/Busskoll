# Busskoll

Live delay predictions for Stockholm (SL) blue bus lines 1, 4 and 6, built on Trafiklab open data
(CC0), and scored live against **SL's own predicted arrival times**.

## Status: milestone 1

- [x] Scaffold: pyproject, ruff, pytest, CI (Python 3.12), `.env.example`
- [x] Live GTFS-RT fetch + TripUpdates parser (`busskoll.ingest.live`)
- [x] Resumable KoDa backfill (`busskoll.ingest.koda`)
- [x] Walk-forward backtest of both baselines (`busskoll.eval.backtest`)
- [ ] First baseline numbers on real history (needs `KODA_KEY`)

## How it works

1. **Backfill:** KoDa archives one hour of SL TripUpdates per request. Each hour is unpacked and
   filtered to lines 1/4/6 (trip_id → line from the static GTFS for that week). It's thinned to
   one snapshot per 30 s and the next 6 stops, then saved as
   `data/koda/tripupdates/date=…/hour=….parquet`. A finished hour is never fetched again, and a
   failed one (202 timeout, corrupt 7z, outage) is retried on the next run.
2. **Actual arrival:** the last delay SL reported for a stop, accepted only if that report came at
   most 60 s before the arrival (i.e. the bus was there).
3. **Forecast points:** every snapshot × the next 1–5 stops. The two baselines:
   - **persistence:** delay at the last stop already passed. It only counts once that stop's value
     is final, so nothing from the future leaks in.
   - **SL:** the delay SL predicted for that stop in the same snapshot.
4. **Report:** MAE in seconds overall, by horizon, for trips already ≥2 min late, by line and by
   day (walk-forward folds) → `reports/baselines.md`.

## Run

```bash
python3.12 -m venv .venv && .venv/bin/pip install -e ".[ml]" ruff
cp .env.example .env   # add your Trafiklab keys
.venv/bin/python -m busskoll.ingest.koda --days 14
.venv/bin/python -m busskoll.eval.backtest
.venv/bin/ruff check src tests && .venv/bin/pytest -q
```

## Call budget

The realtime Bronze key allows 30k calls a month, about one every 90 s. Milestone 1 makes no
realtime calls. KoDa takes one call per (day, hour) plus one static call per week, and asks
users to keep only 2–3 downloads running at once; the backfill runs them one at a time.
