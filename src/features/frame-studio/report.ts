/*
  Frame Studio — the build report.

  The part drawings say what to cut. This says what was designed and why, in
  the order a builder needs it: what the aircraft is, what it weighs and how
  it balances, why the arm is the size it is, what the checks found, what
  every part is, what to order, and how to put it together. It goes at the
  front of the same PDF as the 1:1 drawings, so one file carries the design.

  Every figure is read from the design the studio computed, the same object
  the screen shows. The pictures are the solid view rendered off screen and
  vector drawings of the real geometry, never illustrations of a frame in
  general. Text is set in Helvetica, which every PDF reader carries, so the
  file needs nothing embedded but the two renders.
*/

import { type BomLine, type RecipeStep } from "./bom";
import { cameraById } from "./catalog";
import { type FrameDesign, type Hole, type Profile } from "./geometry";
import { lookForPart } from "./parts";
import { PdfDoc, textWidth, type JpegImage, type Pen, type Pt } from "./pdf";
import { drawPage, partSpecs, type PrintPlan } from "./printsheet";
import { type Finding } from "./validate";

export interface ReportInput {
  design: FrameDesign;
  findings: Finding[];
  bom: BomLine[];
  recipe: RecipeStep[];
  vehicleName: string;
  plan: PrintPlan;
  images?: { hero?: JpegImage | null; exploded?: JpegImage | null };
  date?: Date;
}

/* ---------------------------------------------------------------- palette */

const C = {
  navy: "#14213d",
  navy2: "#1d3461",
  ink: "#1f2a44",
  ink2: "#33405c",
  muted: "#5d677d",
  line: "#d9d3c7",
  soft: "#ece7dd",
  paper: "#f8f6f1",
  white: "#ffffff",
  accent: "#a8470f",
  accentSoft: "#f6e6da",
  ok: "#376f33",
  okSoft: "#e3eedf",
  warn: "#965700",
  warnSoft: "#f6ead3",
  bad: "#b3261e",
  badSoft: "#f6dedb",
  onNavy: "#c9d1e0",
};

/* ------------------------------------------------------------ text helpers */

/** Characters Helvetica's WinAnsi encoding cannot carry, mapped to ones it can. */
const SUBS: Record<string, string> = {
  "→": "->",
  "←": "<-",
  "≈": "~",
  "≥": ">=",
  "≤": "<=",
  "−": "-",
  "‘": "'",
  "⌀": "Ø",
  "″": '"',
  "′": "'",
  "‑": "-", // non-breaking hyphen
  " ": " ", // narrow no-break space
  " ": " ", // thin space
  "✓": "",
};
const SUB_RE = new RegExp(`[${Object.keys(SUBS).join("")}]`, "g");
export const clean = (s: string) => s.replace(SUB_RE, (c) => SUBS[c] ?? c);

/** Break text into lines no wider than `maxW` at `size`. */
export function wrap(text: string, size: number, maxW: number, bold = false): string[] {
  const out: string[] = [];
  for (const para of clean(text).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next, size, bold) <= maxW) {
        line = next;
        continue;
      }
      if (line) out.push(line);
      // A single word wider than the line is cut where it must be.
      let w = word;
      while (textWidth(w, size, bold) > maxW && w.length > 1) {
        let k = w.length - 1;
        while (k > 1 && textWidth(w.slice(0, k), size, bold) > maxW) k--;
        out.push(w.slice(0, k));
        w = w.slice(k);
      }
      line = w;
    }
    out.push(line);
  }
  return out;
}

const r1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1);
const r0 = (v: number) => String(Math.round(v));
const g = (v: number) => `${r0(v)} g`;

/* ----------------------------------------------------------- page geometry */

interface PageGeom {
  w: number;
  h: number;
  /** Content box. */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

const MARGIN_X = 16;
const MARGIN_TOP = 22;
const MARGIN_BOTTOM = 18;

type Op = (doc: PdfDoc) => void;

interface ReportPage {
  ops: Op[];
  /** Section title shown in the running header; empty on the cover. */
  section: string;
}

/**
 * Lays content down the page and starts a new one when it runs out.
 *
 * Content is recorded as drawing operations and only drawn once the whole
 * report has been laid out, because every footer says "page 3 of 14" and the
 * 14 is not known until the end.
 */
class Flow {
  pages: ReportPage[] = [];
  y = 0;
  readonly geo: PageGeom;
  private section = "";

  constructor(w: number, h: number) {
    this.geo = { w, h, x0: MARGIN_X, x1: w - MARGIN_X, y0: MARGIN_TOP, y1: h - MARGIN_BOTTOM };
  }

  get width() {
    return this.geo.x1 - this.geo.x0;
  }

  get page() {
    return this.pages[this.pages.length - 1];
  }

  newPage(section = this.section) {
    this.section = section;
    this.pages.push({ ops: [], section });
    this.y = this.geo.y0;
  }

  /** Make room for `h` mm, turning the page if it is not there. */
  need(h: number) {
    if (this.y + h > this.geo.y1) this.newPage();
  }

  op(f: Op) {
    this.page.ops.push(f);
  }

  /** A paragraph at the cursor. Returns its height. */
  para(text: string, o: { size?: number; bold?: boolean; color?: string; x?: number; w?: number; lead?: number; after?: number } = {}) {
    const size = o.size ?? 3.05;
    const lead = o.lead ?? size * 1.5;
    const x = o.x ?? this.geo.x0;
    const w = o.w ?? this.width;
    const lines = wrap(text, size, w, o.bold);
    for (const line of lines) {
      this.need(lead);
      const y = this.y + size;
      this.op((d) => d.text([x, y], line, { size, bold: o.bold, color: o.color ?? C.ink }));
      this.y += lead;
    }
    this.y += o.after ?? 2;
    return lines.length * lead;
  }

  /** A section heading, numbered, on a fresh page. */
  section_(num: number, title: string, intro?: string) {
    this.newPage(title);
    const y = this.y;
    this.op((d) => {
      d.text([this.geo.x0, y + 4.2], String(num).padStart(2, "0"), { size: 4.6, bold: true, color: C.accent });
      d.text([this.geo.x0 + 11, y + 4.2], title, { size: 6.4, bold: true, color: C.navy });
      d.poly([[this.geo.x0, y + 8.5], [this.geo.x1, y + 8.5]], { stroke: C.navy, width: 0.5 }, false);
    });
    this.y += 13;
    if (intro) this.para(intro, { color: C.ink2, after: 4 });
  }

