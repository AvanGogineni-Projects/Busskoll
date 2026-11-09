import { useEffect, useId, useRef, useState } from "react";
import { search, type Hit } from "../lib";
import { Badge } from "./DetailPanel";

// One box for the whole network: type a line number, a destination or a stop. Works as an
// ARIA combobox: arrows move, Enter opens, Escape closes; "/" focuses it from anywhere.
interface Props {
  lines: { line: string; ends: string[] }[];
  stops: { name: string; lines: string[] }[];
  onPick: (h: Hit) => void;
  size?: "lg" | "sm";
  autoFocusKey?: boolean;
}

export default function Search({ lines, stops, onPick, size = "lg", autoFocusKey }: Props) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const hits = search(lines, stops, q);

  useEffect(() => {
    if (!autoFocusKey) return;
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "/" && !/INPUT|TEXTAREA/.test(t.tagName)) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [autoFocusKey]);

  const pick = (h: Hit) => {
    setQ("");
    setOpen(false);
    input.current?.blur();
    onPick(h);
  };

  const lg = size === "lg";
  return (
    <div className="relative">
      <div
        className={`flex items-center gap-3 rounded-lg border bg-panel transition-colors focus-within:border-brand ${lg ? "h-16 px-5" : "h-10 px-3"} hairline`}
      >
        <svg width={lg ? 20 : 15} height={lg ? 20 : 15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="shrink-0 text-mute" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" strokeLinecap="round" />
        </svg>
        <input
          ref={input}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => Math.min(a + 1, hits.length - 1)));
            else if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
            else if (e.key === "Enter" && hits[active]) pick(hits[active]);
            else if (e.key === "Escape") (setOpen(false), input.current?.blur());
          }}
          role="combobox"
          aria-expanded={open && hits.length > 0}
          aria-controls={`${id}-list`}
          aria-activedescendant={open && hits[active] ? `${id}-${active}` : undefined}
          aria-label="Search a line or stop"
          placeholder={lg ? "Search a line, destination or stop" : "Line or stop"}
          className={`min-w-0 flex-1 bg-transparent pt-1 text-fg outline-none placeholder:text-mute ${lg ? "text-[19px] font-semibold" : "text-[14px]"}`}
        />
        {lg && <kbd className="hidden rounded border hairline px-1.5 pt-0.5 font-mono text-[12px] text-mute sm:block">/</kbd>}
      </div>
      {open && q.trim() && (
        <ul
          id={`${id}-list`}
          role="listbox"
          className="absolute left-0 right-0 top-full z-40 mt-2 max-h-[60vh] overflow-y-auto rounded-lg border hairline bg-panel py-1 shadow-2xl"
        >
          {hits.length ? (
            hits.map((h, i) => (
              <li
                key={h.kind + h.id}
                id={`${id}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => (e.preventDefault(), pick(h))}
                onMouseEnter={() => setActive(i)}
                className={`flex cursor-pointer items-center gap-3 px-4 py-2.5 ${i === active ? "bg-fg/[0.06]" : ""}`}
              >
                {h.kind === "line" ? (
                  <Badge line={h.id} />
                ) : (
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border-2 border-fg/60 text-[10px] font-black text-fg" aria-hidden="true">
                    H
                  </span>
                )}
                <span className="min-w-0 pt-0.5">
                  <span className="block truncate text-[15px] font-semibold text-fg">{h.label}</span>
                  <span className="block truncate text-[12px] text-mute">{h.sub}</span>
                </span>
              </li>
            ))
          ) : (
            <li className="px-4 py-3 text-[14px] text-mute">No line or stop matches "{q}".</li>
          )}
        </ul>
      )}
    </div>
  );
}
