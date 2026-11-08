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
  stopFill: string;
  stopLine: string;
}
export const MAP_PAINT: Record<Theme, MapPaint> = {
  light: {
    style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
    land: "#e9edf2",
    land2: "#e1e7ee",
    water: "#c9d6e6",
    road: "#ffffff",
    building: "#dde3ea",
    label: "#64748b",
    route: "#1f5fe0",
    stopFill: "#ffffff",
    stopLine: "#1f5fe0",
  },
  dark: {
    style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
    land: "#0b1220",
    land2: "#0d1526",
    water: "#060a13",
    road: "#1a2438",
    building: "#111a2c",
    label: "#5f6f8a",
    route: "#5696ff",
    stopFill: "#070b14",
    stopLine: "#5696ff",
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
