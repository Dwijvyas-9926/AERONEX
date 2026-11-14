import { checkValue, defFor, type MetaSet } from "./paramMeta";

/*
  Parameter files: reading the two common formats and comparing a file with
  the aircraft before anything is staged.

  Mission Planner writes "NAME,VALUE" (some tools use a space or a tab).
  QGroundControl writes "SYSID COMPID NAME VALUE TYPE", tab-separated.
  Lines starting with # are comments in both.
*/

export interface ParsedParamFile {
  values: Record<string, number>;
  /** Lines that could not be read, with their line numbers. */
  bad: { line: number; text: string }[];
  format: "mission-planner" | "qgroundcontrol" | "empty";
}

const NAME = /^[A-Z][A-Z0-9_]{0,15}$/;

export function parseParamFile(text: string): ParsedParamFile {
  const values: Record<string, number> = {};
  const bad: ParsedParamFile["bad"] = [];
  let qgc = 0;
  let mp = 0;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const t = line.split(/[\s,]+/).filter(Boolean);
    let name: string | undefined;
    let value: number | undefined;
    if (t.length >= 4 && /^\d+$/.test(t[0]) && /^\d+$/.test(t[1]) && NAME.test(t[2])) {
      name = t[2];
      value = Number(t[3]);
      qgc++;
    } else if (t.length >= 2 && NAME.test(t[0])) {
      name = t[0];
      value = Number(t[1]);
      mp++;
    }
    if (name === undefined || value === undefined || !Number.isFinite(value)) {
      bad.push({ line: i + 1, text: line.length > 60 ? `${line.slice(0, 60)}…` : line });
      return;
    }
    values[name] = value;
  });
  const format = qgc + mp === 0 ? "empty" : qgc > mp ? "qgroundcontrol" : "mission-planner";
  return { values, bad, format };
}

/**
 * Settings that belong to one particular aircraft and should not be copied
 * from another one's file without thought: sensor calibrations, device IDs,
 * counters and the MAVLink system ID.
 */
const BOARD_SPECIFIC = [
  /^INS_(ACC|GYR)\d?(OFFS|SCAL)_?/,
  /^INS_ACC\d?_ID$|^INS_GYR\d?_ID$/,
  /^INS_TCAL/,
  /^COMPASS_(OFS|DIA|ODI|MOT|SCALE|DEV_ID|PRIO)/,
  /_DEV_ID$|_DEVID$/,
  /^BARO\d?_GND_PRESS$/,
  /^RC\d+_(MIN|MAX|TRIM)$/,
  /^STAT_/,
  /^FORMAT_VERSION$/,
  /^SYSID_THISMAV$|^MAV_SYSID$/,
  /^AHRS_TRIM_/,
];

export type DiffReason = "calibration" | "read-only" | "changes by itself" | "outside range" | "invalid";

export interface DiffRow {
  name: string;
  vehicle: number;
  file: number;
  /** Why this row starts unticked, if it does. */
  caution?: DiffReason;
}

export interface ParamDiff {
  changed: DiffRow[];
  /** In the file but not on this aircraft (a different firmware or feature set). */
  missing: string[];
  same: number;
}

const close = (a: number, b: number) => Math.abs(Math.fround(a) - Math.fround(b)) <= Math.max(1e-6, 1e-6 * Math.abs(a));

/** Compare a file with the aircraft's current values. */
export function compareParams(file: Record<string, number>, vehicle: Record<string, number>, meta: MetaSet | null, types: Record<string, number> = {}): ParamDiff {
  const changed: DiffRow[] = [];
  const missing: string[] = [];
  let same = 0;
  for (const [name, v] of Object.entries(file)) {
    const cur = vehicle[name];
    if (cur === undefined) {
      missing.push(name);
      continue;
    }
    if (close(cur, v)) {
      same++;
      continue;
    }
    const def = defFor(meta, name, vehicle);
    let caution: DiffReason | undefined;
    const checks = checkValue(def, v, types[name]);
    if (def?.ro) caution = "read-only";
    else if (checks.some((c) => c.level === "error")) caution = "invalid";
    else if (def?.cal || BOARD_SPECIFIC.some((re) => re.test(name))) caution = "calibration";
    else if (def?.vol) caution = "changes by itself";
    else if (checks.some((c) => c.level === "outside")) caution = "outside range";
    changed.push({ name, vehicle: cur, file: v, caution });
  }
  changed.sort((a, b) => a.name.localeCompare(b.name));
  missing.sort();
  return { changed, missing, same };
}
