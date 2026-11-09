import { useState } from "react";
import { LINES, type Line, type Scoreboard as Board } from "../api";
import AnimatedNumber from "./AnimatedNumber";

// Head to head: Busskoll's mean absolute error against SL's own prediction for the same
// arrivals. Smaller is better. Per line, and per how many stops ahead the forecast was made.
export default function Scoreboard({ board }: { board: Board }) {
  const [pick, setPick] = useState<Line | "all">("all");
  const block = pick === "all" ? board.overall : board.lines[pick] ?? board.overall;

  if (!board.overall.days_scored) {
    return <p className="text-sm text-mute">Nothing scored yet: scoring starts once buses reach their stops.</p>;
  }
  const us = block.mae_busskoll;
  const sl = block.mae_sl;
  const lead = us <= sl;
  const pct = Math.abs(1 - (lead ? us / sl : sl / us)) * 100;
  const max = Math.max(...block.horizons.flatMap((h) => [h.mae_busskoll, h.mae_sl]));

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="label text-mute">Prediction error · {board.window_days} days</span>
        <div className="flex rounded-md border hairline p-0.5" role="group" aria-label="Scoreboard line">
          {(["all", ...LINES] as const).map((l) => (
            <button
              key={l}
              onClick={() => setPick(l)}
              aria-pressed={pick === l}
              className={`label rounded px-2.5 py-1 transition-colors ${pick === l ? "bg-fg text-panel" : "text-mute hover:text-fg"}`}
            >
              {l === "all" ? "All" : l}
            </button>
          ))}
        </div>
      </div>

      {/* The two contenders. */}
      <div className="mt-4 grid grid-cols-2 gap-3">
        <Contender name="Busskoll" value={us} tone="text-accent" won={lead} />
        <Contender name="SL" value={sl} tone="text-soft" won={!lead} />
      </div>
      <p className="mt-3 text-[13px] leading-snug text-soft">
        {lead ? (
          <><span className="font-semibold text-accent">Busskoll</span> is {pct.toFixed(0)}% closer to the real arrival than SL.</>
        ) : (
          <><span className="font-semibold text-fg">SL</span> leads: its error is {pct.toFixed(0)}% smaller. The model has ground to make up.</>
        )}
      </p>

          {/* Error by horizon: paired bars, Busskoll over SL, same scale. */}
          <div className="mt-5 flex items-center justify-between">
            <span className="label text-mute">By stops ahead · seconds</span>
            <span className="label flex items-center gap-3 text-mute">
              <i className="inline-block h-1.5 w-3 rounded-full bg-accent" /> Busskoll
              <i className="inline-block h-1.5 w-3 rounded-full bg-rival" /> SL
            </span>
          </div>
          <ul className="mt-2 space-y-2">
            {block.horizons.map((h) => (
              <li key={h.h} className="grid grid-cols-[2.25rem_1fr] items-center gap-2" title={`${h.n.toLocaleString("en-GB")} arrivals`}>
                <span className="font-mono text-[12px] text-mute">+{h.h}</span>
                <div className="space-y-1">
                  <Bar value={h.mae_busskoll} max={max} className="bg-accent" />
                  <Bar value={h.mae_sl} max={max} className="bg-rival" />
                </div>
              </li>
            ))}
          </ul>

          {/* Days won: one segment per scored day, lit when Busskoll beat SL. */}
          <div className="mt-5 flex items-center justify-between">
            <span className="label text-mute">Days won</span>
            <span className="font-mono text-[12px] text-fg">
              <AnimatedNumber value={block.days_beat} /> / {block.days_scored}
            </span>
          </div>
          <div className="mt-2 flex gap-1" aria-hidden="true">
            {Array.from({ length: block.days_scored }, (_, i) => (
              <span key={i} className={`h-1.5 flex-1 rounded-full ${i < block.days_beat ? "bg-accent" : "bg-fg/10"}`} />
            ))}
          </div>
    </div>
  );
}

function Contender({ name, value, tone, won }: { name: string; value: number; tone: string; won: boolean }) {
  return (
    <div className={`rounded-md border px-3 py-2.5 ${won ? "border-accent/50 bg-accent/[0.07]" : "hairline bg-raise/60"}`}>
      <div className="label flex items-center justify-between text-mute">
        {name}
        {won && <span className="text-accent">leads</span>}
      </div>
      <div className={`mt-1 font-mono text-[34px] font-semibold leading-none tracking-tight tabular ${tone}`}>
        <AnimatedNumber value={value} />
        <span className="ml-1 text-[14px] font-normal text-mute">s</span>
      </div>
    </div>
  );
}

const Bar = ({ value, max, className }: { value: number; max: number; className: string }) => (
  <div className="flex items-center gap-2">
    <div className="h-1.5 flex-1 rounded-full bg-fg/[0.06]">
      <div className={`h-full rounded-full transition-[width] duration-700 ${className}`} style={{ width: `${(value / max) * 100}%` }} />
    </div>
    <span className="w-8 text-right font-mono text-[11px] text-soft tabular">{Math.round(value)}</span>
  </div>
);
