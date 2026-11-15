import { afterEach, describe, expect, it, vi } from "vitest";
import { buildBOM, buildRecipe } from "../bom";
import { designFrame, type FrameSpec } from "../geometry";
import { encodable, PdfDoc, type JpegImage } from "../pdf";
import { pageSizeById, planPrint } from "../printsheet";
import { ardupilotMotor, checkGroups, clean, reportPageCount, toBuildReportPDF, wrap, type ReportInput } from "../report";
import { validateDesign } from "../validate";

const spec = (over: Partial<FrameSpec> = {}): FrameSpec => ({
  layout: "true-x", propIn: 5, clearanceMm: 10, wheelbaseMm: null,
  motorId: "2207", motorThrustG: 1350, stackPattern: 30.5, stackBolt: 3, stackHeightMm: 15,
  battery: { l: 105, w: 35, h: 30, massG: 180 }, electronicsMassG: 120,
  construction: "bolted", materialId: "cf-plate", fixedDimMm: 4, plateThicknessMm: null,
  wallMm: 2.5, lightenPlates: true, batteryMount: "bottom", cameraId: "micro",
  styleId: "freestyle", safetyFactor: 2, ...over,
});

const input = (s: FrameSpec, page = pageSizeById("a4"), images?: ReportInput["images"]): ReportInput => {
  const design = designFrame(s);
  return {
    design,
    findings: validateDesign(design),
    bom: buildBOM(design),
    recipe: buildRecipe(design),
    vehicleName: "Avion",
    plan: planPrint(design, page),
    images,
    date: new Date("2026-11-15T10:00:00Z"),
  };
};

const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join("");

/** Every string drawn on a page, captured as it goes to the writer. */
function captureText() {
  const seen: string[] = [];
  const orig = PdfDoc.prototype.text;
  vi.spyOn(PdfDoc.prototype, "text").mockImplementation(function (this: PdfDoc, at, s, style) {
    seen.push(s);
    return orig.call(this, at, s, style);
  });
  return seen;
}

afterEach(() => vi.restoreAllMocks());

const CASES: [string, FrameSpec][] = [
  ['5" bolted carbon X', spec()],
  ['3" unibody PLA', spec({ propIn: 3, motorId: "1404", motorThrustG: 350, stackPattern: 20, stackBolt: 2, cameraId: "nano", construction: "unibody", materialId: "pla" })],
  ['7" stretched X, battery on top', spec({ propIn: 7, layout: "stretched-x", motorId: "2806", motorThrustG: 1800, batteryMount: "top", styleId: "cinematic" })],
  ['10" H, aluminium', spec({ propIn: 10, layout: "h", motorId: "3110", motorThrustG: 2600, materialId: "alu-6061", cameraId: "none" })],
  ["dead cat", spec({ layout: "deadcat" })],
];

describe("build report", () => {
  it.each(CASES)("%s: a well-formed PDF with the report ahead of every drawing", (_n, s) => {
    const inp = input(s);
    const pdf = toBuildReportPDF(inp);
    const text = latin1(pdf);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    const report = reportPageCount(inp);
    const pages = (text.match(/\/Type \/Page\b/g) ?? []).length;
    expect(report).toBeGreaterThanOrEqual(8);
    expect(pages).toBe(report + inp.plan.pages.length);
    expect(text).toContain(`/Count ${pages}`);
  });

  it.each(CASES)("%s: every word drawn is one the font can print", (_n, s) => {
    const seen = captureText();
    toBuildReportPDF(input(s));
    const bad = seen.flatMap((t) => [...t].filter((ch) => !encodable(ch)).map((ch) => `${JSON.stringify(ch)} in "${t}"`));
    expect(bad).toEqual([]);
  });

  it("says what the design is, in its own numbers", () => {
    const seen = captureText();
    const inp = input(spec());
    toBuildReportPDF(inp);
    const all = seen.join("\n");
    for (const s of ["Frame build report", "Avion", "Design summary", "Weight, balance and performance", "Arm structure", "Design checks", "Hardware to order", "Making and building", "FRAME_CLASS", "FRAME_TYPE"]) {
      expect(all).toContain(s);
    }
    expect(all).toContain(`${Math.round(inp.design.wheelbaseMm)} mm`);
    expect(all).toContain(`${Math.round(inp.design.mass.auwG)} g`);
    expect(all).toContain(`${inp.design.thrustToWeight.toFixed(1)} : 1`);
    for (const part of inp.design.profiles) expect(all).toContain(clean(part.name));
    for (const line of inp.bom) expect(all).toContain(clean(line.item).split(" ").slice(0, 2).join(" "));
    // The last page of the report numbers itself against the whole file.
    const total = reportPageCount(inp) + inp.plan.pages.length;
    expect(all).toContain(`1 / ${total}`.replace(/^1/, "2"));
  });

  it("embeds the renders when it has them, and is the same report without them", () => {
    // The smallest valid baseline JPEG: the writer only frames the bytes.
    const jpeg = (): JpegImage => ({ bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), widthPx: 16, heightPx: 10 });
    const plain = latin1(toBuildReportPDF(input(spec())));
    const pics = latin1(toBuildReportPDF(input(spec(), undefined, { hero: jpeg(), exploded: jpeg() })));
    expect(plain).not.toContain("/DCTDecode");
    expect((pics.match(/\/Subtype \/Image/g) ?? []).length).toBe(2);
    expect(pics).toContain("/Width 16 /Height 10");
  });

  it("follows the drawings' paper size", () => {
    const inp = input(spec(), pageSizeById("letter"));
    const text = latin1(toBuildReportPDF(inp));
    const w = (inp.plan.page.widthMm / 25.4) * 72;
    expect(text).toContain(`/MediaBox [0 0 ${Math.round(w * 1000) / 1000} `);
    expect(text).not.toContain("/MediaBox [0 0 595.276 ");
  });
});

