/*
  A Web Serial port as a ByteLink for the bootloader: a reader loop fills a
  queue, reads wait for the bytes they need or time out.
*/
import { TimeoutError, type ByteLink } from "./bootloader";

export class SerialByteLink implements ByteLink {
  private queue: Uint8Array[] = [];
  private queued = 0;
  private waiter: (() => void) | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private loop: Promise<void> | null = null;
  closed = false;
  /** Set when the port stopped reading (unplugged, or the board rebooted). */
  lostReason: string | null = null;

  port: SerialPort;

  constructor(port: SerialPort) {
    this.port = port;
  }

  async open(baudRate = 115200) {
    await this.port.open({ baudRate, bufferSize: 4096 });
    this.writer = this.port.writable!.getWriter();
    this.loop = this.readLoop();
  }

  private async readLoop() {
    while (!this.closed && this.port.readable) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value?.length) {
            this.queue.push(value);
            this.queued += value.length;
            this.waiter?.();
          }
        }
      } catch (e) {
        this.lostReason = e instanceof Error ? e.message : String(e);
        break;
      } finally {
        try {
          this.reader.releaseLock();
        } catch {
          /* already released */
        }
      }
    }
    this.waiter?.();
  }

  async write(bytes: Uint8Array) {
    if (!this.writer) throw new Error("The port is not open.");
    await this.writer.write(bytes);
  }

  async read(n: number, timeoutMs: number): Promise<Uint8Array> {
    const end = Date.now() + timeoutMs;
    while (this.queued < n) {
      if (this.closed || this.lostReason) throw new Error(this.lostReason ? `The board disconnected (${this.lostReason}).` : "The port was closed.");
      const left = end - Date.now();
      if (left <= 0) throw new TimeoutError(`No reply from the board within ${timeoutMs} ms.`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          this.waiter = null;
          resolve();
        }, left);
        this.waiter = () => {
          clearTimeout(t);
          this.waiter = null;
          resolve();
        };
      });
    }
    const out = new Uint8Array(n);
    let o = 0;
    while (o < n) {
      const head = this.queue[0];
      const take = Math.min(head.length, n - o);
      out.set(head.subarray(0, take), o);
      o += take;
      if (take === head.length) this.queue.shift();
      else this.queue[0] = head.subarray(take);
    }
    this.queued -= n;
    return out;
  }

  discardInput() {
    this.queue = [];
    this.queued = 0;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.reader?.cancel();
    } catch {
      /* gone */
    }
    // Wait for the read loop to let go of the stream (bounded), and abort rather than release the
    // writer: a write still in flight keeps the stream locked, and a locked port cannot be closed,
    // which would leave it "already open" for the next attempt.
    await Promise.race([this.loop?.catch(() => undefined), new Promise((r) => setTimeout(r, 1500))]);
    try {
      await this.writer?.abort();
    } catch {
      /* already errored or closed */
    }
    try {
      this.writer?.releaseLock();
    } catch {
      /* released by the abort */
    }
    try {
      await this.port.close();
    } catch {
      /* the device may already be gone (it rebooted) */
    }
  }
}
