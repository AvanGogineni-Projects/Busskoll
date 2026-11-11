import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import type { Line, ScoreBlock, Vehicle } from "./api";
import AnimatedNumber from "./components/AnimatedNumber";
import BusMap, { type Selection } from "./components/BusMap";
import DetailPanel, { Badge } from "./components/DetailPanel";
import FleetTable from "./components/FleetTable";
import LinesTable, { type LineRow } from "./components/LinesTable";
import Marey from "./components/Marey";
import Scoreboard from "./components/Scoreboard";
import Search from "./components/Search";
import { BUCKET_LABEL, bucket, byLine, fmtDelay, relTime, type Bucket, type Hit } from "./lib";
import { go, useRoute } from "./route";
import { useReducedMotion, useTheme } from "./theme";
import { useLive, useStopGroup, type Health } from "./useLive";

// A search-first app for the whole network, in three views addressed by the URL hash:
//   home  #/            search, network numbers, every line in a table, the network map, accuracy
//   line  #/line/4      that line's map, buses and departure board, then the Marey deep dive
//   stop  #/stop/Name   one departure board across all of the stop's platforms
// Nothing assumes which lines exist: they all come from /v1/routes.
const BUCKETS: Bucket[] = ["early", "ontime", "late", "verylate"];
const DOT: Record<Bucket, string> = { early: "bg-early", ontime: "bg-ontime", late: "bg-late", verylate: "bg-verylate" };
const REPO = "https://github.com/AvanGogineni-Projects/Busskoll";
const EASE = [0.16, 1, 0.3, 1] as const;

function useNow(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

// The mark is a tiny Marey chart: two buses' lines, one of them Busskoll yellow.
const Mark = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <rect width="24" height="24" rx="5" className="fill-fg" />
    <path d="M5 5 L11 12 L13 19" className="fill-none stroke-bg" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M11 5 L17 13 L19 19" className="fill-none stroke-brand" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// First-load splash: a bus drives a short route, waiting at each stop, until the first
// snapshot is in. Shown only while the very first poll is pending (health "loading").
const Loading = () => (
  <motion.div
    className="fixed inset-0 z-50 grid place-items-center bg-bg px-4"
    role="status"
    aria-live="polite"
    exit={{ opacity: 0 }}
    transition={{ duration: 0.4 }}
  >
    <div className="w-full max-w-xs">
      <div className="flex items-center gap-2.5">
        <Mark />
        <span className="pt-0.5 text-[19px] font-extrabold tracking-[-0.02em] text-fg">Busskoll</span>
      </div>
      <div className="relative mt-8 h-6" aria-hidden="true">
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-accent" />
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={`ld-stop ld-stop-${i}`} style={{ left: `${(i * 100) / 3}%` }} />
        ))}
        <span className="ld-bus" />
      </div>
      <div className="label mt-6 text-soft">Fetching live buses from SL…</div>
      <p className="ld-late mt-2 text-[13px] leading-relaxed text-mute">Waking the server. The first load can take a few seconds.</p>
    </div>
  </motion.div>
);

const Reveal = ({ children, className = "", delay = 0 }: { children: ReactNode; className?: string; delay?: number }) => (
  <motion.div
    className={className}
    initial={{ opacity: 0, y: 14 }}
    whileInView={{ opacity: 1, y: 0 }}
    viewport={{ once: true, margin: "-60px" }}
    transition={{ duration: 0.6, ease: EASE, delay }}
  >
    {children}
  </motion.div>
);

const SectionHead = ({ label, title, children }: { label: string; title: string; children?: ReactNode }) => (
  <Reveal className="max-w-3xl">
    <div className="label flex items-center gap-2 text-mute">
      <span className="h-2 w-2 bg-brand" />
      {label}
    </div>
    <h2 className="mt-3 text-[30px] font-extrabold leading-[1.05] tracking-[-0.02em] text-fg sm:text-[38px]">{title}</h2>
    {children && <p className="mt-3 max-w-2xl text-[16px] leading-relaxed text-soft">{children}</p>}
  </Reveal>
);

