import type { ReactNode } from "react";
import type { Arrival, StopCall, StopDetail, Vehicle } from "../api";
import { BUCKET_LABEL, bucket, clock, dueIn, fmtDelay, trend, TREND_ARROW, TREND_LABEL } from "../lib";

// Clicked bus or stop, set like a printed timetable: a heavy ink rule on top, then one row per
// stop with the timetable, SL's prediction and Busskoll's side by side, each with its delay.
interface Props {
  vehicle?: Vehicle;
  stop?: { detail: StopDetail | null; error: boolean; name?: string };
  onClose: () => void;
}

export default function DetailPanel({ vehicle, stop, onClose }: Props) {
  if (vehicle) {
    const t = trend(vehicle.delay_trend_s);
    return (
      <Board
        kicker={<>Bus {vehicle.vehicle_id.slice(-4)} · passed {vehicle.last_stop.name || "last stop"} at {clock(vehicle.last_stop.time)}</>}
        title={<><Badge line={vehicle.line} /> <span className="truncate">{vehicle.headsign}</span></>}
        status={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Chip delay={vehicle.delay_s} long />
            {t && (
              <span className="text-[12px] text-mute" title="Change in delay over its last 3 stops">
                {TREND_ARROW[t]} {TREND_LABEL[t]} ({fmtDelay(vehicle.delay_trend_s!)} over 3 stops)
              </span>
            )}
          </span>
        }
        onClose={onClose}
      >
        {vehicle.next_stops.length ? (
          vehicle.next_stops.map((c, i) => <Row key={c.stop_id + i} title={c.name} call={c} />)
        ) : (
          <Empty>No upcoming stops: the trip is ending.</Empty>
        )}
      </Board>
    );
  }
  if (!stop) return null;
  const d = stop.detail;
  return (
    <Board
      kicker={<>Stop{d ? ` · lines ${d.stop.lines.join(", ")}` : ""} · buses due within 5 stops</>}
      title={<span className="truncate">{d?.stop.name ?? stop.name ?? "…"}</span>}
      onClose={onClose}
    >
      {stop.error ? (
        <Empty>Couldn't load this stop. It retries with the next update.</Empty>
      ) : !d ? (
        <div className="m-4 h-32 animate-pulse bg-fg/[0.05]" />
      ) : d.arrivals.length ? (
        d.arrivals.map((a) => <Row key={a.trip_id} title={<><Badge line={a.line} /> <span className="truncate">{a.headsign}</span></>} call={a} />)
      ) : (
        <Empty>No bus due here in the next few stops.</Empty>
      )}
    </Board>
  );
}

function Board({ kicker, title, status, onClose, children }: { kicker: ReactNode; title: ReactNode; status?: ReactNode; onClose: () => void; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg border hairline bg-panel" aria-live="polite" aria-label="Departure board">
      <header className="flex items-start justify-between gap-3 px-4 pb-3 pt-3">
        <div className="min-w-0">
          <div className="label truncate text-mute">{kicker}</div>
          <h2 className="mt-1.5 flex min-w-0 items-center gap-2 text-[22px] font-extrabold leading-tight tracking-tight">{title}</h2>
          {status && <div className="mt-1.5">{status}</div>}
        </div>
        <button
          onClick={onClose}
          aria-label="Close departure board"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md border hairline text-soft transition-colors hover:bg-fg/[0.06] hover:text-fg"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.6" /></svg>
        </button>
      </header>
      <div className="label grid grid-cols-3 gap-2 border-y hairline bg-fg/[0.03] px-4 py-1.5 text-mute">
        <span>Timetable</span>
        <span>SL</span>
        <span className="text-brand">Busskoll</span>
      </div>
      <div className="divide-y rule">{children}</div>
    </section>
  );
}

function Row({ title, call }: { title: ReactNode; call: StopCall | Arrival }) {
  const s = Date.parse(call.scheduled);
  const delay = (iso: string) => (Date.parse(iso) - s) / 1000;
  return (
    <div className="px-4 py-2.5">
      <div className="flex items-baseline gap-3">
        <span className="flex min-w-0 flex-1 items-center gap-2 text-[15px] font-semibold">{title}</span>
        <span className="shrink-0 font-mono text-[17px] font-bold leading-none text-brand tabular" title="Due, by Busskoll's prediction">
          {dueIn(call.busskoll)}
        </span>
      </div>
      <div className="mt-1.5 grid grid-cols-3 gap-2 font-mono text-[12.5px] tabular">
        <span className="text-mute">{clock(call.scheduled)}</span>
        <span className="flex flex-wrap items-center gap-x-1.5">
          {clock(call.sl)} <Chip delay={delay(call.sl)} />
        </span>
        <span className="flex flex-wrap items-center gap-x-1.5 font-semibold">
          {clock(call.busskoll)} <Chip delay={delay(call.busskoll)} />
        </span>
      </div>
    </div>
  );
}

const CHIP = { early: "text-early", ontime: "text-mute", late: "text-late", verylate: "text-verylate" } as const;
export function Chip({ delay, long }: { delay: number; long?: boolean }) {
  const b = bucket(delay);
  return (
    <span className={`inline-flex items-center gap-1 text-[12px] font-semibold tabular ${CHIP[b]}`} title={BUCKET_LABEL[b]}>
      {long ? `${BUCKET_LABEL[b]} · ${fmtDelay(delay)}` : fmtDelay(delay)}
    </span>
  );
}

// Line number in a solid spot-colour square, like a timetable line box.
export const Badge = ({ line }: { line: string }) => (
  <span className="inline-grid h-6 min-w-6 shrink-0 place-items-center rounded bg-accent px-1.5 pt-0.5 text-[13px] font-extrabold leading-none text-white" aria-label={`Line ${line}`}>
    {line}
  </span>
);

const Empty = ({ children }: { children: ReactNode }) => <p className="px-4 py-4 text-sm text-mute">{children}</p>;
