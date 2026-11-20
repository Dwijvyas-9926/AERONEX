import { describe, expect, it } from "vitest";
import { parseApj } from "../firmware/apj";
import { fromWaypointFile } from "../geo/planFile";
import { loadLog } from "../logs/load";
import { parseParamFile } from "../mavlink/paramFile";
import { missionToPlan } from "../state/simStore";

/*
  Files come from outside: a log off an SD card, a mission or settings file
  from another ground station, a firmware file from a download. Whatever is in
  one, opening it must end in either a result or an Error with words in it,
  promptly, and never in a hang, a crash of another kind, or a result that
  carries values no aircraft could be sent (NaN, a place off the Earth).

  A fixed seed, so a failure can be run again.
*/
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const bytes = (r: () => number, n: number) => Uint8Array.from({ length: n }, () => Math.floor(r() * 256));
const NASTY = ["", " ", "\n\n\n", "\u0000\u0000", "NaN", "Infinity", "-Infinity", "1e999", "0x10", "{}", "[]", "null", "<script>alert(1)</script>", "QGC WPL 110", "QGC WPL 110\n", "a".repeat(100000), "﻿", "1,2,3", "🚁", "__proto__,1", "constructor 5", "toString\t3"];

/** Runs fn; passes when it returns or throws an Error with a message. */
function settles<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch (e) {
    expect(e, "throws an Error, not something else").toBeInstanceOf(Error);
    expect((e as Error).message.length, "the error has words").toBeGreaterThan(3);
    // A TypeError or RangeError from inside is a crash, not an answer.
    expect((e as Error).name === "TypeError" || (e as Error).name === "RangeError" || (e as Error).name === "ReferenceError", `a ${(e as Error).name}: ${(e as Error).message}`).toBe(false);
    return undefined;
  }
}

describe("files from outside", () => {
  it("a waypoint file: nonsense is refused in words, and nothing unusable comes out", () => {
    const r = rng(1);
    const tries: string[] = [...NASTY];
    for (let i = 0; i < 300; i++) {
      const rows = Array.from({ length: 1 + Math.floor(r() * 6) }, (_, k) =>
        Array.from({ length: 8 + Math.floor(r() * 6) }, () => {
          const x = r();
          return x < 0.08 ? "NaN" : x < 0.12 ? "1e400" : x < 0.16 ? "abc" : x < 0.2 ? "" : String(Math.round((r() - 0.5) * (r() < 0.2 ? 1e9 : 400) * 1e6) / 1e6);
        }).join(r() < 0.5 ? "\t" : " ") + (k % 2 ? "\r" : ""),
      );
      tries.push(`QGC WPL 110\n${rows.join("\n")}`);
    }
    for (const t of tries) {
      const items = settles(() => fromWaypointFile(t));
      if (!items) continue;
      for (const it of items) {
        for (const v of [it.frame, it.command, it.p1, it.p2, it.p3, it.p4, it.x, it.y, it.z]) expect(Number.isFinite(v)).toBe(true);
        expect(Math.abs(it.x)).toBeLessThanOrEqual(90e7);
        expect(Math.abs(it.y)).toBeLessThanOrEqual(180e7);
      }
      // And reading it into a plan settles too.
      const plan = settles(() => missionToPlan(items, { lat: 23, lon: 72, altMsl: 50 }));
      if (plan) for (const p of plan.points) for (const v of [p.n, p.e, p.alt, p.holdS]) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("a settings file: every value kept is a finite number, and names are plain", () => {
    const r = rng(2);
    const tries: string[] = [...NASTY, "A,1\nA,2\nB\nC,,\n,5\n#x\nD 3\nE\t4\nF=5", "X,nan\nY,inf\nZ,1e39\nW,-0\nV,0x1F", "__proto__,1\nconstructor,2\nhasOwnProperty,3"];
    for (let i = 0; i < 200; i++) tries.push(Array.from({ length: 5 }, () => String.fromCharCode(...bytes(r, 1 + Math.floor(r() * 30)))).join("\n"));
    for (const t of tries) {
      const p = settles(() => parseParamFile(t));
      if (!p) continue;
      for (const [k, v] of Object.entries(p.values)) {
        expect(Number.isFinite(v), `${k} = ${v}`).toBe(true);
        expect(/^[A-Z0-9_]{1,16}$/.test(k), `name "${k}"`).toBe(true);
      }
      // A file cannot reach into the object it is read into.
      expect(Object.getPrototypeOf(p.values) === Object.prototype || Object.getPrototypeOf(p.values) === null).toBe(true);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    }
  });

  it("a firmware file: anything but a whole .apj is refused in words", async () => {
    const r = rng(3);
    const tries: string[] = [...NASTY, '{"board_id":9}', '{"board_id":9,"image":"!!!!","image_size":10}', '{"board_id":"9","image":"","image_size":0}', '{"board_id":9,"image":"eJwDAAAAAAE=","image_size":1e12}', '{"board_id":9,"image":"eJwDAAAAAAE=","image_size":-1}', JSON.stringify({ board_id: 9, image: btoa(String.fromCharCode(...bytes(r, 400))), image_size: 400 })];
    for (const t of tries) {
      try {
        const a = await parseApj(t);
        expect(a.image.length).toBeGreaterThan(0);
        expect(Number.isInteger(a.boardId)).toBe(true);
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
        expect((e as Error).message.length).toBeGreaterThan(3);
        expect((e as Error).name === "TypeError" || (e as Error).name === "RangeError", `${(e as Error).name}: ${(e as Error).message} for ${t.slice(0, 60)}`).toBe(false);
      }
    }
  });

  it("a flight log: random and cut-short bytes are refused or read, never a crash or a hang", () => {
    const r = rng(4);
    const started = Date.now();
    const tries: Uint8Array[] = [new Uint8Array(0), new Uint8Array(1), new Uint8Array(3).fill(0xa3)];
    // Dataflash-looking: the header bytes, an FMT record, then noise.
    for (let i = 0; i < 60; i++) {
      const b = bytes(r, 200 + Math.floor(r() * 4000));
      b[0] = 0xa3;
      b[1] = 0x95;
      b[2] = 0x80;
      // Sprinkle more record headers through it.
      for (let k = 89; k + 3 < b.length; k += 20 + Math.floor(r() * 90)) {
        b[k] = 0xa3;
        b[k + 1] = 0x95;
        b[k + 2] = r() < 0.5 ? 0x80 : Math.floor(r() * 256);
      }
      tries.push(b);
    }
    // Telemetry-log-looking: 8 bytes of time, then a MAVLink start byte and noise.
    for (let i = 0; i < 60; i++) {
      const b = bytes(r, 100 + Math.floor(r() * 3000));
      for (let k = 0; k + 20 < b.length; k += 20 + Math.floor(r() * 60)) b[k + 8] = r() < 0.5 ? 0xfd : 0xfe;
      tries.push(b);
    }
    for (let i = 0; i < 40; i++) tries.push(bytes(r, Math.floor(r() * 5000)));
    for (const b of tries) {
      const got = settles(() => loadLog(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, "fuzz.bin"));
      if (got) expect(got.flight).toBeDefined();
    }
    expect(Date.now() - started).toBeLessThan(30000);
  }, 60000);
});
