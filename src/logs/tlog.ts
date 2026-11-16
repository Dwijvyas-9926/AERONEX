/*
  MAVLink telemetry logs (.tlog): what a ground station received over the
  link (and sent), as Mission Planner, QGroundControl, MAVProxy and AERONEX
  record it. Each record is an 8-byte big-endian timestamp in microseconds
  since 1970, then one whole MAVLink packet (v1 or v2) as it came over the
  link, checksum included (pymavlink writes them with struct '>Q').

  Every packet is checked against its checksum with the same parser the live
  link uses, so a .tlog reads exactly as the telemetry did. Records that do
  not hold a valid packet are stepped over and counted.
*/
import { MESSAGES } from "../mavlink/dialect.generated";
import { decode, MavlinkParser, type MavFrame } from "../mavlink/parser";
import type { Column, RawLog, ReadStats, Table } from "./types";

const DEFS = new Map(MESSAGES.map((d) => [d[0], d]));
const STX_V1 = 0xfe;
const STX_V2 = 0xfd;

/** A plausible tlog timestamp: between 2000 and 2100. */
const plausible = (us: number) => us > 946684800e6 && us < 4102444800e6;

/** The bytes of one record: timestamp then the packet. */
export function tlogRecord(timeUs: number, packet: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + packet.length);
  new DataView(out.buffer).setBigUint64(0, BigInt(Math.round(timeUs)), false);
  out.set(packet, 8);
  return out;
}

/** True when these bytes look like a .tlog: a plausible timestamp followed by a MAVLink start byte. */
export function looksLikeTlog(bytes: Uint8Array): boolean {
  if (bytes.length < 10) return false;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return plausible(Number(dv.getBigUint64(0, false))) && (bytes[8] === STX_V1 || bytes[8] === STX_V2);
}

function packetLength(bytes: Uint8Array, i: number): number {
  const stx = bytes[i];
  if (stx === STX_V1) return 6 + bytes[i + 1] + 2;
  if (stx === STX_V2) return 10 + bytes[i + 1] + 2 + (bytes[i + 2] & 1 ? 13 : 0);
  return 0;
}

/** Columns for one message: scalar fields as they are, arrays as name[0], name[1]… */
function layout(msgid: number): { fields: string[]; text: boolean[]; wide: boolean[] } {
  const def = DEFS.get(msgid)!;
  const fields: string[] = [];
  const text: boolean[] = [];
  const wide: boolean[] = [];
  for (const [name, type, arr] of def[4]) {
    if (type === "char") {
      fields.push(name);
      text.push(true);
      wide.push(false);
    } else if (arr > 0) {
      for (let k = 0; k < arr; k++) {
        fields.push(`${name}[${k}]`);
        text.push(false);
        wide.push(/32|64|double/.test(type));
      }
    } else {
      fields.push(name);
      text.push(false);
      wide.push(/32|64|double/.test(type));
    }
  }
  // Who sent it: a .tlog holds the ground station's own messages and other systems' too.
  fields.push("sysid", "compid");
  text.push(false, false);
  wide.push(false, false);
  return { fields, text, wide };
}

export interface TlogOptions {
  progress?: (share: number) => void;
}

