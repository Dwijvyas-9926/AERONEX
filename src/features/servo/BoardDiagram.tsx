/*
  The flight controller's servo rail, drawn: for a Pixhawk 2.4.8 (Pixhawk 1
  class), a top view of the board showing where the rail is, and the rail
  itself end-on, in the order printed on the case seen from the rear — RC IN,
  SB, MAIN OUT 8 to 1 and AUX OUT 6 to 1, each a column of
  signal, + and − pins — with what every output does, live. Outputs that
  share a rate are bracketed together. Other boards get the rail alone, in
  ArduPilot's output order and timer groups.

  Colour marks the kind of function and is never the only cue: every pin
  carries its function's short name, and the selected one is named in full.
*/
import { useState } from "react";
import { functionInfo, type Output } from "../../servo/model";
import { categoryOf, shortName } from "./labels";

interface Props {
  outputs: Output[];
  pwm: (number | undefined)[];
  /** Pixhawk 2.4.8 drawing, or a plain rail. */
  pixhawk1: boolean;
  /** The groups that run at the motors' rate (they contain a motor). */
  rateText: (group: number[]) => string;
  selected: number | null;
  onSelect: (servo: number) => void;
  /** Outputs with a warning, to flag on the drawing. */
  flagged: Set<number>;
  firmwareNames?: [number, string][];
}

const COL = 40;
const PIN = 15;

export function BoardDiagram(props: Props) {
  const [hover, setHover] = useState<number | null>(null);
  return props.pixhawk1 ? <Pixhawk {...props} hover={hover} setHover={setHover} /> : <PlainRail {...props} hover={hover} setHover={setHover} />;
}

type Inner = Props & { hover: number | null; setHover: (n: number | null) => void };

/** One output's column of three pins, its number above and its function below. */
function Column({ o, x, y, num, p, live }: { o: Output; x: number; y: number; num: string; p: Inner; live: number | undefined }) {
  const cat = categoryOf(o.fn);
  const sel = p.selected === o.servo;
  const hov = p.hover === o.servo;
  const on = (live ?? 0) > 0;
  const info = functionInfo(o.fn, p.firmwareNames);
  return (
    <g
      className={`sv-col sv-cat-${cat} ${sel ? "sel" : ""} ${hov ? "hov" : ""}`}
      transform={`translate(${x} ${y})`}
      role="button"
      tabIndex={0}
      aria-pressed={sel}
      aria-label={`${o.port.long}, SERVO${o.servo}: ${info.label}${live ? `, ${live} microseconds` : ""}`}
      onClick={() => p.onSelect(o.servo)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          p.onSelect(o.servo);
        }
      }}
      onMouseEnter={() => p.setHover(o.servo)}
      onMouseLeave={() => p.setHover(null)}
    >
      <rect className="sv-col-hit" x={-COL / 2} y={-34} width={COL} height={178} rx={8} />
      <text className="sv-num" x={0} y={-16} textAnchor="middle">
        {num}
      </text>
      {/* Signal, + and − pins: the signal pin carries the function's colour. */}
      <rect className={`sv-pin sv-pin-sig ${on ? "live" : ""}`} x={-PIN / 2} y={0} width={PIN} height={PIN} rx={2.5} />
      <rect className="sv-pin sv-pin-pwr" x={-PIN / 2} y={26} width={PIN} height={PIN} rx={2.5} />
      <rect className="sv-pin sv-pin-gnd" x={-PIN / 2} y={52} width={PIN} height={PIN} rx={2.5} />
      <g className="sv-chip" transform="translate(0 86)">
        <rect x={-17} y={0} width={34} height={20} rx={5} />
        <text x={0} y={14} textAnchor="middle">
          {shortName(o)}
        </text>
      </g>
      {p.flagged.has(o.servo) && (
        <g className="sv-flag" transform="translate(13 -30)" aria-hidden="true">
          <circle r={7} />
          <text y={3.5} textAnchor="middle">
            !
          </text>
        </g>
      )}
      <text className="sv-live" x={0} y={124} textAnchor="middle">
        {live ? live : ""}
      </text>
    </g>
  );
}

