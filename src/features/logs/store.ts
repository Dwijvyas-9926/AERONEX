/*
  The Flight Logs page's state: the open log, the library, the shared time
  window and cursor (every chart and the replay follow the same time).
*/
import { create } from "zustand";
import { openLogBytes } from "../../logs/client";
import { addLog, deleteLog, libraryAvailable, listLogs, readLogBytes, settleInterrupted, updateLog, type LogRecord, type LogSource } from "../../logs/library";
import type { ChartPreset } from "../../logs/analyze";
import type { Loaded } from "../../logs/load";
import { recorder } from "../../logs/recorder";

export type LogTab = "report" | "charts" | "replay" | "events" | "params" | "messages";

interface OpenLog extends Loaded {
  /** Library id, when it is kept there. */
  id: string | null;
  name: string;
  size: number;
}

interface LogsState {
  library: LogRecord[];
  libraryError: string | null;
  open: OpenLog | null;
  loading: { name: string; share: number } | null;
  error: string | null;
  tab: LogTab;
  view: [number, number];
  cursor: number | null;
  /** The chart set on the Charts tab. */
  preset: ChartPreset;
  /** Fields added on the Charts tab, as "MSG.Field". */
  custom: string[];
  setPreset: (p: ChartPreset) => void;
  setCustom: (c: string[]) => void;
  refresh: () => Promise<void>;
  openFile: (file: File, keep: boolean) => Promise<void>;
  openBytes: (buffer: ArrayBuffer, name: string, source: LogSource, keep: boolean) => Promise<void>;
  openFromLibrary: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  close: () => void;
  setTab: (t: LogTab) => void;
  setView: (v: [number, number]) => void;
  setCursor: (t: number | null) => void;
  /** Show a moment: put the cursor there and the window around it. */
  focus: (t: number, span?: number, tab?: LogTab) => void;
}

const kindOf = (name: string): "bin" | "tlog" => (/\.tlog$/i.test(name) ? "tlog" : "bin");

export const useLogs = create<LogsState>((set, get) => ({
  library: [],
  libraryError: null,
  open: null,
  loading: null,
  error: null,
  tab: "report",
  view: [0, 1],
  cursor: null,
  preset: "attitude",
  custom: [],
  setPreset: (preset) => set({ preset }),
  setCustom: (custom) => set({ custom }),

  refresh: async () => {
    if (!libraryAvailable()) return;
    try {
      await settleInterrupted(await recorder.liveId());
      set({ library: await listLogs(), libraryError: null });
    } catch (e) {
      set({ libraryError: e instanceof Error ? e.message : String(e) });
    }
  },

  openFile: async (file, keep) => {
    set({ loading: { name: file.name, share: 0 }, error: null });
    let buffer: ArrayBuffer;
    try {
      buffer = await file.arrayBuffer();
    } catch {
      set({ loading: null, error: `Could not read ${file.name}.` });
      return;
    }
    await get().openBytes(buffer, file.name, "file", keep);
  },

  openBytes: async (buffer, name, source, keep) => {
    set({ loading: { name, share: 0 }, error: null });
    try {
      const loaded = await openLogBytes(buffer, name, (share) => set({ loading: { name, share } }));
      let id: string | null = null;
      if (keep && libraryAvailable()) {
        try {
          const rec = await addLog({ name, kind: loaded.flight.kind, source, summary: summaryLine(loaded) }, buffer);
          id = rec.id;
        } catch {
          /* kept only for this visit: the library is full or unavailable */
        }
      }
      show(set, { ...loaded, id, name, size: buffer.byteLength });
      void get().refresh();
    } catch (e) {
      set({ loading: null, error: e instanceof Error ? e.message : String(e) });
    }
  },

  openFromLibrary: async (id) => {
    const rec = get().library.find((r) => r.id === id);
    const name = rec?.name ?? "log";
    set({ loading: { name, share: 0 }, error: null });
    try {
      const buffer = await readLogBytes(id);
      if (!buffer.byteLength) throw new Error(rec?.state === "recording" ? "This recording has nothing saved yet; it is written every few seconds." : "This log is empty.");
      const loaded = await openLogBytes(buffer, name, (share) => set({ loading: { name, share } }));
      show(set, { ...loaded, id, name, size: buffer.byteLength });
      // Keep the list's line in step with what the checks now say.
      if (rec && rec.state !== "recording") await updateLog(id, { summary: summaryLine(loaded) }).catch(() => {});
      void get().refresh();
    } catch (e) {
      set({ loading: null, error: e instanceof Error ? e.message : String(e) });
    }
  },

  remove: async (id) => {
    await deleteLog(id);
    if (get().open?.id === id) set({ open: { ...get().open!, id: null } });
    await get().refresh();
  },

  close: () => set({ open: null, cursor: null, error: null }),
  setTab: (tab) => set({ tab }),
  setView: (view) => set({ view }),
  setCursor: (cursor) => set({ cursor }),
  focus: (t, span, tab) => {
    const o = get().open;
    if (!o) return;
    const full = o.flight.duration;
    const w = Math.min(full, span ?? Math.max(20, full / 8));
    let a = t - w / 2;
    a = Math.max(0, Math.min(full - w, a));
    set({ cursor: t, view: [a, a + w], ...(tab ? { tab } : {}) });
  },
}));

function show(set: (p: Partial<LogsState>) => void, open: OpenLog) {
  const full: [number, number] = [0, Math.max(1, open.flight.duration)];
  set({ open, loading: null, error: null, view: full, cursor: null, tab: "report", custom: [] });
}

export function summaryLine(l: Loaded): LogRecord["summary"] {
  const a = l.analysis;
  return {
    verdict: a.verdict,
    fails: a.findings.filter((x) => x.severity === "fail").length,
    warns: a.findings.filter((x) => x.severity === "warn").length,
    flightTime: a.summary.flightTime,
    startUtc: a.summary.startUtc,
    vehicle: a.summary.vehicle,
    firmware: a.summary.firmware,
  };
}

export { kindOf };
