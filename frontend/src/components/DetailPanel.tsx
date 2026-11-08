import type { ReactNode } from "react";
import type { Arrival, StopCall, StopDetail, Vehicle } from "../api";
import { BUCKET_LABEL, bucket, clock, fmtDelay } from "../lib";

// Clicked bus or stop: each upcoming arrival as a ledger row, with the timetable, SL's
// prediction and Busskoll's side by side, each with its delay against the timetable.
interface Props {
  vehicle?: Vehicle;
  stop?: { detail: StopDetail | null; error: boolean; name?: string };
  onClose: () => void;
}

export default function DetailPanel({ vehicle, stop, onClose }: Props) {
  if (vehicle) {
    return (
      <Shell
        kicker={<>Bus {vehicle.vehicle_id.slice(-4)} · <Chip delay={vehicle.delay_s} long /></>}
        title={<><Badge line={vehicle.line} /> {vehicle.headsign}</>}
        sub={`Passed ${vehicle.last_stop.name || "last stop"} at ${clock(vehicle.last_stop.time)}`}
        onClose={onClose}
      >
        {vehicle.next_stops.length ? (
          vehicle.next_stops.map((c, i) => <CallRow key={c.stop_id + i} n={i + 1} title={c.name} call={c} />)
        ) : (
          <Empty>No upcoming stops: the trip is ending.</Empty>
        )}
      </Shell>
    );
  }
  if (stop) {
    const d = stop.detail;
    return (
      <Shell
        kicker={<>Stop{d ? ` · lines ${d.stop.lines.join(", ")}` : ""}</>}
        title={d?.stop.name ?? stop.name ?? "…"}
        sub="Buses due within their next 5 stops"
        onClose={onClose}
      >
        {stop.error ? (
          <Empty>Couldn't load this stop. It retries with the next update.</Empty>
        ) : !d ? (
          <div className="h-40 animate-pulse bg-fg/[0.04]" />
        ) : d.arrivals.length ? (
          d.arrivals.map((a, i) => <CallRow key={a.trip_id} n={i + 1} title={<><Badge line={a.line} /> {a.headsign}</>} call={a} />)
        ) : (
          <Empty>No bus due here in the next few stops.</Empty>
        )}
      </Shell>
    );
  }
  return null;
}

function Shell({ kicker, title, sub, onClose, children }: { kicker: ReactNode; title: ReactNode; sub: string; onClose: () => void; children: ReactNode }) {
  return (
    <section className="border-l border-t border-line" aria-live="polite" aria-label="Selection detail">
      <header className="flex items-start justify-between gap-3 border-b border-r border-line px-4 py-3">
        <div className="min-w-0">
          <div className="caps text-mute">{kicker}</div>
          <h2 className="mt-1 flex items-center gap-2 text-[22px] font-extrabold leading-tight tracking-[-0.02em] text-fg">{title}</h2>
          <div className="caps mt-1 text-mute">{sub}</div>
        </div>
        <button onClick={onClose} aria-label="Close detail" className="caps shrink-0 border border-line px-2 py-1 text-fg transition-colors hover:bg-ink-600 hover:on-active">
          Close
        </button>
      </header>
      <div className="caps grid grid-cols-3 border-b border-r border-line px-4 py-1.5 text-mute">
        <span>Timetable</span>
        <span>SL</span>
        <span className="text-signal">Busskoll</span>
      </div>
      {children}
    </section>
  );
}

function CallRow({ n, title, call }: { n: number; title: ReactNode; call: StopCall | Arrival }) {
  const s = Date.parse(call.scheduled);
  const delay = (iso: string) => (Date.parse(iso) - s) / 1000;
  return (
    <div className="border-b border-r border-line px-4 py-2.5">
      <div className="flex items-center gap-2 text-[15px] font-semibold text-fg">
        <span className="caps w-4 text-mute">{n}</span>
        <span className="flex min-w-0 items-center gap-1.5 truncate">{title}</span>
      </div>
      <div className="mt-1.5 grid grid-cols-3 gap-2 pl-6 font-mono text-[13px] tabular">
        <span className="text-soft">{clock(call.scheduled)}</span>
        <span className="flex flex-wrap items-center gap-x-1.5 text-fg">
          {clock(call.sl)} <Chip delay={delay(call.sl)} />
        </span>
        <span className="flex flex-wrap items-center gap-x-1.5 font-semibold text-fg">
          {clock(call.busskoll)} <Chip delay={delay(call.busskoll)} />
        </span>
      </div>
    </div>
  );
}

const CHIP = { early: "text-early", ontime: "text-ontime", late: "text-late", verylate: "text-verylate" } as const;
export function Chip({ delay, long }: { delay: number; long?: boolean }) {
  const b = bucket(delay);
  return (
    <span className={`caps inline-flex items-center gap-1 ${CHIP[b]}`} title={BUCKET_LABEL[b]}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {long ? `${BUCKET_LABEL[b]} ${fmtDelay(delay)}` : fmtDelay(delay)}
    </span>
  );
}

export const Badge = ({ line }: { line: string }) => (
  <span className="inline-grid h-6 min-w-6 shrink-0 place-items-center bg-signal px-1 font-mono text-[13px] font-semibold leading-none text-white dark:text-[#0c0e11]" aria-label={`Line ${line}`}>
    {line}
  </span>
);

const Empty = ({ children }: { children: ReactNode }) => <p className="caps border-b border-r border-line px-4 py-4 text-mute">{children}</p>;
