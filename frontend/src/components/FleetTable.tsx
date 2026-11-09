import type { Vehicle } from "../api";
import { dueIn, trend, TREND_ARROW, TREND_LABEL } from "../lib";
import { Badge, Chip } from "./DetailPanel";

// Every bus on the road as a sortable-by-lateness table: the dispatcher's view.
// Clicking a row selects the bus (the map brings it into view).
export default function FleetTable({ vehicles, selected, onSelect }: { vehicles: Vehicle[]; selected?: string; onSelect: (id: string) => void }) {
  const rows = [...vehicles].sort((a, b) => b.delay_s - a.delay_s);
  if (!rows.length) return <p className="px-4 py-6 text-sm text-mute">No buses on the selected lines right now.</p>;
  return (
    <table className="w-full table-fixed text-left text-[13px]">
      <thead className="label sticky top-0 z-[1] bg-panel text-mute">
        <tr className="border-b hairline">
          <th className="w-12 py-2 pl-4 font-normal">Line</th>
          <th className="py-2 font-normal">To · next stop</th>
          <th className="w-16 py-2 text-right font-normal">Due</th>
          <th className="w-[6.5rem] py-2 pr-4 text-right font-normal">Delay</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((v) => {
          const next = v.next_stops[0];
          const on = v.vehicle_id === selected;
          return (
            <tr
              key={v.vehicle_id}
              onClick={() => onSelect(v.vehicle_id)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onSelect(v.vehicle_id))}
              tabIndex={0}
              aria-selected={on}
              className={`cursor-pointer border-b rule outline-none transition-colors focus-visible:bg-brand/10 ${on ? "bg-brand/10" : "hover:bg-fg/[0.04]"}`}
            >
              <td className="py-2 pl-4">
                <Badge line={v.line} />
              </td>
              <td className="min-w-0 py-2 pr-2">
                <div className="truncate font-semibold text-fg">{v.headsign}</div>
                <div className="truncate text-[12px] text-mute">{next ? next.name : "Trip ending"}</div>
              </td>
              <td className="py-2 text-right font-mono text-[12px] text-soft tabular">{next ? dueIn(next.busskoll) : "–"}</td>
              <td className="py-2 pr-4 text-right">
                <Chip delay={v.delay_s} />
                <Trend s={v.delay_trend_s} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// "↗ Losing time": colour plus words, never colour alone.
export function Trend({ s, className = "text-mute" }: { s: number | null; className?: string }) {
  const t = trend(s);
  if (!t) return null;
  return (
    <div className={`text-[11px] ${t === "worse" ? "text-late" : t === "better" ? "text-early" : ""} ${className}`} title="Change in delay over its last 3 stops">
      <span aria-hidden="true">{TREND_ARROW[t]}</span> {TREND_LABEL[t]}
    </div>
  );
}
