import { describe, expect, it } from "vitest";
import { ROUTES } from "../../../app/routes";
import { GUIDES } from "../../../app/guide";
import { DEFAULT_CONFIG } from "../../keyboard-flight/flightController";
import { DEFAULT_LIMITS, GIVE_UP_M } from "../../../geo/fence";
import { DETAILED_PATHS, MANUAL, manualText } from "../manual";
import { RULES, systemBlocks } from "../prompt";
import { PAGE_STARTERS } from "../starters";

const text = manualText();
const paths = new Set(ROUTES.map((r) => r.path));

describe("the assistant's manual", () => {
  it("has an entry for every page, with its guide and its detail", () => {
    for (const r of ROUTES) {
      const t = MANUAL.find((m) => m.path === r.path);
      expect(t, r.path).toBeDefined();
      expect(t!.body).toContain(GUIDES[r.path].purpose);
      for (const step of GUIDES[r.path].steps) expect(t!.body).toContain(step);
      expect(DETAILED_PATHS, r.path).toContain(r.path);
    }
  });

  it("states Keyboard Flight's limits as the controller enforces them", () => {
    const kf = MANUAL.find((m) => m.path === "/keyboard-flight")!.body;
    expect(kf).toContain(`${DEFAULT_CONFIG.maxHoriz} m/s`);
    expect(kf).toContain(`ceiling ${DEFAULT_CONFIG.maxAlt} m`);
    expect(kf).toContain(`range ${DEFAULT_CONFIG.maxRange} m`);
    expect(kf).toContain(`take-off to ${DEFAULT_CONFIG.takeoffAlt} m`);
    expect(kf).toContain("FS_GCS_ENABLE = 5");
    expect(kf).toMatch(/no key to descend/i);
  });

  it("states the fence defaults from the fence code", () => {
    const m = MANUAL.find((t) => t.path === "/missions")!.body;
    expect(m).toContain(`default ${DEFAULT_LIMITS.FENCE_ALT_MAX} m above home`);
    expect(m).toContain(`More than ${GIVE_UP_M} m outside`);
  });

  it("links only to pages that exist", () => {
    const linked = [...text.matchAll(/\]\(#(\/[a-z-]*)\)/g)].map((m) => m[1]);
    expect(linked.length).toBeGreaterThan(20);
    for (const p of linked) expect(paths, p).toContain(p);
    for (const p of Object.keys(PAGE_STARTERS)) expect(paths, p).toContain(p);
  });

  it("says what AERONEX cannot do", () => {
    const limits = MANUAL.find((t) => t.id === "limits")!.body;
    for (const w of ["firmware", "PX4", "logs", "UDP", ".plan", "rally", "AutoTune"]) expect(limits).toContain(w);
  });

  it("holds nothing unfinished, and stays a size worth caching", () => {
    expect(text).not.toMatch(/\b(TODO|TBD|FIXME|lorem)\b/i);
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("NaN");
    expect(text.length).toBeGreaterThan(20_000);
    expect(text.length).toBeLessThan(90_000);
  });
});

describe("the assistant's instructions", () => {
  it("puts the fixed part first, marked for caching, and the live part after it", () => {
    const blocks = systemBlocks("Page open: Overview (#/).");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[0].text).toContain("# AERONEX MANUAL");
    expect(blocks[0].text).toContain("# VERIFIED REFERENCE");
    expect(blocks[1].cache_control).toBeUndefined();
    expect(blocks[1].text).toContain("Page open: Overview");
    // The cached part must not change from one question to the next.
    expect(systemBlocks("other")[0].text).toBe(blocks[0].text);
  });

  it("keeps the rules that make it safe to trust", () => {
    expect(RULES).toMatch(/AERONEX does not have it/);
    expect(RULES).toMatch(/Never describe a page, button, keyboard key or option that the manual does not describe/);
    expect(RULES).toMatch(/Never tell anyone to disable arming checks/);
    expect(RULES).toMatch(/You cannot see the aircraft, press buttons, change settings or fly it/);
    expect(RULES).toMatch(/\[Keyboard Flight\]\(#\/keyboard-flight\)/);
    expect(RULES).toMatch(/"I don't know" is an acceptable answer/);
  });
});