/** A fixed column that is not an output (RC IN, SB). */
function FixedColumn({ x, y, label, sub }: { x: number; y: number; label: string; sub: string }) {
  return (
    <g className="sv-fixed" transform={`translate(${x} ${y})`}>
      <title>{sub}</title>
      <text className="sv-num" x={0} y={-16} textAnchor="middle">
        {label}
      </text>
      <rect className="sv-pin sv-pin-in" x={-PIN / 2} y={0} width={PIN} height={PIN} rx={2.5} />
      <rect className="sv-pin sv-pin-pwr" x={-PIN / 2} y={26} width={PIN} height={PIN} rx={2.5} />
      <rect className="sv-pin sv-pin-gnd" x={-PIN / 2} y={52} width={PIN} height={PIN} rx={2.5} />
      <text className="sv-fixed-sub" x={0} y={100} textAnchor="middle">
        {sub.split(" ")[0]}
      </text>
    </g>
  );
}

/** Brackets under outputs that share a rate. */
function Groups({ groups, xOf, y, p }: { groups: number[][]; xOf: (servo: number) => number | null; y: number; p: Inner }) {
  return (
    <g className="sv-groups">
      {groups.map((g) => {
        const xs = g.map(xOf).filter((v): v is number => v !== null);
        if (!xs.length) return null;
        const a = Math.min(...xs) - COL / 2 + 5;
        const b = Math.max(...xs) + COL / 2 - 5;
        const text = p.rateText(g);
        const hot = /Hz with motors|DShot|OneShot/.test(text);
        return (
          <g key={g.join("-")} className={hot ? "hot" : ""}>
            <path d={`M${a} ${y} v8 H${b} v-8`} />
            <text x={(a + b) / 2} y={y + 24} textAnchor="middle">
              {text.replace(/ with motors$/, "")}
            </text>
            {hot && (
              <text className="sv-groups-sub" x={(a + b) / 2} y={y + 38} textAnchor="middle">
                motors
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}

function Pixhawk(p: Inner) {
  const byServo = new Map(p.outputs.map((o) => [o.servo, o]));
  // The rail, left to right as printed on a Pixhawk 2.4.8's case seen from the rear:
  // RC IN, SB, then MAIN OUT 8 down to 1, then AUX OUT 6 down to 1.
  const X0 = 440;
  const railY = 210;
  const xRc = X0;
  const xSb = X0 + COL;
  const mainStart = X0 + COL * 2 + 14;
  const xMain = (k: number) => mainStart + (8 - k) * COL;
  const auxStart = xMain(1) + COL + 26;
  const xAux = (k: number) => auxStart + (6 - k) * COL;
  const xOf = (servo: number) => (servo <= 8 ? xMain(servo) : servo <= 14 ? xAux(servo - 8) : null);
  const left = xRc - COL / 2 - 104;
  const right = xAux(1) + COL / 2 + 14;
  const sel = p.selected !== null ? byServo.get(p.selected) : undefined;
  const focus = p.hover !== null ? byServo.get(p.hover) : sel;

  return (
    <svg className="sv-board" viewBox="0 0 1300 470" role="group" aria-label="Pixhawk 2.4.8 servo rail. Choose an output to set it up.">
      <defs>
        <linearGradient id="sv-case" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fbfaf7" />
          <stop offset="1" stopColor="#dcd8cf" />
        </linearGradient>
        <linearGradient id="sv-top" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2a3550" />
          <stop offset="1" stopColor="#161f33" />
        </linearGradient>
        <linearGradient id="sv-header" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2b2f38" />
          <stop offset="1" stopColor="#15181e" />
        </linearGradient>
        <linearGradient id="sv-gold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f3d48a" />
          <stop offset="0.55" stopColor="#c99a3b" />
          <stop offset="1" stopColor="#8c6420" />
        </linearGradient>
        <filter id="sv-shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="6" stdDeviation="8" floodColor="#14213d" floodOpacity="0.18" />
        </filter>
      </defs>

      {/* ---- Top view of the board: where the rail is ---- */}
      <g className="sv-top" transform="translate(40 40)">
        <text className="sv-caption" x={115} y={-24} textAnchor="middle">
          Top view
        </text>
        <rect x={0} y={0} width={230} height={376} rx={22} fill="url(#sv-case)" stroke="#bdb6a6" filter="url(#sv-shadow)" />
        <rect x={18} y={18} width={194} height={300} rx={14} fill="url(#sv-top)" />
        {/* Forward arrow, as on the case */}
        <g transform="translate(115 120)" className="sv-arrow">
          <path d="M0 -58 L26 -18 H10 V40 H-10 V-18 H-26 Z" />
        </g>
        <text className="sv-board-name" x={115} y={210} textAnchor="middle">
          PIXHAWK
        </text>
        <text className="sv-board-sub" x={115} y={232} textAnchor="middle">
          2.4.8 · FMUv3
        </text>
        {/* Status LED and the front ports, for orientation */}
        <circle cx={115} cy={280} r={9} className="sv-led" />
        <g className="sv-ports">
          {[24, 62, 100, 138, 176].map((x) => (
            <rect key={x} x={x + 4} y={-7} width={26} height={10} rx={2} />
          ))}
          {[40, 90, 140, 190, 240].map((y) => (
            <rect key={`l${y}`} x={-7} y={y} width={10} height={26} rx={2} />
          ))}
          {[40, 90, 140, 190, 240].map((y) => (
            <rect key={`r${y}`} x={227} y={y} width={10} height={26} rx={2} />
          ))}
        </g>
        {/* The rail at the rear end, highlighted */}
        <rect x={16} y={330} width={198} height={34} rx={6} className="sv-rail-mark" />
        {Array.from({ length: 16 }, (_, i) => (
          <rect key={i} x={24 + i * 11.6} y={339} width={7} height={16} rx={1.5} className="sv-rail-mini" />
        ))}
        <text className="sv-caption" x={115} y={400} textAnchor="middle">
          Servo rail, at the rear
        </text>
      </g>
      {/* Zoom lines from the rail to its end view */}
      <path className="sv-zoom" d={`M254 372 L${left} ${railY - 52}`} />
      <path className="sv-zoom" d={`M254 404 L${left} ${railY + 86}`} />

      {/* ---- The rail, end-on ---- */}
      <text className="sv-caption" x={(left + right) / 2} y={railY - 100} textAnchor="middle">
        Servo rail, seen from the rear
      </text>
      <rect x={left} y={railY - 52} width={right - left} height={138} rx={14} fill="url(#sv-header)" filter="url(#sv-shadow)" />
      {/* Group labels, as printed on the case */}
      <g className="sv-rail-labels">
        <text x={(xMain(1) + xMain(8)) / 2} y={railY - 68} textAnchor="middle">
          MAIN OUT
        </text>
        <path d={`M${xMain(8) - 14} ${railY - 62} H${xMain(1) + 14}`} />
        <text x={(xAux(1) + xAux(6)) / 2} y={railY - 68} textAnchor="middle">
          AUX OUT
        </text>
        <path d={`M${xAux(6) - 14} ${railY - 62} H${xAux(1) + 14}`} />
      </g>
      {/* Row names, inside the header beside the pins */}
      <g className="sv-rows sv-rows-in">
        <text x={left + 16} y={railY + 12}>
          S signal
        </text>
        <text x={left + 16} y={railY + 38}>
          + power in
        </text>
        <text x={left + 16} y={railY + 64}>
          − ground
        </text>
      </g>
      <FixedColumn x={xRc} y={railY} label="RC" sub="Receiver input (PPM / S.Bus): not an output" />
      <FixedColumn x={xSb} y={railY} label="SB" sub="S.Bus out / RSSI: not a servo output" />
      {[8, 7, 6, 5, 4, 3, 2, 1].map((k) => {
        const o = byServo.get(k);
        return o ? <Column key={o.servo} o={o} x={xMain(k)} y={railY} num={String(k)} p={p} live={p.pwm[o.servo - 1]} /> : null;
      })}
      {[6, 5, 4, 3, 2, 1].map((k) => {
        const o = byServo.get(k + 8);
        return o ? <Column key={o.servo} o={o} x={xAux(k)} y={railY} num={String(k)} p={p} live={p.pwm[o.servo - 1]} /> : null;
      })}
      <Groups groups={p.outputs.length ? groupsOf(p.outputs) : []} xOf={xOf} y={railY + 140} p={p} />

      {/* A servo plug: which wire goes where */}
      <g className="sv-plug" transform={`translate(${right + 34} ${railY - 6})`}>
        <rect x={0} y={0} width={30} height={84} rx={4} />
        <path className="w-sig" d="M30 13 C60 13 58 13 84 13" />
        <path className="w-pwr" d="M30 39 C60 39 58 39 84 39" />
        <path className="w-gnd" d="M30 65 C60 65 58 65 84 65" />
        <text x={-6} y={-12}>Servo plug</text>
        <text x={90} y={17}>signal</text>
        <text x={90} y={43}>red</text>
        <text x={90} y={69}>dark</text>
      </g>

      {/* What the pointed-at output is */}
      {focus && <Focus o={focus} live={p.pwm[focus.servo - 1]} x={(left + right) / 2} y={railY + 206} names={p.firmwareNames} />}
    </svg>
  );
}

function groupsOf(outputs: Output[]): number[][] {
  const seen = new Set<string>();
  const out: number[][] = [];
  for (const o of outputs) {
    if (!o.group) continue;
    const k = o.group.join(",");
    if (!seen.has(k)) {
      seen.add(k);
      out.push(o.group);
    }
  }
  return out;
}

function Focus({ o, live, x, y, names }: { o: Output; live: number | undefined; x: number; y: number; names?: [number, string][] }) {
  const info = functionInfo(o.fn, names);
  return (
    <g className="sv-focus" transform={`translate(${x} ${y})`}>
      <text textAnchor="middle">
        <tspan className="sv-focus-port">{o.port.long}</tspan>
        <tspan dx={10} className="sv-focus-fn">
          {info.label}
        </tspan>
        <tspan dx={10} className="sv-focus-pwm">
          {live ? `${live} µs` : live === 0 ? "no pulses" : ""}
        </tspan>
      </text>
    </g>
  );
}

/** Any other board: its outputs in ArduPilot's order, grouped by timer. */
function PlainRail(p: Inner) {
  const n = p.outputs.length;
  const gap = 16;
  const groups = groupsOf(p.outputs);
  // Lay columns out with a little space between timer groups.
  const xs = new Map<number, number>();
  let x = 120;
  let last: string | null = null;
  for (const o of p.outputs) {
    const g = o.group?.join(",") ?? null;
    if (last !== null && g !== last) x += gap;
    xs.set(o.servo, x);
    x += COL;
    last = g;
  }
  const width = Math.max(600, x + 80);
  const railY = 90;
  const sel = p.selected !== null ? p.outputs.find((o) => o.servo === p.selected) : undefined;
  const focus = p.hover !== null ? p.outputs.find((o) => o.servo === p.hover) : sel;
  return (
    <svg className="sv-board" viewBox={`0 0 ${width} ${groups.length ? 360 : 320}`} role="group" aria-label={`${n} servo outputs. Choose one to set it up.`}>
      <defs>
        <linearGradient id="sv-header2" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2b2f38" />
          <stop offset="1" stopColor="#15181e" />
        </linearGradient>
      </defs>
      <rect x={120 - COL / 2 - 14} y={railY - 52} width={x - 120 + 28 - COL / 2 + COL / 2} height={138} rx={14} fill="url(#sv-header2)" />
      <g className="sv-rows">
        <text x={120 - COL / 2 - 26} y={railY + 11} textAnchor="end">
          S
        </text>
        <text x={120 - COL / 2 - 26} y={railY + 37} textAnchor="end">
          +
        </text>
        <text x={120 - COL / 2 - 26} y={railY + 63} textAnchor="end">
          −
        </text>
      </g>
      {p.outputs.map((o) => (
        <Column key={o.servo} o={o} x={xs.get(o.servo)!} y={railY} num={String(o.servo)} p={p} live={p.pwm[o.servo - 1]} />
      ))}
      <Groups groups={groups} xOf={(s) => xs.get(s) ?? null} y={railY + 140} p={p} />
      {focus && <Focus o={focus} live={p.pwm[focus.servo - 1]} x={width / 2} y={railY + 216} names={p.firmwareNames} />}
    </svg>
  );
}
