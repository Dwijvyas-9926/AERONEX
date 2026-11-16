/*
  Reads a log off the main thread: a 100 MB log takes a second or two to
  read and check, and the page stays responsive meanwhile.
*/
import { LogFormatError, loadLog } from "./load";

export type WorkerIn = { buffer: ArrayBuffer; name: string };
export type WorkerOut =
  | { type: "progress"; share: number }
  | { type: "done"; result: ReturnType<typeof loadLog> }
  | { type: "error"; message: string; format: boolean };

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  const { buffer, name } = e.data;
  let last = 0;
  try {
    const result = loadLog(buffer, name, (share) => {
      if (share - last >= 0.02 || share === 1) {
        last = share;
        (self as unknown as Worker).postMessage({ type: "progress", share } satisfies WorkerOut);
      }
    });
    (self as unknown as Worker).postMessage({ type: "done", result } satisfies WorkerOut);
  } catch (err) {
    (self as unknown as Worker).postMessage({ type: "error", message: err instanceof Error ? err.message : String(err), format: err instanceof LogFormatError } satisfies WorkerOut);
  }
};
