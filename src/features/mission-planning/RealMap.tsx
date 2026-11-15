import { CloudDownload, Home as HomeIcon, Layers, LocateFixed, Maximize, Minus, Mountain, Navigation, Plus, WifiOff, X } from "lucide-react";
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as MlMap, Marker, StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre 6 runs its tile work in a module worker; under a bundler it has to be told where that file is.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { useEffect, useRef, useState } from "react";
import { covers, sampleDem } from "../../geo/elevation";
import { circleRing } from "../../geo/fence";
import { distanceM, parseLatLon, tilesIn, tileUrl, toGlobal, toLocal, type LatLon } from "../../geo/geo";
import { ELEVATION, IMAGERY, imageryById, imageryUrl, KEPT } from "../../geo/sources";
import { clearKept, keptCount, keptFetch, saveTiles } from "../../geo/tileCache";
import { useHomeSource } from "../../services/link/homeFollow";
import { useLink } from "../../state/linkStore";
import { useDem, useMapPrefs } from "../../state/mapStore";
import { notify } from "../../state/notifyStore";
import { ZONE_COLOR, type FenceLayer } from "./fenceLayer";

/*
  The route on a real map: a satellite picture over measured ground.

  Everything the plan holds is in metres from home, so this converts at the
  edge, on the way in and on the way out. Waypoints and home are dragged
  where the old map had number boxes; the aircraft, when one is linked, is
  drawn where its own GPS says it is.

  The picture is evidence of where things are, not of what is in the way: it
  may be years old, and the ground heights know nothing of trees or wires.
*/
export interface RealMapProps {
  home: LatLon;
  route: { id: string; n: number; e: number; label: string; tag?: string }[];
  closeRoute?: boolean;
  /** A second path, such as a predicted flight. */
  ghost?: { n: number; e: number }[];
  fenceRadius?: number | null;
  mark?: { n: number; e: number; label: string; tone: "ok" | "bad" } | null;
  /** Where the route comes closest to the ground, when that is worth showing. */
  low?: { n: number; e: number; clear: number } | null;
  wind?: { speed: number; fromDeg: number } | null;
  /** Home cannot be moved: an aircraft is flying from it. */
  homeLocked?: boolean;
  onPick?: (n: number, e: number) => void;
  onMovePoint?: (id: string, n: number, e: number) => void;
  onMoveHome?: (to: LatLon) => void;
  /** The fence zones, and their editing when the Fence tab is open. */
  fenceLayer?: FenceLayer;
}

const kept = (url: string) => url.replace("https://", KEPT);

let protocolReady = false;
function registerProtocol() {
  if (protocolReady) return;
  protocolReady = true;
  maplibregl.setWorkerUrl(workerUrl);
  // Tiles from open sources go through the app's own store, so they survive the field.
  maplibregl.addProtocol("aeronex", async (params, abort) => {
    const res = await keptFetch(`https://${params.url.slice(KEPT.length)}`, abort.signal);
    if (!res.ok) throw new Error(`Tile ${res.status}`);
    return { data: await res.arrayBuffer() };
  });
}

type Shape = Parameters<GeoJSONSource["setData"]>[0];
const EMPTY = { type: "FeatureCollection" as const, features: [] };
const line = (pts: LatLon[]) => ({ type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: pts.map((p) => [p.lon, p.lat]) } });