export function parseTlog(buffer: ArrayBuffer, name: string, opt: TlogOptions = {}): RawLog {
  const bytes = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  const stats: ReadStats = { bytes: bytes.length, messages: 0, skipped: 0, corruptSpans: 0, truncated: false, unknownTypes: 0 };
  const parser = new MavlinkParser();

  // Pass 1: find the valid records. Only where they are is kept, not the frames: a long .tlog holds millions.
  const offs: number[] = [];
  const times: number[] = [];
  const ids: number[] = [];
  let i = 0;
  let junk = false;
  const N = bytes.length;
  const step = Math.max(1, Math.floor(N / 40));
  let next = step;
  const unknown = new Set<number>();
  while (i + 8 < N) {
    const us = Number(dv.getBigUint64(i, false));
    const len = plausible(us) ? packetLength(bytes, i + 8) : 0;
    if (!len) {
      if (!junk) stats.corruptSpans++;
      junk = true;
      stats.skipped++;
      i++;
      continue;
    }
    if (i + 8 + len > N) {
      stats.truncated = true;
      break;
    }
    parser.reset();
    const frames = parser.push(bytes.subarray(i + 8, i + 8 + len));
    if (frames.length !== 1) {
      // A record whose packet fails its checksum or is not in the dialect.
      if (bytes[i + 8] === STX_V2 && !DEFS.has(bytes[i + 15] | (bytes[i + 16] << 8) | (bytes[i + 17] << 16))) unknown.add(bytes[i + 15]);
      if (!junk) stats.corruptSpans++;
      junk = true;
      stats.skipped++;
      i++;
      continue;
    }
    junk = false;
    offs.push(i);
    times.push(us);
    ids.push(frames[0].msgid);
    i += 8 + len;
    if (i >= next) {
      opt.progress?.((i / N) * 0.6);
      next += step;
    }
  }
  stats.unknownTypes = unknown.size;
  stats.messages = offs.length;

  // Pass 2: columns of exactly the right size per message type.
  const counts = new Map<number, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  let t0 = Infinity;
  for (const t of times) if (t < t0) t0 = t;
  if (!Number.isFinite(t0)) t0 = 0;
  const tables = new Map<number, { table: Table; text: boolean[]; row: number }>();
  for (const [id, n] of counts) {
    const { fields, text, wide } = layout(id);
    const cols: Column[] = fields.map((_, k) => (text[k] ? new Array<string>(n) : wide[k] ? new Float64Array(n) : new Float32Array(n)));
    tables.set(id, {
      table: { name: DEFS.get(id)![1], fields, units: fields.map(() => ""), scales: fields.map(() => ""), mults: fields.map(() => 1), instance: -1, count: n, cols, t: new Float64Array(n) },
      text,
      row: 0,
    });
  }
  let last = t0;
  for (let k = 0; k < offs.length; k++) {
    const o = offs[k];
    parser.reset();
    const frame: MavFrame = parser.push(bytes.subarray(o + 8, o + 8 + packetLength(bytes, o + 8)))[0];
    const r = { t: times[k], frame };
    const entry = tables.get(frame.msgid)!;
    const d = decode(frame)!;
    const { table, row } = entry;
    let c = 0;
    for (const [fname, type, arr] of DEFS.get(r.frame.msgid)![4]) {
      const v = d[fname];
      if (type === "char") (table.cols[c++] as string[])[row] = v as string;
      else if (arr > 0) for (let j = 0; j < arr; j++) (table.cols[c++] as Float64Array)[row] = (v as number[])[j];
      else (table.cols[c++] as Float64Array)[row] = v as number;
    }
    (table.cols[c++] as Float32Array)[row] = r.frame.sysid;
    (table.cols[c++] as Float32Array)[row] = r.frame.compid;
    table.t[row] = (r.t - t0) / 1e6;
    if (r.t > last) last = r.t;
    entry.row++;
    if (k % 20000 === 0) opt.progress?.(0.6 + (k / offs.length) * 0.4);
  }
  opt.progress?.(1);

  // Where a message came from more than one system (the aircraft and the ground station), tell them apart by sysid.
  for (const { table } of tables.values()) {
    const sys = table.cols[table.fields.indexOf("sysid")] as Float32Array;
    for (let r = 1; r < table.count; r++) {
      if (sys[r] !== sys[0]) {
        table.instance = table.fields.indexOf("sysid");
        break;
      }
    }
  }

  return {
    kind: "tlog",
    name,
    tables: new Map([...tables.values()].map((e) => [e.table.name, e.table])),
    stats,
    startUtc: offs.length ? t0 / 1000 : null,
    duration: (last - t0) / 1e6,
  };
}
