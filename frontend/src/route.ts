import { useEffect, useState } from "react";

// Three views, addressed by the URL hash so back/forward and shared links work on a static
// host: #/ (all lines), #/line/4, #/stop/Odenplan (a stop name covers all its platforms).
export type Route = { view: "home" } | { view: "line"; line: string } | { view: "stop"; name: string };

export function parse(hash: string): Route {
  const [kind, ...rest] = hash.replace(/^#\/?/, "").split("/");
  const id = decodeURIComponent(rest.join("/"));
  if (kind === "line" && id) return { view: "line", line: id };
  if (kind === "stop" && id) return { view: "stop", name: id };
  return { view: "home" };
}

export const href = (r: Route) =>
  r.view === "line" ? `#/line/${encodeURIComponent(r.line)}` : r.view === "stop" ? `#/stop/${encodeURIComponent(r.name)}` : "#/";

export const go = (r: Route) => {
  window.location.hash = href(r);
};

export function useRoute() {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parse(window.location.hash));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
