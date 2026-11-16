/*
  Opening a log from the page: in a worker where the browser has them, on
  this thread where it does not.
*/
import { LogFormatError, loadLog, type Loaded } from "./load";
import type { WorkerOut } from "./worker";

export function openLogBytes(buffer: ArrayBuffer, name: string, onProgress?: (share: number) => void): Promise<Loaded> {
  if (typeof Worker === "undefined") {
    return new Promise((resolve, reject) => {
      try {
        resolve(loadLog(buffer, name, onProgress));
      } catch (e) {
        reject(e);
      }
    });
  }
  return new Promise((resolve, reject) => {
    let w: Worker;
    try {
      w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    } catch {
      try {
        resolve(loadLog(buffer, name, onProgress));
      } catch (e) {
        reject(e);
      }
      return;
    }
    w.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      if (m.type === "progress") onProgress?.(m.share);
      else {
        w.terminate();
        if (m.type === "done") resolve(m.result);
        else reject(m.format ? new LogFormatError(m.message) : new Error(m.message));
      }
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(e.message || "The log reader stopped unexpectedly."));
    };
    // The buffer is copied, not transferred: the caller may still want to save it.
    w.postMessage({ buffer, name });
  });
}
