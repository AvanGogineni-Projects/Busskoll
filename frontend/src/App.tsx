import { useEffect, useRef, useState, type ReactNode } from "react";
import { LINES, type Line } from "./api";
import AnimatedNumber from "./components/AnimatedNumber";
import BusMap, { type Selection } from "./components/BusMap";
import DetailPanel from "./components/DetailPanel";
import FleetTable from "./components/FleetTable";
import Scoreboard from "./components/Scoreboard";
import { BUCKET_LABEL, relTime, type Bucket } from "./lib";
import { useReducedMotion, useTheme } from "./theme";
import { useLive, useStop, type Health } from "./useLive";

const STATUS: Record<Health, { label: string; dot: string }> = {
  live: { label: "Live", dot: "bg-ontime" },
  mock: { label: "Demo replay · API offline", dot: "bg-led" },
  offline: { label: "Data unavailable", dot: "bg-verylate" },
  loading: { label: "Connecting", dot: "bg-mute" },
};
const BUCKETS: Bucket[] = ["early", "ontime", "late", "verylate"];
const DOT: Record<Bucket, string> = { early: "bg-early", ontime: "bg-ontime", late: "bg-late", verylate: "bg-verylate" };
type Tab = "fleet" | "board" | "record";

// Re-render every few seconds so "updated 20 s ago" and the due-in countdowns stay true.
function useNow(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

const Logo = () => (
  <svg width="20" height="20" viewBox="0 0 22 22" aria-hidden="true">
    <circle cx="11" cy="11" r="9" fill="none" stroke="rgb(var(--accent))" strokeWidth="2.5" />
    <circle cx="11" cy="11" r="3.5" fill="rgb(var(--led))" />
  </svg>
);

// One figure in the KPI strip.
const Kpi = ({ label, children, hint, tone = "text-fg" }: { label: string; children: ReactNode; hint?: ReactNode; tone?: string }) => (
  <div className="min-w-0 border-b border-r hairline px-4 py-3 sm:border-b-0">
    <div className="label truncate text-mute">{label}</div>
    <div className={`mt-1 font-mono text-[24px] font-semibold leading-none tracking-tight tabular ${tone}`}>{children}</div>
    {hint && <div className="mt-1 truncate text-[12px] text-mute">{hint}</div>}
  </div>
);

export default function App() {
  const { routes, vehicles, scoreboard, health, lastUpdated, loading, refresh, client } = useLive();
  const { theme, toggle } = useTheme();
  const reduced = useReducedMotion();
  const now = useNow(5000);
  const [lines, setLines] = useState<Set<Line>>(new Set(LINES));
  const [sel, setSel] = useState<Selection>(null);
  const [tab, setTab] = useState<Tab>("fleet");
  const inspector = useRef<HTMLElement>(null);
  const stop = useStop(client, sel?.kind === "stop" ? sel.id : null, lastUpdated);

  const shown = vehicles?.vehicles.filter((v) => lines.has(v.line)) ?? [];
  const late = shown.filter((v) => v.delay_s >= 120).length;
  const vehicle = sel?.kind === "bus" ? vehicles?.vehicles.find((v) => v.vehicle_id === sel.id) : undefined;
  const open = !!vehicle || sel?.kind === "stop";
  const all = scoreboard?.overall;

  // Picking a bus or stop opens its departure board; clearing it goes back to the fleet.
  const pick = (s: Selection) => {
    setSel(s);
    setTab((t) => (s ? "board" : t === "board" ? "fleet" : t));
    // Phones stack the inspector under the map: bring the board into view.
    if (s && window.innerWidth < 1024) inspector.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  };

  // Keep at least one line on: an empty map reads as "no buses running".
  const toggleLine = (l: Line) =>
    setLines((prev) => {
      const next = new Set(prev);
      if (next.has(l) && next.size > 1) next.delete(l);
      else next.add(l);
      return next;
    });

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && pick(null);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const TABS: { id: Tab; label: string; badge?: number }[] = [
    { id: "fleet", label: "Fleet", badge: vehicles ? shown.length : undefined },
    { id: "board", label: "Departures" },
    { id: "record", label: "Track record" },
  ];

  return (
    <div className="flex min-h-[100dvh] flex-col bg-bg lg:h-[100dvh] lg:overflow-hidden">
      {/* App bar */}
      <header className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2 border-b hairline bg-panel px-4 py-2.5 lg:h-14 lg:flex-nowrap lg:px-5 lg:py-0">
        <div className="flex items-center gap-2.5">
          <Logo />
          <span className="text-[16px] font-semibold tracking-tight text-fg">Busskoll</span>
          <span className="hidden text-[13px] text-mute md:inline">/ Stockholm · SL blue buses</span>
        </div>

        <div className="flex items-center gap-2" role="group" aria-label="Filter lines">
          <span className="label text-mute">Lines</span>
          <div className="flex rounded-md border hairline p-0.5">
            {LINES.map((l) => (
              <button
                key={l}
                onClick={() => toggleLine(l)}
                aria-pressed={lines.has(l)}
                aria-label={`Line ${l}`}
                className={`h-7 min-w-9 rounded px-2.5 font-mono text-[13px] font-bold transition-colors ${
                  lines.has(l) ? "bg-accent text-white dark:text-bg" : "text-mute hover:bg-fg/[0.06] hover:text-fg"
                }`}
              >
                {l}
              </button>
            ))}
          </div>
        </div>

        <div className="ml-auto flex items-center gap-3">
          <span className="flex items-center gap-2" role="status">
            <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS[health].dot} ${health === "live" && !reduced ? "animate-pulse" : ""}`} />
            <span className="text-[13px] text-soft">{STATUS[health].label}</span>
            {lastUpdated && <span className="hidden text-[13px] text-mute sm:inline">· updated {relTime(lastUpdated, now)}</span>}
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
      </header>

      {health === "offline" ? (
        <main className="grid flex-1 place-items-center p-6" role="alert">
          <div className="max-w-md rounded-md border hairline bg-panel p-6">
            <div className="label text-verylate">Data unavailable</div>
            <h1 className="mt-2 text-[26px] font-semibold leading-tight tracking-tight text-fg">The live feed isn't responding.</h1>
            <p className="mt-3 text-[15px] leading-relaxed text-soft">
              No buses are shown rather than stale or made-up ones. The page retries every minute on its own.
            </p>
            <button
              onClick={refresh}
              disabled={loading}
              className="mt-5 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50 dark:text-bg"
            >
              {loading ? "Retrying…" : "Retry now"}
            </button>
          </div>
        </main>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <main className="flex min-h-0 flex-1 flex-col">
            {/* KPI strip */}
            <section className="grid shrink-0 grid-cols-2 border-b hairline bg-panel sm:grid-cols-5" aria-label="Key figures">
              <Kpi label="Buses on the road" hint={`lines ${[...lines].sort().join(" · ")}`}>
                {vehicles ? <AnimatedNumber value={shown.length} /> : "–"}
              </Kpi>
              <Kpi label="Running late" hint="2+ min behind timetable" tone={late ? "text-late" : "text-fg"}>
                {vehicles ? <AnimatedNumber value={late} /> : "–"}
              </Kpi>
              <Kpi label="Busskoll error" hint="mean absolute, seconds" tone="text-accent">
                {all ? <AnimatedNumber value={all.mae_busskoll} /> : "–"}
              </Kpi>
              <Kpi label="SL error" hint="same arrivals, seconds" tone="text-soft">
                {all ? <AnimatedNumber value={all.mae_sl} /> : "–"}
              </Kpi>
              <Kpi label="Days won" hint={scoreboard ? `of ${all?.days_scored} scored vs SL` : undefined}>
                {all ? (
                  <>
                    <AnimatedNumber value={all.days_beat} />
                    <span className="text-[16px] text-mute">/{all.days_scored}</span>
                  </>
                ) : (
                  "–"
                )}
              </Kpi>
            </section>

            {/* Map pane */}
            <div className="relative h-[60vh] min-h-[360px] lg:h-auto lg:min-h-0 lg:flex-1">
              <BusMap routes={routes} vehicles={vehicles} lines={lines} selected={sel} onSelect={pick} reduced={reduced} />
              <ul
                className="absolute left-3 top-3 mr-14 flex flex-wrap gap-x-3 gap-y-1 rounded-md border hairline bg-panel/90 px-3 py-2"
                aria-label="Bus colours by delay"
              >
                {BUCKETS.map((b) => (
                  <li key={b} className="label flex items-center gap-1.5 text-soft">
                    <span className={`h-2 w-2 rounded-full ${DOT[b]}`} aria-hidden="true" />
                    {BUCKET_LABEL[b]}
                  </li>
                ))}
              </ul>
            </div>
          </main>

          {/* Inspector */}
          <aside ref={inspector} className="flex shrink-0 flex-col border-t hairline bg-panel lg:w-[440px] lg:border-l lg:border-t-0" aria-label="Inspector">
            <div className="flex shrink-0 border-b hairline px-2" role="tablist">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                  className={`-mb-px flex items-center gap-2 border-b-2 px-3 py-3 text-[13px] font-medium transition-colors ${
                    tab === t.id ? "border-accent text-fg" : "border-transparent text-mute hover:text-fg"
                  }`}
                >
                  {t.label}
                  {t.badge != null && <span className="rounded bg-fg/[0.07] px-1.5 font-mono text-[11px] text-soft">{t.badge}</span>}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 lg:overflow-y-auto" role="tabpanel">
              {tab === "fleet" &&
                (vehicles ? (
                  <FleetTable vehicles={shown} selected={sel?.kind === "bus" ? sel.id : undefined} onSelect={(id) => pick({ kind: "bus", id })} />
                ) : (
                  <div className="m-4 h-64 animate-pulse rounded-md bg-fg/[0.04]" />
                ))}
              {tab === "board" && (
                <div className="p-4">
                  {open ? (
                    <DetailPanel
                      vehicle={vehicle}
                      stop={sel?.kind === "stop" ? { ...stop, name: routes?.stops.find((s) => s.stop_id === sel.id)?.name } : undefined}
                      onClose={() => pick(null)}
                    />
                  ) : (
                    <p className="text-sm text-mute">Select a bus on the map or in the fleet table, or click a stop, to see its next arrivals.</p>
                  )}
                </div>
              )}
              {tab === "record" && (
                <div className="p-4">{scoreboard ? <Scoreboard board={scoreboard} /> : <div className="h-72 animate-pulse rounded-md bg-fg/[0.04]" />}</div>
              )}
            </div>
            <footer className="label shrink-0 border-t hairline px-4 py-2.5 text-mute">Trafiklab GTFS-RT + KoDa (CC0) · map © OSM · © CARTO</footer>
          </aside>
        </div>
      )}
    </div>
  );
}
