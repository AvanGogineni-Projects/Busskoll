import type { ReactNode } from "react";
import { LINES, type Line, type Scoreboard as Board, type ScoreBlock } from "../api";
import AnimatedNumber from "./AnimatedNumber";

// The track record as a ledger (Elvarsel's scoreboard): Busskoll's mean absolute error
// against SL's own prediction for the same arrivals, overall and per line x stops ahead.
export default function Scoreboard({ board, lines }: { board: Board; lines: Set<Line> }) {
  const all = board.overall;
  if (!all.days_scored) {
    return (
      <Frame>
        <p className="caps px-4 py-3 text-mute">Nothing scored yet: scoring starts once buses reach their stops.</p>
      </Frame>
    );
  }
  const gain = all.mae_sl ? (1 - all.mae_busskoll / all.mae_sl) * 100 : 0;
  const shown = LINES.filter((l) => lines.has(l) && board.lines[l]);
  return (
    <Frame note={`${board.window_days} days · ${all.days_scored} scored`}>
      <div className="grid grid-cols-2">
        <Cell label="Busskoll MAE" tone={gain < 0 ? "text-verylate" : "text-fg"} value={<AnimatedNumber value={all.mae_busskoll} />} unit="s" hint={`SL ${Math.round(all.mae_sl)} s`} />
        <Cell
          label="vs SL"
          tone={gain < 0 ? "text-verylate" : "text-fg"}
          value={<><span>{gain >= 0 ? "−" : "+"}</span><AnimatedNumber value={Math.abs(gain)} /></>}
          unit="%"
          hint={gain >= 0 ? "smaller error" : "larger error"}
        />
        <Cell
          label="Days beaten"
          tone={all.days_beat * 2 >= all.days_scored ? "text-fg" : "text-verylate"}
          value={<><AnimatedNumber value={all.days_beat} />/{all.days_scored}</>}
          hint="smaller daily error"
        />
        <Cell label="Arrivals scored" tone="text-fg" value={<AnimatedNumber value={all.horizons.reduce((a, h) => a + h.n, 0) / 1000} />} unit="k" hint="stop × horizon pairs" />
      </div>

      {/* Line x horizon: Busskoll's MAE big, SL's beneath; signal colour where SL wins. */}
      <div className="border-b border-r border-line px-4 pb-3 pt-2">
        <div className="caps flex justify-between text-mute">
          <span>MAE by stops ahead · s</span>
          <span>
            <span className="text-fg">Busskoll</span> / SL
          </span>
        </div>
        <table className="mt-2 w-full table-fixed font-mono text-[12px] tabular">
          <thead>
            <tr className="caps text-mute">
              <th className="w-[26%] py-1 text-left font-normal">Line</th>
              {all.horizons.map((h) => (
                <th key={h.h} className="py-1 text-right font-normal">+{h.h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((l) => (
              <Row key={l} label={l} days={board.lines[l]!} />
            ))}
            {shown.length > 1 && <Row label="All" days={all} />}
          </tbody>
        </table>
      </div>
    </Frame>
  );
}

function Row({ label, days }: { label: string; days: ScoreBlock }) {
  return (
    <tr className="border-t border-dashed border-line/30 align-top">
      <td className="py-1.5">
        <span className="font-semibold text-fg">{label}</span>
        <span className="block text-[10px] text-mute" title="days Busskoll beat SL">
          {days.days_beat}/{days.days_scored} d
        </span>
      </td>
      {days.horizons.map((h) => (
        <td key={h.h} className="py-1.5 text-right" title={`${h.n.toLocaleString("en-GB")} arrivals`}>
          <span className={h.mae_busskoll <= h.mae_sl ? "text-fg" : "text-verylate"}>
            <AnimatedNumber value={h.mae_busskoll} />
          </span>
          <span className="block text-[10px] text-mute">{Math.round(h.mae_sl)}</span>
        </td>
      ))}
    </tr>
  );
}

const Frame = ({ note, children }: { note?: string; children: ReactNode }) => (
  <section className="border-l border-t border-line" aria-label="Track record">
    <header className="caps flex flex-wrap items-baseline justify-between gap-2 border-b border-r border-line px-4 py-2">
      <span className="text-fg">
        <span className="text-signal">Track record</span> · vs SL's own predictions
      </span>
      {note && <span className="text-mute">{note}</span>}
    </header>
    {children}
  </section>
);

function Cell({ label, value, unit, hint, tone }: { label: string; value: ReactNode; unit?: string; hint: string; tone: string }) {
  return (
    <div className="min-w-0 border-b border-r border-line px-4 py-3">
      <div className="caps text-mute">{label}</div>
      <div className={`mt-1 font-mono text-[30px] font-medium leading-none tracking-[-0.03em] tabular ${tone}`}>
        {value}
        {unit && <span className="ml-0.5 text-[15px] text-mute">{unit}</span>}
      </div>
      <div className="caps mt-1.5 truncate text-mute">{hint}</div>
    </div>
  );
}
