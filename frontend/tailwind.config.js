/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class", // theme.tsx toggles .dark on <html>
  theme: {
    extend: {
      // Every colour is a CSS variable (index.css), so the same classes serve light and dark.
      colors: {
        ink: {
          900: "rgb(var(--ink-900) / <alpha-value>)",
          800: "rgb(var(--ink-800) / <alpha-value>)",
          600: "rgb(var(--ink-600) / <alpha-value>)",
        },
        fg: "rgb(var(--fg) / <alpha-value>)",
        line: "rgb(var(--line) / var(--line-alpha))",
        mute: "rgb(var(--mute) / <alpha-value>)",
        soft: "rgb(var(--soft) / <alpha-value>)",
        signal: "rgb(var(--signal) / <alpha-value>)",
        early: "rgb(var(--early) / <alpha-value>)",
        ontime: "rgb(var(--ontime) / <alpha-value>)",
        late: "rgb(var(--late) / <alpha-value>)",
        verylate: "rgb(var(--verylate) / <alpha-value>)",
      },
      fontFamily: {
        sans: ["Archivo", "system-ui", "sans-serif"],
        mono: ["'IBM Plex Mono'", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      // Print ledger: square corners everywhere (dots stay round via rounded-full).
      borderRadius: { none: "0", DEFAULT: "0", sm: "0", md: "0", lg: "0", xl: "0", full: "9999px" },
    },
  },
  plugins: [],
};
