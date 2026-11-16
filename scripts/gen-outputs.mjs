#!/usr/bin/env node
/*
  Builds src/servo/outputs.generated.ts from an ArduPilot source tree: for
  every flight-controller board, its servo/motor outputs as the firmware
  numbers them (SERVO1, SERVO2 …), which ones share a timer and so must run
  at the same rate, and the GPIO number each one becomes when used as a relay
  or GPIO pin. Run it again when ArduPilot adds boards:

      node scripts/gen-outputs.mjs ~/ardupilot

  Read from each board's hwdef.dat (with "include" and "undef" applied) as
  chibios_hwdef.py reads it:
  - a board with an IO coprocessor (IOMCU_UART) has 8 outputs on it, SERVO1-8,
    driven in three groups, 1-2, 3-4 and 5-8 (AP_IOMCU ch_masks 0x03, 0x0C,
    0xF0), as GPIO 101-108; its own PWM(n) pins follow as SERVO 8+n;
  - otherwise PWM(n) is SERVOn;
  - outputs on the same timer (TIMx) share one rate.
*/
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("usage: node scripts/gen-outputs.mjs <ardupilot source tree>");
  process.exit(1);
}
const hwdefDir = path.join(root, "libraries/AP_HAL_ChibiOS/hwdef");
const types = new Map();
for (const line of readFileSync(path.join(root, "Tools/AP_Bootloader/board_types.txt"), "utf8").split("\n")) {
  const m = /^\s*(\S+)\s+(\d+)/.exec(line);
  if (m) types.set(m[1], Number(m[2]));
}

/** Lines of a hwdef with includes expanded and "undef" applied, in order. */
function expand(file, seen = new Set()) {
  if (seen.has(file) || !existsSync(file)) return [];
  seen.add(file);
  let out = [];
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const inc = /^include\s+(\S+)/.exec(line);
    if (inc) {
      out.push(...expand(path.resolve(path.dirname(file), inc[1]), seen));
      continue;
    }
    const un = /^undef\s+(.+)$/.exec(line);
    if (un) {
      for (const what of un[1].split(/\s+/)) out = out.filter((l) => l.split(/\s+/)[0] !== what);
      continue;
    }
    out.push(line);
  }
  return out;
}

const last = (lines, key) => {
  let v;
  for (const l of lines) {
    const m = new RegExp(`^${key}\\s+(.+)$`).exec(l);
    if (m) v = m[1].trim();
  }
  return v;
};

const layouts = [];
const layoutKey = new Map();
const byPlatform = {};
const platformId = {};
const idsOf = new Map();
for (const name of readdirSync(hwdefDir).sort()) {
  const file = path.join(hwdefDir, name, "hwdef.dat");
  if (!existsSync(file)) continue;
  const lines = expand(file);
  const text = lines.join("\n");
  if (/AP_PERIPH|IOMCU_FW|^name\s/m.test(text) || /iomcu/i.test(name)) continue;
  const idRaw = last(lines, "APJ_BOARD_ID");
  const id = idRaw === undefined ? undefined : /^\d+$/.test(idRaw) ? Number(idRaw) : types.get(idRaw);
  if (id === undefined) continue;

  const io = lines.some((l) => /^IOMCU_UART\s/.test(l));
  const outputs = [];
  if (io) for (let k = 1; k <= 8; k++) outputs.push({ servo: k, group: k <= 2 ? "IO1" : k <= 4 ? "IO2" : "IO3", gpio: 100 + k, io: true });
  const base = io ? 8 : 0;
  // A pin defined twice (by an include and the board) counts once: the last definition wins.
  const pins = new Map();
  for (const l of lines) {
    const m = /^(P[A-K]\d+)\s+(TIM\d+)_CH\d+N?\s+TIM\d+\s.*\bPWM\((\d+)\)/.exec(l);
    if (m) {
      const g = /\bGPIO\((\d+)\)/.exec(l);
      pins.set(m[1], { pwm: Number(m[3]), timer: m[2], gpio: g ? Number(g[1]) : null });
    }
  }
  for (const p of [...pins.values()].sort((a, b) => a.pwm - b.pwm)) outputs.push({ servo: base + p.pwm, group: p.timer, gpio: p.gpio, io: false });
  if (!outputs.length) continue;
  outputs.sort((a, b) => a.servo - b.servo);

  const groups = [];
  const index = new Map();
  for (const o of outputs) {
    if (!index.has(o.group)) {
      index.set(o.group, groups.length);
      groups.push([]);
    }
    groups[index.get(o.group)].push(o.servo);
  }
  const layout = { io, servos: outputs.map((o) => o.servo), gpio: outputs.map((o) => o.gpio), groups };
  const key = JSON.stringify(layout);
  if (!layoutKey.has(key)) {
    layoutKey.set(key, layouts.length);
    layouts.push(layout);
  }
  const li = layoutKey.get(key);
  byPlatform[name] = li;
  platformId[name] = id;
  if (!idsOf.has(id)) idsOf.set(id, new Set());
  idsOf.get(id).add(li);
}

