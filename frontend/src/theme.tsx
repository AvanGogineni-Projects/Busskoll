import type { Bucket } from "./lib";
import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";

export type Theme = "light" | "dark";

// Colours the map paints itself (MapLibre can't read CSS variables). Kept in step with index.css.
// The CARTO basemap is re-tinted to these on load (BusMap tint()), so the map and the panels
// read as one surface instead of a stock basemap with UI on top.
export interface MapPaint {
  style: string;
  land: string;
  land2: string; // parks, landuse
  water: string;
  road: string;
  building: string;
  label: string;
  route: string;
  sel: string; // the selected bus's route
  stopFill: string;
  stopLine: string;
  delay: Record<Bucket, string>; // "r,g,b" for the bus light trails, same as the CSS delay colours
}
export const MAP_PAINT: Record<Theme, MapPaint> = {
  light: {
    style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
    land: "#f8f9fa",
    land2: "#f0f2f4",
    water: "#dde5ee",
    road: "#ffffff",
    building: "#eceef1",
    label: "#7a808a",
    route: "#006aa7",
    sel: "#e6aa00",
    stopFill: "#ffffff",
    stopLine: "#006aa7",
    delay: { early: "0,106,167", ontime: "17,19,23", late: "214,108,20", verylate: "214,40,30" },
  },
  dark: {
    style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
    land: "#0e1014",
    land2: "#12151a",
    water: "#171c25",
    road: "#1d2128",
    building: "#14171d",
    label: "#5d636e",
    route: "#408cdc",
    sel: "#fecc02",
    stopFill: "#0e1014",
    stopLine: "#408cdc",
    delay: { early: "110,168,240", ontime: "236,237,239", late: "255,138,61", verylate: "255,77,61" },
  },
};

const KEY = "busskoll-theme";
function initial(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // storage blocked (private mode): fall through to the system preference
  }
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

const Ctx = createContext<{ theme: Theme; toggle: () => void }>({ theme: "dark", toggle: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initial);
  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
  }, [theme]);
  const toggle = () =>
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(KEY, next);
      } catch {
        // not persisted; the toggle still works for this visit
      }
      return next;
    });
  return <Ctx.Provider value={{ theme, toggle }}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);

// prefers-reduced-motion, live (users can flip it without reloading).
export function useReducedMotion() {
  const q = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(() => window.matchMedia?.(q).matches ?? false);
  useLayoutEffect(() => {
    const m = window.matchMedia?.(q);
    if (!m) return;
    const on = () => setReduced(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return reduced;
}
