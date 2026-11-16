import { TimeoutError, type ByteLink } from "../bootloader";
import type { SimBootloader } from "./blsim";

/** The uploader's side of a wire to a simulated bootloader. */
export class SimLink implements ByteLink {
  sent = 0;
  private wake: (() => void) | null = null;
  sim: SimBootloader;
  constructor(sim: SimBootloader) {
    this.sim = sim;
    sim.onOutput = () => this.wake?.();
  }
  async write(bytes: Uint8Array) {
    this.sent += bytes.length;
    await Promise.resolve();
    this.sim.input(bytes);
  }
  async read(n: number, timeoutMs: number) {
    const end = Date.now() + timeoutMs;
    while (this.sim.out.length < n) {
      const left = end - Date.now();
      if (left <= 0) throw new TimeoutError(`timeout waiting for ${n} bytes`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, Math.min(left, 20));
        this.wake = () => {
          clearTimeout(t);
          r();
        };
      });
    }
    return Uint8Array.from(this.sim.out.splice(0, n));
  }
  discardInput() {
    this.sim.out.length = 0;
  }
}