// A board id whose platforms all have the same outputs can be resolved from the id alone.
const byId = {};
for (const [id, set] of idsOf) if (set.size === 1) byId[id] = [...set][0];
// Otherwise the layout most of its boards share (board id 9: the Pixhawk1 family, with a few odd ones out).
const likely = {};
for (const [id, set] of idsOf) {
  if (set.size === 1) continue;
  const count = new Map();
  for (const [, li] of Object.entries(byPlatform).filter(([n]) => platformId[n] === id)) count.set(li, (count.get(li) ?? 0) + 1);
  const total = [...count.values()].reduce((a, b) => a + b, 0);
  const [li, n] = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
  if (n / total >= 0.6) likely[id] = li;
}

const out = `/*
  Generated by scripts/gen-outputs.mjs from ArduPilot's hardware definitions
  (${Object.keys(byPlatform).length} boards, ${layouts.length} distinct output layouts). Do not edit by hand.

  OUTPUT_LAYOUTS: the servo/motor outputs of a board, as SERVOn numbers.
    io: the first 8 are on an IO coprocessor (MAIN OUT); the rest are the
        main processor's own (AUX OUT on a Pixhawk).
    gpio: the GPIO number each output becomes as a relay or GPIO pin.
    groups: outputs that share a timer and therefore one output rate.
  LAYOUT_BY_BOARD_ID: board id (as AUTOPILOT_VERSION reports it) → layout,
    for ids whose boards all have the same outputs.
  LAYOUT_LIKELY_BY_BOARD_ID: for ids shared by boards with different outputs,
    the layout at least 60% of them have.
  LAYOUT_BY_PLATFORM: ArduPilot build name → layout.
*/
export interface OutputLayout {
  io: boolean;
  servos: number[];
  gpio: (number | null)[];
  groups: number[][];
}

export const OUTPUT_LAYOUTS: OutputLayout[] = [
${layouts.map((l) => `  { io: ${l.io}, servos: [${l.servos.join(", ")}], gpio: [${l.gpio.map((g) => (g === null ? "null" : g)).join(", ")}], groups: [${l.groups.map((g) => `[${g.join(", ")}]`).join(", ")}] },`).join("\n")}
];

export const LAYOUT_BY_BOARD_ID: Record<number, number> = { ${Object.entries(byId)
  .sort((a, b) => Number(a[0]) - Number(b[0]))
  .map(([k, v]) => `${k}: ${v}`)
  .join(", ")} };

export const LAYOUT_LIKELY_BY_BOARD_ID: Record<number, number> = { ${Object.entries(likely)
  .sort((a, b) => Number(a[0]) - Number(b[0]))
  .map(([k, v]) => `${k}: ${v}`)
  .join(", ")} };

export const LAYOUT_BY_PLATFORM: Record<string, number> = { ${Object.entries(byPlatform)
  .map(([k, v]) => `${JSON.stringify(k)}: ${v}`)
  .join(", ")} };
`;
const dest = path.join(path.dirname(new URL(import.meta.url).pathname), "../src/servo/outputs.generated.ts");
writeFileSync(dest, out);
console.log(`${Object.keys(byPlatform).length} boards, ${layouts.length} layouts, ${Object.keys(byId).length} ids resolvable → ${dest}`);
