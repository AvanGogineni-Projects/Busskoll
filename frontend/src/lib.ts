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

// Where a point sits along a shape: metres from the start to the nearest point on it, and how
// far off the shape it is. Used to order a line's stops top to bottom on the Marey chart.
// `from` skips the shape before that distance, so a route that uses the same street twice
// places a bus on the pass it is actually on.
export function project({ coords, cum }: Shape, p: LngLat, from = -Infinity): { d: number; off: number } {
  const kx = rad(1) * Math.cos(rad(p[1])) * R;
  const ky = rad(1) * R;
  let best = { d: 0, off: Infinity };
  for (let i = 0; i < coords.length - 1; i++) {
    if (cum[i + 1] < from) continue;
    const ax = (coords[i][0] - p[0]) * kx, ay = (coords[i][1] - p[1]) * ky;
    const bx = (coords[i + 1][0] - p[0]) * kx, by = (coords[i + 1][1] - p[1]) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const off = Math.hypot(ax + dx * t, ay + dy * t);
    if (off < best.off) best = { d: cum[i] + (cum[i + 1] - cum[i]) * t, off };
  }
  return best;
}

// The stretch of the shape between d0 and d1 (d0 < d1): both end points plus the vertices
// between them. Used for the light trail drawn behind each bus.
export function sliceShape(shape: Shape, d0: number, d1: number): LngLat[] {
  const out = [pointAt(shape, d0)];
  for (let i = 0; i < shape.cum.length; i++) if (shape.cum[i] > d0 && shape.cum[i] < d1) out.push(shape.coords[i]);
  out.push(pointAt(shape, d1));
  return out;
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

// A bus's track. With a GPS fix it starts where the bus really was at that moment and drops
// stops it has already driven past; otherwise it starts at the last stop SL reports passed.
// A fix too far off the route (detour, bad GPS) is ignored.
export const GPS_MAX_OFF_M = 80;
export function trackFrom(
  last: { time: string; dist_m: number },
  next: { busskoll: string; dist_m: number }[],
  shape: Shape,
  gps?: { lat: number; lon: number; time: string } | null,
): Knot[] {
  const sec = (iso: string) => Date.parse(iso) / 1000;
  const fix = gps ? project(shape, [gps.lon, gps.lat], last.dist_m - 300) : null;
  const start = fix && fix.off <= GPS_MAX_OFF_M ? { t: sec(gps!.time), d: fix.d } : { t: sec(last.time), d: last.dist_m };
  return monotonic([start, ...next.filter((c) => c.dist_m > start.d).map((c) => ({ t: sec(c.busskoll), d: c.dist_m }))]);
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

// Is the bus losing time or catching up? From the change in its delay over its last few
// stops (API field delay_trend_s); under half a minute either way counts as steady.
export type Trend = "worse" | "steady" | "better";
export function trend(changeS: number | null | undefined): Trend | null {
  if (changeS == null) return null;
  return changeS >= 30 ? "worse" : changeS <= -30 ? "better" : "steady";
}
export const TREND_LABEL: Record<Trend, string> = { worse: "Losing time", steady: "Steady", better: "Catching up" };
export const TREND_ARROW: Record<Trend, string> = { worse: "↗", steady: "→", better: "↘" };

export function relTime(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`;
}

// Departure-board countdown, "now" inside 30 s. Only upcoming stops are shown, so a time
// already past means the bus is behind its prediction: still "now", never "gone".
export function dueIn(iso: string, now = Date.now()): string {
  const s = (Date.parse(iso) - now) / 1000;
  if (s <= 30) return "now";
  return `${Math.round(s / 60)} min`;
}

export const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm" });

// ---- lines and search --------------------------------------------------------------
// Line numbers in timetable order: 1, 4, 6, 43X, 117 (numeric where they're numbers).
export const byLine = (a: string, b: string) => a.localeCompare(b, "sv", { numeric: true });

// Case- and accent-insensitive, so "ostra" finds "Östra station".
export const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

export interface Hit {
  kind: "line" | "stop";
  id: string; // line number, or stop name (a stop's platforms share it)
  label: string;
  sub: string;
}

// Search lines (by number or destination) and stops (by name). Lines first; within each,
// exact and prefix matches before matches inside the text.
export function search(lines: { line: string; ends: string[] }[], stops: { name: string; lines: string[] }[], q: string, limit = 8): Hit[] {
  const f = fold(q);
  if (!f) return [];
  const rank = (text: string) => (text === f ? 0 : text.startsWith(f) ? 1 : text.includes(f) ? 2 : -1);
  const scored: { hit: Hit; r: number }[] = [];
  for (const l of lines) {
    const n = fold(l.line) === f ? 0 : fold(l.line).startsWith(f) ? 1 : -1; // "4" shouldn't find "14"
    const e = Math.min(...l.ends.map((x) => rank(fold(x))).filter((r) => r >= 0).map((r) => r + 3), 99);
    const r = n >= 0 ? n : e;
    if (r < 99) scored.push({ hit: { kind: "line", id: l.line, label: `Line ${l.line}`, sub: l.ends.join(" – ") }, r });
  }
  const seen = new Set<string>();
  for (const s of stops) {
    if (seen.has(s.name)) continue;
    const r = rank(fold(s.name));
    if (r < 0) continue;
    seen.add(s.name);
    scored.push({ hit: { kind: "stop", id: s.name, label: s.name, sub: `Lines ${[...new Set(stops.filter((x) => x.name === s.name).flatMap((x) => x.lines))].sort(byLine).join(", ")}` }, r: r + 6 });
  }
  return scored.sort((a, b) => a.r - b.r || byLine(a.hit.id, b.hit.id)).slice(0, limit).map((x) => x.hit);
}
