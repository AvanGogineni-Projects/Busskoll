"""FastAPI service: live predictions for our lines (config.LINES) from SL's realtime feed + the exported model.

    uvicorn busskoll.api:app --reload        # dev (the frontend's `npm run dev` calls :8000)

The API never trains. Each refresh reads SL's TripUpdates and VehiclePositions (and, less often, ServiceAlerts),
rebuilds the model's inputs from that single snapshot, and runs the model in NumPy (trees.py).
SL's feed keeps each trip's last ~5 passed stops with their final delay, which is all that
persistence and the bus ahead need, so no database is involved.
"""
from __future__ import annotations

import json
import threading
import time
from datetime import UTC, datetime
from pathlib import Path

import httpx
import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

from busskoll import trees
from busskoll.eval.backtest import HORIZONS, KEY
from busskoll.ingest import live
from busskoll.model import FEATURES, features

ASSETS = Path(__file__).resolve().parent / "assets"
# Two calls (TripUpdates + VehiclePositions) per 180 s at most: ~28.8k/month, inside Trafiklab Bronze's 30k.
REFRESH_S = 180
ALERTS_EVERY_S = 900

app = FastAPI(title="Busskoll")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])


@app.middleware("http")
async def _cache_headers(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/v1/") and response.status_code == 200:  # never cache errors
        static = request.url.path in ("/v1/routes", "/v1/scoreboard")
        response.headers["Cache-Control"] = ("public, max-age=300, s-maxage=3600" if static else
                                             f"public, max-age=30, s-maxage={REFRESH_S}, stale-while-revalidate=60")
    return response


def _load_models() -> dict[str, dict[str, np.ndarray]]:
    with np.load(ASSETS / "model.npz") as z:
        assert list(z["features"]) == FEATURES, "model.npz was exported with different features"
        out: dict[str, dict[str, np.ndarray]] = {}
        for k in z.files:
            if k != "features":
                name, field = k.rsplit(".", 1)  # "point.value", "0.9.value"
                out.setdefault(name, {})[field] = z[k]
    return out


TT = json.loads((ASSETS / "timetable.json").read_text())
MODELS = _load_models()
BOARD = json.loads((ASSETS / "scoreboard.json").read_text())
STOPS = {s["stop_id"]: s for s in TT["stops"]}
ROUTES = pd.DataFrame(list(TT["alert_routes"].items()), columns=["route_id", "line"])


def _iso(t: float) -> str:
    return datetime.fromtimestamp(t, UTC).isoformat().replace("+00:00", "Z")


def predict(tu: pd.DataFrame, alerts: pd.DataFrame) -> pd.DataFrame:
    """Live snapshot -> one row per (trip, upcoming stop) the model can score, with model_delay.
    A stop counts as passed once its arrival time is behind the snapshot (SL's final value)."""
    passed = tu[tu["arrival_time"] <= tu["ts"]]
    truth = passed.rename(columns={"delay": "actual_delay"}).assign(known_at=passed["arrival_time"])[
        [*KEY, "stop_sequence", "actual_delay", "known_at", "arrival_time"]]
    pts = features(tu, truth, alerts, ROUTES, live=True)
    if pts.empty:
        return pts.assign(model_delay=pd.Series(dtype=float))
    resid = trees.predict(MODELS["point"], pts[FEATURES])
    return pts.assign(model_delay=pts["sl_delay"] + resid)


def vehicles(tu: pd.DataFrame, pred: pd.DataFrame, vp: pd.DataFrame | None = None) -> list[dict]:
    """The API's Vehicle objects (see frontend/src/api.ts). `vp` adds each trip's latest GPS fix."""
    names = {s: v["name"] for s, v in STOPS.items()}
    # by trip_id alone: SL's VehiclePositions leaves start_date empty
    fixes = ({} if vp is None or vp.empty else
             vp.sort_values("ts").groupby("trip_id").last()[["ts", "lat", "lon"]].to_dict("index"))
    ours = pred.set_index([*KEY, "stop_sequence"])["model_delay"].to_dict() if len(pred) else {}
    out = []
    for (trip_id, start_date), g in tu.sort_values("stop_sequence").groupby(KEY):
        line, shape_id, headsign = TT["trips"][trip_id]
        dist = TT["shapes"][shape_id]["stops"]
        g = g[g["stop_id"].isin(dist.keys())]
        ts = int(g["ts"].max()) if len(g) else 0
        done, ahead = g[g["arrival_time"] <= ts], g[g["arrival_time"] > ts]
        if done.empty or ahead.empty:
            continue  # not started yet, or finished
        last = done.iloc[-1]
        back = done.iloc[-4] if len(done) >= 4 else None
        sched = lambda r: int(r.arrival_time - r.delay)
        fix = fixes.get(trip_id)
        out.append({
            "vehicle_id": str(last.vehicle_id), "trip_id": trip_id, "line": line, "headsign": headsign,
            "shape_id": shape_id, "delay_s": int(last.delay),
            "delay_trend_s": int(last.delay - back.delay) if back is not None else None,
            "last_stop": {"stop_id": last.stop_id, "name": names.get(last.stop_id, ""), "dist_m": dist[last.stop_id],
                          "time": _iso(last.arrival_time)},
            # shortcut: SL's feed only keeps ~10 min of passed stops, not the frontend's 45; store passes
            # (Neon, next milestone) to show a longer history.
            "passed": [{"stop_id": r.stop_id, "dist_m": dist[r.stop_id], "scheduled": _iso(sched(r)),
                        "actual": _iso(r.arrival_time)} for r in done.itertuples()],
            # where the bus really is (null without a fix): the map trusts this over the predicted times
            "gps": {"lat": round(float(fix["lat"]), 5), "lon": round(float(fix["lon"]), 5), "time": _iso(fix["ts"])}
                   if fix else None,
            "next_stops": [{
                "stop_id": r.stop_id, "name": names.get(r.stop_id, ""), "dist_m": dist[r.stop_id],
                "scheduled": _iso(sched(r)), "sl": _iso(r.arrival_time),
                # no model input (e.g. no passed stop yet): Busskoll shows SL's own prediction
                "busskoll": _iso(sched(r) + ours.get((trip_id, start_date, r.stop_sequence), r.delay)),
            } for r in ahead.head(HORIZONS).itertuples()],
        })
    return out


class _Live:
    """The latest snapshot, refreshed at most every REFRESH_S per server instance."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.at = 0.0
        self.data: dict | None = None
        self.alerts = pd.DataFrame(columns=["alert_id", "route_id", "stop_id", "first_seen", "last_seen"])
        self.alerts_at = 0.0

    def get(self) -> dict:
        with self.lock:
            now = time.time()
            if self.data is None or now - self.at >= REFRESH_S:
                with httpx.Client(timeout=20) as c:
                    if now - self.alerts_at >= ALERTS_EVERY_S:
                        try:
                            a = live.parse_alerts(live.fetch("ServiceAlerts", c))
                            # In the feed now = active for every snapshot we score now.
                            self.alerts = a.assign(first_seen=0, last_seen=np.iinfo("int64").max)
                            self.alerts_at = now
                        except httpx.HTTPError:
                            pass  # alerts are one input among many: keep the last copy
                    tu = live.parse_trip_updates(live.fetch("TripUpdates", c), TT["trips"].keys())
                    try:
                        vp = live.parse_vehicle_positions(live.fetch("VehiclePositions", c), TT["trips"].keys())
                    except httpx.HTTPError:
                        vp = None  # positions are a nicety: the map falls back to predicted times
                tu = tu.assign(line=tu["trip_id"].map(lambda t: TT["trips"][t][0]))
                as_of = int(tu["ts"].max()) if len(tu) else int(now)
                self.data = {"as_of": _iso(as_of), "vehicles": vehicles(tu, predict(tu, self.alerts), vp)}
                self.at = now
            return self.data


LIVE = _Live()


def _snapshot() -> dict:
    try:
        return LIVE.get()
    except httpx.HTTPError as e:  # never echo the error: the request URL carries the API key
        why = f"HTTP {e.response.status_code}" if isinstance(e, httpx.HTTPStatusError) else type(e).__name__
        raise HTTPException(status_code=503, detail=f"SL realtime feed unavailable ({why})") from None


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/v1/vehicles")
def get_vehicles() -> dict:
    return _snapshot()


@app.get("/v1/routes")
def get_routes() -> dict:
    by_line: dict[str, list] = {}
    for sid, s in TT["shapes"].items():
        by_line.setdefault(s["line"], []).append({"shape_id": sid, "headsign": s["headsign"], "coords": s["coords"]})
    return {"routes": [{"line": k, "shapes": v} for k, v in sorted(by_line.items())], "stops": TT["stops"]}


@app.get("/v1/scoreboard")
def get_scoreboard() -> dict:
    return {"as_of": _iso(time.time()), **BOARD}


@app.get("/v1/stops/{stop_id}")
def get_stop(stop_id: str) -> dict:
    if stop_id not in STOPS:
        raise HTTPException(status_code=404, detail="unknown stop")
    snap = _snapshot()
    arrivals = [{"vehicle_id": v["vehicle_id"], "trip_id": v["trip_id"], "line": v["line"], "headsign": v["headsign"],
                 "scheduled": s["scheduled"], "sl": s["sl"], "busskoll": s["busskoll"]}
                for v in snap["vehicles"] for s in v["next_stops"] if s["stop_id"] == stop_id]
    return {"as_of": snap["as_of"], "stop": STOPS[stop_id], "arrivals": sorted(arrivals, key=lambda a: a["busskoll"])}
