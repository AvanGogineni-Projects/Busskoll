import { useEffect, useState } from "react";
import { LINES, type Line } from "./api";
import BusMap, { type Selection } from "./components/BusMap";
import DetailPanel from "./components/DetailPanel";
import Scoreboard from "./components/Scoreboard";
import { BUCKET_LABEL, relTime, type Bucket } from "./lib";
import { useReducedMotion, useTheme } from "./theme";
import { useLive, useStop, type Health } from "./useLive";

const STATUS: Record<Health, { label: string; dot: string }> = {
  live: { label: "Live", dot: "bg-ontime" },
  mock: { label: "Backend offline · demo replay", dot: "bg-late" },
  offline: { label: "Data unavailable", dot: "bg-verylate" },
  loading: { label: "Connecting…", dot: "bg-mute" },
};
const BUCKETS: Bucket[] = ["early", "ontime", "late", "verylate"];
const DOT: Record<Bucket, string> = { early: "bg-early", ontime: "bg-ontime", late: "bg-late", verylate: "bg-verylate" };

// Re-render every few seconds so "updated 20 s ago" stays true between polls.
function useNow(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export default function App() {
  const { routes, vehicles, scoreboard, health, lastUpdated, loading, refresh, client } = useLive();
  const { theme, toggle } = useTheme();
  const reduced = useReducedMotion();
  const now = useNow(5000);
  const [lines, setLines] = useState<Set<Line>>(new Set(LINES));
  const [sel, setSel] = useState<Selection>(null);
  const stop = useStop(client, sel?.kind === "stop" ? sel.id : null, lastUpdated);

  const shown = vehicles?.vehicles.filter((v) => lines.has(v.line)) ?? [];
  const vehicle = sel?.kind === "bus" ? vehicles?.vehicles.find((v) => v.vehicle_id === sel.id) : undefined;
  const open = !!vehicle || sel?.kind === "stop";

  // Keep at least one line on: an empty map reads as "no buses running".
  const toggleLine = (l: Line) =>
    setLines((prev) => {
      const next = new Set(prev);
      if (next.has(l) && next.size > 1) next.delete(l);
      else next.add(l);
      return next;
    });

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setSel(null);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);

  return (
    <div className="flex min-h-[100dvh] flex-col lg:h-[100dvh] lg:overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 pb-2 pt-4 sm:px-6">
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="text-2xl font-extrabold uppercase tracking-[-0.03em] text-fg">Busskoll</span>
          <span className="caps hidden truncate text-mute md:inline">SL blue buses · live delay desk</span>
        </div>
        <div className="caps flex items-center gap-3 text-mute">
          <span className="flex items-center gap-1.5" role="status">
            <span className={`h-1.5 w-1.5 rounded-full ${STATUS[health].dot} ${health === "live" && !reduced ? "animate-pulse" : ""}`} />
            <span className="text-fg">{STATUS[health].label}</span>
          </span>
          {lastUpdated && <span className="hidden sm:inline">updated {relTime(lastUpdated, now)}</span>}
          <button
            onClick={toggle}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            className="caps border border-line px-2 py-1 text-fg transition-colors hover:bg-ink-600 hover:on-active"
          >
            {theme === "dark" ? "Light" : "Dark"}
          </button>
        </div>
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2" role="group" aria-label="Filter lines">
            <span className="caps mr-1 text-mute">Lines</span>
            {LINES.map((l) => (
              <button
                key={l}
                onClick={() => toggleLine(l)}
                aria-pressed={lines.has(l)}
                className={`h-8 min-w-10 border border-line px-2 font-mono text-[14px] font-semibold transition-colors ${
                  lines.has(l) ? "bg-ink-600 on-active" : "text-mute hover:text-fg"
                }`}
              >
                {l}
              </button>
            ))}
          </div>
          <ul className="caps flex flex-wrap items-center gap-x-3 gap-y-1 text-mute" aria-label="Delay colours">
            {BUCKETS.map((b) => (
              <li key={b} className="flex items-center gap-1.5">
                <span className={`h-2.5 w-2.5 rounded-full ${DOT[b]}`} aria-hidden="true" />
                {BUCKET_LABEL[b]}
              </li>
            ))}
          </ul>
        </div>
      </header>
      {/* Masthead rule: heavy ink, then a dotted second rule. */}
      <div className="mx-4 border-t-2 border-line sm:mx-6" />
      <div className="rule-dot mx-4 mt-[3px] sm:mx-6" aria-hidden="true" />

      <main className="flex-1 px-4 pb-6 pt-4 sm:px-6 lg:grid lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_400px] lg:gap-6">
        <div className="relative h-[62dvh] min-h-[340px] overflow-hidden border border-line lg:h-auto lg:min-h-0">
          {health === "offline" ? (
            <section className="absolute inset-0 grid place-items-center p-6" role="alert">
              <div className="max-w-md border-l-[3px] border-verylate py-2 pl-5">
                <div className="caps text-verylate">Data unavailable</div>
                <h1 className="mt-2 text-[32px] font-extrabold leading-[0.95] tracking-[-0.035em] text-fg sm:text-[44px]">
                  The live feed isn't responding.
                </h1>
                <p className="mt-4 text-[15px] leading-relaxed text-soft">
                  No buses are shown rather than stale or made-up ones. The page retries every minute on its own.
                </p>
                <button
                  onClick={refresh}
                  disabled={loading}
                  className="caps mt-6 border border-line px-3 py-2 text-fg transition-colors hover:bg-ink-600 hover:on-active disabled:opacity-50"
                >
                  {loading ? "Retrying…" : "Retry now"}
                </button>
              </div>
            </section>
          ) : (
            <>
              <BusMap routes={routes} vehicles={vehicles} lines={lines} selected={sel} onSelect={setSel} reduced={reduced} />
              <div className="caps pointer-events-none absolute left-3 top-3 border border-line bg-ink-800/90 px-2.5 py-1.5 text-fg backdrop-blur-sm">
                {vehicles ? (
                  <>
                    <span className="font-semibold">{shown.length}</span> buses on the road
                  </>
                ) : (
                  "Loading buses…"
                )}
              </div>
            </>
          )}
        </div>

        <aside className="mt-6 flex flex-col gap-6 lg:mt-0 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
          {/* One panel: a bottom sheet over the map on phones, the top of this column on desktop. */}
          {open && (
            <div className="fixed inset-x-0 bottom-0 z-40 max-h-[58dvh] overflow-y-auto border-t-2 border-line bg-ink-900 px-4 pb-4 pt-3 shadow-[0_-12px_32px_rgba(0,0,0,0.25)] lg:static lg:max-h-none lg:overflow-visible lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none">
              <DetailPanel
                vehicle={vehicle}
                stop={sel?.kind === "stop" ? { ...stop, name: routes?.stops.find((s) => s.stop_id === sel.id)?.name } : undefined}
                onClose={() => setSel(null)}
              />
            </div>
          )}
          {scoreboard ? (
            <Scoreboard board={scoreboard} lines={lines} />
          ) : health !== "offline" ? (
            <div className="h-[320px] animate-pulse border border-line bg-fg/[0.03]" />
          ) : null}
          {!open && health !== "offline" && (
            <p className="caps border-l-2 border-line pl-3 leading-relaxed text-mute">
              Tap a bus or a stop for its next arrivals: timetable, SL's prediction and Busskoll's, side by side.
            </p>
          )}
          <footer className="caps mt-auto flex flex-col gap-1 border-t border-line pt-3 text-mute">
            <span>Trafiklab GTFS-RT + KoDa history (CC0) · updates once a minute</span>
            <span>Map © OpenStreetMap contributors · © CARTO</span>
          </footer>
        </aside>
      </main>
    </div>
  );
}