// A row of headline figures.
const Stats = ({ items }: { items: { k: string; v: ReactNode; hint?: string; tone?: string }[] }) => (
  <div className="grid grid-cols-2 overflow-hidden rounded-lg border hairline lg:grid-cols-4">
    {items.map((c, i) => (
      <div key={c.k} className={`border-hairline px-5 py-4 ${i % 2 ? "" : "border-r"} ${i < 2 ? "border-b lg:border-b-0" : ""} lg:border-r lg:last:border-r-0 hairline`}>
        <div className="label text-mute">{c.k}</div>
        <div className={`mt-1.5 font-mono text-[28px] font-bold leading-none tracking-tight tabular ${c.tone ?? "text-fg"}`}>{c.v}</div>
        {c.hint && <div className="mt-1.5 text-[12px] text-mute">{c.hint}</div>}
      </div>
    ))}
  </div>
);

const Err = ({ s }: { s?: ScoreBlock }) =>
  s ? (
    <>
      <span className="text-brand">
        <AnimatedNumber value={s.mae_busskoll} />
      </span>
      <span className="mx-1.5 text-mute">/</span>
      <AnimatedNumber value={s.mae_sl} />
      <span className="ml-1 text-[15px] font-semibold text-mute">s</span>
    </>
  ) : (
    "–"
  );

// Figures for a set of buses: on time means within SL's own window (1 min early to 2 min late).
function figures(vs: Vehicle[]) {
  const avg = vs.length ? vs.reduce((s, v) => s + v.delay_s, 0) / vs.length : null;
  const onTime = vs.length ? vs.filter((v) => bucket(v.delay_s) === "ontime").length / vs.length : null;
  const worst = vs.reduce<Vehicle | undefined>((w, v) => (!w || v.delay_s > w.delay_s ? v : w), undefined);
  return { avg, onTime, worst };
}
const pct = (x: number | null) => (x == null ? "–" : `${Math.round(x * 100)}%`);

const Key = () => (
  <ul className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-soft" aria-label="How to read the chart">
    {[
      { l: "Where the bus has been", c: "stroke-fg", w: 2 },
      { l: "Timetable", c: "stroke-fg/30", w: 1 },
      { l: "SL's prediction", c: "stroke-rival", w: 1.5, dash: "3 4" },
      { l: "Busskoll's prediction", c: "stroke-brand", w: 2.5 },
    ].map((k) => (
      <li key={k.l} className="flex items-center gap-2">
        <svg width="26" height="8" aria-hidden="true">
          <line x1="0" y1="4" x2="26" y2="4" className={k.c} strokeWidth={k.w} strokeDasharray={k.dash} />
        </svg>
        {k.l}
      </li>
    ))}
  </ul>
);

const MapKey = () => (
  <ul className="absolute bottom-9 left-3 hidden flex-col gap-1 rounded-md border hairline bg-bg/90 px-3 py-2 backdrop-blur sm:flex" aria-label="Map key">
    {BUCKETS.map((b) => (
      <li key={b} className="flex items-center gap-2 text-[12px] text-soft">
        <span className={`h-2.5 w-2.5 rounded-full ${DOT[b]}`} aria-hidden="true" />
        {BUCKET_LABEL[b]}
      </li>
    ))}
  </ul>
);

const Back = () => (
  <a href="#/" className="label inline-flex items-center gap-2 text-mute hover:text-fg">
    <span aria-hidden="true">←</span> All lines
  </a>
);

const STEPS = [
  {
    t: "Collect",
    b: "SL publishes the position and predicted arrivals of every bus once a minute (GTFS-Realtime, via Trafiklab). Past days come from the KoDa archive.",
  },
  {
    t: "Predict",
    b: "For each bus, Busskoll predicts its arrival at the next five stops. The current version is a baseline that assumes the bus keeps its present delay; a trained model is in development.",
  },
  {
    t: "Score",
    b: "When the bus arrives, Busskoll's and SL's predictions are both compared with the actual time. The averages per line and per number of stops ahead make up the accuracy table.",
  },
];
const STACK = ["GTFS-Realtime", "KoDa archive", "Python", "pandas", "React", "TypeScript", "MapLibre"];

