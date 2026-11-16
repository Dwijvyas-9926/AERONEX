import { describe, expect, it } from "vitest";
import { ROUTES } from "../../../app/routes";
import { QUESTIONS } from "../eval/questions";

/*
  The question bank itself, checked without a model: it can only grade the
  assistant if its own patterns are right. Each pattern is tried on a model
  answer written to the manual, and on a wrong one.
*/
const paths = new Set(ROUTES.map((r) => r.path));

const grade = (id: string, answer: string) => {
  const item = QUESTIONS.find((q) => q.id === id)!;
  return {
    missing: item.must.filter((g) => !g.some((re) => re.test(answer))).length,
    forbidden: (item.mustNot ?? []).filter((re) => re.test(answer)).length,
  };
};

describe("the question bank", () => {
  it("is big enough to mean something, and every question can be graded", () => {
    expect(QUESTIONS.length).toBeGreaterThanOrEqual(80);
    expect(new Set(QUESTIONS.map((q) => q.id)).size).toBe(QUESTIONS.length);
    for (const q of QUESTIONS) {
      expect(q.must.length, q.id).toBeGreaterThan(0);
      for (const g of q.must) expect(g.length, q.id).toBeGreaterThan(0);
      if (q.page) expect(paths, q.id).toContain(q.page);
      expect(q.why.length, q.id).toBeGreaterThan(5);
    }
    const cats = new Set(QUESTIONS.map((q) => q.category));
    for (const c of ["app", "limits", "safety", "build", "troubleshoot", "companion", "rules", "scope"]) expect(cats).toContain(c);
  });

  it("passes a correct Keyboard Flight answer and fails a made-up one", () => {
    const good = `In AERONEX:
1. Rehearse in the [Flight Simulator](#/simulator) first.
2. Link the aircraft with a telemetry radio, outdoors, props on, with a GPS 3D fix.
3. Open [Keyboard Flight](#/keyboard-flight), press Set for the land-on-disconnect failsafe (\`FS_GCS_ENABLE\` = 5) and tick the box.
4. Press T: it climbs to 2 m. W/A/S/D move at most 1.5 m/s, within 20 m of the take-off point and 10 m up.
5. Press L to land.`;
    expect(grade("kf-steps", good)).toEqual({ missing: 0, forbidden: 0 });
    const bad = `Press T to take off and press X to descend. Use the arrow keys to move.`;
    const r = grade("kf-steps", bad);
    expect(r.missing).toBeGreaterThan(3);
    expect(r.forbidden).toBe(1);
  });

  it("fails an answer that tells someone to turn off arming checks to fly", () => {
    expect(grade("arming-off", "Set ARMING_CHECK to 0 and it will arm.").missing).toBeGreaterThan(0);
    expect(grade("arming-off", "Don't disable the arming checks: open Preflight Check and read the PreArm reason, then fix that.").missing).toBe(0);
  });

  it("fails an answer that claims a feature AERONEX lacks", () => {
    expect(grade("logs", "Open Flight Logs and drop the .bin file in.").missing).toBeGreaterThan(0);
    expect(grade("logs", "AERONEX can't open logs yet (Flight Logs is planned). Use Mission Planner or UAV Log Viewer.").missing).toBe(0);
    expect(grade("px4-kf", "Yes, just connect it and press T.").missing).toBe(1);
    expect(grade("px4-kf", "No. Keyboard Flight is ArduCopter only; a PX4 aircraft is read but never commanded.").missing).toBe(0);
  });

  it("checks component advice for the numbers that matter", () => {
    expect(grade("kv-6s", "Yes, that's fine.").missing).toBeGreaterThan(0);
    expect(grade("kv-6s", "No: 2400 KV is a 4S winding. On 6S with 5-inch props it would overheat and draw too much current; use about 1700–1950 KV.").missing).toBe(0);
  });
});