  /** A sub-heading that keeps at least `keep` mm of what follows on the same page. */
  heading(text: string, keep = 22) {
    this.need(9 + keep);
    const y = this.y;
    this.op((d) => d.text([this.geo.x0, y + 4], clean(text), { size: 4.1, bold: true, color: C.navy }));
    this.y += 8;
  }
}

/* --------------------------------------------------------- drawing helpers */

function roundRect(x: number, y: number, w: number, h: number, r: number): Pt[] {
  const k = Math.min(r, w / 2, h / 2);
  const pts: Pt[] = [];
  const corner = (cx: number, cy: number, a0: number) => {
    for (let i = 0; i <= 6; i++) {
      const a = a0 + (i / 6) * (Math.PI / 2);
      pts.push([cx + Math.cos(a) * k, cy + Math.sin(a) * k]);
    }
  };
  corner(x + w - k, y + k, -Math.PI / 2);
  corner(x + w - k, y + h - k, 0);
  corner(x + k, y + h - k, Math.PI / 2);
  corner(x + k, y + k, Math.PI);
  return pts;
}

function box(d: PdfDoc, x: number, y: number, w: number, h: number, pen: Pen, r = 1.6) {
  d.poly(roundRect(x, y, w, h, r), pen);
}

/** Mix a #rrggbb colour toward white: 0 keeps it, 1 is white. */
function tint(hex: string, t: number): string {
  const v = parseInt(hex.slice(1), 16);
  const c = (s: number) => Math.round(((v >> s) & 255) + (255 - ((v >> s) & 255)) * t);
  return `#${[16, 8, 0].map((s) => c(s).toString(16).padStart(2, "0")).join("")}`;
}

function extentOf(pts: Pt[]) {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

const rotate = ([x, y]: Pt, a: number): Pt => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];

/** A key-value table. Returns its height. */
function kvTable(f: Flow, rows: [string, string][], o: { x?: number; w?: number; title?: string } = {}) {
  const x = o.x ?? f.geo.x0;
  const w = o.w ?? f.width;
  const rowH = 5.6;
  const size = 2.85;
  const labelW = w * 0.44;
  let used = 0;
  if (o.title) {
    f.need(6 + rowH * Math.min(rows.length, 3));
    const y = f.y;
    f.op((d) => d.text([x, y + 3.4], clean(o.title!), { size: 3.2, bold: true, color: C.accent }));
    f.y += 5.5;
    used += 5.5;
  }
  rows.forEach(([k, v], i) => {
    const lines = wrap(v, size, w - labelW - 2, true);
    const h = Math.max(rowH, lines.length * size * 1.4 + 2.6);
    f.need(h);
    const y = f.y;
    f.op((d) => {
      if (i % 2 === 0) d.poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], { fill: C.paper });
      d.text([x + 2, y + 3.9], clean(k), { size, color: C.muted });
      lines.forEach((l, j) => d.text([x + labelW, y + 3.9 + j * size * 1.4], l, { size, bold: true, color: C.ink }));
    });
    f.y += h;
    used += h;
  });
  f.y += 3;
  return used + 3;
}

/** A data table with a header row. Column widths are fractions of the width. */
function table(f: Flow, cols: { label: string; frac: number; bold?: boolean; align?: "end" }[], rows: string[][], o: { size?: number } = {}) {
  const size = o.size ?? 2.8;
  const x0 = f.geo.x0;
  const w = f.width;
  const xs: number[] = [];
  let acc = x0;
  for (const c of cols) {
    xs.push(acc);
    acc += c.frac * w;
  }
  const header = () => {
    f.need(7 + 8);
    const y = f.y;
    f.op((d) => {
      d.poly([[x0, y], [x0 + w, y], [x0 + w, y + 6.4], [x0, y + 6.4]], { fill: C.navy });
      cols.forEach((c, i) => {
        const tx = c.align === "end" ? xs[i] + c.frac * w - 2 : xs[i] + 2;
        d.text([tx, y + 4.3], c.label, { size: 2.7, bold: true, color: C.white, anchor: c.align === "end" ? "end" : "start" });
      });
    });
    f.y += 6.4;
  };
  header();
  rows.forEach((row, ri) => {
    const cells = row.map((cell, i) => wrap(cell, size, cols[i].frac * w - 4, cols[i].bold));
    const lines = Math.max(...cells.map((c) => c.length));
    const h = lines * size * 1.42 + 3.2;
    if (f.y + h > f.geo.y1) {
      f.newPage();
      header();
    }
    const y = f.y;
    f.op((d) => {
      if (ri % 2 === 1) d.poly([[x0, y], [x0 + w, y], [x0 + w, y + h], [x0, y + h]], { fill: C.paper });
      d.poly([[x0, y + h], [x0 + w, y + h]], { stroke: C.line, width: 0.15 }, false);
      cells.forEach((lines_, i) => {
        const c = cols[i];
        lines_.forEach((l, j) => {
          const tx = c.align === "end" ? xs[i] + c.frac * w - 2 : xs[i] + 2;
          d.text([tx, y + 3.9 + j * size * 1.42], l, { size, bold: c.bold, color: c.bold ? C.ink : C.ink2, anchor: c.align === "end" ? "end" : "start" });
        });
      });
    });
    f.y += h;
  });
  f.y += 4;
}

/** A picture in a frame, scaled to fit the width, with a caption. */
function picture(f: Flow, img: JpegImage, caption: string, maxH: number) {
  const ratio = img.heightPx / img.widthPx;
  let w = f.width;
  let h = w * ratio;
  if (h > maxH) {
    h = maxH;
    w = h / ratio;
  }
  const capLines = wrap(caption, 2.7, f.width);
  f.need(h + 4 + capLines.length * 3.8);
  const x = f.geo.x0 + (f.width - w) / 2;
  const y = f.y;
  f.op((d) => {
    d.image(img, x, y, w, h);
    d.poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], { stroke: C.line, width: 0.25 });
  });
  f.y += h + 3;
  for (const l of capLines) {
    const yy = f.y + 2.7;
    f.op((d) => d.text([f.geo.x0, yy], l, { size: 2.7, color: C.muted }));
    f.y += 3.8;
  }
  f.y += 3;
}

/* ------------------------------------------------------------ the figures */

/** ArduPilot's quad motor numbers and spin directions for FRAME_TYPE 1 (X), by quadrant. */
export function ardupilotMotor(p: Pt): { n: number; spin: "CW" | "CCW" } {
  const [x, y] = p;
  if (x >= 0 && y >= 0) return { n: 1, spin: "CCW" };
  if (x < 0 && y < 0) return { n: 2, spin: "CCW" };
  if (x < 0 && y >= 0) return { n: 3, spin: "CW" };
  return { n: 4, spin: "CW" };
}

/**
 * The assembled frame from above, to scale, with propeller discs, ArduPilot
 * motor numbers and spin directions. Drawn into the square (x, y, size).
 */
function planFigure(d: PdfDoc, D: FrameDesign, x: number, y: number, size: number) {
  const propR = D.propDiaMm / 2;
  const reach = Math.max(...D.motors.map((m) => Math.max(Math.abs(m[0]), Math.abs(m[1])))) + propR + 4;
  const s = (size / 2 - 4) / reach;
  const cx = x + size / 2;
  const cy = y + size / 2 + 1.5;
  // Frame +Y is forward; on the page forward is up.
  const P = ([px, py]: Pt): Pt => [cx + px * s, cy - py * s];

  box(d, x, y, size, size, { fill: C.paper, stroke: C.line, width: 0.2 });
  const base = D.profiles.find((p) => p.id === "chassis" || p.id === "bottom-plate")!;
  const top = D.profiles.find((p) => p.id === "top-plate");
  const shift = D.rootRadiusMm - D.armOverlapMm;
  for (const part of D.profiles.filter((p) => p.cantileverMm !== undefined)) {
    for (const b of D.armGroups.find((gg) => gg.id === part.id)?.bearings ?? []) {
      d.poly(part.outline.map(([px, py]) => P(rotate([px + shift, py], b))), { fill: tint(lookForPart(part.id).color, 0.55), stroke: C.ink2, width: 0.18 });
    }
  }
  d.poly(base.outline.map(P), { fill: tint(lookForPart(base.id).color, 0.6), stroke: C.ink2, width: 0.22 });
  if (top) d.poly(top.outline.map(P), { stroke: C.navy, width: 0.2, dash: [1.2, 0.8] });

  // Battery footprint, dashed: it is on top or underneath, not in the plate.
  const bl = D.spec.battery.l / 2;
  const bw = D.spec.battery.w / 2;
  d.poly([P([-bw, bl]), P([bw, bl]), P([bw, -bl]), P([-bw, -bl])], { stroke: C.muted, width: 0.18, dash: [0.8, 0.8] });

  for (const m of D.motors) {
    const c = P(m);
    d.circle(c, propR * s, { stroke: C.navy2, width: 0.2, dash: [1.4, 1] });
    const { n, spin } = ardupilotMotor(m);
    // Spin arrow: an arc three-quarters round with a head showing direction.
    const ar = propR * s * 0.72;
    const cw = spin === "CW";
    const pts: Pt[] = [];
    for (let i = 0; i <= 24; i++) {
      const a = -Math.PI / 2 + (cw ? 1 : -1) * (i / 24) * Math.PI * 1.25;
      pts.push([c[0] + Math.cos(a) * ar, c[1] + Math.sin(a) * ar]);
    }
    d.poly(pts, { stroke: cw ? C.accent : C.ok, width: 0.35 }, false);
    const end = pts[pts.length - 1];
    const prev = pts[pts.length - 3];
    const ang = Math.atan2(end[1] - prev[1], end[0] - prev[0]);
    const head = 1.6;
    d.poly(
      [end, [end[0] - Math.cos(ang - 0.45) * head, end[1] - Math.sin(ang - 0.45) * head], [end[0] - Math.cos(ang + 0.45) * head, end[1] - Math.sin(ang + 0.45) * head]],
      { fill: cw ? C.accent : C.ok },
    );
    d.circle(c, 3.1, { fill: C.navy });
    d.text([c[0], c[1] + 1.15], String(n), { size: 3.2, bold: true, color: C.white, anchor: "middle" });
    d.text([c[0], c[1] + ar + 4.2], spin, { size: 2.4, bold: true, color: cw ? C.accent : C.ok, anchor: "middle" });
  }

  // Forward arrow.
  d.poly([[cx, y + 3], [cx - 1.8, y + 6.2], [cx + 1.8, y + 6.2]], { fill: C.navy });
  d.text([cx + 3, y + 5.8], "Front", { size: 2.6, bold: true, color: C.navy });
}

