import { useEffect, useRef } from "react";
import maplibregl, { type Map as MLMap } from "maplibre-gl";
import type { Line, Routes, Vehicle, Vehicles } from "../api";
import { BUCKET_LABEL, bucket, buildShape, distAt, easeInOut, fmtDelay, monotonic, pointAt, type Knot, type Shape } from "../lib";
import { MAP_PAINT, useTheme, type MapPaint } from "../theme";

export type Selection = { kind: "bus" | "stop"; id: string } | null;

interface Props {
  routes: Routes | null;
  vehicles: Vehicles | null;
  lines: Set<Line>;
  selected: Selection;
  onSelect: (s: Selection) => void;
  reduced: boolean;
}

// One bus on screen. Its position is a pure function of time: distance along its shape from
// its track (last stop passed -> predicted next stops), so it keeps moving between the
// once-a-minute polls. A new poll doesn't teleport it: for BLEND_MS it eases from where it
// was drawn to where the new track says it is.
interface Anim {
  el: HTMLButtonElement;
  marker: maplibregl.Marker;
  shape: Shape;
  shapeId: string;
  track: Knot[];
  from: number | null; // distance drawn when the latest track arrived
  since: number; // ms timestamp of that moment
}
const BLEND_MS = 1500;
const STEP_MS_REDUCED = 5000; // reduced motion: reposition every 5 s, no tweening
const STOCKHOLM: [number, number] = [18.06, 59.33];

// Re-colour the stock CARTO layers to our palette, by layer id (see their style.json).
function tint(m: MLMap, p: MapPaint) {
  const set = (id: string, prop: string, v: unknown) => {
    try {
      m.setPaintProperty(id, prop, v);
    } catch {
      // a layer missing from this style version: leave it stock
    }
  };
  for (const l of m.getStyle().layers) {
    const id = l.id;
    if (l.type === "background") set(id, "background-color", p.land);
    else if (l.type === "fill") {
      if (id.startsWith("water")) set(id, "fill-color", p.water);
      else if (id.startsWith("building")) set(id, "fill-color", p.building);
      else set(id, "fill-color", p.land2);
    } else if (l.type === "line") {
      if (id === "waterway") set(id, "line-color", p.water);
      else if (id.endsWith("_case") || id.includes("_case_")) set(id, "line-color", p.land);
      else if (/^(road|bridge|tunnel|rail)/.test(id)) set(id, "line-color", p.road);
    } else if (l.type === "symbol") {
      set(id, "text-color", p.label);
      set(id, "text-halo-color", p.land);
    }
  }
}

const sec = (iso: string) => Date.parse(iso) / 1000;
const trackOf = (v: Vehicle) =>
  monotonic([{ t: sec(v.last_stop.time), d: v.last_stop.dist_m }, ...v.next_stops.map((c) => ({ t: sec(c.busskoll), d: c.dist_m }))]);

function distNow(a: Anim, ms: number, reduced: boolean) {
  const target = distAt(a.track, ms / 1000);
  const k = (ms - a.since) / BLEND_MS;
  if (a.from == null || reduced || k >= 1) return target;
  return a.from + (target - a.from) * easeInOut(Math.max(0, k));
}

