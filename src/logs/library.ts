/*
  The log library: flight logs kept in this browser (IndexedDB), so a
  recording, a log downloaded from the aircraft or a file opened once can be
  opened again later without the original file.

  A log is stored as numbered chunks, so a recording can be written as it
  goes: if the browser or the computer stops mid-flight, what was written up
  to the last chunk is still there and opens normally, marked interrupted.

  Space is bounded. Past the cap the oldest logs are removed, recordings
  before files the user chose, and never one that is still being recorded.
  "Reset app data" in Settings deletes the whole library.
*/

import { LOG_DB } from "../state/resetApp";
export { LOG_DB };
const META = "logs";
const CHUNKS = "chunks";

/** Most the library keeps, in bytes. */
export const LIBRARY_CAP = 2 * 1024 ** 3;

export type LogSource = "file" | "recorded" | "aircraft";

export interface LogSummaryLine {
  verdict: "fail" | "warn" | "pass";
  fails: number;
  warns: number;
  flightTime: number;
  startUtc: number | null;
  vehicle: string;
  firmware: string | null;
}

export interface LogRecord {
  id: string;
  name: string;
  kind: "bin" | "tlog";
  source: LogSource;
  size: number;
  chunks: number;
  addedAt: number;
  updatedAt: number;
  state: "complete" | "recording" | "interrupted";
  /** What the last analysis found, for the list. */
  summary?: LogSummaryLine;
  note?: string;
}

export const libraryAvailable = () => typeof indexedDB !== "undefined";

let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(LOG_DB, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(META)) d.createObjectStore(META, { keyPath: "id" });
      if (!d.objectStoreNames.contains(CHUNKS)) d.createObjectStore(CHUNKS);
    };
    req.onsuccess = () => {
      const d = req.result;
      // Reset app data deletes the database: let it, and open afresh next time.
      d.onversionchange = () => {
        d.close();
        dbp = null;
      };
      resolve(d);
    };
    req.onerror = () => {
      dbp = null;
      reject(req.error ?? new Error("Could not open the log library."));
    };
    req.onblocked = () => reject(new Error("The log library is open in another tab that is blocking it."));
  });
  return dbp;
}

function done(t: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error ?? new Error("Log library write failed."));
    t.onabort = () => reject(t.error ?? new Error("Log library write was aborted (the browser may be out of space)."));
  });
}

function req<T>(r: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result as T);
    r.onerror = () => reject(r.error);
  });
}

const chunkKey = (id: string, n: number) => `${id}#${String(n).padStart(6, "0")}`;

export async function listLogs(): Promise<LogRecord[]> {
  const d = await db();
  const t = d.transaction(META, "readonly");
  const all = await req<LogRecord[]>(t.objectStore(META).getAll());
  return all.sort((a, b) => b.addedAt - a.addedAt);
}

export async function getLog(id: string): Promise<LogRecord | undefined> {
  const d = await db();
  return req<LogRecord | undefined>(d.transaction(META, "readonly").objectStore(META).get(id));
}

const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Store a whole log at once (a file opened, or a log downloaded). */
export async function addLog(meta: Pick<LogRecord, "name" | "kind" | "source"> & Partial<LogRecord>, data: ArrayBuffer): Promise<LogRecord> {
  await makeRoom(data.byteLength);
  const now = Date.now();
  const rec: LogRecord = { id: newId(meta.source), size: data.byteLength, chunks: 1, addedAt: now, updatedAt: now, state: "complete", ...meta };
  const d = await db();
  const t = d.transaction([META, CHUNKS], "readwrite");
  t.objectStore(CHUNKS).put(new Blob([data]), chunkKey(rec.id, 0));
  t.objectStore(META).put(rec);
  await done(t);
  return rec;
}

/** Start a log written in chunks (a recording). */
export async function beginLog(meta: Pick<LogRecord, "name" | "kind" | "source">): Promise<LogRecord> {
  const now = Date.now();
  const rec: LogRecord = { id: newId(meta.source), size: 0, chunks: 0, addedAt: now, updatedAt: now, state: "recording", ...meta };
  const d = await db();
  const t = d.transaction(META, "readwrite");
  t.objectStore(META).put(rec);
  await done(t);
  return rec;
}

/** Add the next chunk of a log being written. */
export async function appendChunk(id: string, data: Uint8Array): Promise<void> {
  const d = await db();
  const t = d.transaction([META, CHUNKS], "readwrite");
  const metaStore = t.objectStore(META);
  const rec = await req<LogRecord | undefined>(metaStore.get(id));
  if (!rec) {
    t.abort();
    throw new Error("The recording was deleted.");
  }
  t.objectStore(CHUNKS).put(new Blob([data as Uint8Array<ArrayBuffer>]), chunkKey(id, rec.chunks));
  metaStore.put({ ...rec, chunks: rec.chunks + 1, size: rec.size + data.byteLength, updatedAt: Date.now() });
  await done(t);
}

export async function updateLog(id: string, patch: Partial<Omit<LogRecord, "id">>): Promise<void> {
  const d = await db();
  const t = d.transaction(META, "readwrite");
  const s = t.objectStore(META);
  const rec = await req<LogRecord | undefined>(s.get(id));
  if (rec) s.put({ ...rec, ...patch, id });
  await done(t);
}

/** The whole log as one buffer. */
export async function readLogBytes(id: string): Promise<ArrayBuffer> {
  const d = await db();
  const t = d.transaction([META, CHUNKS], "readonly");
  const rec = await req<LogRecord | undefined>(t.objectStore(META).get(id));
  if (!rec) throw new Error("That log is no longer in the library.");
  const parts = await req<Blob[]>(t.objectStore(CHUNKS).getAll(IDBKeyRange.bound(chunkKey(id, 0), chunkKey(id, 999999))));
  return new Blob(parts).arrayBuffer();
}

export async function deleteLog(id: string): Promise<void> {
  const d = await db();
  const t = d.transaction([META, CHUNKS], "readwrite");
  t.objectStore(META).delete(id);
  t.objectStore(CHUNKS).delete(IDBKeyRange.bound(chunkKey(id, 0), chunkKey(id, 999999)));
  await done(t);
}

/** Recordings left "recording" by a page that went away mid-flight are interrupted, not live. */
export async function settleInterrupted(liveId: string | null): Promise<void> {
  const all = await listLogs();
  for (const r of all) {
    if (r.state === "recording" && r.id !== liveId && Date.now() - r.updatedAt > 60_000) await updateLog(r.id, { state: "interrupted" });
  }
}

/** Remove the oldest logs until `incoming` more bytes fit under the cap. */
async function makeRoom(incoming: number): Promise<string[]> {
  const all = await listLogs();
  let used = all.reduce((s, r) => s + r.size, 0);
  const removed: string[] = [];
  if (used + incoming <= LIBRARY_CAP) return removed;
  const order = [...all].filter((r) => r.state !== "recording").sort((a, b) => (a.source === "recorded" ? 0 : 1) - (b.source === "recorded" ? 0 : 1) || a.addedAt - b.addedAt);
  for (const r of order) {
    if (used + incoming <= LIBRARY_CAP) break;
    await deleteLog(r.id);
    used -= r.size;
    removed.push(r.name);
  }
  return removed;
}

export async function libraryUse(): Promise<{ bytes: number; count: number }> {
  const all = await listLogs();
  return { bytes: all.reduce((s, r) => s + r.size, 0), count: all.length };
}
