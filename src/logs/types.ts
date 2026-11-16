/*
  A flight log as AERONEX holds it once read: one table per message type,
  stored by column so a million rows of one field are one typed array, not a
  million objects. A DataFlash .bin and a MAVLink .tlog both end up in this
  shape, so everything after reading (the flight model, the checks, the
  charts) works on either.
*/

/** One column of a table: numbers in a typed array, or text. */
export type Column = Float64Array | Float32Array | string[];

export interface Table {
  /** The message name, as the log names it (ATT, VIBE; ATTITUDE, VIBRATION in a .tlog). */
  name: string;
  fields: string[];
  /** Unit per field, where the log says ("m", "deg", "A"), else "". */
  units: string[];
  /** A note per field when the stored number is not in the unit as shown (e.g. "×0.1"). */
  scales: string[];
  /** Multiply the stored number by this to get it in the unit shown; 1 when it is stored in that unit. */
  mults: number[];
  /** Index of the field that tells instances apart (IMU, BAT, GPS…), or -1. */
  instance: number;
  count: number;
  cols: Column[];
  /** Seconds since the start of the log, per row; NaN where a row has no time. */
  t: Float64Array;
}

export type LogKind = "bin" | "tlog";

export interface ReadStats {
  bytes: number;
  messages: number;
  /** Bytes that could not be read as a message and were stepped over. */
  skipped: number;
  /** Places where unreadable bytes were found. */
  corruptSpans: number;
  /** The file ended in the middle of a message. */
  truncated: boolean;
  /** Message types used but never described (DataFlash), or not in the MAVLink dialect (.tlog). */
  unknownTypes: number;
}

export interface RawLog {
  kind: LogKind;
  name: string;
  tables: Map<string, Table>;
  stats: ReadStats;
  /** Wall-clock time of the first row, ms since 1970, when the log says. */
  startUtc: number | null;
  /** Seconds from the first row to the last. */
  duration: number;
}

export const isNumeric = (c: Column): c is Float64Array | Float32Array => !Array.isArray(c);

/** A column by field name, or undefined. */
export function col(t: Table | undefined, field: string): Column | undefined {
  if (!t) return undefined;
  const i = t.fields.indexOf(field);
  return i < 0 ? undefined : t.cols[i];
}

/** A numeric column by field name, or undefined. */
export function num(t: Table | undefined, field: string): Float64Array | Float32Array | undefined {
  const c = col(t, field);
  return c && isNumeric(c) ? c : undefined;
}

/**
  A numeric column in the unit the log names for it (the stored number times
  the field's multiplier), as a new array; undefined when there is no such field.
*/
export function scaled(t: Table | undefined, field: string): Float64Array | undefined {
  if (!t) return undefined;
  const i = t.fields.indexOf(field);
  if (i < 0) return undefined;
  const c = t.cols[i];
  if (!isNumeric(c)) return undefined;
  const m = t.mults[i] ?? 1;
  const out = new Float64Array(c.length);
  for (let k = 0; k < c.length; k++) out[k] = c[k] * m;
  return out;
}

/** A text column by field name, or undefined. */
export function text(t: Table | undefined, field: string): string[] | undefined {
  const c = col(t, field);
  return c && !isNumeric(c) ? c : undefined;
}
