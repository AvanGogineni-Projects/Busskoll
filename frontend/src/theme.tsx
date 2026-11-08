import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";

export type Theme = "light" | "dark";

// Colours the map paints itself (MapLibre can't read CSS variables). Kept in step with index.css.
export const MAP_PAINT: Record<Theme, { route: string; stopFill: string; stopLine: string; style: string }> = {
  light: {
    route: "#0b2540",
    stopFill: "#f5f3ec",
    stopLine: "#0b2540",
    style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  },
  dark: {
    route: "#ece9e0",
    stopFill: "#0c0e11",
    stopLine: "#ece9e0",
    style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
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
