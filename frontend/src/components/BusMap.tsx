import { useEffect, useRef } from "react";
import maplibregl, { type ExpressionSpecification, type GeoJSONSource, type Map as MLMap } from "maplibre-gl";
import type { Line, Routes, Vehicle, Vehicles } from "../api";
import { BUCKET_LABEL, bucket, buildShape, distAt, easeInOut, fmtDelay, monotonic, pointAt, sliceShape, type Bucket, type Knot, type Shape } from "../lib";
import { MAP_PAINT, useTheme, type MapPaint } from "../theme";

export type Selection = { kind: "bus" | "stop"; id: string } | null;

interface Props {
  routes: Routes | null;
  vehicles: Vehicles | null;
  lines: Set<Line>;
  selected: Selection;
  onSelect: (s: Selection) => void;
  hover: Line | null; // a line to spotlight (map hover or the header's line buttons)
  onHover: (l: Line | null) => void;
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
const BUCKETS: Bucket[] = ["early", "ontime", "late", "verylate"];
const TRAIL_PX = 90; // light trail behind each bus, a constant length on screen at any zoom
const DRAW_MS = 1800; // routes draw themselves in on first load
// Metres per screen pixel at Stockholm's latitude (512 px tiles).
const mpp = (zoom: number) => (40_075_016.686 * Math.cos((59.33 * Math.PI) / 180)) / (512 * 2 ** zoom);

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

export default function BusMap({ routes, vehicles, lines, selected, onSelect, hover, onHover, reduced }: Props) {
  const { theme } = useTheme();
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const anims = useRef(new Map<string, Anim>());
  const shapes = useRef(new Map<string, Shape>());
  const fitted = useRef(false);
  const styleUrl = useRef(MAP_PAINT[theme].style);
  const styleReady = useRef(false);
  const drawn = useRef(false); // the draw-in plays once per page load
  // Latest props for handlers registered once.
  const latest = useRef({ routes, lines, selected, onSelect, hover, onHover, theme, reduced });
  latest.current = { routes, lines, selected, onSelect, hover, onHover, theme, reduced };

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
      // The map sits in a scrolling page: wheel/one finger scroll the page, ctrl+wheel/two fingers move the map.
      cooperativeGestures: true,
    });
    if (!latest.current.reduced) box.current!.classList.add("intro"); // buses wait for the routes to draw
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
    m.on("mousemove", "route-hit", (e) => {
      const l = e.features?.[0]?.properties.line as Line | undefined;
      if (l && l !== latest.current.hover) latest.current.onHover(l);
    });
    m.on("mouseleave", "route-hit", () => latest.current.onHover(null));
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
      lineMetrics: true, // for the draw-in gradient
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
    // Routes printed as solid spot-colour lines.
    m.addLayer({ id: "route", type: "line", source: "routes", layout: round, paint: { "line-color": p.route, "line-width": ["interpolate", ["linear"], ["zoom"], 11, 2.5, 15, 5] } });
    m.addLayer({ id: "route-hit", type: "line", source: "routes", layout: round, paint: { "line-width": 16, "line-opacity": 0 } });
    // Light trails: where each bus just came from, fading out behind it, coloured by its delay.
    m.addSource("trails", { type: "geojson", lineMetrics: true, data: { type: "FeatureCollection", features: [] } });
    for (const b of BUCKETS) {
      const c = p.delay[b];
      const fade = (a: number): ExpressionSpecification => ["interpolate", ["linear"], ["line-progress"], 0, `rgba(${c},0)`, 1, `rgba(${c},${a})`];
      const filter: ExpressionSpecification = ["==", ["get", "b"], b];
      m.addLayer({ id: `trail-${b}`, type: "line", source: "trails", filter, layout: round, paint: { "line-width": 4, "line-gradient": fade(0.85) } });
    }
    m.addLayer({ id: "route-sel", type: "line", source: "routes", layout: round, paint: { "line-color": p.sel, "line-width": ["interpolate", ["linear"], ["zoom"], 11, 5, 15, 8] }, filter: ["==", "shape_id", ""] });
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
    m.addLayer({ id: "stop-sel", type: "circle", source: "stops", paint: { "circle-radius": 8, "circle-color": p.stopFill, "circle-stroke-color": p.sel, "circle-stroke-width": 3 }, filter: ["==", "stop_id", ""] });
    // Invisible, finger-sized hit area for stops.
    m.addLayer({ id: "stops-hit", type: "circle", source: "stops", paint: { "circle-radius": 14, "circle-opacity": 0 } });
    applyFilters(m);
    applyHover(m);
    drawIn(m);
    if (!fitted.current && m.getContainer().clientHeight > 0) {
      m.resize(); // frame against the pane's real size, not the size at construction
      // After style load: an earlier camera move can be overridden.
      // Frame the lines being shown (one line on its own page, the whole network on the home page).
      const shown = routes.routes.filter((r) => latest.current.lines.has(r.line));
      const pts = (shown.length ? shown : routes.routes).flatMap((r) => r.shapes.flatMap((s) => s.coords));
      const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
      pts.forEach((pt) => b.extend(pt));
      m.fitBounds(b, { padding: { top: 32, bottom: 48, right: 56, left: 32 }, duration: 0 });
      fitted.current = true;
    }
  }

  function applyFilters(m: MLMap) {
    if (!m.getLayer("route")) return;
    const { lines, selected } = latest.current;
    const ls = [...lines];
    const onLine = ["in", ["get", "line"], ["literal", ls]];
    const stopOnLine = ["any", ...ls.map((l) => ["in", l, ["get", "lines"]])];
    for (const id of ["route"]) m.setFilter(id, onLine as maplibregl.FilterSpecification);
    for (const id of ["stops", "stops-hit"]) m.setFilter(id, stopOnLine as maplibregl.FilterSpecification);
    const bus = selected?.kind === "bus" ? anims.current.get(selected.id) : undefined;
    m.setFilter("route-sel", ["==", ["get", "shape_id"], bus?.shapeId ?? ""]);
    m.setFilter("stop-sel", ["==", ["get", "stop_id"], selected?.kind === "stop" ? selected.id : ""]);
  }

  // Routes draw themselves in, then the buses appear (skipped under reduced motion).
  function drawIn(m: MLMap) {
    const box = m.getContainer();
    if (drawn.current || latest.current.reduced) return box.classList.remove("intro");
    drawn.current = true;
    const color = MAP_PAINT[latest.current.theme].route;
    const t0 = performance.now();
    const step = () => {
      if (!m.getLayer("route")) return box.classList.remove("intro"); // style swapped mid-draw
      const k = Math.min(1, (performance.now() - t0) / DRAW_MS);
      m.setPaintProperty("route", "line-gradient", k < 1 ? ["step", ["line-progress"], color, easeInOut(k), "rgba(0,0,0,0)"] : undefined);
      if (k < 1) requestAnimationFrame(step);
      else box.classList.remove("intro");
    };
    requestAnimationFrame(step);
  }

  // Spotlight one line: the others, their stops, trails and buses dim.
  function applyHover(m: MLMap) {
    if (!m.getLayer("route")) return;
    const h = latest.current.hover;
    const on = (yes: number, no: number): ExpressionSpecification | number => (h ? ["case", ["==", ["get", "line"], h], yes, no] : yes);
    m.setPaintProperty("route", "line-opacity", on(1, 0.15));
    for (const b of BUCKETS) {
      m.setPaintProperty(`trail-${b}`, "line-opacity", on(1, 0.12));
    }
    const stopOn = h ? (["case", ["in", h, ["get", "lines"]], 1, 0.15] as ExpressionSpecification) : 1;
    m.setPaintProperty("stops", "circle-opacity", stopOn);
    m.setPaintProperty("stops", "circle-stroke-opacity", stopOn);
    for (const a of anims.current.values()) a.el.classList.toggle("dim", !!h && a.el.dataset.line !== h);
  }

  useEffect(() => {
    if (map.current) applyHover(map.current);
  }, [hover, vehicles]); // eslint-disable-line react-hooks/exhaustive-deps

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
        el.innerHTML = '<span class="dir" aria-hidden="true"></span><span class="num"></span>';
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
      a.el.querySelector(".num")!.textContent = v.line;
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
    let tick = 0;
    const place = () => {
      const now = Date.now();
      const m = map.current;
      const trails = m?.getSource("trails") as GeoJSONSource | undefined;
      const drawTrails = !!trails && tick++ % 2 === 0; // half rate is plenty for a fading tail
      const back = m ? TRAIL_PX * mpp(m.getZoom()) : 0;
      const feats: GeoJSON.Feature[] = [];
      for (const a of anims.current.values()) {
        if (a.el.style.display === "none") continue;
        const d = distNow(a, now, reduced);
        const at = pointAt(a.shape, d);
        a.marker.setLngLat(at);
        if (!m) continue;
        // Heading arrow: the on-screen direction of the shape just ahead of the bus.
        const p0 = m.project(at);
        const p1 = m.project(pointAt(a.shape, d + 30));
        if (Math.hypot(p1.x - p0.x, p1.y - p0.y) > 0.5) a.el.style.setProperty("--rot", `${Math.atan2(p1.y - p0.y, p1.x - p0.x)}rad`);
        if (drawTrails && d > 5)
          feats.push({ type: "Feature", properties: { b: a.el.dataset.b, line: a.el.dataset.line }, geometry: { type: "LineString", coordinates: sliceShape(a.shape, Math.max(0, d - back), d) } });
      }
      if (drawTrails) trails.setData({ type: "FeatureCollection", features: feats });
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

  return <div ref={box} className="absolute inset-0" role="region" aria-label="Map of lines 1, 4, 6 and 179 with live buses" />;
}
