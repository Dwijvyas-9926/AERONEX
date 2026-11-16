import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadLog } from "../src/logs/load";

/*
  The log checks against real ArduCopter flights with real faults.

  sitl/genlogs.py flies ArduCopter's SITL build (the flight code of a
  Pixhawk, with simulated sensors) through a normal flight and through each
  fault the checks look for, and keeps both the on-board .bin and the
  telemetry .tlog of each:

      python3 sitl/genlogs.py <out> <ardupilot> <instance> normal vibration clipping motorfail gpsloss battery compass brownout

  Then each log is read here and the right finding must come up, at the
  right severity, and the normal flight must raise no flight problem at all.

      LOG_FIXTURES=<out> npx vitest run sitl/logfaults

  Skipped without LOG_FIXTURES.
*/
const DIR = process.env.LOG_FIXTURES;

/** Findings each scenario must raise. A list of alternatives means any one of them. */
const EXPECT: Record<string, { bin: (string | string[])[]; tlog: (string | string[])[] }> = {
  vibration: { bin: [["warn:vibe.high.0", "fail:vibe.high.0"]], tlog: [["warn:vibe.high.0", "fail:vibe.high.0"]] },
  clipping: { bin: ["fail:vibe.clip.0", "fail:vibe.high.0"], tlog: ["fail:vibe.clip.0"] },
  motorfail: { bin: ["fail:control.attitude.lost"], tlog: ["fail:control.attitude.lost"] },
  gpsloss: { bin: ["fail:gps.lost.0", "fail:ekf.err.17", "fail:mode.failsafe"], tlog: ["fail:gps.lost.0", "fail:msg.failsafe"] },
  battery: { bin: ["fail:err.6001", "fail:mode.failsafe"], tlog: ["fail:msg.failsafe"] },
  compass: { bin: ["fail:compass.change.0"], tlog: ["fail:compass.change.0"] },
  brownout: { bin: ["fail:flight.end.airborne"], tlog: ["warn:flight.end.airborne"] },
};

const scenarios = DIR && existsSync(DIR) ? readdirSync(DIR).filter((d) => existsSync(path.join(DIR, d, `${d}.bin`))) : [];

describe.skipIf(!DIR)("the log checks on real ArduCopter fault flights", () => {
  for (const name of scenarios) {
    for (const kind of ["bin", "tlog"] as const) {
      const file = path.join(DIR!, name, `${name}.${kind}`);
      if (!existsSync(file)) continue;
      it(`${name}.${kind}`, () => {
        const b = readFileSync(file);
        const { flight, analysis } = loadLog(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), `${name}.${kind}`);
        const got = analysis.findings.map((f) => `${f.severity}:${f.id}`);
        // Ids with a time or text in them are matched by their start.
        const has = (want: string) => got.some((g) => g === want || g.startsWith(`${want}.`));
        console.log(`${name}.${kind} (${flight.firmware ?? flight.vehicle}): ${analysis.verdict}; ${got.join(", ")}`);
        expect(flight.raw.stats.skipped).toBe(0);
        if (name.startsWith("normal")) {
          // A clean flight: nothing about the flight itself. (Settings findings depend on SITL's defaults.)
          expect(analysis.findings.filter((f) => f.area !== "Setup" && f.severity !== "info").map((f) => f.id)).toEqual([]);
          expect(analysis.summary.flightTime).toBeGreaterThan(20);
          return;
        }
        const want = EXPECT[name]?.[kind];
        if (!want) return;
        for (const w of want) {
          const alts = Array.isArray(w) ? w : [w];
          expect(alts.some(has), `${name}.${kind} should raise ${alts.join(" or ")}; it raised ${got.join(", ")}`).toBe(true);
        }
      });
    }
  }
});
