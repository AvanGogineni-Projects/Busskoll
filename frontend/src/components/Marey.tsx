import { useEffect, useMemo, useRef, useState } from "react";
import type { Line, Routes, Vehicle } from "../api";
import { bucket, buildShape, clock, dueIn, fmtDelay, project } from "../lib";

// A live Marey chart (time-distance diagram) for one line in one direction: stops top to
// bottom in the order the bus reaches them, time left to right, each bus one line sloping
// down as it travels. Solid = where it has been; the faint line under it is its timetable, so
// lateness is the horizontal gap between the two. From "now" on, SL's prediction (dashed) and
// Busskoll's (yellow) run ahead. One bus is picked out with labels so a first-time reader can
// follow a single example before taking in the rest.
interface Props {
  line: Line;
  headsign: string; // the direction shown: buses heading here
  routes: Routes;
  vehicles: Vehicle[];
  now: number;
  selected?: string;
  onSelect: (id: string) => void;
}

const PAST_MIN = 40;
const AHEAD_MIN = 20;
const GAP_MIN = 10;

// The line's stops as 0..1 positions along its first shape (both directions' stops project
// onto the same street). `flip` turns the axis over so the chosen direction runs downward.
function axisFor(routes: Routes, line: Line, headsign: string) {
  const r = routes.routes.find((x) => x.line === line);
  if (!r?.shapes.length) return null;
  const shape = buildShape(r.shapes[0].coords);
  const len = shape.cum[shape.cum.length - 1] || 1;
  const flip = r.shapes[0].headsign !== headsign;
  const pos = new Map<string, number>();
  const byName = new Map<string, number[]>();
  for (const s of routes.stops) {
    if (!s.lines.includes(line)) continue;
    const { d, off } = project(shape, [s.lon, s.lat]);
    if (off > 150) continue; // a stop of this line on a branch or detour off the drawn shape
    const y = flip ? 1 - d / len : d / len;
    pos.set(s.stop_id, y);
    byName.set(s.name, [...(byName.get(s.name) ?? []), y]);
  }
  const labels = [...byName].map(([name, ys]) => ({ name, y: ys.reduce((a, b) => a + b, 0) / ys.length })).sort((a, b) => a.y - b.y);
  return { pos, labels };
}

const ms = (iso: string) => Date.parse(iso);
type Pt = readonly [number, number];