describe("design checks in the report", () => {
  it("files every check the studio can raise under a named heading", async () => {
    // Every id the validator can produce, read from its source so a new check cannot slip past.
    const src = (await import("../validate.ts?raw")).default as string;
    const ids = [...src.matchAll(/id: (?:"([^"]+)"|`([^`]+)`)/g)].map((m) =>
      (m[1] ?? m[2]).replace(/\$\{part\.id\}/g, "top-plate").replace(/\$\{[ij]\}/g, "3"),
    );
    expect(ids.length).toBeGreaterThan(20);
    for (const id of ids) {
      const groups = checkGroups([{ id, severity: "warn", scope: "x", title: id, detail: "" }]);
      expect(groups.find((g) => g.result === "warn")?.title, id).not.toBe("Other");
    }
  });

  it("passes everything when nothing was found", () => {
    const groups = checkGroups([]);
    expect(groups.length).toBeGreaterThanOrEqual(14);
    expect(groups.every((g) => g.result === "ok")).toBe(true);
  });
});

describe("ArduPilot motor order", () => {
  it("numbers a quad X the way AP_MotorsMatrix does", () => {
    // +X right, +Y forward.
    expect(ardupilotMotor([50, 50])).toEqual({ n: 1, spin: "CCW" });
    expect(ardupilotMotor([-50, -50])).toEqual({ n: 2, spin: "CCW" });
    expect(ardupilotMotor([-50, 50])).toEqual({ n: 3, spin: "CW" });
    expect(ardupilotMotor([50, -50])).toEqual({ n: 4, spin: "CW" });
  });

  it("gives every studio layout one motor in each quadrant", () => {
    for (const [, s] of CASES) {
      const ns = designFrame(s).motors.map((m) => ardupilotMotor(m).n).sort();
      expect(ns).toEqual([1, 2, 3, 4]);
    }
  });
});

describe("wrap", () => {
  it("keeps lines inside the width and loses no words", () => {
    const t = "The arm is the part that carries every load, so it is sized from the loads.";
    const lines = wrap(t, 3, 40);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(" ")).toBe(t);
  });
  it("turns characters Helvetica lacks into ones it has", () => {
    expect(clean("2 → 3 ≈ 4")).toBe("2 -> 3 ~ 4");
  });
});

/*
  REPORT_OUT=/some/dir npx vitest run report writes the sample reports out,
  for rasterising and looking at. Reached through globalThis because the app's
  type settings, rightly, do not know about Node.
*/
const OUT = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.REPORT_OUT;
if (OUT) {
  it("writes sample reports for inspection", async () => {
    const fs = (await import(/* @vite-ignore */ `node:${"fs"}`)) as { writeFileSync: (p: string, b: Uint8Array) => void };
    for (const [n, s] of CASES) fs.writeFileSync(`${OUT}/${n.replace(/[^a-z0-9]+/gi, "-")}.pdf`, toBuildReportPDF(input(s)));
  });
}
