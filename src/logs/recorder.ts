/*
  The flight recorder: a MAVLink telemetry log (.tlog) of every link session,
  in the same format Mission Planner, QGroundControl and MAVProxy write, so
  it opens in any of them as well as here.

  Every valid packet received is kept, and every packet AERONEX sends, each
  with the time it passed (microseconds since 1970, as .tlog has it). The log
  is written to the library every few seconds, so a browser that closes or a
  computer that dies mid-flight loses at most the last few seconds.

  A session that never heard an autopilot is not kept. Turn recording off in
  Settings.
*/
import { useSettings } from "../state/settingsStore";
import { appendChunk, beginLog, deleteLog, libraryAvailable, updateLog } from "./library";
import { tlogRecord } from "./tlog";

const FLUSH_MS = 5000;
/** A single recording stops growing past this; the rest of the session is not recorded. */
const MAX_BYTES = 512 * 1024 * 1024;

type Send = (bytes: Uint8Array) => Promise<void> | void;

class Recorder {
  private id: Promise<string | null> | null = null;
  private parts: Uint8Array[] = [];
  private pending = 0;
  private total = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private heardAutopilot = false;
  private full = false;
  private writing: Promise<void> = Promise.resolve();
  private label = "";
  /** For tests and the status line. */
  stats = { packets: 0, bytes: 0, active: false };

  get active() {
    return this.id !== null;
  }

  /** Start recording a session. Does nothing if recording is off or there is nowhere to keep it. */
  start(label: string) {
    // A recording still open (a session that was never closed) is finished and kept, not lost.
    void this.stop();
    if (!useSettings.getState().recordTlog || !libraryAvailable()) return;
    this.parts = [];
    this.pending = 0;
    this.total = 0;
    this.heardAutopilot = false;
    this.full = false;
    this.label = label;
    this.stats = { packets: 0, bytes: 0, active: true };
    const name = `${stamp(new Date())} ${label}.tlog`;
    this.id = beginLog({ name, kind: "tlog", source: "recorded" })
      .then((r) => r.id)
      .catch(() => null);
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
  }

  /** A packet received from the link. */
  incoming(raw: Uint8Array | undefined, msgid: number, isAutopilotHeartbeat = false) {
    if (!this.id || !raw) return;
    if (msgid === 0 && isAutopilotHeartbeat) this.heardAutopilot = true;
    this.add(raw);
  }

  /** Wrap the link's send so what AERONEX sends is recorded too. */
  wrapSend(send: Send): Send {
    return (bytes) => {
      this.add(bytes);
      return send(bytes);
    };
  }

  private add(packet: Uint8Array) {
    if (!this.id || this.full) return;
    const rec = tlogRecord(Date.now() * 1000, packet);
    if (this.total + rec.length > MAX_BYTES) {
      this.full = true;
      return;
    }
    this.parts.push(rec);
    this.pending += rec.length;
    this.total += rec.length;
    this.stats.packets++;
    this.stats.bytes = this.total;
  }

  private flush(): Promise<void> {
    if (!this.pending || !this.id) return this.writing;
    const parts = this.parts;
    const size = this.pending;
    this.parts = [];
    this.pending = 0;
    const id = this.id;
    const out = new Uint8Array(size);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    // One write at a time, in order.
    this.writing = this.writing.then(async () => {
      const rid = await id;
      if (!rid) return;
      try {
        await appendChunk(rid, out);
      } catch {
        /* the library is full or gone: the recording ends where it is */
      }
    });
    return this.writing;
  }

  /**
    Stop recording. `keep` false throws the recording away; otherwise it is
    kept only if an autopilot was heard.
  */
  stop(keep = true): Promise<void> {
    if (!this.id) return Promise.resolve();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const id = this.id;
    const heard = this.heardAutopilot;
    const full = this.full;
    void this.flush();
    this.id = null;
    this.stats.active = false;
    const finish = this.writing.then(async () => {
      const rid = await id;
      if (!rid) return;
      if (!keep || !heard) await deleteLog(rid).catch(() => {});
      else await updateLog(rid, { state: "complete", note: full ? "Recording stopped at 512 MB; the rest of the session is not in it." : undefined }).catch(() => {});
    });
    this.writing = finish;
    return finish;
  }

  /** The id of the recording in progress, or null. */
  async liveId(): Promise<string | null> {
    return this.id ? await this.id : null;
  }

  get name() {
    return this.label;
  }
}

/** 2026-11-16 14-05 */
function stamp(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`;
}

export const recorder = new Recorder();