/**
 * The frame from the side, every layer at its height from the design's
 * stack-up, with the propeller plane and the centre of gravity. Heights are
 * drawn larger than lengths so thin plates stay readable; the figure says so.
 */
function sideFigure(d: PdfDoc, D: FrameDesign, x: number, y: number, w: number, h: number) {
  const unibody = D.spec.construction === "unibody";
  const base = D.profiles.find((p) => p.id === "chassis" || p.id === "bottom-plate")!;
  const top = D.profiles.find((p) => p.id === "top-plate")!;
  const deck = D.profiles.find((p) => p.id === "deck-plate");
  const armT = D.profiles.find((p) => p.cantileverMm !== undefined)?.thicknessMm ?? base.thicknessMm;
  // Heights in the stack-up frame: zero is the underside of the arms.
  const toStack = (zFromBottomPlateTop: number) => zFromBottomPlateTop + (unibody ? base.thicknessMm : 0);
  const thrustZ = toStack(D.cg.thrustPlaneZMm);
  const cgZ = toStack(D.cg.zMm);
  const packOnTop = D.spec.batteryMount === "top";
  const packZ0 = packOnTop ? D.stackUp.packZMm : D.stackUp.packZMm - D.spec.battery.h;
  const packZ1 = packZ0 + D.spec.battery.h;
  const zMin = Math.min(unibody ? 0 : -base.thicknessMm, packZ0) - 3;
  const zMax = Math.max(thrustZ, packZ1, D.stackUp.topPlateZMm + top.thicknessMm) + 5;

  const motorY = Math.max(...D.motors.map((m) => Math.abs(m[1])));
  const propR = D.propDiaMm / 2;
  const span = 2 * (motorY + propR) + 10;
  const sx = (w - 20) / span;
  const exaggeration = Math.min(3, Math.max(1, (h - 16) / ((zMax - zMin) * sx)));
  const sz = sx * exaggeration;
  const cx = x + w / 2;
  const groundY = y + h - 9;
  // Fore-aft becomes left-right with the nose to the right; heights go up the page.
  const X = (fy: number) => cx + fy * sx;
  const Y = (z: number) => groundY - (z - zMin) * sz;

  box(d, x, y, w, h, { fill: C.paper, stroke: C.line, width: 0.2 });
  const slab = (y0: number, y1: number, z0: number, z1: number, color: string, label?: string) => {
    d.poly([[X(y0), Y(z1)], [X(y1), Y(z1)], [X(y1), Y(z0)], [X(y0), Y(z0)]], { fill: tint(color, 0.45), stroke: C.ink2, width: 0.15 });
    if (label) d.text([X(y1) + 1.5, Y((z0 + z1) / 2) + 1], label, { size: 2.3, color: C.ink2 });
  };

  // Arms: out to the motors, one each way.
  slab(-motorY, motorY, 0, armT, lookForPart("arm").color);
  if (!unibody) slab(-D.bodyLmm / 2, D.bodyLmm / 2, -base.thicknessMm, 0, lookForPart(base.id).color);
  slab(-D.bodyLmm / 2, D.bodyLmm / 2, D.stackUp.topPlateZMm, D.stackUp.topPlateZMm + top.thicknessMm, lookForPart("top-plate").color);
  if (deck && D.stackUp.deckZMm !== null) slab(-D.bodyLmm / 2, D.bodyLmm / 2, D.stackUp.deckZMm, D.stackUp.deckZMm + deck.thicknessMm, lookForPart("deck-plate").color);
  // The battery, strapped where the design puts it.
  const bl = D.spec.battery.l / 2;
  d.poly([[X(-bl), Y(packZ1)], [X(bl), Y(packZ1)], [X(bl), Y(packZ0)], [X(-bl), Y(packZ0)]], { fill: tint(C.navy, 0.78), stroke: C.navy, width: 0.2 });
  d.text([X(0), Y((packZ0 + packZ1) / 2) + 1], "Battery", { size: 2.4, bold: true, color: C.navy, anchor: "middle" });

  // Motors stand on the arm tips; the propeller plane is where thrust acts.
  for (const my of [-motorY, motorY]) {
    d.poly([[X(my - 3), Y(armT)], [X(my + 3), Y(armT)], [X(my + 3), Y(thrustZ)], [X(my - 3), Y(thrustZ)]], { fill: tint(C.ink2, 0.55), stroke: C.ink2, width: 0.15 });
    d.poly([[X(my - propR), Y(thrustZ)], [X(my + propR), Y(thrustZ)]], { stroke: C.navy2, width: 0.6 }, false);
  }
  d.poly([[X(-motorY - propR - 4), Y(thrustZ)], [X(motorY + propR + 4), Y(thrustZ)]], { stroke: C.navy2, width: 0.15, dash: [1, 0.8] }, false);
  d.text([X(0), Y(thrustZ) - 1.6], "Propeller plane (thrust)", { size: 2.3, color: C.navy2, anchor: "middle" });

  // Centre of gravity: the quartered circle engineers use.
  const cg: Pt = [X(D.cg.offsetYMm), Y(cgZ)];
  d.circle(cg, 2.2, { fill: C.white, stroke: C.bad, width: 0.3 });
  d.poly([cg, [cg[0] + 2.2, cg[1]], ...arc(cg, 2.2, 0, -Math.PI / 2), cg], { fill: C.bad });
  d.poly([cg, [cg[0] - 2.2, cg[1]], ...arc(cg, 2.2, Math.PI, Math.PI / 2), cg], { fill: C.bad });
  d.text([cg[0] + 3.4, cg[1] + 1], "CG", { size: 2.6, bold: true, color: C.bad });

  // The drop from the propeller plane to the CG, dimensioned.
  const dx = X(motorY + propR) + 3;
  if (Math.abs(thrustZ - cgZ) > 0.5) {
    d.poly([[dx, Y(thrustZ)], [dx, Y(cgZ)]], { stroke: C.bad, width: 0.2 }, false);
    d.poly([[dx - 1, Y(cgZ)], [dx + 1, Y(cgZ)]], { stroke: C.bad, width: 0.2 }, false);
    d.text([dx + 1.6, (Y(thrustZ) + Y(cgZ)) / 2 + 1], `${r1(Math.abs(D.cg.belowThrustMm))} mm`, { size: 2.4, bold: true, color: C.bad });
  }

  d.poly([[x + 4, groundY + 2], [x + w - 4, groundY + 2]], { stroke: C.line, width: 0.2 }, false);
  d.text([x + w - 2, y + h - 2.5], `Nose to the right. Heights drawn ${r1(exaggeration)}× their length scale for clarity.`, { size: 2.2, color: C.muted, anchor: "end" });
}

