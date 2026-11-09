/** @type {import('tailwindcss').Config} */
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class", // theme.tsx toggles .dark on <html>
  theme: {
    extend: {
      // Every colour is a CSS variable (index.css), so the same classes serve light and dark.
      colors: {
        bg: v("bg"),
        panel: v("panel"),
        raise: v("raise"),
        edge: v("edge"),
        fg: v("fg"),
        soft: v("soft"),
        mute: v("mute"),
        brand: v("brand"), // flag yellow: Busskoll and "now"
        accent: v("accent"), // flag blue: the blue buses' routes, links
        rival: v("rival"), // SL in comparisons
        early: v("early"),
        ontime: v("ontime"),
        late: v("late"),
        verylate: v("verylate"),
      },
      fontFamily: {
        // Overpass descends from highway-sign lettering; its mono sibling sets times and labels.
        sans: ["Overpass", "system-ui", "sans-serif"],
        mono: ["'Overpass Mono'", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
