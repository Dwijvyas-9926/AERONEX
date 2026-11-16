/*
  Reading an ArduPilot DataFlash log (.bin), as the flight controller wrote it
  to its SD card.

  The format describes itself. Every message starts with the bytes A3 95 and
  a type number; FMT messages say, for each type, its name, its length, the C
  type of each field (one character each) and the field names. FMTU messages
  add each field's unit and multiplier. Nothing about message layouts is
  built in here except FMT itself, so a log from any ArduPilot version, with
  messages this code has never seen, reads correctly.

  Values are scaled the way pymavlink's DFReader (and so Mission Planner, UAV
  Log Viewer and MAVExplorer) scale them: the format characters c, C, e, E
  are hundredths and L is latitude/longitude in 1e-7 degrees; everything else
  is the stored number. That keeps every value here the same as in the tools
  ArduPilot's own documentation uses. Where a unit's multiplier means the
  stored number is not yet in that unit (PM.Load is in tenths of a percent),
  the table says so in `scales` rather than changing the number.

  Reading is two passes over the bytes: the first finds the formats and
  counts each type, the second fills columns of exactly that size. Bytes that
  are not a message (a corrupted block, garbage after a power cut) are
  stepped over one at a time until a known message starts again, and counted.
*/
import type { Column, RawLog, ReadStats, Table } from "./types";

const HEAD1 = 0xa3;
const HEAD2 = 0x95;
const FMT_TYPE = 128;
const FMT_LEN = 89;

/** Bytes each format character takes. */
const SIZE: Record<string, number> = {
  a: 64, b: 1, B: 1, h: 2, H: 2, i: 4, I: 4, f: 4, d: 8, n: 4, N: 16, Z: 64,
  c: 2, C: 2, e: 4, E: 4, L: 4, M: 1, q: 8, Q: 8, g: 2,
};

/** Scaling implied by the format character (pymavlink DFReader's). */
const IMPLIED: Record<string, number> = { c: 0.01, C: 0.01, e: 0.01, E: 0.01, L: 1e-7 };

/** Characters stored as text. */
const TEXT = new Set(["n", "N", "Z", "a"]);
/** Characters needing double precision: 32/64-bit integers and doubles. */
const WIDE = new Set(["i", "I", "e", "E", "L", "q", "Q", "d"]);

interface Format {
  type: number;
  length: number;
  name: string;
  format: string;
  fields: string[];
  /** Byte offset of each field in the message body (after the 3-byte header). */
  offsets: number[];
  units: string;
  mults: string;
}

