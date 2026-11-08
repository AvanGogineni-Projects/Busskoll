// Typed client for the Busskoll API (FastAPI on Vercel, reading Neon Postgres).
// Base URL: VITE_API_BASE if set; otherwise the uvicorn dev server in `npm run dev`,
// and same-origin ("") in production, where Vercel routes /v1/* to the API.
// Reads are CDN-cached, so the dashboard polls at most once a minute (useLive.ts).

export const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, "") ??
  (import.meta.env.DEV ? "http://localhost:8000" : "");

export const LINES = ["1", "4", "6"] as const;
export type Line = (typeof LINES)[number];

// One upcoming stop of a trip. Times are ISO 8601; delays are derived against `scheduled`.
export interface StopCall {
  stop_id: string;
  name: string;
  dist_m: number; // metres along the trip's shape
  scheduled: string;
  sl: string; // SL's own predicted arrival
  busskoll: string; // Busskoll's predicted arrival
}

export interface Vehicle {
  vehicle_id: string;
  trip_id: string;
  line: Line;
  headsign: string;
  shape_id: string;
  delay_s: number; // delay at the last stop passed (+ve = late)
  last_stop: { stop_id: string; name: string; dist_m: number; time: string };
  next_stops: StopCall[]; // the next 1-5 stops, in order
}

export interface Vehicles {
  as_of: string;
  vehicles: Vehicle[];
}

export interface RouteShape {
  shape_id: string;
  headsign: string;
  coords: [number, number][]; // [lon, lat]
}

export interface Stop {
  stop_id: string;
  name: string;
  lat: number;
  lon: number;
  lines: Line[];
}

export interface Routes {
  routes: { line: Line; shapes: RouteShape[] }[];
  stops: Stop[];
}

export interface Arrival extends Omit<StopCall, "stop_id" | "name" | "dist_m"> {
  vehicle_id: string;
  trip_id: string;
  line: Line;
  headsign: string;
}

export interface StopDetail {
  as_of: string;
  stop: Stop;
  arrivals: Arrival[]; // buses due within their next 5 stops, soonest first
}

export interface ScoreBlock {
  horizons: { h: number; n: number; mae_busskoll: number; mae_sl: number }[]; // h = stops ahead
  mae_busskoll: number; // seconds
  mae_sl: number;
  days_scored: number;
  days_beat: number; // days Busskoll's MAE was below SL's
}

export interface Scoreboard {
  as_of: string;
  window_days: number;
  overall: ScoreBlock;
  lines: Partial<Record<Line, ScoreBlock>>;
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`, { signal });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

export const fetchVehicles = (signal?: AbortSignal) => get<Vehicles>("/v1/vehicles", signal);
export const fetchRoutes = (signal?: AbortSignal) => get<Routes>("/v1/routes", signal);
export const fetchScoreboard = (signal?: AbortSignal) => get<Scoreboard>("/v1/scoreboard", signal);
export const fetchStop = (id: string, signal?: AbortSignal) =>
  get<StopDetail>(`/v1/stops/${encodeURIComponent(id)}`, signal);

// The same four calls, swappable for the dev-only mock (src/mock.ts).
export interface Client {
  vehicles: typeof fetchVehicles;
  routes: typeof fetchRoutes;
  scoreboard: typeof fetchScoreboard;
  stop: typeof fetchStop;
}
export const live: Client = { vehicles: fetchVehicles, routes: fetchRoutes, scoreboard: fetchScoreboard, stop: fetchStop };