function arc(c: Pt, r: number, a0: number, a1: number): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= 8; i++) {
    const a = a0 + ((a1 - a0) * i) / 8;
    pts.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]);
  }
  return pts;
}

/** A part's outline, holes and slots, scaled into the box. */
function thumbnail(d: PdfDoc, part: Profile, x: number, y: number, size: number) {
  const e = extentOf(part.outline);
  const turned = e.maxY - e.minY > (e.maxX - e.minX) * 1.15;
  const T = (p: Pt): Pt => (turned ? [p[1], -p[0]] : p);
  const pts = part.outline.map(T);
  const te = extentOf(pts);
  const s = (size - 4) / Math.max(te.maxX - te.minX, te.maxY - te.minY);
  const ox = x + size / 2 - ((te.minX + te.maxX) / 2) * s;
  const oy = y + size / 2 + ((te.minY + te.maxY) / 2) * s;
  const P = (p: Pt): Pt => {
    const [px, py] = T(p);
    return [ox + px * s, oy - py * s];
  };
  const color = lookForPart(part.id).color;
  box(d, x, y, size, size, { fill: C.paper, stroke: C.line, width: 0.15 });
  d.poly(part.outline.map(P), { fill: tint(color, 0.55), stroke: C.ink2, width: 0.2 });
  for (const sl of part.slots) d.poly(sl.map(P), { fill: C.paper, stroke: C.ink2, width: 0.12 });
  for (const h of part.holes as Hole[]) d.circle(P(h.c), Math.max(0.25, h.r * s), { fill: C.paper, stroke: C.ink2, width: 0.1 });
}

/** A horizontal gauge: value against a limit, coloured by how close it runs. */
function gauge(d: PdfDoc, x: number, y: number, w: number, value: number, limit: number, label: string, readout: string) {
  const frac = Math.max(0, Math.min(1, value / limit));
  const color = frac < 0.6 ? C.ok : frac < 0.9 ? C.warn : C.bad;
  d.text([x, y], label, { size: 2.8, color: C.ink2 });
  d.text([x + w, y], readout, { size: 2.8, bold: true, color: C.ink, anchor: "end" });
  box(d, x, y + 2, w, 3.2, { fill: C.soft }, 1.4);
  if (frac > 0.01) box(d, x, y + 2, Math.max(2.8, w * frac), 3.2, { fill: color }, 1.4);
}

/* ---------------------------------------------------------- the sections */

const GOVERNING: Record<string, [string, string]> = {
  thrust: ["Motor thrust", "Unusually, steady thrust is the limiting case here. Check the thrust figure you entered."],
  impact: ["Crash loads", "A hard landing, not hovering, is what sizes this arm. Static thrust needs a fraction of the material."],
  stiffness: ["Stiffness", "Strength was never the limit; keeping the arm from flexing is. A flexible arm reads as vibration to the flight controller and makes tuning hard."],
  geometry: ["Bolt clearance", "Neither load nor stiffness decided this. The arm is as narrow as it can be and still fit its own bolts with safe edge distance."],
};

const LAYOUT_NAME: Record<string, string> = { "true-x": "True X", "stretched-x": "Stretched X", h: "H", deadcat: "Dead cat" };

function summaryLine(D: FrameDesign): string {
  return `${D.spec.propIn}" ${LAYOUT_NAME[D.spec.layout] ?? D.spec.layout} quad · ${D.spec.construction === "unibody" ? "unibody" : "bolted arms"} · ${D.material.name}`;
}

function twRating(tw: number): string {
  if (tw < 2) return "Underpowered: it will struggle to climb or recover. Lighten the build or fit more thrust.";
  if (tw < 3) return "Gentle: steady camera and survey flying, with modest reserve for wind.";
  if (tw < 5) return "Sport: plenty of reserve for wind, climbs and recovery.";
  return "Aggressive: freestyle and racing reserve. Expect a low hover throttle.";
}

/** The studio's checks, grouped the way a builder thinks of them. */
const CHECK_GROUPS: { title: string; why: string; ids: RegExp }[] = [
  { title: "Holes inside every part", why: "A hole drawn off the part, or so near the edge that it tears out under load.", ids: /-hole-\d+-(outside|edge)$/ },
  { title: "Wall between holes", why: "Holes and slots so close that the web between them cracks.", ids: /-(holes|slots)-\d+-\d+$|-slot-\d+-(hole-\d+|outside)$/ },
  { title: "Propeller clearance", why: "Neighbouring propeller discs touching, or closer than the gap you asked for.", ids: /^prop-/ },
  { title: "Wheelbase for the propeller", why: "A frame far smaller or larger than published frames for this propeller size.", ids: /^wheelbase-/ },
  { title: "Arms clamped by both plates", why: "An arm held by one plate only, which works loose.", ids: /^root-clamp$/ },
  { title: "Arm strength", why: "Root stress above what the material allows after the safety factor.", ids: /^arm-stress$/ },
  { title: "Arm stiffness", why: "An arm that flexes enough to read as vibration to the flight controller.", ids: /^arm-deflection$/ },
  { title: "Arm proportions", why: "Arms too deep or too wide to cut, print or clamp sensibly.", ids: /^arm-too-/ },
  { title: "Material and stock", why: "Sheet thicknesses that are not sold, or a material unsuited to structure.", ids: /^(stock-|material-)/ },
  { title: "Motor and propeller", why: "A motor size that does not suit the propeller.", ids: /^motor-prop-/ },
  { title: "Battery fit", why: "A pack that overhangs, sits in the propeller discs, or misses its strap slots.", ids: /^(battery-|strap-)/ },
  { title: "Camera fit", why: "A camera with no room between its plates, or a cage too tall.", ids: /^(camera-|cage-)/ },
  { title: "Thrust and hover", why: "Too little thrust to hover with reserve, or a hover throttle too high to control.", ids: /^(tw-|hover-)/ },
  { title: "Balance", why: "Mass hung so far below the propellers that the aircraft swings.", ids: /^cg-/ },
];

export function checkGroups(findings: Finding[]) {
  const problems = findings.filter((x) => x.severity !== "ok");
  const used = new Set<Finding>();
  const out = CHECK_GROUPS.map((gr) => {
    const mine = problems.filter((x) => gr.ids.test(x.id));
    mine.forEach((x) => used.add(x));
    const result: "error" | "warn" | "ok" = mine.some((x) => x.severity === "error") ? "error" : mine.length ? "warn" : "ok";
    const count = mine.filter((x) => x.severity === result).length;
    return { title: gr.title, why: gr.why, result, count };
  });
  // Anything a future check adds still shows, rather than vanishing from the report.
  const rest = problems.filter((x) => !used.has(x));
  if (rest.length) {
    const result = rest.some((x) => x.severity === "error") ? "error" : "warn";
    out.push({ title: "Other", why: "Further checks on this design.", result, count: rest.filter((x) => x.severity === result).length });
  }
  return out;
}

function verdict(findings: Finding[]) {
  const errors = findings.filter((f) => f.severity === "error").length;
  const warns = findings.filter((f) => f.severity === "warn").length;
  if (errors) return { title: "Not ready to build", text: `${errors} error${errors > 1 ? "s" : ""} must be fixed before any part is made${warns ? `, and ${warns} warning${warns > 1 ? "s" : ""} to read` : ""}.`, color: C.bad, soft: C.badSoft };
  if (warns) return { title: "Buildable, with warnings", text: `No errors. ${warns} warning${warns > 1 ? "s" : ""} to read before you order parts.`, color: C.warn, soft: C.warnSoft };
  return { title: "Ready to build", text: "Every check passed.", color: C.ok, soft: C.okSoft };
}