function baseStyle(): StyleSpecification {
  const dem = { type: "raster-dem" as const, tiles: [kept(ELEVATION.url)], tileSize: ELEVATION.tileSize, maxzoom: ELEVATION.maxZoom, encoding: "terrarium" as const };
  return {
    version: 8,
    sources: {
      // One for the 3D ground and one for the shading, as the library advises.
      dem,
      shade: dem,
      fence: { type: "geojson", data: EMPTY },
      zones: { type: "geojson", data: EMPTY },
      zonedraft: { type: "geojson", data: EMPTY },
      route: { type: "geojson", data: EMPTY },
      ghost: { type: "geojson", data: EMPTY },
      track: { type: "geojson", data: EMPTY },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": "#e9e5da" } },
      { id: "shade", type: "hillshade", source: "shade", paint: { "hillshade-exaggeration": 0.4, "hillshade-shadow-color": "#3b4763", "hillshade-highlight-color": "#ffffff", "hillshade-accent-color": "#5d677d" } },
      { id: "fence", type: "line", source: "fence", paint: { "line-color": "#ff6b57", "line-width": 2, "line-dasharray": [3, 2] } },
      // Keep-out zones are shaded; keep-in zones are only edged, so the ground inside stays readable.
      { id: "zones-fill", type: "fill", source: "zones", paint: { "fill-color": ["match", ["get", "role"], "out", ZONE_COLOR.out, ZONE_COLOR.in], "fill-opacity": ["match", ["get", "role"], "out", ["case", ["get", "sel"], 0.3, 0.2], ["case", ["get", "sel"], 0.1, 0.03]] } },
      { id: "zones-halo", type: "line", source: "zones", layout: { "line-join": "round" }, paint: { "line-color": "#fdfcf8", "line-width": ["case", ["get", "sel"], 6, 4.5], "line-opacity": 0.85 } },
      { id: "zones-line", type: "line", source: "zones", filter: ["!", ["get", "bad"]], layout: { "line-join": "round" }, paint: { "line-color": ["match", ["get", "role"], "out", ZONE_COLOR.out, ZONE_COLOR.in], "line-width": ["case", ["get", "sel"], 3.5, 2.5] } },
      { id: "zones-bad", type: "line", source: "zones", filter: ["get", "bad"], paint: { "line-color": ["match", ["get", "role"], "out", ZONE_COLOR.out, ZONE_COLOR.in], "line-width": ["case", ["get", "sel"], 3.5, 2.5], "line-dasharray": [2, 1.5] } },
      { id: "zonedraft", type: "line", source: "zonedraft", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["match", ["get", "role"], "out", ZONE_COLOR.out, ZONE_COLOR.in], "line-width": 2.5, "line-dasharray": [1.5, 1.2] } },
      { id: "route-edge", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#0d1629", "line-width": 6, "line-opacity": 0.7 } },
      { id: "route", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#f28c38", "line-width": 3 } },
      { id: "ghost", type: "line", source: "ghost", paint: { "line-color": "#9a7fe0", "line-width": 2.5, "line-dasharray": [2, 1.5] } },
      { id: "track", type: "line", source: "track", paint: { "line-color": "#2f6fe4", "line-width": 2.5 } },
    ],
  };
}

function dot(cls: string, label: string, tag?: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = cls;
  const b = document.createElement("b");
  b.textContent = label;
  el.append(b);
  if (tag) {
    const s = document.createElement("span");
    s.textContent = tag;
    el.append(s);
  }
  // A click on a marker is not a click on the map.
  el.addEventListener("click", (e) => e.stopPropagation());
  return el;
}

export default function RealMap(props: RealMapProps) {
  const { home, route, closeRoute, ghost, fenceRadius, mark, low, wind, homeLocked } = props;
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const marks = useRef(new Map<string, Marker>());
  const homeMark = useRef<Marker | null>(null);
  const extra = useRef<{ mark: Marker | null; low: Marker | null; ac: Marker | null }>({ mark: null, low: null, ac: null });
  const trail = useRef<LatLon[]>([]);
  const handles = useRef(new Map<string, Marker>());
  const handleSig = useRef("");
  // A handle is being dragged: leave the markers where the pointer has them.
  const dragging = useRef(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [panel, setPanel] = useState(false);
  const [pointer, setPointer] = useState<LatLon | null>(null);
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  const [saved, setSaved] = useState(0);
  const [saving, setSaving] = useState<{ done: number; total: number } | null>(null);
  const [goto, setGoto] = useState("");
  // The next click on the map puts home there, instead of adding a waypoint.
  const [placing, setPlacing] = useState(false);
  const placingRef = useRef(false);
  placingRef.current = placing;
  const stopSave = useRef<AbortController | null>(null);

  const prefs = useMapPrefs();
  const src = imageryById(prefs.imagery);
  const url = imageryUrl(src, prefs.keys, prefs.customUrl);
  const patch = useDem((s) => s.patch);
  const linked = useLink((s) => s.status === "connected");
  const virtual = useLink((s) => s.virtual);
  const pos = useLink((s) => s.telemetry.position?.value);
  const hudHeading = useLink((s) => s.telemetry.hud?.value.heading);
  const sats = useLink((s) => s.telemetry.gps?.value.satellites ?? null);
  const homeFrom = useHomeSource((h) => h.source);
  const taken = useHomeSource((h) => h.taken);

  /** Home, the route and whatever else is drawn, as a box to fit the view to. */
  const fit = (animate = true) => {
    const map = mapRef.current;
    if (!map) return;
    const p = latest.current;
    const b = new maplibregl.LngLatBounds();
    const see = (n: number, e: number) => {
      const g = toGlobal(p.home, n, e);
      b.extend([g.lon, g.lat]);
    };
    // Never closer than a few fields, so home alone still shows its surroundings.
    see(350, 350);
    see(-350, -350);
    p.route.forEach((r) => see(r.n, r.e));
    p.ghost?.forEach((r) => see(r.n, r.e));
    if (p.mark) see(p.mark.n, p.mark.e);
    map.fitBounds(b, { padding: 64, maxZoom: 16, duration: animate ? 500 : 0 });
  };

  /* ------------------------------------------------------------- the map */
  useEffect(() => {
    if (!box.current) return;
    registerProtocol();
    let map: MlMap;
    try {
      map = new maplibregl.Map({
        container: box.current,
        style: baseStyle(),
        center: [latest.current.home.lon, latest.current.home.lat],
        zoom: 15,
        maxPitch: 75,
        // The ground heights are used whatever picture is shown, so they are always credited.
        attributionControl: { compact: true, customAttribution: ELEVATION.attribution },
        // The picture is all there is to see: no need to keep drawing copies of the world.
        renderWorldCopies: false,
      });
    } catch (e) {
      setFailed((e as Error).message || "This browser could not start the map.");
      return;
    }
    mapRef.current = map;
    map.addControl(new maplibregl.ScaleControl({ unit: "metric", maxWidth: 120 }), "top-left");
    map.dragRotate.enable();
    map.on("load", () => {
      fit(false);
      setReady(true);
    });
    map.on("click", (ev) => {
      const p = latest.current;
      if (placingRef.current) {
        setPlacing(false);
        p.onMoveHome?.({ lat: ev.lngLat.lat, lon: ev.lngLat.lng });
        return;
      }
      // With the Fence tab open a click picks a zone, or places a corner of the one being drawn; it never adds a waypoint.
      const f = p.fenceLayer;
      if (f?.editing && !f.drawing) {
        const hit = map.queryRenderedFeatures(ev.point, { layers: ["zones-fill", "zones-line", "zones-bad"] })[0];
        f.onSelect?.(hit ? String(hit.properties?.id) : null);
        return;
      }
      if (!p.onPick) return;
      const l = toLocal(p.home, ev.lngLat.lat, ev.lngLat.lng);
      p.onPick(l.n, l.e);
    });
    let last = 0;
    map.on("mousemove", (ev) => {
      const now = performance.now();
      if (now - last < 80) return;
      last = now;
      setPointer({ lat: ev.lngLat.lat, lon: ev.lngLat.lng });
    });
    map.on("mouseout", () => setPointer(null));
    const esc = (ev: KeyboardEvent) => ev.key === "Escape" && setPlacing(false);
    window.addEventListener("keydown", esc);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    const sized = new ResizeObserver(() => map.resize());
    sized.observe(box.current);
    void keptCount().then(setSaved);
    const held = marks.current;
    const others = extra.current;
    const grips = handles.current;
    return () => {
      window.removeEventListener("keydown", esc);
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
      sized.disconnect();
      stopSave.current?.abort();
      held.clear();
      grips.clear();
      homeMark.current = null;
      others.mark = others.low = others.ac = null;
      mapRef.current = null;
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------------------------------------------------- the picture */
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    if (map.getLayer("imagery")) map.removeLayer("imagery");
    if (map.getSource("imagery")) map.removeSource("imagery");
    if (!url) return;
    map.addSource("imagery", { type: "raster", tiles: [src.keep ? kept(url) : url], tileSize: src.tileSize, maxzoom: src.maxZoom, attribution: src.attribution });
    map.addLayer({ id: "imagery", type: "raster", source: "imagery", paint: { "raster-fade-duration": 150 } }, "shade");
  }, [ready, url, src]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    map.setLayoutProperty("shade", "visibility", prefs.shading ? "visible" : "none");
  }, [ready, prefs.shading]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    map.setTerrain(prefs.relief3d ? { source: "dem", exaggeration: 1 } : null);
    map.easeTo({ pitch: prefs.relief3d ? 58 : 0, bearing: prefs.relief3d ? map.getBearing() : 0, duration: 600 });
  }, [ready, prefs.relief3d]);

  /* ------------------------------------------------------------ the plan */
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const g = (p: { n: number; e: number }) => toGlobal(home, p.n, p.e);
    const set = (id: string, data: unknown) => (map.getSource(id) as GeoJSONSource | undefined)?.setData(data as Shape);

    const pts = [home, ...route.map(g), ...(closeRoute && route.length ? [home] : [])];
    set("route", pts.length > 1 ? line(pts) : EMPTY);
    set("ghost", ghost && ghost.length > 1 ? line(ghost.map(g)) : EMPTY);
    if (fenceRadius) {
      const ring: LatLon[] = [];
      for (let a = 0; a <= 360; a += 5) ring.push(toGlobal(home, fenceRadius * Math.cos((a * Math.PI) / 180), fenceRadius * Math.sin((a * Math.PI) / 180)));
      set("fence", line(ring));
    } else set("fence", EMPTY);

    // Home.
    if (!homeMark.current) {
      const m = new maplibregl.Marker({ element: dot("rmap-home", "H"), draggable: true }).setLngLat([home.lon, home.lat]).addTo(map);
      m.on("dragend", () => {
        const at = m.getLngLat();
        latest.current.onMoveHome?.({ lat: at.lat, lon: at.lng });
      });
      homeMark.current = m;
    }
    homeMark.current.setLngLat([home.lon, home.lat]);
    homeMark.current.setDraggable(!!props.onMoveHome && !homeLocked);
    homeMark.current.getElement().title = homeFrom === "aircraft" ? "Home: the aircraft's GPS position. It follows the aircraft while it is linked." : homeLocked ? "Home: the aircraft is flying from here" : "Home. Drag to move it; the waypoints stay where they are.";

    // Waypoints: keep the markers that are still wanted, so a drag is not cut short.
    const want = new Set(route.map((r) => r.id));
    for (const [id, m] of marks.current) {
      if (!want.has(id)) {
        m.remove();
        marks.current.delete(id);
      }
    }
    for (const r of route) {
      const at = g(r);
      let m = marks.current.get(r.id);
      const sig = `${r.label}|${r.tag ?? ""}`;
      if (m && m.getElement().dataset.sig !== sig) {
        m.remove();
        m = undefined;
      }
      if (!m) {
        const el = dot("rmap-wp", r.label, r.tag);
        el.dataset.sig = sig;
        el.title = `Waypoint ${r.label}. Drag to move it.`;
        const made = new maplibregl.Marker({ element: el, draggable: !!props.onMovePoint }).setLngLat([at.lon, at.lat]).addTo(map);
        made.on("dragend", () => {
          const p = latest.current;
          const ll = made.getLngLat();
          const l = toLocal(p.home, ll.lat, ll.lng);
          p.onMovePoint?.(r.id, l.n, l.e);
        });
        marks.current.set(r.id, made);
        m = made;
      }
      m.setLngLat([at.lon, at.lat]);
    }

    const place = (key: "mark" | "low", cls: string, label: string | null, where: { n: number; e: number } | null | undefined) => {
      extra.current[key]?.remove();
      extra.current[key] = null;
      if (!where || !label) return;
      const at = g(where);
      extra.current[key] = new maplibregl.Marker({ element: dot(cls, "", label) }).setLngLat([at.lon, at.lat]).addTo(map);
    };
    place("mark", `rmap-mark ${mark?.tone ?? "ok"}`, mark?.label ?? null, mark);
    place("low", "rmap-low", low ? (low.clear < 0 ? `${Math.round(-low.clear)} m into the ground` : `${Math.round(low.clear)} m clear`) : null, low);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, home, route, closeRoute, ghost, fenceRadius, mark, low, homeLocked, homeFrom, !!props.onMoveHome, !!props.onMovePoint]);

  /* ----------------------------------------------------------- the fence */
  const fl = props.fenceLayer;
  // The pointer matters to the fence only while a zone is being drawn.
  const drawPointer = fl?.drawing ? pointer : null;
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const set = (id: string, data: unknown) => (map.getSource(id) as GeoJSONSource | undefined)?.setData(data as Shape);
    const ring = (pts: LatLon[]) => [...pts, pts[0]].map((p) => [p.lon, p.lat]);
    const zones = fl?.zones ?? [];
    set("zones", {
      type: "FeatureCollection",
      features: zones
        .filter((z) => (z.shape === "polygon" ? z.points.length >= 3 : z.radiusM > 0))
        .map((z) => ({
          type: "Feature",
          properties: { id: z.id, role: z.role, sel: fl?.editing && fl.selected === z.id, bad: fl?.bad.includes(z.id) ?? false },
          geometry: { type: "Polygon", coordinates: [z.shape === "polygon" ? ring(z.points) : circleRing(z.centre, z.radiusM).map((p) => [p.lon, p.lat])] },
        })),
    });
    // The shape being drawn, with a line on to the pointer.
    const d = fl?.drawing;
    if (d && d.points.length) {
      const pts = d.shape === "circle" ? [d.points[0], ...(drawPointer ? [drawPointer] : [])] : [...d.points, ...(drawPointer ? [drawPointer] : [])];
      const feats: unknown[] = [{ type: "Feature", properties: { role: d.role }, geometry: { type: "LineString", coordinates: pts.map((p) => [p.lon, p.lat]) } }];
      if (d.shape === "circle" && drawPointer) {
        feats.push({ type: "Feature", properties: { role: d.role }, geometry: { type: "LineString", coordinates: circleRing(d.points[0], distanceM(d.points[0], drawPointer)).map((p) => [p.lon, p.lat]) } });
      }
      set("zonedraft", { type: "FeatureCollection", features: feats });
    } else set("zonedraft", EMPTY);

    /*
      Handles: the corners of the selected zone (drag to move, right-click to
      remove), a + on each edge to add a corner, a circle's centre and its
      edge. They are rebuilt only when what they are for changes, so a drag
      in progress is not cut short by the store updating under it.
    */
    const sel = fl?.editing && !d ? zones.find((z) => z.id === fl.selected) : undefined;
    const sig = d ? `draw:${d.shape}:${d.points.length}` : sel ? `${sel.id}:${sel.shape}:${sel.shape === "polygon" ? sel.points.length : 1}` : "";
    const grip = (key: string, cls: string, at: LatLon, title: string, draggable: boolean) => {
      let m = handles.current.get(key);
      if (!m) {
        const el = document.createElement("div");
        el.className = `rmap-grip ${cls}`;
        el.title = title;
        el.addEventListener("click", (e) => e.stopPropagation());
        m = new maplibregl.Marker({ element: el, draggable }).setLngLat([at.lon, at.lat]).addTo(map);
        handles.current.set(key, m);
      } else if (!dragging.current) m.setLngLat([at.lon, at.lat]);
      return m;
    };
    if (sig !== handleSig.current) {
      for (const m of handles.current.values()) m.remove();
      handles.current.clear();
      handleSig.current = sig;
      const call = () => latest.current.fenceLayer;
      const ll = (m: Marker): LatLon => ({ lat: m.getLngLat().lat, lon: m.getLngLat().lng });
      if (d) {
        d.points.forEach((p, i) => {
          const closes = i === 0 && d.shape === "polygon" && d.points.length >= 3;
          const m = grip(`d${i}`, `draw${closes ? " closes" : ""}`, p, closes ? "Click to close the shape" : `Corner ${i + 1}`, false);
          if (closes) m.getElement().addEventListener("click", () => call()?.onClose?.());
        });
      } else if (sel?.shape === "polygon") {
        sel.points.forEach((p, i) => {
          const m = grip(`v${i}`, "vertex", p, `Corner ${i + 1}: drag to move. Right-click to remove.`, true);
          m.on("dragstart", () => {
            dragging.current = true;
            call()?.onVertex?.(sel.id, i, ll(m), "start");
          });
          m.on("drag", () => call()?.onVertex?.(sel.id, i, ll(m), "move"));
          m.on("dragend", () => {
            dragging.current = false;
            call()?.onVertex?.(sel.id, i, ll(m), "end");
          });
          m.getElement().addEventListener("contextmenu", (e) => {
            e.preventDefault();
            call()?.onRemoveVertex?.(sel.id, i);
          });
          const next = sel.points[(i + 1) % sel.points.length];
          const mid = { lat: (p.lat + next.lat) / 2, lon: (p.lon + next.lon) / 2 };
          const plus = grip(`m${i}`, "mid", mid, "Add a corner here", false);
          plus.getElement().addEventListener("click", () => {
            const z = call()?.zones.find((x) => x.id === sel.id);
            if (z?.shape !== "polygon") return;
            const a = z.points[i];
            const b = z.points[(i + 1) % z.points.length];
            call()?.onInsert?.(sel.id, i + 1, { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 });
          });
        });
      } else if (sel?.shape === "circle") {
        const c = grip("c", "centre", sel.centre, "Centre: drag to move the circle", true);
        c.on("dragstart", () => {
          dragging.current = true;
          call()?.onCentre?.(sel.id, ll(c), "start");
        });
        c.on("drag", () => call()?.onCentre?.(sel.id, ll(c), "move"));
        c.on("dragend", () => {
          dragging.current = false;
          call()?.onCentre?.(sel.id, ll(c), "end");
        });
        const r = grip("r", "radius", toGlobal(sel.centre, 0, sel.radiusM), "Edge: drag to change the radius", true);
        const radius = (phase: "start" | "move" | "end") => {
          const z = call()?.zones.find((x) => x.id === sel.id);
          if (z?.shape === "circle") call()?.onRadius?.(sel.id, Math.max(1, Math.round(distanceM(z.centre, ll(r)))), phase);
        };
        r.on("dragstart", () => {
          dragging.current = true;
          radius("start");
        });
        r.on("drag", () => radius("move"));
        r.on("dragend", () => {
          dragging.current = false;
          radius("end");
        });
      }
    } else if (sel?.shape === "polygon" && !dragging.current) {
      // Same handles, new positions: follow the zone (an undo, or a corner typed elsewhere).
      sel.points.forEach((p, i) => {
        handles.current.get(`v${i}`)?.setLngLat([p.lon, p.lat]);
        const next = sel.points[(i + 1) % sel.points.length];
        handles.current.get(`m${i}`)?.setLngLat([(p.lon + next.lon) / 2, (p.lat + next.lat) / 2]);
      });
    } else if (sel?.shape === "circle") {
      const c = handles.current.get("c");
      if (c && !dragging.current) c.setLngLat([sel.centre.lon, sel.centre.lat]);
      const r = handles.current.get("r");
      const edge = toGlobal(sel.centre, 0, sel.radiusM);
      if (r && !dragging.current) r.setLngLat([edge.lon, edge.lat]);
    }
  }, [ready, fl, drawPointer]);

  // Home has just been taken from an aircraft's GPS: show it.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !taken) return;
    const h = latest.current.home;
    if (!map.getBounds().contains([h.lon, h.lat])) fit(false);
    setPlacing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, taken]);

  // Home moved a long way (a new field, or the aircraft's own position): go there.
  const lastHome = useRef(home);
  useEffect(() => {
    const was = lastHome.current;
    lastHome.current = home;
    const moved = toLocal(was, home.lat, home.lon);
    if (ready && Math.hypot(moved.n, moved.e) > 1500) fit(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, home]);

  /* -------------------------------------------------------- the aircraft */
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const has = linked && pos && (pos.lat !== 0 || pos.lon !== 0);
    if (!has) {
      extra.current.ac?.remove();
      extra.current.ac = null;
      if (trail.current.length) {
        trail.current = [];
        (map.getSource("track") as GeoJSONSource | undefined)?.setData(EMPTY);
      }
      return;
    }
    if (!extra.current.ac) {
      const el = document.createElement("div");
      el.className = `rmap-ac${virtual ? " virtual" : ""}`;
      el.innerHTML = '<svg viewBox="-12 -12 24 24" aria-hidden="true"><path d="M0,-10 L7,8 L0,4 L-7,8 Z"/></svg>';
      el.title = virtual ? "The virtual aircraft" : "Your aircraft, where its GPS says it is";
      extra.current.ac = new maplibregl.Marker({ element: el, rotationAlignment: "map", pitchAlignment: "map" }).setLngLat([pos.lon, pos.lat]).addTo(map);
    }
    extra.current.ac.setLngLat([pos.lon, pos.lat]);
    extra.current.ac.setRotation(pos.heading ?? hudHeading ?? 0);
    const t = trail.current;
    const prev = t[t.length - 1];
    if (!prev || Math.abs(prev.lat - pos.lat) + Math.abs(prev.lon - pos.lon) > 2e-6) {
      t.push({ lat: pos.lat, lon: pos.lon });
      if (t.length > 2000) t.splice(0, t.length - 2000);
      if (t.length > 1) (map.getSource("track") as GeoJSONSource | undefined)?.setData(line(t) as Shape);
    }
  }, [ready, linked, virtual, pos, hudHeading]);

  /* ------------------------------------------------------------- actions */
  const zoom = (by: number) => mapRef.current?.easeTo({ zoom: mapRef.current.getZoom() + by, duration: 250 });

  const toMe = () => {
    if (!navigator.geolocation) return notify("warn", "This browser cannot tell where it is");
    navigator.geolocation.getCurrentPosition(
      (p) => mapRef.current?.flyTo({ center: [p.coords.longitude, p.coords.latitude], zoom: 16 }),
      () => notify("warn", "Your location is not available", "Allow location for this page in the browser, or type the coordinates in Layers."),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const go = () => {
    const at = parseLatLon(goto);
    if (!at) return notify("warn", "That is not a place", "Type a latitude and a longitude, such as 23.0225, 72.5714.");
    mapRef.current?.flyTo({ center: [at.lon, at.lat], zoom: 16 });
  };

  const saveArea = async () => {
    const map = mapRef.current;
    if (!map) return;
    const b = map.getBounds();
    const area = { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
    const z = Math.floor(map.getZoom());
    const urls: string[] = [];
    // The ground heights always; the picture where its licence allows keeping it.
    for (let k = Math.max(6, Math.min(11, z - 2)); k <= ELEVATION.maxZoom; k++) for (const t of tilesIn(area, k)) urls.push(tileUrl(ELEVATION.url, t));
    if (src.keep && url) for (let k = Math.max(0, z - 2); k <= Math.min(src.maxZoom, z + 2); k++) for (const t of tilesIn(area, k)) urls.push(tileUrl(url, t));
    if (urls.length > 3000) return notify("warn", "That is too large an area to save at once", `It would be ${urls.length.toLocaleString()} map tiles. Zoom in to the field you will fly from and save that.`);
    const stop = new AbortController();
    stopSave.current = stop;
    setSaving({ done: 0, total: urls.length });
    const failedCount = await saveTiles(urls, (done, total) => setSaving({ done, total }), stop.signal);
    stopSave.current = null;
    setSaving(null);
    setSaved(await keptCount());
    if (stop.signal.aborted) return;
    if (failedCount) notify("warn", "Some of the area could not be saved", `${failedCount} of ${urls.length} tiles did not arrive. Check the connection and save again; what arrived is kept.`);
    else notify("success", "Area saved", src.keep ? "The picture and the ground heights for this view now work without the internet." : `The ground heights are saved. The ${src.name.toLowerCase()} picture cannot be: its provider does not allow it.`);
  };

  const ground = pointer && patch && covers(patch, home, 0) ? (() => {
    const l = toLocal(home, pointer.lat, pointer.lon);
    return Math.abs(l.n) <= patch.half && Math.abs(l.e) <= patch.half ? sampleDem(patch, l.n, l.e) : null;
  })() : null;

  const hasAircraft = linked && !!pos && (pos.lat !== 0 || pos.lon !== 0);

  if (failed) {
    return (
      <div className="rmap rmap-failed">
        <p>
          <strong>The map could not start.</strong> It needs WebGL, which this browser or computer has turned off. {failed}
        </p>
        <p>The practice field above works without it.</p>
      </div>
    );
  }

  return (
    <div className={`rmap${props.onPick ? " pickable" : ""}${fl?.drawing ? " drawing" : ""}`}>
      <div ref={box} className="rmap-canvas" role="application" aria-label={fl?.editing ? "Map of the fence. Click a zone to select it; drag its corners to move them." : "Map of the route. Click to add a waypoint; drag a marker to move it."} />

      <div className="rmap-tools" role="group" aria-label="Map controls">
        <button onClick={() => zoom(1)} aria-label="Zoom in" data-tip="Zoom in"><Plus /></button>
        <button onClick={() => zoom(-1)} aria-label="Zoom out" data-tip="Zoom out"><Minus /></button>
        <button onClick={() => fit()} aria-label="Fit the route" data-tip="Show the whole route"><Maximize /></button>
        <button onClick={() => prefs.set("relief3d", !prefs.relief3d)} aria-pressed={prefs.relief3d} aria-label="3D ground" data-tip={prefs.relief3d ? "Back to the flat map" : "3D ground"}><Mountain /></button>
        {props.onMoveHome && !homeLocked && (
          <button onClick={() => setPlacing(!placing)} aria-pressed={placing} aria-label="Put home here" data-tip="Put home: then click the take-off spot"><HomeIcon /></button>
        )}
        {hasAircraft ? (
          <button onClick={() => mapRef.current?.flyTo({ center: [pos!.lon, pos!.lat], zoom: Math.max(16, mapRef.current.getZoom()) })} aria-label="Go to the aircraft" data-tip="Go to the aircraft"><Navigation /></button>
        ) : (
          <button onClick={toMe} aria-label="Go to this computer's location" data-tip={linked && !virtual ? "No aircraft GPS yet: go to this computer's location" : "Go to this computer's location"}><LocateFixed /></button>
        )}
        <button onClick={() => setPanel(!panel)} aria-pressed={panel} aria-label="Layers and offline maps" data-tip="Map picture and offline areas"><Layers /></button>
      </div>

      {panel && (
        <div className="rmap-panel" role="dialog" aria-label="Layers and offline maps">
          <div className="rmap-panel-head">
            <strong>Map</strong>
            <button className="icon-btn" aria-label="Close" onClick={() => setPanel(false)}><X /></button>
          </div>
          <label className="field">
            <span>Picture</span>
            <select className="select" value={src.id} onChange={(e) => prefs.set("imagery", e.target.value)}>
              {IMAGERY.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <small>{src.detail}</small>
          </label>
          {src.needsKey && (
            <label className="field">
              <span>MapTiler key</span>
              <input className="input" type="password" autoComplete="off" value={prefs.keys[src.needsKey] ?? ""} onChange={(e) => prefs.set("keys", { ...prefs.keys, [src.needsKey!]: e.target.value })} placeholder="Paste the key from your MapTiler account" />
              <small>Kept in this browser only, and sent only to MapTiler.</small>
            </label>
          )}
          {src.id === "custom" && (
            <label className="field">
              <span>Tile address</span>
              <input className="input" value={prefs.customUrl} onChange={(e) => prefs.set("customUrl", e.target.value)} placeholder="https://…/{z}/{x}/{y}.jpg" />
              <small>Must start with https and contain {"{z}"}, {"{x}"} and {"{y}"}. Check the provider's terms allow it.</small>
            </label>
          )}
          <label className="sim-check">
            <input type="checkbox" checked={prefs.shading} onChange={(e) => prefs.set("shading", e.target.checked)} />
            <span><strong>Shade the slopes</strong><small>Shows the shape of the land on the flat map.</small></span>
          </label>
          <div className="rmap-goto">
            <label className="field">
              <span>Go to coordinates</span>
              <input className="input" value={goto} onChange={(e) => setGoto(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} placeholder="23.0225, 72.5714" />
            </label>
            <button className="btn btn-sm" onClick={go}>Go</button>
          </div>
          <div className="rmap-offline">
            <strong>For the field, without internet</strong>
            <small>Saves what this view shows, and closer, on this computer. Move and zoom to the place you will fly from first.</small>
            {saving ? (
              <div className="rmap-saving">
                <progress value={saving.done} max={saving.total} />
                <span>{saving.done} of {saving.total}</span>
                <button className="btn btn-sm" onClick={() => stopSave.current?.abort()}>Stop</button>
              </div>
            ) : (
              <button className="btn btn-sm" onClick={saveArea} disabled={!online}><CloudDownload /> Save this area</button>
            )}
            <small className="rmap-kept">
              {saved ? `${saved.toLocaleString()} map tiles are saved on this computer.` : "Nothing saved yet."}{" "}
              {saved > 0 && !saving && (
                <button className="link-btn" onClick={() => void clearKept().then(() => setSaved(0))}>Remove them</button>
              )}
            </small>
          </div>
        </div>
      )}

      {placing && (
        <div className="rmap-note placing">
          Click the map where the aircraft will take off. The waypoints stay where they are. <button className="link-btn" onClick={() => setPlacing(false)}>Cancel</button>
        </div>
      )}
      {!url && !placing && (
        <div className="rmap-note">
          {src.needsKey ? "This picture needs your MapTiler key." : "This picture needs a tile address."} <button className="link-btn" onClick={() => setPanel(true)}>Open Layers</button>
        </div>
      )}
      {!online && (
        <div className="rmap-note offline"><WifiOff /> No internet: only saved areas are shown.</div>
      )}

      <div className="fmap-legend rmap-legend">
        {pointer ? (
          <span className="num">{pointer.lat.toFixed(5)}, {pointer.lon.toFixed(5)}{ground != null ? `, ground ${Math.round(ground)} m` : ""}</span>
        ) : (
          <span className={homeFrom === "waiting" ? "rmap-wait" : undefined}>
            {homeFrom === "aircraft"
              ? `Home is the aircraft's GPS position${sats !== null ? ` (${sats} satellites)` : ""}: ${home.lat.toFixed(5)}, ${home.lon.toFixed(5)}`
              : homeFrom === "waiting"
                ? `Waiting for the aircraft's GPS${sats !== null ? ` (${sats} satellites so far)` : ""}. Home is still where you placed it.`
                : `Home ${home.lat.toFixed(5)}, ${home.lon.toFixed(5)}`}
          </span>
        )}
        {wind && wind.speed > 0 && (
          <span><i className="fmap-wind" style={{ transform: `rotate(${wind.fromDeg + 180}deg)` }} aria-hidden /> Wind {wind.speed.toFixed(0)} m/s from {Math.round(wind.fromDeg)}°</span>
        )}
        <span className="fmap-hint">
          {placing
            ? "Click to put home there. Esc cancels."
            : fl?.drawing
              ? fl.drawing.shape === "circle"
                ? fl.drawing.points.length
                  ? "Click to set the radius. Esc cancels."
                  : "Click the centre of the circle. Esc cancels."
                : "Click to place each corner. Click the first corner, or press Enter, to finish."
              : fl?.editing
                ? "Click a zone to select it, then drag its corners."
                : props.onPick
                  ? "Click to add a waypoint. Drag a marker to move it."
                  : "Scroll to zoom, drag to move."}
        </span>
      </div>
    </div>
  );
}