export default function App() {
  const { routes, vehicles, scoreboard, health, lastUpdated, loading, refresh, client } = useLive();
  const { theme, toggle } = useTheme();
  const reduced = useReducedMotion();
  const now = useNow(reduced ? 5000 : 1000); // the deep-dive chart's "now" slides with the clock
  const route = useRoute();
  const [sel, setSel] = useState<Selection>(null);
  const [dir, setDir] = useState(0); // which of the line's two directions the line page shows
  const [hover, setHover] = useState<Line | null>(null);

  const all = useMemo(() => vehicles?.vehicles ?? [], [vehicles]);
  // The network as data: every line with its two end points, in timetable order.
  const lines = useMemo(
    () => (routes?.routes ?? []).map((r) => ({ line: r.line, ends: [...new Set(r.shapes.map((s) => s.headsign))] })).sort((a, b) => byLine(a.line, b.line)),
    [routes]
  );
  const stops = routes?.stops ?? [];
  const allLines = useMemo(() => new Set(lines.map((l) => l.line)), [lines]);
  const rows: LineRow[] = lines.map((l) => {
    const vs = all.filter((v) => v.line === l.line);
    const f = figures(vs);
    const s = scoreboard?.lines[l.line];
    return { line: l.line, ends: l.ends, buses: vs.length, avg: f.avg, onTime: f.onTime, err: s ? { bk: s.mae_busskoll, sl: s.mae_sl } : undefined };
  });
  const net = figures(all);

  const openLine = (line: string) => go({ view: "line", line });
  const openStop = (stopId: string) => {
    const name = stops.find((s) => s.stop_id === stopId)?.name;
    if (name) go({ view: "stop", name });
  };
  const openBus = (id: string) => {
    const v = all.find((x) => x.vehicle_id === id);
    if (!v) return;
    setDir(Math.max(0, (lines.find((l) => l.line === v.line)?.ends ?? []).indexOf(v.headsign)));
    setSel({ kind: "bus", id });
    if (route.view !== "line" || route.line !== v.line) go({ view: "line", line: v.line });
  };
  const onPick = (h: Hit) => go(h.kind === "line" ? { view: "line", line: h.id } : { view: "stop", name: h.id });
  const onMap = (s: Selection) => (s?.kind === "bus" ? openBus(s.id) : s ? openStop(s.id) : setSel(null));

  // A different line or page starts with nothing selected (a bus picked on the way in survives).
  const routeKey = route.view === "line" ? `line:${route.line}` : route.view === "stop" ? `stop:${route.name}` : "home";
  useEffect(() => {
    setSel((s) => (s?.kind === "bus" && route.view === "line" && all.find((v) => v.vehicle_id === s.id)?.line === route.line ? s : null));
  }, [routeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setSel(null);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);

  const demo = health === "mock";
  const status = {
    live: { label: "Live", dot: "bg-brand" },
    mock: { label: `Demo – replay of recorded data, ${lines.length} lines`, dot: "bg-late" },
    offline: { label: "Data unavailable", dot: "bg-verylate" },
    loading: { label: "Connecting", dot: "bg-mute" },
  }[health satisfies Health];

  const offline = (
    <div className="grid h-full place-items-center p-6" role="alert">
      <div className="max-w-sm">
        <div className="label text-verylate">Data unavailable</div>
        <p className="mt-2 text-[22px] font-bold leading-tight text-fg">The live feed isn't responding.</p>
        <p className="mt-3 text-[15px] leading-relaxed text-soft">No buses are shown rather than stale or made-up ones. The page retries every minute.</p>
        <button
          onClick={refresh}
          disabled={loading}
          className="mt-5 rounded-md bg-brand px-4 py-2 text-sm font-bold text-[#111317] transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {loading ? "Retrying…" : "Retry now"}
        </button>
      </div>
    </div>
  );

  // ---- home ------------------------------------------------------------------------
  const home = (
    <>
      <section className="mx-auto max-w-7xl px-4 pb-14 pt-12 lg:px-8 lg:pt-20">
        <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease: EASE }} className="max-w-3xl">
          <div className="label flex items-center gap-2 text-soft">
            <span className={`h-2 w-2 rounded-full ${status.dot}`} />
            {status.label}
          </div>
          <h1 className="mt-4 text-[40px] font-black leading-[0.98] tracking-[-0.03em] text-fg sm:text-[58px]">
            When will your bus <span className="text-brand">really</span> arrive?
          </h1>
          <p className="mt-5 max-w-2xl text-[17px] leading-relaxed text-soft">
            Busskoll follows every SL bus in real time, predicts when it reaches its next stops, and checks each prediction against the actual
            arrival and against SL's own forecast.
          </p>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease: EASE, delay: 0.1 }} className="mt-8 max-w-3xl">
          <Search lines={lines} stops={stops} onPick={onPick} autoFocusKey />
          {rows.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="label mr-1 text-mute">Busiest now</span>
              {[...rows]
                .sort((a, b) => b.buses - a.buses)
                .slice(0, 8)
                .map((r) => (
                  <a key={r.line} href={`#/line/${encodeURIComponent(r.line)}`} className="transition-transform hover:-translate-y-0.5" aria-label={`Line ${r.line}`}>
                    <Badge line={r.line} />
                  </a>
                ))}
            </div>
          )}
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease: EASE, delay: 0.2 }} className="mt-12">
          <Stats
            items={[
              { k: "Buses on the road", v: vehicles ? <AnimatedNumber value={all.length} /> : "–", hint: `on ${lines.length} lines` },
              { k: "On time", v: pct(net.onTime), hint: "1 min early to 2 min late" },
              { k: "Average delay", v: net.avg == null ? "–" : fmtDelay(net.avg), hint: "against the timetable", tone: net.avg != null && net.avg >= 120 ? "text-late" : undefined },
              { k: "Prediction error", v: <Err s={scoreboard?.overall} />, hint: scoreboard ? `Busskoll / SL, ${scoreboard.window_days} days, lower is better` : undefined },
            ]}
          />
        </motion.div>
      </section>

      <main className="mx-auto max-w-7xl px-4 lg:px-8">
        <section id="lines" className="pt-8 lg:pt-12">
          <SectionHead label="Lines" title="Every line, right now">
            Live figures for each line. Sort by any column, or open a line for its map, buses and arrival predictions.
          </SectionHead>
          <Reveal className="mt-8">{health === "offline" ? <p className="text-sm text-mute">No live data right now.</p> : <LinesTable rows={rows} onOpen={openLine} />}</Reveal>
        </section>

        <section id="map" className="pt-20 lg:pt-28">
          <SectionHead label="Map" title="The network map">
            Every bus, coloured by its delay. Hover a route to pick it out; click a bus to open its line, or a stop for its departures.
          </SectionHead>
          <Reveal className="relative mt-8 h-[68vh] min-h-[420px] overflow-hidden rounded-lg border hairline">
            {health === "offline" ? (
              offline
            ) : (
              <>
                <BusMap key="network" routes={routes} vehicles={vehicles} lines={allLines} selected={null} onSelect={onMap} hover={hover} onHover={setHover} reduced={reduced} />
                <MapKey />
              </>
            )}
          </Reveal>
        </section>

        <section id="accuracy" className="pt-20 lg:pt-28">
          <SectionHead label="Accuracy" title="Busskoll compared with SL">
            Mean absolute error in seconds between predicted and actual arrival, over the last {scoreboard?.window_days ?? 13} days of recorded SL data, by
            how many stops ahead the prediction was made. Each line's own numbers are on its page. Lower is better.
          </SectionHead>
          <Reveal className="mt-8 rounded-lg border hairline bg-panel p-5 sm:p-8">
            {scoreboard ? <Scoreboard board={scoreboard} /> : <p className="text-sm text-mute">{health === "offline" ? "No scores while the feed is down." : "Loading scores…"}</p>}
          </Reveal>
        </section>

        <section id="method" className="pb-24 pt-20 lg:pt-28">
          <SectionHead label="Method" title="How it works">
            Open data in; one number out: how close each prediction came to the actual arrival.
          </SectionHead>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <Reveal key={s.t} delay={i * 0.08} className="rounded-lg border hairline bg-panel p-6">
                <div className="font-mono text-[13px] font-bold text-brand">0{i + 1}</div>
                <h3 className="mt-4 text-[22px] font-extrabold tracking-tight text-fg">{s.t}</h3>
                <p className="mt-2 text-[15px] leading-relaxed text-soft">{s.b}</p>
              </Reveal>
            ))}
          </div>
          <p className="mt-8 text-[13px] text-mute">Built with {STACK.join(", ")}</p>
        </section>
      </main>
    </>
  );

  // ---- line ------------------------------------------------------------------------
  const lineView = (line: string) => {
    const meta = lines.find((l) => l.line === line);
    if (routes && !meta) {
      return (
        <section className="mx-auto max-w-7xl px-4 py-16 lg:px-8">
          <Back />
          <h1 className="mt-6 text-[40px] font-black tracking-tight text-fg">Line {line}</h1>
          <p className="mt-3 text-[17px] text-soft">This line isn't covered yet{demo ? ": the demo replays lines " + lines.map((l) => l.line).join(", ") : ""}.</p>
        </section>
      );
    }
    const ends = meta?.ends ?? [];
    const towards = ends[dir] ?? ends[0] ?? "";
    const vs = all.filter((v) => v.line === line);
    const f = figures(vs);
    const vehicle = sel?.kind === "bus" ? vs.find((v) => v.vehicle_id === sel.id) : undefined;
    const toggleDir = (
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Direction">
        <span className="label text-mute">Towards</span>
        {ends.map((hs, i) => (
          <button
            key={hs}
            onClick={() => setDir(i)}
            aria-pressed={dir === i}
            className={`max-w-[14rem] truncate rounded-md border px-3 pb-1 pt-1.5 text-[13px] font-semibold transition-colors ${
              dir === i ? "border-fg bg-fg text-bg" : "hairline text-soft hover:text-fg"
            }`}
          >
            {hs}
          </button>
        ))}
      </div>
    );
    return (
      <>
        <section className="mx-auto max-w-7xl px-4 pt-8 lg:px-8 lg:pt-10">
          <Back />
          <div className="mt-6 flex flex-wrap items-end justify-between gap-6">
            <div className="flex items-center gap-5">
              <span className="grid h-[72px] min-w-[72px] place-items-center rounded-lg bg-accent px-3 pt-1.5 text-[44px] font-black leading-none text-white">{line}</span>
              <div>
                <h1 className="text-[34px] font-black leading-none tracking-[-0.02em] text-fg sm:text-[42px]">Line {line}</h1>
                <p className="mt-2 text-[16px] text-soft">{ends.join(" – ")}</p>
              </div>
            </div>
            {toggleDir}
          </div>
          <div className="mt-8">
            <Stats
              items={[
                { k: "Buses now", v: vehicles ? <AnimatedNumber value={vs.length} /> : "–", hint: "both directions" },
                { k: "On time", v: pct(f.onTime), hint: "1 min early to 2 min late" },
                { k: "Average delay", v: f.avg == null ? "–" : fmtDelay(f.avg), tone: f.avg != null && f.avg >= 120 ? "text-late" : undefined },
                { k: "Prediction error", v: <Err s={scoreboard?.lines[line]} />, hint: scoreboard?.lines[line] ? "Busskoll / SL, lower is better" : "not scored yet" },
              ]}
            />
          </div>
        </section>

        <main className="mx-auto max-w-7xl px-4 lg:px-8">
          <section className="pt-8">
            <div className="flex flex-col overflow-hidden rounded-lg border hairline lg:h-[70vh] lg:min-h-[540px] lg:flex-row">
              <div className="relative h-[55vh] min-h-[340px] lg:h-auto lg:flex-1">
                {health === "offline" ? (
                  offline
                ) : (
                  <>
                    <BusMap
                      key={`line-${line}`}
                      routes={routes}
                      vehicles={vehicles}
                      lines={new Set([line])}
                      selected={sel}
                      onSelect={onMap}
                      hover={null}
                      onHover={() => {}}
                      reduced={reduced}
                    />
                    <MapKey />
                  </>
                )}
              </div>
              <div className="max-h-[520px] shrink-0 overflow-y-auto border-t hairline lg:max-h-none lg:w-[420px] lg:border-l lg:border-t-0">
                {vehicle ? (
                  <div className="rise p-4">
                    <DetailPanel vehicle={vehicle} onClose={() => setSel(null)} />
                  </div>
                ) : (
                  <>
                    <div className="label border-b hairline px-4 py-2.5 text-mute">
                      Buses towards {towards} · most delayed first
                    </div>
                    <FleetTable vehicles={vs.filter((v) => v.headsign === towards)} selected={undefined} onSelect={(id) => setSel({ kind: "bus", id })} />
                  </>
                )}
              </div>
            </div>
          </section>

          <section className="pt-20 lg:pt-24">
            <SectionHead label="Deep dive" title={`Line ${line} over time`}>
              Each line in this chart is one bus travelling down the list of stops as time passes. The flatter the line, the slower the bus; the gap to its
              faint timetable line is how late it is. Right of <span className="font-bold text-brand">now</span>, SL and Busskoll each predict the rest
              of the trip.
            </SectionHead>
            <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
              <Key />
              {toggleDir}
            </div>
            <div className="mt-4 h-[64vh] min-h-[440px] rounded-lg border hairline px-2 py-3 lg:px-4">
              {health === "offline" ? (
                offline
              ) : routes && vehicles ? (
                <Marey line={line} headsign={towards} routes={routes} vehicles={all} now={now} selected={vehicle?.vehicle_id} onSelect={(id) => setSel({ kind: "bus", id })} />
              ) : (
                <div className="h-full animate-pulse bg-fg/[0.03]" />
              )}
            </div>
          </section>

          <section className="pb-24 pt-20 lg:pt-24">
            <SectionHead label="Accuracy" title={`How well line ${line} is predicted`}>
              Mean absolute error in seconds, by how many stops ahead the prediction was made. Lower is better.
            </SectionHead>
            <Reveal className="mt-8 rounded-lg border hairline bg-panel p-5 sm:p-8">
              {scoreboard ? <Scoreboard board={scoreboard} line={line} /> : <p className="text-sm text-mute">Loading scores…</p>}
            </Reveal>
          </section>
        </main>
      </>
    );
  };

  // ---- stop ------------------------------------------------------------------------
  const stopIds = route.view === "stop" ? stops.filter((s) => s.name === route.name).map((s) => s.stop_id) : [];
  const group = useStopGroup(client, stopIds, lastUpdated);
  const stopView = (name: string) => {
    const servedBy = [...new Set(stops.filter((s) => s.name === name).flatMap((s) => s.lines))].sort(byLine);
    return (
      <>
        <section className="mx-auto max-w-7xl px-4 pt-8 lg:px-8 lg:pt-10">
          <Back />
          <div className="mt-6">
            <div className="label text-mute">Stop · all platforms</div>
            <h1 className="mt-2 text-[36px] font-black leading-none tracking-[-0.02em] text-fg sm:text-[46px]">{name}</h1>
            {servedBy.length > 0 && (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <span className="label mr-1 text-mute">Lines</span>
                {servedBy.map((l) => (
                  <a key={l} href={`#/line/${encodeURIComponent(l)}`} className="transition-transform hover:-translate-y-0.5" aria-label={`Line ${l}`}>
                    <Badge line={l} />
                  </a>
                ))}
              </div>
            )}
          </div>
        </section>
        <main className="mx-auto max-w-7xl px-4 pb-24 pt-8 lg:px-8">
          {routes && !stopIds.length ? (
            <p className="text-[17px] text-soft">No stop called "{name}" on the lines covered{demo ? " in the demo" : ""}.</p>
          ) : (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
              <DetailPanel stop={{ ...group, name }} onClose={() => history.back()} />
              <div className="relative h-[60vh] min-h-[380px] overflow-hidden rounded-lg border hairline">
                {health !== "offline" && stopIds.length > 0 && (
                  <BusMap
                    key={`stop-${name}`}
                    routes={routes}
                    vehicles={vehicles}
                    lines={new Set(servedBy)}
                    selected={{ kind: "stop", id: stopIds[0] }}
                    onSelect={onMap}
                    hover={null}
                    onHover={() => {}}
                    reduced={reduced}
                  />
                )}
              </div>
            </div>
          )}
        </main>
      </>
    );
  };

  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence>{health === "loading" && <Loading key="loading" />}</AnimatePresence>
      <div className="min-h-[100dvh] bg-bg">
        <header className="sticky top-0 z-30 border-b hairline bg-bg/90 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-7xl items-center gap-5 px-4 lg:px-8">
            <a href="#/" className="flex shrink-0 items-center gap-2.5">
              <Mark />
              <span className="pt-0.5 text-[19px] font-extrabold tracking-[-0.02em] text-fg">Busskoll</span>
            </a>
            {route.view !== "home" ? (
              <div className="hidden w-full max-w-sm md:block">
                <Search lines={lines} stops={stops} onPick={onPick} size="sm" />
              </div>
            ) : (
              <nav className="hidden items-center gap-6 pt-0.5 text-[14px] font-semibold text-soft md:flex" aria-label="Sections">
                {[
                  ["lines", "Lines"],
                  ["map", "Map"],
                  ["accuracy", "Accuracy"],
                  ["method", "Method"],
                ].map(([id, label]) => (
                  <button key={id} onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: reduced ? "auto" : "smooth" })} className="hover:text-fg">
                    {label}
                  </button>
                ))}
              </nav>
            )}
            <div className="ml-auto flex shrink-0 items-center gap-4">
              <span className="hidden items-center gap-2 text-[13px] lg:flex" role="status">
                <span className={`h-2 w-2 shrink-0 rounded-full ${status.dot} ${health === "live" && !reduced ? "animate-pulse" : ""}`} />
                <span className="pt-0.5 text-soft">{demo ? "Demo" : status.label}</span>
                {lastUpdated && <span className="pt-0.5 text-mute">– updated {relTime(lastUpdated, now)}</span>}
              </span>
              <button
                onClick={toggle}
                aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                className="grid h-8 w-8 place-items-center rounded-md border hairline text-soft transition-colors hover:bg-fg/[0.06] hover:text-fg"
              >
                {theme === "dark" ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.5" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" /></svg>
                )}
              </button>
            </div>
          </div>
        </header>

        {route.view === "line" ? lineView(route.line) : route.view === "stop" ? stopView(route.name) : home}

        <footer className="border-t hairline">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-6 text-[13px] text-mute lg:px-8">
            <span className="flex items-center gap-2.5">
              <Mark size={18} />
              <span className="pt-0.5">
                <span className="font-bold text-fg">Busskoll</span> – built by Avan Gogineni
              </span>
            </span>
            <span className="flex flex-wrap items-center gap-x-5 gap-y-1 pt-0.5">
              <a href={REPO} className="font-semibold text-fg hover:text-brand">
                Source on GitHub
              </a>
              <span>Data: Trafiklab GTFS-RT and KoDa (CC0). Map © OpenStreetMap, © CARTO</span>
            </span>
          </div>
        </footer>
      </div>
    </MotionConfig>
  );
}