/** Lay out the whole report. Returns the pages, still to be drawn. */
function layoutReport(input: ReportInput, w: number, h: number, drawingPages: number) {
  const D = input.design;
  const f = new Flow(w, h);
  const toc: { title: string; page: number }[] = [];
  const mark = (title: string) => toc.push({ title, page: f.pages.length });
  const date = input.date ?? new Date();
  const camera = cameraById(D.spec.cameraId);
  const isCut = D.material.method === "cut";
  const unibody = D.spec.construction === "unibody";

  /* ---- cover ---- */
  f.newPage("");
  {
    const G = f.geo;
    const v = verdict(input.findings);
    const heroImg = input.images?.hero ?? null;
    f.op((d) => {
      d.poly([[0, 0], [G.w, 0], [G.w, 62], [0, 62]], { fill: C.navy });
      d.poly([[0, 62], [G.w, 62], [G.w, 63.2], [0, 63.2]], { fill: C.accent });
      d.text([G.x0, 17], "AERONEX  Frame Studio", { size: 3.3, bold: true, color: C.onNavy });
      d.text([G.x1, 17], date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }), { size: 3.1, color: C.onNavy, anchor: "end" });
      d.text([G.x0, 33], "Frame build report", { size: 5, color: C.onNavy });
      const name = wrap(input.vehicleName, 10, G.x1 - G.x0, true)[0];
      d.text([G.x0, 47], name, { size: 10, bold: true, color: C.white });
      d.text([G.x0, 56], clean(summaryLine(D)), { size: 3.4, color: C.onNavy });
    });
    f.y = 70;
    // The aircraft itself: the rendered solid view, or the plan drawing without WebGL.
    if (heroImg) {
      const iw = f.width;
      const ih = Math.min(iw * (heroImg.heightPx / heroImg.widthPx), 98);
      const y = f.y;
      f.op((d) => {
        d.image(heroImg, G.x0, y, iw, ih);
        d.poly([[G.x0, y], [G.x1, y], [G.x1, y + ih], [G.x0, y + ih]], { stroke: C.line, width: 0.25 });
      });
      f.y += ih + 6;
    } else {
      const y = f.y;
      f.op((d) => planFigure(d, D, G.x0 + (f.width - 90) / 2, y, 90));
      f.y += 96;
    }

    // Four figures that say what this aircraft is.
    const tiles: [string, string, string][] = [
      ["Wheelbase", `${r0(D.wheelbaseMm)} mm`, "motor to motor, diagonal"],
      ["All-up weight", g(D.mass.auwG), "ready to fly, with battery"],
      ["Thrust : weight", `${D.thrustToWeight.toFixed(1)} : 1`, "at full throttle"],
      ["Hover throttle", `${Math.round(D.hoverThrottle * 100)} %`, "estimate, before tuning"],
    ];
    const tw = (f.width - 9) / 4;
    const ty = f.y;
    f.op((d) => {
      tiles.forEach(([label, value, sub], i) => {
        const x = G.x0 + i * (tw + 3);
        box(d, x, ty, tw, 21, { fill: C.paper, stroke: C.line, width: 0.2 });
        d.text([x + 3, ty + 5.5], label, { size: 2.7, color: C.muted });
        d.text([x + 3, ty + 13.2], value, { size: 5.6, bold: true, color: C.navy });
        d.text([x + 3, ty + 18], sub, { size: 2.3, color: C.muted });
      });
    });
    f.y += 27;

    // The verdict.
    const vy = f.y;
    f.op((d) => {
      box(d, G.x0, vy, f.width, 13, { fill: v.soft });
      d.poly([[G.x0, vy], [G.x0 + 1.6, vy], [G.x0 + 1.6, vy + 13], [G.x0, vy + 13]], { fill: v.color });
      d.text([G.x0 + 5, vy + 5.6], v.title, { size: 3.6, bold: true, color: v.color });
      d.text([G.x0 + 5, vy + 10.3], clean(v.text), { size: 2.8, color: C.ink });
    });
    f.y += 19;

    // Contents, filled once the sections know their pages.
    const cy = f.y;
    f.op((d) => {
      d.text([G.x0, cy + 3.5], "Contents", { size: 3.6, bold: true, color: C.navy });
      toc.forEach((t, i) => {
        const y = cy + 10 + i * 5.4;
        d.text([G.x0, y], `${String(i + 1).padStart(2, "0")}`, { size: 2.9, bold: true, color: C.accent });
        d.text([G.x0 + 8, y], t.title, { size: 2.9, color: C.ink });
        d.poly([[G.x0 + 10 + textWidth(t.title, 2.9), y - 0.6], [G.x1 - 12, y - 0.6]], { stroke: C.line, width: 0.15, dash: [0.4, 0.8] }, false);
        d.text([G.x1, y], String(t.page), { size: 2.9, bold: true, color: C.ink, anchor: "end" });
      });
    });
  }

  /* ---- 1 design summary ---- */
  mark("Design summary");
  f.section_(1, "Design summary", "What this aircraft is, as the studio worked it out. Values the studio chose for you are marked as such in Frame Studio.");
  {
    const colW = (f.width - 8) / 2;
    const top = f.y;
    const left: [string, [string, string][]][] = [
      [
        "Airframe",
        [
          ["Layout", `${LAYOUT_NAME[D.spec.layout] ?? D.spec.layout}, ${unibody ? "unibody (one-piece chassis)" : "bolted arms"}`],
          ["Propellers", `${D.spec.propIn}" (${r0(D.propDiaMm)} mm)`],
          ["Wheelbase", `${r0(D.wheelbaseMm)} mm`],
          ["Published band", D.referenceBand ? `${D.referenceBand.min} to ${D.referenceBand.max} mm for ${D.spec.propIn}"` : "none published"],
          ["Prop gap", `${r1(D.spec.clearanceMm)} mm between discs`],
          ["Flying style", `${D.style.label} (${D.style.loadFactor} g landing load)`],
        ],
      ],
      [
        "Propulsion",
        [
          ["Motors", `4 × ${D.motor.size}, ${D.motor.pattern} mm pattern, M${D.motor.bolt}`],
          ["Thrust per motor", `${r0(D.spec.motorThrustG)} g peak${D.spec.motorThrustG === D.motor.thrustG ? `, typical on ${D.motor.thrustCells}S` : " (your figure)"}`],
          ["Usual KV", `${D.motor.kv[0]} to ${D.motor.kv[1]} KV on ${D.motor.thrustCells}S`],
        ],
      ],
    ];
    const right: [string, [string, string][]][] = [
      [
        "Electronics and battery",
        [
          ["Flight stack", `${D.spec.stackPattern} mm square, M${D.spec.stackBolt}, ${r1(D.spec.stackHeightMm)} mm tall`],
          ["Camera", camera.id === "none" ? "none" : camera.name],
          ["Battery", `${D.spec.battery.l} × ${D.spec.battery.w} × ${D.spec.battery.h} mm, ${r0(D.spec.battery.massG)} g`],
          ["Battery mount", D.spec.batteryMount === "top" ? "strapped on top" : "strapped underneath"],
          ["Electronics", `${r0(D.spec.electronicsMassG)} g (stack, receiver, camera, wiring)`],
        ],
      ],
      [
        "Material",
        [
          ["Material", D.material.name],
          ["Made by", isCut ? "cutting from sheet (CNC, waterjet or laser)" : "3D printing"],
          [isCut ? "Arm stock" : "Arm section", isCut ? `${r1(D.stock.armDimMm)} mm sheet` : `${r1(D.section.widthMm)} × ${r1(D.section.heightMm)} mm${D.section.hollow ? `, ${r1(D.stock.wallMm)} mm walls` : ""}`],
          ["Plates", `${r1(D.stock.bottomPlateMm)} mm bottom, ${r1(D.stock.topPlateMm)} mm top`],
          ["Lightening", D.lightening.count ? `${D.lightening.count} cut-outs, saving ${r1(D.lightening.savedG)} g` : "solid plates"],
        ],
      ],
    ];
    // Left column flows normally; the right column is laid beside it.
    const startPage = f.pages.length;
    for (const [t, rows] of left) kvTable(f, rows, { title: t, w: colW });
    const leftEnd = f.y;
    f.y = top;
    for (const [t, rows] of right) kvTable(f, rows, { title: t, w: colW, x: f.geo.x0 + colW + 8 });
    if (f.pages.length !== startPage) throw new Error("Design summary overflowed its page");
    f.y = Math.max(leftEnd, f.y) + 2;

    f.heading("Seen from above, with ArduPilot's motor order", 100);
    const fy = f.y;
    const size = 92;
    f.op((d) => planFigure(d, D, f.geo.x0, fy, size));
    // ArduPilot set-up, beside the figure.
    const bx = f.geo.x0 + size + 7;
    const bw = f.width - size - 7;
    const lines: [string, string, boolean][] = [
      ["Set these on the flight controller", "", true],
      ["FRAME_CLASS", "1   Quad", false],
      ["FRAME_TYPE", "1   X", false],
      ["", "", false],
      ["Motor 1", "front right, counter-clockwise", false],
      ["Motor 2", "rear left, counter-clockwise", false],
      ["Motor 3", "front left, clockwise", false],
      ["Motor 4", "rear right, clockwise", false],
    ];
    f.op((d) => {
      box(d, bx, fy, bw, size, { fill: C.white, stroke: C.line, width: 0.2 });
      lines.forEach(([k, v, head], i) => {
        const y = fy + 7 + i * 5.6;
        if (head) d.text([bx + 4, y], k, { size: 3.1, bold: true, color: C.navy });
        else if (k) {
          d.text([bx + 4, y], k, { size: 2.9, bold: true, color: k.startsWith("FRAME") ? C.accent : C.ink });
          d.text([bx + 27, y], v, { size: 2.9, color: C.ink });
        }
      });
      const note = wrap(
        'Numbers are ArduPilot\'s output order for a quad X, from its AP_MotorsMatrix. Connect ESC 1 to output 1 and so on, then check each motor turns as drawn with the motor test in AERONEX Calibration, before propellers go on. To spin every motor the other way ("props out"), set FRAME_TYPE 3 (H) instead.',
        2.55,
        bw - 8,
      );
      note.forEach((l, i) => d.text([bx + 4, fy + 54 + i * 3.7], l, { size: 2.55, color: C.ink2 }));
    });
    f.y += size + 5;
  }

  /* ---- 2 weight and balance ---- */
  mark("Weight, balance and performance");
  f.section_(2, "Weight, balance and performance", "Where the mass goes, how much thrust there is to spare, and how the weight hangs relative to the propellers.");
  {
    const items: [string, number, string][] = [
      ["Battery", D.mass.batteryG, C.navy],
      ["Motors", D.mass.motorsG, C.navy2],
      ["Frame", D.mass.frameG, lookForPart("arm").color],
      ["Electronics", D.mass.electronicsG, "#4f8257"],
      ["Hardware", D.mass.hardwareG, C.muted],
    ];
    f.heading(`All-up weight ${g(D.mass.auwG)}`, 40);
    const y0 = f.y;
    const barX = f.geo.x0 + 26;
    const barW = f.width - 26 - 34;
    const maxG = Math.max(...items.map((i) => i[1]));
    f.op((d) => {
      items.forEach(([label, grams, color], i) => {
        const y = y0 + i * 7;
        d.text([f.geo.x0, y + 3.6], label, { size: 2.9, color: C.ink2 });
        box(d, barX, y + 0.8, barW, 4, { fill: C.soft }, 1.2);
        box(d, barX, y + 0.8, Math.max(2.4, (barW * grams) / maxG), 4, { fill: color }, 1.2);
        d.text([f.geo.x1, y + 3.6], `${g(grams)}  ${r0((grams / D.mass.auwG) * 100)} %`, { size: 2.9, bold: true, color: C.ink, anchor: "end" });
      });
    });
    f.y += items.length * 7 + 5;

    f.heading("Performance", 34);
    const pw = (f.width - 6) / 2;
    const py = f.y;
    const tw = D.thrustToWeight;
    const twColor = tw < 2 ? C.bad : tw < 3 ? C.warn : C.ok;
    const cards: [string, string, string, string][] = [
      ["Thrust to weight", `${tw.toFixed(1)} : 1`, twRating(tw), twColor],
      [
        "Hover throttle",
        `${Math.round(D.hoverThrottle * 100)} %`,
        `Hovering takes ${Math.round(D.hoverThrustFraction * 100)} % of full thrust. ArduPilot learns the real figure in flight as MOT_THST_HOVER; ${(D.hoverThrottle).toFixed(2)} is a sound starting value.`,
        C.navy,
      ],
    ];
    let cardH = 0;
    const wrapped = cards.map((c) => wrap(c[2], 2.75, pw - 8));
    cardH = 17 + Math.max(...wrapped.map((w_) => w_.length)) * 3.9;
    f.need(cardH);
    f.op((d) => {
      cards.forEach(([label, value, , color], i) => {
        const x = f.geo.x0 + i * (pw + 6);
        box(d, x, py, pw, cardH, { fill: C.paper, stroke: C.line, width: 0.2 });
        d.text([x + 4, py + 6], label, { size: 2.9, color: C.muted });
        d.text([x + 4, py + 14], value, { size: 6, bold: true, color });
        wrapped[i].forEach((l, j) => d.text([x + 4, py + 19.5 + j * 3.9], l, { size: 2.75, color: C.ink2 }));
      });
    });
    f.y += cardH + 6;

    f.heading("How it balances", 80);
    const sy = f.y;
    const sh = 62;
    f.op((d) => sideFigure(d, D, f.geo.x0, sy, f.width, sh));
    f.y += sh + 4;
    const below = D.cg.belowThrustMm;
    f.para(
      `The centre of gravity sits ${r1(Math.abs(below))} mm ${below >= 0 ? "below" : "above"} the propeller plane and ${r1(Math.abs(D.cg.offsetYMm))} mm ${D.cg.offsetYMm >= 0 ? "forward of" : "behind"} the centre of thrust. ` +
        (D.spec.batteryMount === "top"
          ? "With the battery on top the mass sits close to the thrust plane, so the aircraft turns with less inertia and lands on a wide, flat base. Keep the strap tight: a loose pack can reach the propellers."
          : "With the battery underneath the frame stays low and the pack is shielded, at the price of the mass hanging further below the propellers, which makes the aircraft slower to rotate.") +
        (Math.abs(D.cg.offsetYMm) > 3 ? " Slide the battery to bring the centre of gravity onto the centre of thrust before the first flight." : ""),
      { color: C.ink2 },
    );
  }

  /* ---- 3 structure ---- */
  mark("Arm structure");
  f.section_(3, "Arm structure", "The arm is the part that carries every load, so it is sized from the loads: steady thrust, a hard landing for this flying style, and how far it may bend.");
  {
    const S = D.section;
    const [govTitle, govText] = GOVERNING[S.governing] ?? [S.governing, ""];
    const colW = (f.width - 8) / 2;
    const top = f.y;
    kvTable(
      f,
      [
        ["Section", `${r1(S.widthMm)} × ${r1(S.heightMm)} mm${S.hollow ? `, hollow box, ${r1(S.wallMm)} mm walls` : ", solid"}`],
        ["Exposed length", `${r1(D.armLengthMm)} mm`],
        ["Clamped length", unibody ? "one piece with the chassis" : `${r1(D.armOverlapMm)} mm between the plates`],
        ["Motor pad", `${r1(S.padWidthMm)} mm wide`],
        ["Arm bolts", unibody ? "none" : `M${D.rootBoltMm}`],
      ],
      { title: "The arm", w: colW },
    );
    const leftEnd = f.y;
    f.y = top;
    kvTable(
      f,
      [
        ["Material", D.material.name],
        ["Allowable stress", `${r0(S.allowableMPa)} MPa after safety factor ${D.spec.safetyFactor}`],
        ["Thrust load", `${r1(S.thrustN)} N per motor`],
        ["Landing load", `${r1(S.impactN)} N at the worst arm`],
        ["Sized by", govTitle],
      ],
      { title: "Loads and limits", w: colW, x: f.geo.x0 + colW + 8 },
    );
    f.y = Math.max(leftEnd, f.y) + 2;

    // Gauges: how hard the arm works, against what it may do.
    f.need(30);
    const gy = f.y;
    const deflLimit = D.armLengthMm / 150;
    f.op((d) => {
      gauge(d, f.geo.x0, gy + 3, colW, S.stressMPa, S.allowableMPa, "Peak stress at the root", `${r0(S.stressMPa)} of ${r0(S.allowableMPa)} MPa`);
      gauge(d, f.geo.x0 + colW + 8, gy + 3, colW, S.deflectionMm, deflLimit, "Tip flex at full thrust", `${S.deflectionMm.toFixed(2)} of ${deflLimit.toFixed(2)} mm`);
    });
    f.y += 14;

    // Why this size: the governing case, in words.
    const gl = wrap(govText, 2.95, f.width - 12);
    const gh = 10 + gl.length * 4.2;
    f.need(gh);
    const by = f.y;
    f.op((d) => {
      box(d, f.geo.x0, by, f.width, gh, { fill: C.accentSoft });
      d.poly([[f.geo.x0, by], [f.geo.x0 + 1.6, by], [f.geo.x0 + 1.6, by + gh], [f.geo.x0, by + gh]], { fill: C.accent });
      d.text([f.geo.x0 + 6, by + 6], `Sized by ${govTitle.toLowerCase()}`, { size: 3.3, bold: true, color: C.accent });
      gl.forEach((l, i) => d.text([f.geo.x0 + 6, by + 11 + i * 4.2], l, { size: 2.95, color: C.ink }));
    });
    f.y += gh + 5;

    f.heading("What each load case asks for", 30);
    const unit = isCut ? "width" : "height";
    table(
      f,
      [
        { label: "Load case", frac: 0.34, bold: true },
        { label: `Arm ${unit} it needs`, frac: 0.33, align: "end" },
        { label: "Governs", frac: 0.33, align: "end" },
      ],
      (["thrust", "impact", "stiffness", "geometry"] as const).map((k) => [
        GOVERNING[k][0],
        `${r1(S.required[k])} mm`,
        S.governing === k ? "Yes" : "",
      ]),
    );

    const exploded = input.images?.exploded ?? null;
    if (exploded) {
      const maxH = 88;
      const h_ = Math.min(f.width * (exploded.heightPx / exploded.widthPx), maxH);
      f.heading("How it goes together", h_ + 12);
      picture(f, exploded, "Exploded view, from the solid model in Frame Studio. Parts are lifted apart along the bolts that join them; colours identify the part, as on the drawings.", maxH);
    }
  }

  /* ---- 4 checks ---- */
  mark("Design checks");
  f.section_(4, "Design checks", "Every check the studio runs on the design: hole edge distances, wall between holes, propeller clearance, battery and stack fit, structure and balance.");
  {
    const errors = input.findings.filter((x) => x.severity === "error");
    const warns = input.findings.filter((x) => x.severity === "warn");
    const groups = checkGroups(input.findings);
    const passed = groups.filter((gr) => gr.result === "ok").length;
    const cy = f.y;
    const counts: [string, string, string, string][] = [
      [String(errors.length), errors.length === 1 ? "Error" : "Errors", C.bad, C.badSoft],
      [String(warns.length), warns.length === 1 ? "Warning" : "Warnings", C.warn, C.warnSoft],
      [`${passed}/${groups.length}`, "Checks passed", C.ok, C.okSoft],
    ];
    const cw = (f.width - 8) / 3;
    f.op((d) => {
      counts.forEach(([nn, label, color, soft], i) => {
        const x = f.geo.x0 + i * (cw + 4);
        box(d, x, cy, cw, 14, { fill: soft });
        d.text([x + 4, cy + 9.6], nn, { size: 6, bold: true, color });
        d.text([x + 6 + textWidth(nn, 6, true), cy + 8.6], label, { size: 3.2, bold: true, color });
      });
    });
    f.y += 20;

    f.heading("What was checked", 30);
    table(
      f,
      [
        { label: "Check", frac: 0.3, bold: true },
        { label: "What it guards against", frac: 0.54 },
        { label: "Result", frac: 0.16, bold: true, align: "end" },
      ],
      groups.map((gr) => [gr.title, gr.why, gr.result === "error" ? `${gr.count} error${gr.count > 1 ? "s" : ""}` : gr.result === "warn" ? `${gr.count} warning${gr.count > 1 ? "s" : ""}` : "Pass"]),
      { size: 2.7 },
    );

    const finding = (x: Finding) => {
      const chip = x.severity === "error" ? ["Error", C.bad, C.badSoft] : x.severity === "warn" ? ["Warning", C.warn, C.warnSoft] : ["Pass", C.ok, C.okSoft];
      const textX = f.geo.x0 + 22;
      const tw_ = f.width - 22;
      const title = wrap(x.title, 3.0, tw_, true);
      const detail = wrap(x.detail, 2.75, tw_);
      const meas = x.measured || x.limit ? `${x.measured ? `Measured ${x.measured}` : ""}${x.measured && x.limit ? "; " : ""}${x.limit ? `limit ${x.limit}` : ""}` : "";
      const h = title.length * 4.2 + 3.6 + detail.length * 3.8 + (meas ? 4 : 0) + 3;
      f.need(h);
      const y = f.y;
      f.op((d) => {
        box(d, f.geo.x0, y + 0.4, 18, 5, { fill: chip[2] }, 1.2);
        d.text([f.geo.x0 + 9, y + 3.9], chip[0], { size: 2.5, bold: true, color: chip[1], anchor: "middle" });
        title.forEach((l, i) => d.text([textX, y + 3.9 + i * 4.2], l, { size: 3.0, bold: true, color: C.ink }));
        let yy = y + 3.9 + title.length * 4.2 - 0.6;
        d.text([textX, yy], clean(x.scope), { size: 2.5, color: C.muted });
        yy += 3.9;
        detail.forEach((l) => {
          d.text([textX, yy], l, { size: 2.75, color: C.ink2 });
          yy += 3.8;
        });
        if (meas) d.text([textX, yy], clean(meas), { size: 2.6, bold: true, color: chip[1] });
        d.poly([[f.geo.x0, y + h - 1], [f.geo.x1, y + h - 1]], { stroke: C.line, width: 0.12 }, false);
      });
      f.y += h;
    };
    if (errors.length + warns.length) {
      f.heading("Findings to act on", 24);
      for (const x of [...errors, ...warns]) finding(x);
    } else {
      f.para("Nothing to act on: every check passed for this design.", { color: C.ok, bold: true });
    }
  }

  /* ---- 5 parts ---- */
  mark("Parts");
  f.section_(5, "Parts", `${D.profiles.length} different parts, ${D.profiles.reduce((a, p) => a + p.qty, 0)} pieces in all. Each has a full-size drawing at the back of this report.`);
  {
    for (const part of D.profiles) {
      const rows = partSpecs(D, part).map((r) => [r.label, r.value] as [string, string]);
      const thumb = 40;
      const colW = (f.width - thumb - 6) / 2;
      const per = Math.ceil(rows.length / 2);
      const h = Math.max(thumb, 9 + per * 4.6) + 6;
      f.need(h);
      const y = f.y;
      f.op((d) => {
        box(d, f.geo.x0, y, f.width, h - 3, { stroke: C.line, width: 0.2, fill: C.white });
        thumbnail(d, part, f.geo.x0 + 2, y + 2, thumb - 4);
        const tx = f.geo.x0 + thumb + 2;
        d.circle([tx + 1.6, y + 5.3], 1.6, { fill: lookForPart(part.id).color });
        d.text([tx + 5, y + 6.4], clean(part.name), { size: 3.6, bold: true, color: C.navy });
        d.text([f.geo.x1 - 3, y + 6.4], `${part.qty} off`, { size: 3.2, bold: true, color: C.accent, anchor: "end" });
        rows.forEach(([k, v], i) => {
          const col = Math.floor(i / per);
          const x = tx + col * (colW + 2);
          const yy = y + 12.5 + (i % per) * 4.6;
          d.text([x, yy], clean(k), { size: 2.6, color: C.muted });
          const vv = wrap(v, 2.6, colW - 26, true)[0];
          d.text([x + colW - 3, yy], vv, { size: 2.6, bold: true, color: C.ink, anchor: "end" });
        });
      });
      f.y += h;
    }
  }

  /* ---- 6 hardware ---- */
  mark("Hardware to order");
  f.section_(6, "Hardware to order", "Fasteners and fittings worked out from the stack-up they pass through. Bolt lengths are rounded up to sizes that are sold.");
  table(
    f,
    [
      { label: "Qty", frac: 0.08, bold: true, align: "end" },
      { label: "Item", frac: 0.32, bold: true },
      { label: "Where it goes", frac: 0.36 },
      { label: "Note", frac: 0.24 },
    ],
    input.bom.map((b) => [String(b.qty), b.item, b.purpose, b.note ?? ""]),
  );

  /* ---- 7 build steps ---- */
  mark("Making and building");
  f.section_(7, "Making and building", isCut ? "Settings for the cutter and the order to assemble in." : "Settings for the printer and the order to assemble in.");
  input.recipe.forEach((step, i) => {
    const title = wrap(step.title, 3.3, f.width - 12, true);
    const detail = wrap(step.detail, 2.95, f.width - 12);
    f.need(title.length * 4.6 + Math.min(detail.length, 3) * 4.3 + 4);
    const y = f.y;
    f.op((d) => {
      d.circle([f.geo.x0 + 3.4, y + 2.4], 3.4, { fill: C.navy });
      d.text([f.geo.x0 + 3.4, y + 3.6], String(i + 1), { size: 3.1, bold: true, color: C.white, anchor: "middle" });
      title.forEach((l, j) => d.text([f.geo.x0 + 12, y + 3.6 + j * 4.6], l, { size: 3.3, bold: true, color: C.navy }));
    });
    f.y += title.length * 4.6 + 1.5;
    f.para(step.detail, { x: f.geo.x0 + 12, w: f.width - 12, size: 2.95, color: C.ink2, after: 4 });
  });

  /* ---- drawings divider ---- */
  mark("Part drawings at 1:1");
  f.section_(8, "Part drawings at 1:1", "The pages that follow are full size. They are the cheapest check there is: print them, then lay your real motors, stack, camera and battery on them before paying for a cut.");
  {
    const steps = [
      ["Print at 100 %", 'In the print dialog choose "Actual size" or 100 %. Never "Fit to page", which shrinks every drawing by a few percent and hides the very errors you are looking for.'],
      ["Measure the ruler", "Every drawing has a 100 mm ruler. Check it with a real ruler. If it is not exactly 100 mm, nothing on that page can be trusted."],
      ["Lay the parts on", "Put the motors on the motor pads, the stack on its holes, the camera between its plates and the battery on its strap slots. Every hole should line up."],
      ["Then order the cut", "Send the DXF or STL files from Frame Studio's Export step, with the hardware list from this report."],
    ];
    steps.forEach(([t, body], i) => {
      const lines = wrap(body, 2.95, f.width - 12);
      f.need(8 + lines.length * 4.2);
      const y = f.y;
      f.op((d) => {
        d.circle([f.geo.x0 + 3.4, y + 2.4], 3.4, { fill: C.accent });
        d.text([f.geo.x0 + 3.4, y + 3.6], String(i + 1), { size: 3.1, bold: true, color: C.white, anchor: "middle" });
        d.text([f.geo.x0 + 12, y + 3.6], t, { size: 3.3, bold: true, color: C.navy });
        lines.forEach((l, j) => d.text([f.geo.x0 + 12, y + 8.6 + j * 4.2], l, { size: 2.95, color: C.ink2 }));
      });
      f.y += 10 + lines.length * 4.2;
    });
    const first = f.pages.length + 1;
    f.para(`Drawings: pages ${first} to ${first + drawingPages - 1}, ${drawingPages} page${drawingPages === 1 ? "" : "s"}.`, { bold: true, color: C.navy });
  }

  // Contents page numbers are 1-based.
  for (const t of toc) t.page = t.page + 1;
  return { pages: f.pages, geo: f.geo, toc };
}

