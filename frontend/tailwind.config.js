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
        accent: v("accent"),
        rival: v("rival"), // SL's colour in head-to-head charts
        led: v("led"),
        board: v("board"), // departure board: dark in both themes, like real signage
        "board-fg": v("board-fg"),
        "board-mute": v("board-mute"),
        early: v("early"),
        ontime: v("ontime"),
        late: v("late"),
        verylate: v("verylate"),
      },
      fontFamily: {
        sans: ["'Instrument Sans'", "system-ui", "sans-serif"],
        mono: ["'JetBrains Mono'", "ui-monospace", "SFMono-Regular", "monospace"],
        dot: ["Doto", "'JetBrains Mono'", "monospace"],
      },
    },
  },
  plugins: [],
};