export default function BusMap({ routes, vehicles, lines, selected, onSelect, reduced }: Props) {
  const { theme } = useTheme();
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const anims = useRef(new Map<string, Anim>());
  const shapes = useRef(new Map<string, Shape>());
  const fitted = useRef(false);
  const styleUrl = useRef(MAP_PAINT[theme].style);
  const styleReady = useRef(false);
  // Latest props for handlers registered once.
  const latest = useRef({ routes, lines, selected, onSelect, theme, reduced });
  latest.current = { routes, lines, selected, onSelect, theme, reduced };

  // ---- map + static layers ------------------------------------------------------
  useEffect(() => {
    const m = new maplibregl.Map({
      container: box.current!,
      style: MAP_PAINT[latest.current.theme].style,
      center: STOCKHOLM,
      zoom: 11.5,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    m.touchZoomRotate.disableRotation();
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.current = m;
    m.on("style.load", () => {
      styleReady.current = true; // first load and every theme switch
      tint(m, MAP_PAINT[latest.current.theme]);
      addLayers(m);
    });
    m.on("click", (e) => {
      const hit = m.getLayer("stops-hit") ? m.queryRenderedFeatures(e.point, { layers: ["stops-hit"] }) : [];
      latest.current.onSelect(hit.length ? { kind: "stop", id: String(hit[0].properties.stop_id) } : null);
    });
    m.on("mouseenter", "stops-hit", () => (m.getCanvas().style.cursor = "pointer"));
    m.on("mouseleave", "stops-hit", () => (m.getCanvas().style.cursor = ""));
    // MapLibre only tracks window resizes; the docked pane also resizes with the layout.
    const ro = new ResizeObserver(() => m.resize());
    ro.observe(box.current!);
    const store = anims.current;
    return () => {
      ro.disconnect();
      store.forEach((a) => a.marker.remove());
      store.clear();
      m.remove();
      map.current = null;
      styleReady.current = false;
      fitted.current = false;
    };
  }, []);

  // Builds sources + layers from the latest routes (no-op until routes and style are in).
  function addLayers(m: MLMap) {
    const { routes, theme } = latest.current;
    // Not isStyleLoaded(): that stays false while basemap tiles stream in, and we'd miss our turn.
    if (!routes || !styleReady.current || m.getSource("routes")) return;
    const p = MAP_PAINT[theme];
    m.addSource("routes", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: routes.routes.flatMap((r) =>
          r.shapes.map((s) => ({ type: "Feature" as const, properties: { line: r.line, shape_id: s.shape_id }, geometry: { type: "LineString" as const, coordinates: s.coords } }))
        ),
      },
    });
    m.addSource("stops", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: routes.stops.map((s) => ({
          type: "Feature" as const,
          properties: { stop_id: s.stop_id, name: s.name, lines: s.lines.join(",") },
          geometry: { type: "Point" as const, coordinates: [s.lon, s.lat] },
        })),
      },
    });
    const round = { "line-join": "round", "line-cap": "round" } as const;
    // Routes as lit tracks: a wide soft glow under a crisp core.
    m.addLayer({ id: "route-glow", type: "line", source: "routes", layout: round, paint: { "line-color": p.route, "line-width": ["interpolate", ["linear"], ["zoom"], 11, 6, 15, 14], "line-blur": 6, "line-opacity": 0.28 } });
    m.addLayer({ id: "route", type: "line", source: "routes", layout: round, paint: { "line-color": p.route, "line-width": ["interpolate", ["linear"], ["zoom"], 11, 1.6, 15, 3.5], "line-opacity": 0.9 } });
    m.addLayer({ id: "route-sel", type: "line", source: "routes", layout: round, paint: { "line-color": p.route, "line-width": ["interpolate", ["linear"], ["zoom"], 11, 4, 15, 7] }, filter: ["==", "shape_id", ""] });
    m.addLayer({
      id: "stops",
      type: "circle",
      source: "stops",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 1.5, 13, 3.5, 16, 6],
        "circle-color": p.stopFill,
        "circle-stroke-color": p.stopLine,
        "circle-stroke-width": 1.5,
      },
    });
    m.addLayer({ id: "stop-sel", type: "circle", source: "stops", paint: { "circle-radius": 8, "circle-color": p.stopFill, "circle-stroke-color": p.route, "circle-stroke-width": 3 }, filter: ["==", "stop_id", ""] });
    // Invisible, finger-sized hit area for stops.
    m.addLayer({ id: "stops-hit", type: "circle", source: "stops", paint: { "circle-radius": 14, "circle-opacity": 0 } });
    applyFilters(m);
    if (!fitted.current && m.getContainer().clientHeight > 0) {
      m.resize(); // frame against the pane's real size, not the size at construction
      // Frame the three routes (after style load: an earlier camera move can be overridden).
      const pts = routes.routes.flatMap((r) => r.shapes.flatMap((s) => s.coords));
      const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
      pts.forEach((pt) => b.extend(pt));
      m.fitBounds(b, { padding: 32, duration: 0 });
      fitted.current = true;
    }
  }

  function applyFilters(m: MLMap) {
    if (!m.getLayer("route")) return;
    const { lines, selected } = latest.current;
    const ls = [...lines];
    const onLine = ["in", ["get", "line"], ["literal", ls]];
    const stopOnLine = ["any", ...ls.map((l) => ["in", l, ["get", "lines"]])];
    for (const id of ["route-glow", "route"]) m.setFilter(id, onLine as maplibregl.FilterSpecification);
    for (const id of ["stops", "stops-hit"]) m.setFilter(id, stopOnLine as maplibregl.FilterSpecification);
    const bus = selected?.kind === "bus" ? anims.current.get(selected.id) : undefined;
    m.setFilter("route-sel", ["==", ["get", "shape_id"], bus?.shapeId ?? ""]);
    m.setFilter("stop-sel", ["==", ["get", "stop_id"], selected?.kind === "stop" ? selected.id : ""]);
  }

  // Theme switch: swap the basemap; style.load re-adds our layers in the new paint.
  useEffect(() => {
    const m = map.current;
    const url = MAP_PAINT[theme].style;
    if (!m || styleUrl.current === url) return;
    styleUrl.current = url;
    styleReady.current = false;
    m.setStyle(url);
  }, [theme]);

  useEffect(() => {
    const m = map.current;
    if (!m || !routes) return;
    shapes.current = new Map(routes.routes.flatMap((r) => r.shapes.map((s) => [s.shape_id, buildShape(s.coords)] as const)));
    addLayers(m); // or style.load does it once the basemap is in
  }, [routes]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- buses: sync markers with each poll ------------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!m || !vehicles) return;
    const now = Date.now();
    const seen = new Set<string>();
    for (const v of vehicles.vehicles) {
      const shape = shapes.current.get(v.shape_id);
      if (!shape) continue;
      seen.add(v.vehicle_id);
      let a = anims.current.get(v.vehicle_id);
      if (a && a.shapeId !== v.shape_id) {
        a.marker.remove(); // same bus started a new trip: no easing across routes
        anims.current.delete(v.vehicle_id);
        a = undefined;
      }
      if (a) {
        a.from = distNow(a, now, latest.current.reduced);
        a.since = now;
        a.track = trackOf(v);
      } else {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "bus";
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          latest.current.onSelect({ kind: "bus", id: v.vehicle_id });
        });
        const track = trackOf(v);
        const marker = new maplibregl.Marker({ element: el }).setLngLat(pointAt(shape, distAt(track, now / 1000))).addTo(m);
        a = { el, marker, shape, shapeId: v.shape_id, track, from: null, since: now };
        anims.current.set(v.vehicle_id, a);
      }
      const b = bucket(v.delay_s);
      a.el.dataset.b = b;
      a.el.textContent = v.line;
      a.el.dataset.line = v.line;
      a.el.setAttribute("aria-label", `Line ${v.line} to ${v.headsign}: ${BUCKET_LABEL[b].toLowerCase()} (${fmtDelay(v.delay_s)})`);
      a.el.title = `${v.line} → ${v.headsign} · ${fmtDelay(v.delay_s)}`;
    }
    for (const [id, a] of anims.current) {
      if (!seen.has(id)) {
        a.marker.remove();
        anims.current.delete(id);
      }
    }
  }, [vehicles, routes]);

  // Line filter + selection: marker visibility/state and the map layers.
  useEffect(() => {
    for (const [id, a] of anims.current) {
      a.el.style.display = lines.has(a.el.dataset.line as Line) ? "" : "none";
      a.el.setAttribute("aria-pressed", String(selected?.kind === "bus" && selected.id === id));
    }
    if (map.current) applyFilters(map.current);
  }, [lines, selected, vehicles]); // eslint-disable-line react-hooks/exhaustive-deps

  // A bus picked from the fleet table may be off screen: bring it into view.
  useEffect(() => {
    const m = map.current;
    const a = selected?.kind === "bus" ? anims.current.get(selected.id) : undefined;
    if (!m || !a) return;
    const at = a.marker.getLngLat();
    if (!m.getBounds().contains(at)) m.easeTo({ center: at, duration: reduced ? 0 : 600 });
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- animation loop ------------------------------------------------------------
  useEffect(() => {
    const place = () => {
      const now = Date.now();
      for (const a of anims.current.values()) {
        if (a.el.style.display === "none") continue;
        a.marker.setLngLat(pointAt(a.shape, distNow(a, now, reduced)));
      }
    };
    if (reduced) {
      place();
      const id = setInterval(place, STEP_MS_REDUCED);
      return () => clearInterval(id);
    }
    let raf = 0;
    const frame = () => {
      place();
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [reduced]);

  return <div ref={box} className="absolute inset-0" role="region" aria-label="Map of lines 1, 4 and 6 with live buses" />;
}