/** Running header and footer on every report page except the cover. */
function frame(d: PdfDoc, G: PageGeom, section: string, vehicle: string, page: number, total: number) {
  if (section) {
    d.text([G.x0, 11], "AERONEX Frame Studio", { size: 2.6, bold: true, color: C.navy });
    d.text([G.x0 + textWidth("AERONEX Frame Studio", 2.6, true) + 3, 11], clean(`Build report · ${section}`), { size: 2.6, color: C.muted });
    d.text([G.x1, 11], clean(vehicle), { size: 2.6, color: C.muted, anchor: "end" });
    d.poly([[G.x0, 13.5], [G.x1, 13.5]], { stroke: C.line, width: 0.2 }, false);
  }
  d.poly([[G.x0, G.h - 12], [G.x1, G.h - 12]], { stroke: C.line, width: 0.2 }, false);
  d.text([G.x0, G.h - 8], "Figures are design estimates from published material data. Check the drawings at 1:1 before any part is made.", { size: 2.3, color: C.muted });
  d.text([G.x1, G.h - 8], `${page} / ${total}`, { size: 2.6, bold: true, color: C.navy, anchor: "end" });
}

/**
 * The build report followed by every part drawing at 1:1, as one PDF.
 * Report pages use the drawings' paper size so the file prints as one job.
 */
export function toBuildReportPDF(input: ReportInput): Uint8Array {
  const { plan } = input;
  const { pages, geo } = layoutReport(input, plan.page.widthMm, plan.page.heightMm, plan.pages.length);
  const total = pages.length + plan.pages.length;
  const doc = new PdfDoc(geo.w, geo.h);
  pages.forEach((p, i) => {
    doc.beginPage(geo.w, geo.h);
    for (const op of p.ops) op(doc);
    frame(doc, geo, p.section, input.vehicleName, i + 1, total);
    doc.endPage();
  });
  for (const pg of plan.pages) {
    doc.beginPage(pg.page.widthMm, pg.page.heightMm);
    drawPage(doc, input.design, plan, pg, input.vehicleName);
    doc.endPage();
  }
  return doc.build(`${input.vehicleName} — frame build report`);
}

/** How many report pages come before the drawings (for the export card). */
export function reportPageCount(input: ReportInput): number {
  return layoutReport(input, input.plan.page.widthMm, input.plan.page.heightMm, input.plan.pages.length).pages.length;
}
