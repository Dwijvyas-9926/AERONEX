/*
  From a file's bytes to a checked flight: work out what kind of log it is,
  read it, build the flight model and run the checks. Runs in a worker for
  files dropped on the page, and directly in tests.
*/
import { analyze, type Analysis } from "./analyze";
import { looksLikeDataflash, parseDataflash } from "./dataflash";
import { buildFlight, type Flight } from "./model";
import { looksLikeTlog, parseTlog } from "./tlog";

export class LogFormatError extends Error {}

export interface Loaded {
  flight: Flight;
  analysis: Analysis;
  /** Milliseconds spent reading and checking. */
  ms: number;
}

export function detectKind(bytes: Uint8Array): "bin" | "tlog" | null {
  if (looksLikeDataflash(bytes)) return "bin";
  if (looksLikeTlog(bytes)) return "tlog";
  return null;
}

export function loadLog(buffer: ArrayBuffer, name: string, progress?: (share: number) => void): Loaded {
  const t0 = performance.now();
  const bytes = new Uint8Array(buffer);
  if (!bytes.length) throw new LogFormatError("The file is empty.");
  const kind = detectKind(bytes);
  if (!kind) {
    throw new LogFormatError(
      /\.(bin|log)$/i.test(name)
        ? "This is not an ArduPilot DataFlash log: it does not start with a log header. Logs downloaded with Mission Planner or QGroundControl, or copied from the SD card's APM/LOGS folder, open here."
        : /\.tlog$/i.test(name)
          ? "This is not a MAVLink telemetry log: no MAVLink packet was found at the start."
          : "AERONEX reads ArduPilot DataFlash logs (.bin) and MAVLink telemetry logs (.tlog). This file is neither.",
    );
  }
  const raw = kind === "bin" ? parseDataflash(buffer, name, { progress }) : parseTlog(buffer, name, { progress });
  if (!raw.stats.messages) throw new LogFormatError("No messages could be read from this file. It may be damaged or empty.");
  if (kind === "bin" && !raw.tables.size) throw new LogFormatError("The log holds format descriptions but no data.");
  const flight = buildFlight(raw);
  const analysis = analyze(flight);
  return { flight, analysis, ms: performance.now() - t0 };
}
