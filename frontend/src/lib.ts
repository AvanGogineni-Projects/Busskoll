// Pure helpers (no DOM, no React) so scripts/lib.check.ts can test them under plain Node.

export type LngLat = [number, number];

// ---- geometry: positions along a route shape ---------------------------------------
export interface Shape {
  coords: LngLat[];
  cum: number[]; // metres from the start to each vertex
}

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

// Equirectangular distance: exact enough at city scale, and the same method the
// fixture export used to place stops (scripts/export_fixture.py), so dist_m lines up.
export function metres(a: LngLat, b: LngLat): number {
  const x = rad(b[0] - a[0]) * Math.cos(rad((a[1] + b[1]) / 2));
  return Math.hypot(x, rad(b[1] - a[1])) * R;
}

export function buildShape(coords: LngLat[]): Shape {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + metres(coords[i - 1], coords[i]));
  return { coords, cum };
}

// The point `d` metres along the shape (clamped to its ends).
export function pointAt({ coords, cum }: Shape, d: number): LngLat {
  if (d <= 0) return coords[0];
  const end = cum.length - 1;
  if (d >= cum[end]) return coords[end];
  let lo = 0, hi = end;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  const t = (d - cum[lo]) / (cum[hi] - cum[lo] || 1);
  return [coords[lo][0] + (coords[hi][0] - coords[lo][0]) * t, coords[lo][1] + (coords[hi][1] - coords[lo][1]) * t];
}

// ---- time -> distance along a trip ----------------------------------------------
// A track is the bus's last passed stop then its predicted next stops: (time s, dist m).
export interface Knot {
  t: number;
  d: number;
}

// Times forced strictly increasing: a prediction already in the past (bus running
// later than predicted) must not send the bus backwards or divide by zero.
export function monotonic(knots: Knot[]): Knot[] {
  const out: Knot[] = [];
  for (const k of knots) {
    const prev = out[out.length - 1];
    out.push(prev ? { t: Math.max(k.t, prev.t + 1), d: Math.max(k.d, prev.d) } : k);
  }
  return out;
}

// Linear between knots; holds at the first/last knot outside them (bus waits at its
// next stop until the next snapshot says it has passed).
export function distAt(track: Knot[], t: number): number {
  if (!track.length) return 0;
  if (t <= track[0].t) return track[0].d;
  for (let i = 1; i < track.length; i++) {
    if (t <= track[i].t) {
      const a = track[i - 1], b = track[i];
      return a.d + ((b.d - a.d) * (t - a.t)) / (b.t - a.t);
    }
  }
  return track[track.length - 1].d;
}

export const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

// ---- delays ------------------------------------------------------------------------
export type Bucket = "early" | "ontime" | "late" | "verylate";

// SL's own punctuality convention is roughly "up to 1 min early, up to 3 min late";
// we split late at 2 and 5 min so the map separates "a bit late" from "really late".
export function bucket(delayS: number): Bucket {
  if (delayS < -60) return "early";
  if (delayS < 120) return "ontime";
  if (delayS < 300) return "late";
  return "verylate";
}

export const BUCKET_LABEL: Record<Bucket, string> = {
  early: "Early",
  ontime: "On time",
  late: "2–5 min late",
  verylate: "5+ min late",
};

// "+2:05" / "−0:40" / "±0:00": signed minutes:seconds.
export function fmtDelay(s: number): string {
  const a = Math.round(Math.abs(s));
  const sign = s > 0 ? "+" : s < 0 ? "−" : "±";
  return `${sign}${Math.floor(a / 60)}:${String(a % 60).padStart(2, "0")}`;
}

export function relTime(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`;
}

export const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm" });
