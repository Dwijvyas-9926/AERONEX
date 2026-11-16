/*
  A time-series chart on a canvas, for log data: up to millions of samples.

  Where more than one sample falls on a pixel column the column is drawn as
  the full range of those samples (lowest to highest), so a one-sample spike
  is never thinned away, however far out the chart is zoomed. Gaps in the
  data (NaN, or no samples for a while) are left as gaps, not bridged.

  Every chart on the page shares one time window and one cursor: drag to
  pan, wheel or pinch to zoom, double-click to show the whole log, and the
  arrow keys to step the cursor.
*/
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clock } from "../../logs/analyze";
import { indexAt } from "../../logs/model";
import type { Panel } from "../../logs/series";
import { clampView } from "./plotView";

export interface Band {
  from: number;
  to: number;
  label: string;
}
export interface Marker {
  t: number;
  tone: "bad" | "warn" | "note";
  label: string;
}

interface PlotProps {
  panel: Panel;
  view: [number, number];
  full: [number, number];
  cursor: number | null;
  bands?: Band[];
  markers?: Marker[];
  height?: number;
  onCursor: (t: number | null) => void;
  onView: (v: [number, number]) => void;
  /** Show the time axis labels (the bottom chart of a stack). */
  axis?: boolean;
}

const PAD = { l: 56, r: 12, t: 8, b: 22 };
const SERIES_VARS = ["--series-1", "--series-2", "--series-3", "--series-4", "--series-5", "--series-6", "--series-7", "--series-8"];

function niceStep(span: number, target: number) {
  const raw = span / Math.max(1, target);
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
}

const timeStep = (span: number, target: number) => {
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const raw = span / Math.max(1, target);
  return steps.find((s) => s >= raw) ?? 3600;
};

function timeLabel(t: number, step: number) {
  if (step < 1) return `${clock(t)}.${Math.floor((t % 1) * 10)}`;
  return clock(t);
}

/** A tick label with as many decimals as the tick step needs. */
function fmtTick(v: number, step: number) {
  const d = Math.max(0, Math.min(6, -Math.floor(Math.log10(step) + 1e-9)));
  return v.toFixed(d);
}

