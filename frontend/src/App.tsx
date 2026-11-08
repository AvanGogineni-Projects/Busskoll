import { useEffect, useState, type ReactNode } from "react";
import { LINES, type Line } from "./api";
import BusMap, { type Selection } from "./components/BusMap";
import DetailPanel from "./components/DetailPanel";
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

// Re-render every few seconds so "updated 20 s ago" and the board countdowns stay true.
function useNow(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

const Logo = () => (
  <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
    <circle cx="11" cy="11" r="9" fill="none" stroke="rgb(var(--accent))" strokeWidth="2.5" />
    <circle cx="11" cy="11" r="3.5" fill="rgb(var(--led))" />
  </svg>
);

const Legend = () => (
  <ul className="flex flex-wrap gap-x-3 gap-y-1" aria-label="Bus colours by delay">
    {BUCKETS.map((b) => (
      <li key={b} className="label flex items-center gap-1.5 text-mute">
        <span className={`h-2 w-2 rounded-full ${DOT[b]}`} aria-hidden="true" />
        {BUCKET_LABEL[b]}
      </li>
    ))}
  </ul>
);

const Glass = ({ className = "", children }: { className?: string; children: ReactNode }) => (
  <div className={`glass pointer-events-auto ${className}`}>{children}</div>
);

export default function App() {
  const { routes, vehicles, scoreboard, health, lastUpdated, loading, refresh, client } = useLive();
  const { theme, toggle } = useTheme();
  const reduced = useReducedMotion();
  const now = useNow(5000);
  const [lines, setLines] = useState<Set<Line>>(new Set(LINES));
  const [sel, setSel] = useState<Selection>(null);
  const [sheet, setSheet] = useState(false); // phone: scoreboard sheet expanded
  const stop = useStop(client, sel?.kind === "stop" ? sel.id : null, lastUpdated);

  const shown = vehicles?.vehicles.filter((v) => lines.has(v.line)) ?? [];
  const late = shown.filter((v) => v.delay_s >= 120).length;
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

  const summary = (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[28px] font-semibold leading-none tracking-tight text-fg tabular">{vehicles ? shown.length : "–"}</span>
        <span className="text-[14px] text-soft">buses on the road{vehicles && late ? <>, <span className="text-late">{late} running late</span></> : null}</span>
      </div>
      <div className="mt-2.5">
        <Legend />
      </div>
    </div>
  );

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden">
      {health === "offline" ? (
        <div className="absolute inset-0 grid place-items-center bg-bg p-6" role="alert">
          <Glass className="max-w-md p-6">
            <div className="label text-verylate">Data unavailable</div>
            <h1 className="mt-2 text-[30px] font-semibold leading-tight tracking-tight text-fg">The live feed isn't responding.</h1>
            <p className="mt-3 text-[15px] leading-relaxed text-soft">
              No buses are shown rather than stale or made-up ones. The page retries every minute on its own.
            </p>
            <button
              onClick={refresh}
              disabled={loading}
              className="mt-5 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {loading ? "Retrying…" : "Retry now"}
            </button>
          </Glass>
        </div>
      ) : (
        <BusMap routes={routes} vehicles={vehicles} lines={lines} selected={sel} onSelect={setSel} reduced={reduced} />
      )}

      {/* Top bar: brand + status, then the line switch and theme. */}
      <header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-wrap items-start justify-between gap-2 p-3 sm:p-4">
        <Glass className="flex min-w-0 items-center gap-3 px-3.5 py-2">
          <Logo />
          <span className="text-[17px] font-semibold tracking-tight text-fg">busskoll</span>
          <span className="h-4 w-px bg-fg/15" aria-hidden="true" />
          <span className="flex min-w-0 items-center gap-1.5" role="status">
            <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS[health].dot} ${health === "live" && !reduced ? "animate-pulse" : ""}`} />
            <span className="label truncate text-soft">{STATUS[health].label}</span>
            {lastUpdated && <span className="label hidden text-mute sm:inline">· {relTime(lastUpdated, now)}</span>}
          </span>
        </Glass>
        <Glass className="flex items-center gap-1 p-1">
          <span className="label px-2 text-mute">Line</span>
          {LINES.map((l) => (
            <button
              key={l}
              onClick={() => toggleLine(l)}
              aria-pressed={lines.has(l)}
              aria-label={`Line ${l}`}
              className={`h-8 min-w-9 rounded-full px-2.5 font-mono text-[14px] font-bold transition-colors ${
                lines.has(l) ? "bg-accent text-white dark:text-bg" : "text-mute hover:bg-fg/[0.06] hover:text-fg"
              }`}
            >
              {l}
            </button>
          ))}
          <span className="mx-1 h-5 w-px bg-fg/15" aria-hidden="true" />
          <button
            onClick={toggle}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            className="grid h-8 w-8 place-items-center rounded-full text-soft transition-colors hover:bg-fg/[0.06] hover:text-fg"
          >
            {theme === "dark" ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.5" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" /></svg>
            )}
          </button>
        </Glass>
      </header>

      {health !== "offline" && (
        <>
          {/* Desktop: instrument rail on the left. */}
          <aside className="pointer-events-none absolute bottom-4 left-4 top-[76px] z-10 hidden w-[380px] flex-col gap-3 lg:flex">
            <Glass className="p-4">{summary}</Glass>
            <Glass className="min-h-0 overflow-y-auto p-4">
              {scoreboard ? <Scoreboard board={scoreboard} /> : <div className="h-72 animate-pulse rounded-lg bg-fg/[0.04]" />}
            </Glass>
            {!open && (
              <p className="label pointer-events-auto mt-auto px-1 leading-relaxed text-mute [text-shadow:0_1px_2px_rgb(var(--bg))]">
                Tap a bus or a stop for its departure board
              </p>
            )}
          </aside>

          {/* Phone: summary + scoreboard as a bottom sheet (hidden while a board is open). */}
          {!open && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 p-2 lg:hidden">
              <Glass className="max-h-[72dvh] overflow-y-auto rounded-b-[14px] px-4 pb-4 pt-2">
                <button
                  onClick={() => setSheet((s) => !s)}
                  aria-expanded={sheet}
                  aria-label={sheet ? "Collapse track record" : "Expand track record"}
                  className="mx-auto mb-2 block h-1.5 w-10 rounded-full bg-fg/20"
                />
                {summary}
                {scoreboard && (
                  <div className="mt-4 border-t hairline pt-3">
                    <Scoreboard board={scoreboard} compact={!sheet} />
                    {!sheet && (
                      <button onClick={() => setSheet(true)} className="label mt-3 text-accent">
                        Full track record ↑
                      </button>
                    )}
                  </div>
                )}
              </Glass>
            </div>
          )}

          {/* Departure board: right column on desktop, bottom sheet on phones. */}
          {open && (
            <div className="absolute inset-x-0 bottom-0 z-20 max-h-[64dvh] overflow-y-auto p-2 lg:inset-x-auto lg:bottom-auto lg:right-4 lg:top-[76px] lg:max-h-[calc(100dvh-92px)] lg:w-[400px] lg:p-0">
              <DetailPanel
                vehicle={vehicle}
                stop={sel?.kind === "stop" ? { ...stop, name: routes?.stops.find((s) => s.stop_id === sel.id)?.name } : undefined}
                onClose={() => setSel(null)}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
