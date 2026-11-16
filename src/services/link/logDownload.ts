/*
  Downloading DataFlash logs from the aircraft over MAVLink, by the MAVLink
  log protocol (LOG_REQUEST_LIST, LOG_ENTRY, LOG_REQUEST_DATA, LOG_DATA,
  LOG_REQUEST_END, LOG_ERASE), as ArduPilot answers it.

  The aircraft sends a log in 90-byte pieces. Pieces lost on the link are
  asked for again, range by range, until every byte is in; the log is only
  handed over when it is complete, so it is never silently short.

  ArduPilot only serves logs while disarmed, and slows its other telemetry
  while it does. Over a USB cable expect around 50–100 KB/s; over a
  telemetry radio a few KB/s, so a large log can take many minutes.
*/
import type { Decoded } from "../../mavlink/parser";
import { useLink } from "../../state/linkStore";
import { commandLink } from "./commandLink";

export interface AircraftLog {
  id: number;
  size: number;
  /** UTC seconds since 1970 when the log started, or 0 when the aircraft did not know the time. */
  timeUtc: number;
}

export class LogDownloadError extends Error {}

const PIECE = 90;

function ready() {
  if (!commandLink.canSend) throw new LogDownloadError("Connect to the aircraft first.");
  const v = useLink.getState().vehicle;
  if (v?.armed) throw new LogDownloadError("Disarm the aircraft first: ArduPilot only sends logs while disarmed.");
}

/** Ask the aircraft which logs it has. */
export function listAircraftLogs(timeoutMs = 5000): Promise<AircraftLog[]> {
  ready();
  return new Promise((resolve, reject) => {
    const got = new Map<number, AircraftLog>();
    let expected = -1;
    let quiet: ReturnType<typeof setTimeout> | null = null;
    let asks = 0;
    const finish = (err?: Error) => {
      stopTap();
      clearTimeout(overall);
      if (quiet) clearTimeout(quiet);
      if (err) reject(err);
      else resolve([...got.values()].sort((a, b) => a.id - b.id));
    };
    const ask = () => {
      asks++;
      commandLink.post("LOG_REQUEST_LIST", { start: 0, end: 0xffff }).catch((e) => finish(e instanceof Error ? e : new Error(String(e))));
    };
    const stopTap = commandLink.tap((name: string, d: Decoded) => {
      if (name !== "LOG_ENTRY") return;
      expected = d.num_logs as number;
      if (expected === 0) return finish();
      const id = d.id as number;
      if (id > 0) got.set(id, { id, size: d.size as number, timeUtc: d.time_utc as number });
      if (quiet) clearTimeout(quiet);
      if (got.size >= expected) return finish();
      // Entries stopped coming before the list was complete: ask again, then settle for what came.
      quiet = setTimeout(() => (asks < 3 ? ask() : finish()), 1200);
    });
    const overall = setTimeout(() => {
      if (expected < 0) finish(new LogDownloadError("The aircraft did not answer the request for its log list. Check that it runs ArduPilot and that the link is up."));
      else finish();
    }, timeoutMs);
    ask();
  });
}

export interface DownloadProgress {
  received: number;
  size: number;
  /** Bytes per second over the last few seconds. */
  rate: number;
}

/**
  Download one log. Resolves with its bytes once every byte has arrived;
  rejects if the aircraft stops answering, the link closes, or `signal` aborts.
*/
export function downloadAircraftLog(entry: AircraftLog, onProgress?: (p: DownloadProgress) => void, signal?: AbortSignal): Promise<ArrayBuffer> {
  ready();
  const size = entry.size;
  const buf = new Uint8Array(size);
  const pieces = Math.ceil(size / PIECE);
  const have = new Uint8Array(pieces);
  let received = 0;
  const samples: { t: number; n: number }[] = [];
  return new Promise((resolve, reject) => {
    if (size === 0) return resolve(new ArrayBuffer(0));
    let lastData = Date.now();
    let lastReport = 0;
    let rounds = 0;
    let settled = false;
    const end = () => void commandLink.post("LOG_REQUEST_END", {}).catch(() => {});
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      stopTap();
      clearInterval(watch);
      signal?.removeEventListener("abort", onAbort);
      end();
      if (err) reject(err);
      else resolve(buf.buffer);
    };
    const onAbort = () => finish(new LogDownloadError("Download cancelled."));
    signal?.addEventListener("abort", onAbort);
    const request = (ofs: number, count: number) => commandLink.post("LOG_REQUEST_DATA", { id: entry.id, ofs, count }).catch((e) => finish(e instanceof Error ? e : new Error(String(e))));
    const stopTap = commandLink.tap((name: string, d: Decoded) => {
      if (name !== "LOG_DATA" || d.id !== entry.id) return;
      const ofs = d.ofs as number;
      const count = d.count as number;
      if (ofs % PIECE !== 0 || ofs >= size || count === 0) return;
      const k = ofs / PIECE;
      if (have[k]) return;
      const n = Math.min(count, size - ofs);
      const data = d.data as number[];
      for (let j = 0; j < n; j++) buf[ofs + j] = data[j];
      have[k] = 1;
      received += n;
      lastData = Date.now();
      rounds = 0;
      if (!samples.length || lastData - samples[samples.length - 1].t >= 50) samples.push({ t: lastData, n: received });
      while (samples.length > 2 && lastData - samples[0].t > 3000) samples.shift();
      // Progress ten times a second at most: a fast link delivers thousands of pieces a second.
      if (received >= size || lastData - lastReport >= 100) {
        lastReport = lastData;
        const span = (samples[samples.length - 1].t - samples[0].t) / 1000;
        onProgress?.({ received, size, rate: span > 0 ? (samples[samples.length - 1].n - samples[0].n) / span : 0 });
      }
      if (received >= size) finish();
    });
    // Ask for the missing ranges when the stream goes quiet.
    const watch = setInterval(() => {
      if (!commandLink.canSend) return finish(new LogDownloadError("The link closed during the download."));
      if (Date.now() - lastData < 1500) return;
      rounds++;
      if (rounds > 8) return finish(new LogDownloadError(`The aircraft stopped sending after ${received.toLocaleString()} of ${size.toLocaleString()} bytes.`));
      let asked = 0;
      for (let k = 0; k < pieces && asked < 20; k++) {
        if (have[k]) continue;
        let e = k;
        while (e + 1 < pieces && !have[e + 1]) e++;
        const ofs = k * PIECE;
        request(ofs, Math.min(size, (e + 1) * PIECE) - ofs);
        asked++;
        k = e;
      }
      lastData = Date.now();
    }, 500);
    request(0, size);
  });
}

/** Erase every log on the aircraft's card. */
export async function eraseAircraftLogs(): Promise<void> {
  ready();
  await commandLink.post("LOG_ERASE", {});
}