export default function Marey({ line, headsign, routes, vehicles, now, selected, onSelect }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<string | null>(null);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(box.current!);
    return () => ro.disconnect();
  }, []);

  const axis = useMemo(() => axisFor(routes, line, headsign), [routes, line, headsign]);
  const { w, h } = size;
  const narrow = w < 640;
  const ml = narrow ? 92 : 170, mr = narrow ? 12 : 130, mt = 34, mb = 14;
  const past = (narrow ? 25 : PAST_MIN) * 60_000;
  const ahead = (narrow ? 12 : AHEAD_MIN) * 60_000;
  const t0 = now - past, t1 = now + ahead;
  const X = (t: number) => ml + ((t - t0) / (t1 - t0)) * (w - ml - mr);
  const Y = (y: number) => mt + y * (h - mt - mb);

  const trips = useMemo(() => {
    if (!axis) return [];
    return vehicles
      .filter((v) => v.line === line && v.headsign === headsign)
      .map((v) => {
        const at = (id: string) => axis.pos.get(id);
        const pt = (t: number, y: number | undefined): Pt | null => (y == null ? null : [X(t), Y(y)]);
        // Where the bus is now: between its last stop and the next, by Busskoll's predicted timing.
        const yl = at(v.last_stop.stop_id);
        const nx = v.next_stops[0];
        const yn = nx ? at(nx.stop_id) : undefined;
        const tl = ms(v.last_stop.time);
        const tn = nx ? ms(nx.busskoll) : tl;
        const k = tn > tl ? Math.min(1, Math.max(0, (now - tl) / (tn - tl))) : 1;
        const yNow = yl == null ? undefined : yn == null ? yl : yl + (yn - yl) * k;
        const head = pt(now, yNow);
        const later = (iso: string) => Math.max(ms(iso), now);
        const lp = v.passed[v.passed.length - 1];
        return {
          v,
          head,
          // The latest passed stop: where the gap between timetable and reality is labelled.
          gap: lp && at(lp.stop_id) != null ? { y: Y(at(lp.stop_id)!), xs: X(ms(lp.scheduled)), xa: X(ms(lp.actual)) } : null,
          timetable: [...v.passed.map((p) => pt(ms(p.scheduled), at(p.stop_id))), ...v.next_stops.map((c) => pt(ms(c.scheduled), at(c.stop_id)))],
          actual: [...v.passed.map((p) => pt(ms(p.actual), at(p.stop_id))), head],
          sl: [head, ...v.next_stops.map((c) => pt(later(c.sl), at(c.stop_id)))],
          bk: [head, ...v.next_stops.map((c) => pt(later(c.busskoll), at(c.stop_id)))],
        };
      });
  }, [axis, vehicles, line, headsign, now, w, h]); // eslint-disable-line react-hooks/exhaustive-deps

  // A gap of more than GAP_MIN between two points is missing data (a stop with no recorded
  // arrival, a layover), not a bus crawling: lift the pen instead of drawing a long straight line.
  const gapPx = ((GAP_MIN * 60_000) / (t1 - t0)) * (w - ml - mr);
  const d = (pts: (Pt | null)[]) => {
    const ok = pts.filter((p): p is Pt => !!p);
    return ok.map(([x, y], i) => `${i && x - ok[i - 1][0] <= gapPx ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");
  };
  const last = (pts: (Pt | null)[]) => pts.filter((p): p is Pt => !!p).pop();

  const ticks: number[] = [];
  for (let t = Math.ceil(t0 / 600_000) * 600_000; t < t1; t += 600_000) ticks.push(t);
  let lastY = -Infinity;
  const labels = (axis?.labels ?? []).filter((l) => {
    const y = Y(l.y);
    if (y - lastY < 13) return false;
    lastY = y;
    return true;
  });

  // The example bus: whatever the reader points at, else the most delayed bus mid-route.
  const story = useMemo(() => {
    // Prefer a bus with a long line behind it, so the example shows a real stretch of trip.
    const mid = trips.filter((t) => t.head && t.gap && t.v.passed.length >= 5 && t.v.next_stops.length >= 2);
    return mid.reduce<(typeof trips)[number] | undefined>((a, t) => (!a || t.v.delay_s > a.v.delay_s ? t : a), undefined)?.v.vehicle_id ?? null;
  }, [trips]);
  const focus = hover ?? selected ?? story;
  const pointing = !!(hover ?? selected);
  const f = trips.find((t) => t.v.vehicle_id === focus);
  const maxLabel = narrow ? 13 : 22;
  const halo = { paintOrder: "stroke" as const, stroke: "rgb(var(--bg))", strokeWidth: 4, strokeLinejoin: "round" as const };

  return (
    <div ref={box} className="relative h-full w-full select-none">
      {w > 0 && axis && (
        <svg width={w} height={h} className="block" role="img" aria-label={`Time-distance chart of line ${line} towards ${headsign}: ${trips.length} buses`}>
          <defs>
            <clipPath id={`plot-${line}`}>
              <rect x={ml} y={0} width={w - ml - mr} height={h} />
            </clipPath>
          </defs>
          <rect x={X(now)} y={mt} width={w - mr - X(now)} height={h - mt - mb} className="fill-fg/[0.035]" />
          {axis.labels.map((l) => (
            <line key={l.name} x1={ml} x2={w - mr} y1={Y(l.y)} y2={Y(l.y)} className="stroke-fg/[0.06]" />
          ))}
          {labels.map((l) => (
            <text key={l.name} x={ml - 10} y={Y(l.y)} dy="0.32em" textAnchor="end" className="fill-mute text-[11px]">
              {l.name.length > maxLabel ? l.name.slice(0, maxLabel - 1) + "…" : l.name}
            </text>
          ))}
          {/* Axis titles */}
          <text x={ml - 10} y={mt - 14} textAnchor="end" className="fill-soft font-mono text-[10px] font-bold uppercase tracking-wider">
            Stops ↓
          </text>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={X(t)} x2={X(t)} y1={mt - 6} y2={h - mb} className="stroke-fg/[0.09]" />
              {Math.abs(X(t) - X(now)) > 40 && (
                <text x={X(t)} y={mt - 14} textAnchor="middle" className="fill-mute font-mono text-[11px]">
                  {clock(new Date(t).toISOString())}
                </text>
              )}
            </g>
          ))}

          <g clipPath={`url(#plot-${line})`}>
            {trips.map((t, i) => {
              const on = focus === t.v.vehicle_id;
              return (
                <g key={t.v.vehicle_id} className="transition-opacity duration-300" opacity={on ? 1 : pointing ? 0.15 : 0.4} style={{ ["--i" as string]: i }}>
                  <path d={d(t.timetable)} pathLength={1} className={`marey-draw fill-none ${on ? "stroke-fg/50" : "stroke-fg/30"}`} strokeWidth={on ? 1.5 : 1} />
                  <path d={d(t.actual)} pathLength={1} className="marey-draw fill-none stroke-fg" strokeWidth={on ? 3 : 1.75} strokeLinejoin="round" strokeLinecap="round" />
                  <path d={d(t.sl)} className="marey-fade fill-none stroke-rival" strokeWidth={on ? 2 : 1.25} strokeDasharray="3 4" />
                  <path d={d(t.bk)} className="marey-fade fill-none stroke-brand" strokeWidth={on ? 3 : 2} strokeLinecap="round" />
                  <path
                    d={d([...t.actual, ...t.bk.slice(1)])}
                    className="cursor-pointer fill-none stroke-transparent"
                    strokeWidth={14}
                    onMouseEnter={() => setHover(t.v.vehicle_id)}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => onSelect(t.v.vehicle_id)}
                  />
                </g>
              );
            })}
          </g>

          <line x1={X(now)} x2={X(now)} y1={mt - 6} y2={h - mb} className="stroke-brand" strokeWidth={1.5} />
          <rect x={X(now) - 26} y={mt - 27} width={52} height={17} className="fill-brand" />
          <text x={X(now)} y={mt - 15} textAnchor="middle" className="fill-[#111317] font-mono text-[11px] font-bold">
            NOW
          </text>

          {trips.map(
            (t) =>
              t.head && (
                <circle
                  key={t.v.vehicle_id}
                  cx={t.head[0]}
                  cy={t.head[1]}
                  r={focus === t.v.vehicle_id ? 6 : 4.5}
                  className={`cursor-pointer stroke-bg delay-${bucket(t.v.delay_s)}`}
                  strokeWidth={2}
                  opacity={focus === t.v.vehicle_id ? 1 : pointing ? 0.2 : 0.5}
                  onMouseEnter={() => setHover(t.v.vehicle_id)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => onSelect(t.v.vehicle_id)}
                />
              )
          )}

          {/* The example bus, explained in place */}
          {f?.head && (
            <g className="pointer-events-none marey-fade" style={{ ["--i" as string]: 8 }}>
              {f.gap && f.gap.xa - f.gap.xs > 8 && (
                <g>
                  <line x1={f.gap.xs} x2={f.gap.xa} y1={f.gap.y - 9} y2={f.gap.y - 9} className="stroke-late" strokeWidth={1.5} />
                  <line x1={f.gap.xs} x2={f.gap.xs} y1={f.gap.y - 13} y2={f.gap.y - 5} className="stroke-late" strokeWidth={1.5} />
                  <line x1={f.gap.xa} x2={f.gap.xa} y1={f.gap.y - 13} y2={f.gap.y - 5} className="stroke-late" strokeWidth={1.5} />
                  <text x={(f.gap.xs + f.gap.xa) / 2} y={f.gap.y - 16} textAnchor="middle" className="fill-late text-[12px] font-bold" style={halo}>
                    {fmtDelay(f.v.delay_s)} behind timetable
                  </text>
                </g>
              )}
              <text x={f.head[0] - 10} y={f.head[1] + 4} textAnchor="end" className="fill-fg text-[12px] font-bold" style={halo}>
                <tspan x={f.head[0] - 10} dy="1.1em">
                  Bus {f.v.line} is here now
                </tspan>
                {f.v.next_stops[0] && (
                  <tspan x={f.head[0] - 10} dy="1.2em" className="fill-soft font-normal">
                    {dueIn(f.v.next_stops[0].busskoll, now) === "now"
                      ? `at ${f.v.next_stops[0].name} now`
                      : `${f.v.next_stops[0].name} in ${dueIn(f.v.next_stops[0].busskoll, now)}`}
                  </tspan>
                )}
              </text>
              {!narrow &&
                (() => {
                  const b = last(f.bk), s = last(f.sl), end = f.v.next_stops[f.v.next_stops.length - 1];
                  if (!b || !s || !end) return null;
                  const [hi, lo] = b[1] <= s[1] ? [b, s] : [s, b];
                  const gapY = Math.max(lo[1], hi[1] + 16);
                  return (
                    <>
                      <text x={b[0] + 8} y={b === hi ? hi[1] : gapY} dy="0.32em" className="fill-brand text-[12px] font-bold" style={halo}>
                        Busskoll: {clock(end.busskoll)}
                      </text>
                      <text x={s[0] + 8} y={s === hi ? hi[1] : gapY} dy="0.32em" className="fill-rival text-[12px] font-semibold" style={halo}>
                        SL: {clock(end.sl)}
                      </text>
                    </>
                  );
                })()}
            </g>
          )}
        </svg>
      )}
    </div>
  );
}