function fmtVal(v: number) {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

/** The y range of the series inside the time window, with a little air. */
function yRange(panel: Panel, t0: number, t1: number): [number, number] {
  if (panel.range) return panel.range;
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of panel.series) {
    const a = Math.max(0, indexAt(s.t, t0));
    const b = Math.min(s.t.length - 1, indexAt(s.t, t1) + 1);
    for (let i = a; i <= b; i++) {
      const v = s.v[i];
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  for (const l of panel.limits ?? []) {
    // A threshold is shown when the data comes within reach of it.
    if (Number.isFinite(hi) && l.value <= hi * 1.6 && l.value >= lo - Math.abs(hi - lo) * 0.6) {
      lo = Math.min(lo, l.value);
      hi = Math.max(hi, l.value);
    }
  }
  if (!Number.isFinite(lo)) return [0, 1];
  if (panel.zero) lo = Math.min(0, lo);
  if (hi === lo) {
    const d = Math.abs(hi) * 0.1 || 1;
    return [lo - d, hi + d];
  }
  const air = (hi - lo) * 0.06;
  return [panel.zero && lo === 0 ? 0 : lo - air, hi + air];
}

export function Plot({ panel, view, full, cursor, bands, markers, height = 150, onCursor, onView, axis = true }: PlotProps) {
  const box = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(600);
  const drag = useRef<{ x: number; v: [number, number]; moved: boolean } | null>(null);
  const [t0, t1] = view;
  const h = height + (axis ? 0 : -PAD.b + 6);
  const y = useMemo(() => yRange(panel, t0, t1), [panel, t0, t1]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(200, el.clientWidth)));
    ro.observe(el);
    setW(Math.max(200, el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const xOf = useCallback((t: number) => PAD.l + ((t - t0) / (t1 - t0 || 1)) * (w - PAD.l - PAD.r), [t0, t1, w]);
  const tOf = useCallback((x: number) => t0 + ((x - PAD.l) / (w - PAD.l - PAD.r)) * (t1 - t0), [t0, t1, w]);

  // Draw.
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const g = c.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(c);
    const tok = (n: string, d: string) => css.getPropertyValue(n).trim() || d;
    const ink = tok("--muted", "#56617a");
    const grid = tok("--line-soft", "#e8e3d8");
    const bandFill = tok("--lp-band", "rgba(20,33,61,0.04)");
    const warn = tok("--warn", "#965700");
    const bad = tok("--danger", "#b3261e");
    const dash = tok("--ink-2", "#33405c");
    const colors = SERIES_VARS.map((v, i) => tok(v, ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"][i]));
    g.clearRect(0, 0, w, h);
    const bottom = h - (axis ? PAD.b : 6);
    const plotH = bottom - PAD.t;
    const yOf = (v: number) => bottom - ((v - y[0]) / (y[1] - y[0])) * plotH;
    g.font = `11px ${tok("--font-ui", "system-ui")}`;

    // Mode bands: alternate tint, label in the corner.
    if (bands) {
      bands.forEach((b, k) => {
        const a = Math.max(PAD.l, xOf(b.from));
        const z = Math.min(w - PAD.r, xOf(b.to));
        if (z <= a) return;
        if (k % 2 === 1) {
          g.fillStyle = bandFill;
          g.fillRect(a, PAD.t, z - a, plotH);
        }
      });
    }

    // Grid and y labels.
    const ys = niceStep(y[1] - y[0], Math.max(2, Math.floor(plotH / 34)));
    g.strokeStyle = grid;
    g.lineWidth = 1;
    g.fillStyle = ink;
    g.textAlign = "right";
    g.textBaseline = "middle";
    for (let v = Math.ceil(y[0] / ys) * ys; v <= y[1] + 1e-9; v += ys) {
      const py = Math.round(yOf(v)) + 0.5;
      g.beginPath();
      g.moveTo(PAD.l, py);
      g.lineTo(w - PAD.r, py);
      g.stroke();
      g.fillText(fmtTick(Math.abs(v) < ys / 1e6 ? 0 : v, ys), PAD.l - 6, py);
    }
    // Time labels.
    const ts = timeStep(t1 - t0, Math.max(2, Math.floor((w - PAD.l) / 90)));
    g.textAlign = "center";
    g.textBaseline = "top";
    for (let t = Math.ceil(t0 / ts) * ts; t <= t1; t += ts) {
      const px = Math.round(xOf(t)) + 0.5;
      g.beginPath();
      g.moveTo(px, PAD.t);
      g.lineTo(px, bottom);
      g.stroke();
      if (axis) g.fillText(timeLabel(t, ts), px, bottom + 5);
    }

    // Thresholds.
    for (const l of panel.limits ?? []) {
      if (l.value < y[0] || l.value > y[1]) continue;
      const py = Math.round(yOf(l.value)) + 0.5;
      g.strokeStyle = l.tone === "bad" ? bad : warn;
      g.setLineDash([5, 4]);
      g.beginPath();
      g.moveTo(PAD.l, py);
      g.lineTo(w - PAD.r, py);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = l.tone === "bad" ? bad : warn;
      g.textAlign = "right";
      g.textBaseline = "bottom";
      g.fillText(l.label, w - PAD.r - 4, py - 2);
    }

    // Series.
    g.save();
    g.beginPath();
    g.rect(PAD.l, PAD.t, w - PAD.l - PAD.r, plotH);
    g.clip();
    let solid = 0;
    for (const s of panel.series) {
      const color = s.dashed ? dash : colors[solid++ % colors.length];
      g.strokeStyle = color;
      g.lineWidth = s.dashed ? 1.25 : 1.5;
      g.setLineDash(s.dashed ? [4, 3] : []);
      g.lineJoin = "round";
      const n = s.t.length;
      if (!n) continue;
      const a = Math.max(0, indexAt(s.t, t0) - 1);
      const b = Math.min(n - 1, indexAt(s.t, t1) + 1);
      // A gap wider than 20 samples' worth of the typical spacing is a gap in the data.
      const typical = n > 1 ? (s.t[n - 1] - s.t[0]) / (n - 1) : 1;
      const gapT = Math.max(typical * 20, 1);
      // An angle crossing 0/360 is a wrap, not a swing across the chart.
      const half = panel.wrap ? panel.wrap / 2 : Infinity;
      const pxPerSample = (b - a) / Math.max(1, w - PAD.l - PAD.r);
      g.beginPath();
      if (pxPerSample <= 2) {
        let pen = false;
        for (let i = a; i <= b; i++) {
          const v = s.v[i];
          if (!Number.isFinite(v) || (i > a && (s.t[i] - s.t[i - 1] > gapT || Math.abs(v - s.v[i - 1]) > half))) {
            pen = false;
            if (!Number.isFinite(v)) continue;
          }
          const px = xOf(s.t[i]);
          const py = yOf(v);
          if (pen) g.lineTo(px, py);
          else g.moveTo(px, py);
          pen = true;
        }
        g.stroke();
        // Sparse data: show the samples themselves.
        if (pxPerSample < 0.1 && !s.dashed) {
          g.fillStyle = color;
          for (let i = a; i <= b; i++) if (Number.isFinite(s.v[i])) g.fillRect(xOf(s.t[i]) - 1.5, yOf(s.v[i]) - 1.5, 3, 3);
        }
      } else {
        // Envelope: per pixel column, the lowest and highest sample.
        let col = -1;
        let lo = Infinity;
        let hi = -Infinity;
        let first = NaN;
        let last = NaN;
        let prevLast = NaN;
        let prevT = -Infinity;
        const flush = () => {
          if (col < 0 || !Number.isFinite(lo)) return;
          const px = col + 0.5;
          if (Number.isFinite(prevLast)) g.lineTo(px, yOf(first));
          else g.moveTo(px, yOf(first));
          g.lineTo(px, yOf(lo));
          g.lineTo(px, yOf(hi));
          g.lineTo(px, yOf(last));
          prevLast = last;
        };
        for (let i = a; i <= b; i++) {
          const v = s.v[i];
          const gap = s.t[i] - prevT > gapT || (i > a && Math.abs(v - s.v[i - 1]) > half);
          prevT = s.t[i];
          if (!Number.isFinite(v) || gap) {
            flush();
            col = -1;
            lo = Infinity;
            hi = -Infinity;
            prevLast = NaN;
            if (!Number.isFinite(v)) continue;
          }
          const c2 = Math.floor(xOf(s.t[i]));
          if (c2 !== col) {
            flush();
            col = c2;
            lo = hi = first = last = v;
          } else {
            if (v < lo) lo = v;
            if (v > hi) hi = v;
            last = v;
          }
        }
        flush();
        g.stroke();
      }
      g.setLineDash([]);
    }
    g.restore();

    // Events.
    for (const m of markers ?? []) {
      if (m.t < t0 || m.t > t1) continue;
      const px = Math.round(xOf(m.t)) + 0.5;
      g.strokeStyle = m.tone === "bad" ? bad : m.tone === "warn" ? warn : ink;
      g.globalAlpha = m.tone === "note" ? 0.45 : 0.8;
      g.beginPath();
      g.moveTo(px, PAD.t);
      g.lineTo(px, bottom);
      g.stroke();
      g.globalAlpha = 1;
    }

    // Cursor.
    if (cursor !== null && cursor >= t0 && cursor <= t1) {
      const px = Math.round(xOf(cursor)) + 0.5;
      g.strokeStyle = tok("--ink", "#14213d");
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(px, PAD.t);
      g.lineTo(px, bottom);
      g.stroke();
    }
    // Axis line.
    g.strokeStyle = tok("--line", "#dad3c4");
    g.beginPath();
    g.moveTo(PAD.l + 0.5, PAD.t);
    g.lineTo(PAD.l + 0.5, bottom);
    g.lineTo(w - PAD.r, bottom + 0.5);
    g.stroke();
  }, [panel, w, h, y, t0, t1, xOf, bands, markers, cursor, axis]);

  // Pointer: drag pans, a still pointer moves the cursor.
  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, v: view, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const r = cv.current!.getBoundingClientRect();
    const x = e.clientX - r.left;
    const d = drag.current;
    if (d) {
      const dx = e.clientX - d.x;
      if (Math.abs(dx) > 3) d.moved = true;
      if (d.moved) {
        const dt = (-dx / (w - PAD.l - PAD.r)) * (d.v[1] - d.v[0]);
        onView(clampView([d.v[0] + dt, d.v[1] + dt], full));
        return;
      }
    }
    if (x >= PAD.l && x <= w - PAD.r) onCursor(tOf(x));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) {
      const r = cv.current!.getBoundingClientRect();
      onCursor(tOf(e.clientX - r.left));
    }
  };
  // Wheel zoom, around the pointer. Attached by hand: React's wheel handler is passive and cannot stop the page scrolling.
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        const dt = (e.deltaX / (w - PAD.l - PAD.r)) * (t1 - t0);
        onView(clampView([t0 + dt, t1 + dt], full));
        return;
      }
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const at = tOf(e.clientX - r.left);
      const k = Math.exp(e.deltaY * 0.0015);
      onView(clampView([at - (at - t0) * k, at + (t1 - at) * k], full));
    };
    c.addEventListener("wheel", wheel, { passive: false });
    return () => c.removeEventListener("wheel", wheel);
  }, [t0, t1, w, tOf, onView, full]);

  // What the series read at the cursor.
  const readings = useMemo(() => {
    if (cursor === null) return null;
    return panel.series.map((s) => {
      const i = indexAt(s.t, cursor);
      return i >= 0 && Math.abs(s.t[i] - cursor) <= Math.max(2, (t1 - t0) / 50) ? s.v[i] : NaN;
    });
  }, [panel, cursor, t0, t1]);

  let solid = 0;
  return (
    <figure className="lp-plot">
      <figcaption className="lp-plot-head">
        <span className="lp-plot-title">
          {panel.title}
          {panel.unit && <span className="lp-plot-unit"> {panel.unit}</span>}
        </span>
        <span className="lp-legend">
          {panel.series.map((s, k) => {
            const slot = s.dashed ? -1 : solid++;
            return (
              <span key={k} className="lp-key">
                <i className={s.dashed ? "dash" : ""} style={s.dashed ? undefined : { background: `var(${SERIES_VARS[slot % SERIES_VARS.length]})` }} />
                {s.label}
                {readings && <b>{fmtVal(readings[k])}</b>}
              </span>
            );
          })}
        </span>
      </figcaption>
      <div ref={box} className="lp-plot-box">
        <canvas
          ref={cv}
          style={{ width: w, height: h }}
          role="img"
          aria-label={`${panel.title} chart from ${clock(t0)} to ${clock(t1)}`}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => !drag.current && onCursor(null)}
          onDoubleClick={() => onView(full)}
          onKeyDown={(e) => {
            const step = (t1 - t0) / 100;
            if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
              e.preventDefault();
              const at = cursor ?? (t0 + t1) / 2;
              onCursor(Math.min(full[1], Math.max(full[0], at + (e.key === "ArrowRight" ? step : -step))));
            }
          }}
        />
      </div>
    </figure>
  );
}
