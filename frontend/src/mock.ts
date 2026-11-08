// Dev-only stand-in for the API: replays one real hour of KoDa history (fixture.json,
// made by scripts/export_fixture.py) on a loop, shifted so it reads as "now".
// Only imported behind `import.meta.env.DEV`, so it never ships in a production build.
//
// There is no model yet, so the "busskoll" prediction here is the persistence baseline
// (the delay at the last stop passed, carried forward) and the scoreboard's Busskoll
// column is that baseline's real backtest. SL's numbers are SL's real predictions.
import type { Arrival, Client, Line, Routes, Scoreboard, ScoreBlock, StopCall, Vehicle } from "./api";
import RAW from "./fixture.json";

interface Fixture {
  window: [number, number];
  routes: Routes["routes"];
  stops: { stop_id: string; name: string; lat: number; lon: number; lines: Line[] }[];
  trips: {
    trip_id: string;
    line: Line;
    vehicle_id: string;
    headsign: string;
    shape_id: string;
    stops: { seq: number; stop_id: string; dist_m: number; scheduled: number; actual: number | null }[];
    sl: [number, number, number][]; // [snapshot ts, stop seq, predicted delay s]
  }[];
  scoreboard: { window_days: number; overall: ScoreBlock; lines: Partial<Record<Line, ScoreBlock>> };
}
const FX = RAW as unknown as Fixture;
const NAME = new Map(FX.stops.map((s) => [s.stop_id, s.name]));
const [W0, W1] = FX.window;

// Wall clock -> the fixture second it replays, and the shift that maps fixture times back.
function clockNow() {
  const now = Date.now() / 1000;
  const t = W0 + ((((now - W0) % (W1 - W0)) + (W1 - W0)) % (W1 - W0));
  return { t, shift: now - t };
}
const iso = (s: number, shift: number) => new Date((s + shift) * 1000).toISOString();

function vehiclesAt(t: number, shift: number, ahead = 5): Vehicle[] {
  const out: Vehicle[] = [];
  for (const trip of FX.trips) {
    // Passed = arrived by t. A stop with no recorded arrival counts as passed once a later one is.
    let last = -1;
    trip.stops.forEach((s, i) => s.actual != null && s.actual <= t && (last = i));
    if (last < 0 || last === trip.stops.length - 1) continue; // not started, or finished
    const passed = trip.stops[last];
    const delay = passed.actual! - passed.scheduled;
    // SL's latest prediction (as of t) per stop.
    const sl = new Map<number, number>();
    for (const [ts, seq, d] of trip.sl) if (ts <= t) sl.set(seq, d);
    // KoDa was thinned to SL's next 6 stops per snapshot; beyond those, carry SL's last
    // predicted delay forward (as SL's own feed does) rather than fall back to on time.
    let slDelay = delay;
    const next: StopCall[] = trip.stops.slice(last + 1, last + 1 + ahead).map((s) => {
      slDelay = sl.get(s.seq) ?? slDelay;
      return {
        stop_id: s.stop_id,
        name: NAME.get(s.stop_id) ?? s.stop_id,
        dist_m: s.dist_m,
        scheduled: iso(s.scheduled, shift),
        sl: iso(s.scheduled + slDelay, shift),
        busskoll: iso(s.scheduled + delay, shift),
      };
    });
    out.push({
      vehicle_id: trip.vehicle_id,
      trip_id: trip.trip_id,
      line: trip.line,
      headsign: trip.headsign,
      shape_id: trip.shape_id,
      delay_s: delay,
      last_stop: { stop_id: passed.stop_id, name: NAME.get(passed.stop_id) ?? "", dist_m: passed.dist_m, time: iso(passed.actual!, shift) },
      next_stops: next,
    });
  }
  return out;
}

const later = <T,>(v: T) => new Promise<T>((ok) => setTimeout(() => ok(v), 120)); // feel like a network

export const mock: Client = {
  vehicles: async () => {
    const { t, shift } = clockNow();
    return later({ as_of: iso(t, shift), vehicles: vehiclesAt(t, shift) });
  },
  routes: async () => later({ routes: FX.routes, stops: FX.stops.map(({ stop_id, name, lat, lon, lines }) => ({ stop_id, name, lat, lon, lines })) }),
  scoreboard: async () => later<Scoreboard>({ as_of: new Date().toISOString(), ...FX.scoreboard }),
  stop: async (id) => {
    const stop = FX.stops.find((s) => s.stop_id === id);
    if (!stop) throw new Error(`/v1/stops/${id}: HTTP 404`);
    const { t, shift } = clockNow();
    const arrivals: Arrival[] = vehiclesAt(t, shift).flatMap((v) =>
      v.next_stops
        .filter((c) => c.stop_id === id)
        .map(({ scheduled, sl, busskoll }) => ({ vehicle_id: v.vehicle_id, trip_id: v.trip_id, line: v.line, headsign: v.headsign, scheduled, sl, busskoll }))
    );
    arrivals.sort((a, b) => a.busskoll.localeCompare(b.busskoll));
    return later({ as_of: iso(t, shift), stop, arrivals });
  },
};