const latin1 = (b: Uint8Array, o: number, n: number) => {
  let s = "";
  for (let k = 0; k < n; k++) {
    const c = b[o + k];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
};

function makeFormat(type: number, length: number, name: string, format: string, labels: string): Format | null {
  const fields = labels ? labels.split(",") : [];
  if (!format || fields.length !== format.length) return null;
  const offsets: number[] = [];
  let o = 0;
  for (const ch of format) {
    const s = SIZE[ch];
    if (s === undefined) return null;
    offsets.push(o);
    o += s;
  }
  // The stated length includes the 3-byte header. A mismatch means a corrupted FMT.
  if (o + 3 !== length) return null;
  return { type, length, name, format, fields, offsets, units: "", mults: "" };
}

const FMT_FMT = makeFormat(FMT_TYPE, FMT_LEN, "FMT", "BBnNZ", "Type,Length,Name,Format,Columns")!;

/** IEEE 754 half precision. */
function half(bits: number): number {
  const s = bits & 0x8000 ? -1 : 1;
  const e = (bits >> 10) & 0x1f;
  const f = bits & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

function readField(dv: DataView, bytes: Uint8Array, o: number, ch: string): number | string {
  switch (ch) {
    case "b": return dv.getInt8(o);
    case "B": case "M": return dv.getUint8(o);
    case "h": return dv.getInt16(o, true);
    case "H": return dv.getUint16(o, true);
    case "i": return dv.getInt32(o, true);
    case "I": return dv.getUint32(o, true);
    case "f": return dv.getFloat32(o, true);
    case "d": return dv.getFloat64(o, true);
    case "c": return dv.getInt16(o, true) * 0.01;
    case "C": return dv.getUint16(o, true) * 0.01;
    case "e": return dv.getInt32(o, true) * 0.01;
    case "E": return dv.getUint32(o, true) * 0.01;
    case "L": return dv.getInt32(o, true) * 1e-7;
    case "q": return Number(dv.getBigInt64(o, true));
    case "Q": return Number(dv.getBigUint64(o, true));
    case "g": return half(dv.getUint16(o, true));
    case "n": return latin1(bytes, o, 4);
    case "N": return latin1(bytes, o, 16);
    case "Z": return latin1(bytes, o, 64);
    case "a": {
      const v: number[] = [];
      for (let k = 0; k < 32; k++) v.push(dv.getInt16(o + 2 * k, true));
      return v.join(" ");
    }
  }
  return NaN;
}

/** Does a message of this format fit, and does the next one start where it ends (or the file end)? */
function fits(bytes: Uint8Array, i: number, len: number): boolean {
  return i + len <= bytes.length;
}

export interface DataflashOptions {
  /** Called with the share read so far, 0–1, now and then. */
  progress?: (share: number) => void;
}

/** True when these bytes look like a DataFlash log: they start with a message header. */
export function looksLikeDataflash(bytes: Uint8Array): boolean {
  // Logs start with FMT messages; allow a little leading junk.
  const n = Math.min(bytes.length - 2, 512);
  for (let i = 0; i < n; i++) if (bytes[i] === HEAD1 && bytes[i + 1] === HEAD2 && bytes[i + 2] === FMT_TYPE) return true;
  return false;
}

export function parseDataflash(buffer: ArrayBuffer, name: string, opt: DataflashOptions = {}): RawLog {
  const bytes = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  const stats: ReadStats = { bytes: bytes.length, messages: 0, skipped: 0, corruptSpans: 0, truncated: false, unknownTypes: 0 };
  const formats = new Map<number, Format>([[FMT_TYPE, FMT_FMT]]);
  const counts = new Map<number, number>();
  const unknown = new Set<number>();

  /*
    Pass 1: walk the messages, learning formats as they appear and counting
    each type. A FMT can redefine a type mid-log (it should not, but a log
    joined from two boots can); the last definition wins for both passes.
  */
  let i = 0;
  let inJunk = false;
  const N = bytes.length;
  const step = Math.max(1, Math.floor(N / 50));
  let nextReport = step;
  while (i + 3 <= N) {
    if (bytes[i] !== HEAD1 || bytes[i + 1] !== HEAD2) {
      if (!inJunk) stats.corruptSpans++;
      inJunk = true;
      stats.skipped++;
      i++;
      continue;
    }
    const type = bytes[i + 2];
    const f = formats.get(type);
    if (!f) {
      unknown.add(type);
      if (!inJunk) stats.corruptSpans++;
      inJunk = true;
      stats.skipped++;
      i++;
      continue;
    }
    if (!fits(bytes, i, f.length)) {
      stats.truncated = true;
      break;
    }
    inJunk = false;
    if (type === FMT_TYPE) {
      const b = i + 3;
      const ft = bytes[b];
      const fl = bytes[b + 1];
      const nf = makeFormat(ft, fl, latin1(bytes, b + 2, 4), latin1(bytes, b + 6, 16), latin1(bytes, b + 22, 64));
      if (nf && ft !== FMT_TYPE) formats.set(ft, nf);
    }
    counts.set(type, (counts.get(type) ?? 0) + 1);
    stats.messages++;
    i += f.length;
    if (i >= nextReport) {
      opt.progress?.((i / N) * 0.5);
      nextReport += step;
    }
  }
  // A type that never became known was corruption, not a real message type.
  for (const t of unknown) if (!formats.has(t)) stats.unknownTypes++;

  /*
    FMTU (units and multipliers per field) and the UNIT and MULT tables they
    refer to are read in the second pass like everything else, then applied.
  */
  const tables = new Map<number, Table>();
  const wide = new Map<number, boolean[]>();
  for (const [type, f] of formats) {
    const n = counts.get(type) ?? 0;
    if (!n) continue;
    const isWide = [...f.format].map((ch) => WIDE.has(ch));
    wide.set(type, isWide);
    const cols: Column[] = [...f.format].map((ch, k) => (TEXT.has(ch) ? new Array<string>(n) : isWide[k] ? new Float64Array(n) : new Float32Array(n)));
    tables.set(type, {
      name: f.name,
      fields: f.fields,
      units: f.fields.map(() => ""),
      scales: f.fields.map(() => ""),
      mults: f.fields.map(() => 1),
      instance: -1,
      count: 0,
      cols,
      t: new Float64Array(n).fill(NaN),
    });
  }

  // Pass 2: fill. The same walk, so the same messages are found.
  const filled = new Map<number, number>();
  i = 0;
  nextReport = step;
  let firstUs = Infinity;
  let lastUs = -Infinity;
  const timeIndex = new Map<number, number>();
  for (const [type, f] of formats) timeIndex.set(type, f.fields[0] === "TimeUS" ? 0 : -1);
  const scanFormats = new Map<number, Format>([[FMT_TYPE, FMT_FMT]]);

  while (i + 3 <= N) {
    if (bytes[i] !== HEAD1 || bytes[i + 1] !== HEAD2) {
      i++;
      continue;
    }
    const type = bytes[i + 2];
    // Use the formats as known at this point in the file, as pass 1 did.
    const f = scanFormats.get(type);
    if (!f) {
      i++;
      continue;
    }
    if (!fits(bytes, i, f.length)) break;
    const b = i + 3;
    if (type === FMT_TYPE) {
      const ft = bytes[b];
      const nf = makeFormat(ft, bytes[b + 1], latin1(bytes, b + 2, 4), latin1(bytes, b + 6, 16), latin1(bytes, b + 22, 64));
      if (nf && ft !== FMT_TYPE) scanFormats.set(ft, nf);
    }
    const table = tables.get(type);
    const final = formats.get(type)!;
    // Rows written under an earlier, different definition of the type cannot share its columns.
    if (table && f.format === final.format) {
      const row = filled.get(type) ?? 0;
      if (row < table.t.length) {
        for (let k = 0; k < f.format.length; k++) {
          const v = readField(dv, bytes, b + f.offsets[k], f.format[k]);
          const c = table.cols[k];
          if (Array.isArray(c)) c[row] = v as string;
          else c[row] = v as number;
        }
        const ti = timeIndex.get(type)!;
        if (ti >= 0) {
          const us = (table.cols[ti] as Float64Array)[row];
          table.t[row] = us;
          if (us > 0 && us < firstUs) firstUs = us;
          if (us > lastUs) lastUs = us;
        }
        filled.set(type, row + 1);
      }
    }
    i += f.length;
    if (i >= nextReport) {
      opt.progress?.(0.5 + (i / N) * 0.5);
      nextReport += step;
    }
  }

  // Units, multipliers and instance fields, from FMTU and the UNIT and MULT tables it refers to.
  const named = new Map<string, { table: Table; rows: number }>();
  for (const [type, table] of tables) {
    const rows = filled.get(type) ?? 0;
    if (rows) named.set(table.name, { table, rows });
  }
  const unitNames = new Map<string, string>();
  const multValues = new Map<string, number>();
  const uT = named.get("UNIT")?.table;
  const mT = named.get("MULT")?.table;
  const fT = named.get("FMTU")?.table;
  const rows = (t: Table | undefined) => (t ? (named.get(t.name)?.rows ?? 0) : 0);
  if (uT) {
    const id = uT.cols[uT.fields.indexOf("Id")] as Float32Array;
    const label = uT.cols[uT.fields.indexOf("Label")] as string[];
    for (let r = 0; r < rows(uT); r++) unitNames.set(String.fromCharCode(id[r] & 0xff), label[r]);
  }
  if (mT) {
    const id = mT.cols[mT.fields.indexOf("Id")] as Float32Array;
    const mult = mT.cols[mT.fields.indexOf("Mult")] as Float64Array;
    for (let r = 0; r < rows(mT); r++) multValues.set(String.fromCharCode(id[r] & 0xff), mult[r]);
  }
  const fmtu: { type: number; units: string; mults: string }[] = [];
  if (fT) {
    const ty = fT.cols[fT.fields.indexOf("FmtType")] as Float32Array;
    const un = fT.cols[fT.fields.indexOf("UnitIds")] as string[];
    const mu = fT.cols[fT.fields.indexOf("MultIds")] as string[];
    for (let r = 0; r < rows(fT); r++) fmtu.push({ type: ty[r], units: un[r] ?? "", mults: mu[r] ?? "" });
  }
  for (const u of fmtu) {
    const table = tables.get(u.type);
    const f = formats.get(u.type);
    if (!table || !f) continue;
    for (let k = 0; k < f.fields.length; k++) {
      const uc = u.units[k];
      const mc = u.mults[k];
      if (uc === "#") table.instance = k;
      const unit = uc && uc !== "-" && uc !== "?" ? (unitNames.get(uc) ?? "") : "";
      table.units[k] = unit === "UNKNOWN" ? "" : unit;
      const m = mc ? multValues.get(mc) : undefined;
      // A multiplier the format has not already applied: note it, do not apply it.
      const implied = IMPLIED[f.format[k]];
      if (m !== undefined && m !== 0 && m !== 1 && !(implied && Math.abs(implied - m) / m < 1e-6) && f.fields[k] !== "TimeUS") {
        table.scales[k] = `×${+m.toPrecision(3)}`;
        table.mults[k] = m;
      }
    }
  }

  // Trim to what was filled (a type redefined mid-log has fewer rows in its final shape).
  const out = new Map<string, Table>();
  const t0 = Number.isFinite(firstUs) ? firstUs : 0;
  for (const [type, table] of tables) {
    const n = filled.get(type) ?? 0;
    if (!n) continue;
    if (n < table.t.length) {
      table.cols = table.cols.map((c) => (Array.isArray(c) ? c.slice(0, n) : c.subarray(0, n)));
      table.t = table.t.subarray(0, n);
    }
    table.count = n;
    for (let r = 0; r < n; r++) table.t[r] = table.t[r] > 0 ? (table.t[r] - t0) / 1e6 : NaN;
    // Two types can share a name in a damaged log; keep the larger.
    const prev = out.get(table.name);
    if (!prev || prev.count < n) out.set(table.name, table);
  }
  opt.progress?.(1);

  return {
    kind: "bin",
    name,
    tables: out,
    stats,
    startUtc: gpsStartUtc(out),
    duration: Number.isFinite(firstUs) && lastUs > firstUs ? (lastUs - firstUs) / 1e6 : 0,
  };
}

/** GPS time is ahead of UTC by the leap seconds since 1980: 18 since 2017. */
export const GPS_LEAP_SECONDS = 18;
const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);

/** The wall-clock time at the start of the log, from the first GPS row with a fix and a week number. */
function gpsStartUtc(tables: Map<string, Table>): number | null {
  const g = tables.get("GPS");
  if (!g) return null;
  const wk = g.cols[g.fields.indexOf("GWk")];
  const ms = g.cols[g.fields.indexOf("GMS")];
  const st = g.cols[g.fields.indexOf("Status")];
  if (!wk || !ms || !st || Array.isArray(wk) || Array.isArray(ms) || Array.isArray(st)) return null;
  for (let r = 0; r < g.count; r++) {
    if (st[r] >= 3 && wk[r] > 0 && Number.isFinite(g.t[r])) {
      const utc = GPS_EPOCH_MS + wk[r] * 7 * 86400000 + ms[r] - GPS_LEAP_SECONDS * 1000;
      return utc - g.t[r] * 1000;
    }
  }
  return null;
}
