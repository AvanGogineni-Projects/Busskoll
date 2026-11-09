import { useState } from "react";
import { byLine, fmtDelay, fold } from "../lib";
import { Badge } from "./DetailPanel";

// Every line in one sortable, filterable table: the index of the network. Built for hundreds
// of rows (one compact row each, sticky header), not just the three lines in the demo.
export interface LineRow {
  line: string;
  ends: string[];
  buses: number;
  avg: number | null; // mean delay of its buses now, seconds
  onTime: number | null; // share of its buses on time now, 0..1
  err?: { bk: number; sl: number }; // mean absolute prediction error, seconds
}
type Key = "line" | "buses" | "avg" | "onTime" | "err";
const COLS: { k: Key; label: string; right?: boolean; hide?: string }[] = [
  { k: "line", label: "Line" },
  { k: "buses", label: "Buses now", right: true },
  { k: "avg", label: "Avg delay", right: true },
  { k: "onTime", label: "On time", right: true, hide: "hidden sm:table-cell" },
  { k: "err", label: "Error · Busskoll / SL", right: true, hide: "hidden md:table-cell" },
];

export default function LinesTable({ rows, onOpen }: { rows: LineRow[]; onOpen: (line: string) => void }) {
  const [sort, setSort] = useState<{ k: Key; desc: boolean }>({ k: "line", desc: false });
  const [filter, setFilter] = useState("");
  const val = (r: LineRow, k: Key) => (k === "err" ? (r.err?.bk ?? null) : k === "line" ? null : r[k]);
  const f = fold(filter);
  const shown = rows
    .filter((r) => !f || fold(r.line).startsWith(f) || r.ends.some((e) => fold(e).includes(f)))
    .sort((a, b) => {
      if (sort.k === "line") return sort.desc ? byLine(b.line, a.line) : byLine(a.line, b.line);
      const x = val(a, sort.k), y = val(b, sort.k);
      if (x == null || y == null) return x == null ? 1 : -1; // no data sinks to the bottom
      return sort.desc ? y - x : x - y;
    });

  return (
    <div className="overflow-hidden rounded-lg border hairline bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b hairline px-4 py-3">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter lines"
          aria-label="Filter lines by number or destination"
          className="h-9 w-56 rounded-md border hairline bg-bg px-3 pt-0.5 text-[14px] text-fg outline-none placeholder:text-mute focus:border-brand"
        />
        <span className="label text-mute">
          {shown.length} of {rows.length} lines
        </span>
      </div>
      <div className="max-h-[560px] overflow-y-auto">
        <table className="w-full text-left text-[14px]">
          <thead className="label sticky top-0 z-[1] bg-panel text-mute">
            <tr className="border-b hairline">
              {COLS.map((c) => (
                <th key={c.k} className={`py-2 font-normal first:pl-4 last:pr-4 ${c.right ? "text-right" : ""} ${c.hide ?? ""}`} aria-sort={sort.k === c.k ? (sort.desc ? "descending" : "ascending") : "none"}>
                  <button
                    onClick={() => setSort((s) => ({ k: c.k, desc: s.k === c.k ? !s.desc : c.k !== "line" }))}
                    className={`uppercase hover:text-fg ${sort.k === c.k ? "text-fg" : ""}`}
                  >
                    {c.label}
                    {sort.k === c.k && <span aria-hidden="true"> {sort.desc ? "↓" : "↑"}</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr
                key={r.line}
                onClick={() => onOpen(r.line)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen(r.line))}
                tabIndex={0}
                className="cursor-pointer border-b rule outline-none transition-colors last:border-0 hover:bg-fg/[0.04] focus-visible:bg-brand/10"
              >
                <td className="py-2.5 pl-4">
                  <span className="flex min-w-0 items-center gap-3">
                    <Badge line={r.line} />
                    <span className="truncate pt-0.5 text-soft">{r.ends.join(" – ")}</span>
                  </span>
                </td>
                <td className="py-2.5 text-right font-mono tabular text-fg">{r.buses || "–"}</td>
                <td className={`py-2.5 text-right font-mono tabular ${r.avg != null && r.avg >= 120 ? "text-late" : "text-fg"}`}>{r.avg == null ? "–" : fmtDelay(r.avg)}</td>
                <td className="hidden py-2.5 text-right font-mono tabular text-fg sm:table-cell">{r.onTime == null ? "–" : `${Math.round(r.onTime * 100)}%`}</td>
                <td className="hidden py-2.5 pr-4 text-right font-mono tabular md:table-cell">
                  {r.err ? (
                    <>
                      <span className="text-brand">{Math.round(r.err.bk)}</span>
                      <span className="text-mute"> / </span>
                      <span className="text-fg">{Math.round(r.err.sl)} s</span>
                    </>
                  ) : (
                    <span className="text-mute">–</span>
                  )}
                </td>
              </tr>
            ))}
            {!shown.length && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-mute">
                  No line matches "{filter}".
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
