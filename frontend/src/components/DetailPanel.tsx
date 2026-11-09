import type { ReactNode } from "react";
import type { Arrival, StopCall, StopDetail, Vehicle } from "../api";
import { BUCKET_LABEL, bucket, clock, dueIn, fmtDelay } from "../lib";

// Clicked bus or stop, as a departure board: dark in both themes like real signage, with
// amber dot-matrix countdowns. Each row sets the timetable, SL's prediction and Busskoll's
// side by side, each with its delay against the timetable.
interface Props {
  vehicle?: Vehicle;
  stop?: { detail: StopDetail | null; error: boolean; name?: string };
  onClose: () => void;
}

export default function DetailPanel({ vehicle, stop, onClose }: Props) {
  if (vehicle) {
    return (
      <Board
        kicker={<>Bus {vehicle.vehicle_id.slice(-4)} · passed {vehicle.last_stop.name || "last stop"} {clock(vehicle.last_stop.time)}</>}
        title={<><Badge line={vehicle.line} /> <span className="truncate">{vehicle.headsign}</span></>}
        status={<Chip delay={vehicle.delay_s} long />}
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
      kicker={<>Stop{d ? ` · lines ${d.stop.lines.join(" · ")}` : ""} · buses due within 5 stops</>}
      title={<span className="truncate">{d?.stop.name ?? stop.name ?? "…"}</span>}
      onClose={onClose}
    >
      {stop.error ? (
        <Empty>Couldn't load this stop. It retries with the next update.</Empty>
      ) : !d ? (
        <div className="m-3 h-32 animate-pulse rounded-lg bg-white/[0.04]" />
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
    <section className="overflow-hidden rounded-md border border-white/10 bg-board text-board-fg" aria-live="polite" aria-label="Departure board">
      <header className="flex items-start justify-between gap-3 px-4 pb-3 pt-3.5">
        <div className="min-w-0">
          <div className="label truncate text-board-mute">{kicker}</div>
          <h2 className="mt-1.5 flex min-w-0 items-center gap-2 text-[22px] font-semibold leading-tight tracking-tight">{title}</h2>
          {status && <div className="mt-1.5">{status}</div>}
        </div>
        <button
          onClick={onClose}
          aria-label="Close departure board, back to fleet"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-white/[0.06] text-board-mute transition-colors hover:bg-white/[0.12] hover:text-board-fg"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </button>
      </header>
      <div className="label grid grid-cols-3 gap-2 border-y border-white/[0.08] px-4 py-1.5 text-board-mute">
        <span>Timetable</span>
        <span>SL</span>
        <span className="text-[rgb(86_150_255)]">Busskoll</span>
      </div>
      <div className="divide-y divide-white/[0.06]">{children}</div>
    </section>
  );
}

function Row({ title, call }: { title: ReactNode; call: StopCall | Arrival }) {
  const s = Date.parse(call.scheduled);
  const delay = (iso: string) => (Date.parse(iso) - s) / 1000;
  return (
    <div className="px-4 py-2.5">
      <div className="flex items-center gap-3">
        <span className="flex min-w-0 flex-1 items-center gap-2 text-[15px] font-medium">{title}</span>
        <span className="led shrink-0 text-[22px] leading-none tabular" title="Due, by Busskoll's prediction">
          {dueIn(call.busskoll)}
        </span>
      </div>
      <div className="mt-1.5 grid grid-cols-3 gap-2 font-mono text-[12.5px] tabular">
        <span className="text-board-mute">{clock(call.scheduled)}</span>
        <span className="flex flex-wrap items-center gap-x-1.5">
          {clock(call.sl)} <Chip delay={delay(call.sl)} board />
        </span>
        <span className="flex flex-wrap items-center gap-x-1.5 font-semibold">
          {clock(call.busskoll)} <Chip delay={delay(call.busskoll)} board />
        </span>
      </div>
    </div>
  );
}

// On the always-dark board the chips use the dark-theme delay colours, whatever the page theme.
const CHIP = { early: "text-early", ontime: "text-ontime", late: "text-late", verylate: "text-verylate" } as const;
const BOARD_CHIP = { early: "text-[#67c8ff]", ontime: "text-[#3ddc97]", late: "text-[#ff9140]", verylate: "text-[#ff4d6d]" } as const;
export function Chip({ delay, long, board = long }: { delay: number; long?: boolean; board?: boolean }) {
  const b = bucket(delay);
  return (
    <span className={`inline-flex items-center gap-1 font-mono text-[11px] ${(board ? BOARD_CHIP : CHIP)[b]}`} title={BUCKET_LABEL[b]}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {long ? `${BUCKET_LABEL[b]} · ${fmtDelay(delay)}` : fmtDelay(delay)}
    </span>
  );
}

export const Badge = ({ line }: { line: string }) => (
  <span className="inline-grid h-6 min-w-6 shrink-0 place-items-center rounded-md bg-[#1f5fe0] px-1.5 font-mono text-[13px] font-bold leading-none text-white" aria-label={`Line ${line}`}>
    {line}
  </span>
);

const Empty = ({ children }: { children: ReactNode }) => <p className="px-4 py-4 text-sm text-board-mute">{children}</p>;
