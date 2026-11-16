/*
  Talking to the ArduPilot (and PX4) bootloader: the serial protocol a
  Pixhawk-family board answers for a few seconds after power-on, or for as
  long as it is told to stay after a "reboot to bootloader" command.

  Every exchange follows ArduPilot's own uploader (Tools/scripts/uploader.py)
  and the bootloader that answers it (Tools/AP_Bootloader/bl_protocol.cpp):
  a command byte, its arguments, EOC (0x20); the reply is any data, then
  INSYNC (0x12) and a status (OK 0x10, FAILED 0x11, INVALID 0x13, or 0x14 for
  a chip revision that cannot be programmed). Programming goes: identify,
  erase, write in 252-byte pieces, check the CRC the board computes over its
  whole flash against the CRC of the image, and reboot into the new firmware.
*/
import { crc32, flashCrc } from "./crc32";

export const P = {
  INSYNC: 0x12,
  EOC: 0x20,
  OK: 0x10,
  FAILED: 0x11,
  INVALID: 0x13,
  BAD_SILICON_REV: 0x14,
  GET_SYNC: 0x21,
  GET_DEVICE: 0x22,
  CHIP_ERASE: 0x23,
  CHIP_VERIFY: 0x24,
  PROG_MULTI: 0x27,
  READ_MULTI: 0x28,
  GET_CRC: 0x29,
  GET_OTP: 0x2a,
  GET_SN: 0x2b,
  GET_CHIP: 0x2c,
  SET_BOOT_DELAY: 0x2d,
  GET_CHIP_DES: 0x2e,
  REBOOT: 0x30,
  EXTF_ERASE: 0x34,
  EXTF_PROG_MULTI: 0x35,
  EXTF_GET_CRC: 0x37,
  INFO_BL_REV: 0x01,
  INFO_BOARD_ID: 0x02,
  INFO_BOARD_REV: 0x03,
  INFO_FLASH_SIZE: 0x04,
  INFO_EXTF_SIZE: 0x06,
} as const;

const BL_REV_MIN = 2;
const BL_REV_MAX = 5;
/** Bytes per write: the protocol allows 255, it must be a multiple of 4. */
export const PROG_MULTI_MAX = 252;

/** A byte stream to the board: a Web Serial port, or a test's simulated bootloader. */
export interface ByteLink {
  write(bytes: Uint8Array): Promise<void>;
  /** Exactly n bytes, or throws a timeout. */
  read(n: number, timeoutMs: number): Promise<Uint8Array>;
  /** Throw away anything received and not yet read. */
  discardInput(): void;
}

export class TimeoutError extends Error {}
export class BootloaderError extends Error {}

export interface BoardInfo {
  blRev: number;
  boardId: number;
  boardRev: number;
  /** Bytes of flash available for firmware, as the bootloader reports it. */
  flashSize: number;
  extfSize: number;
  /** The MCU's IDCODE (revision in the top 16 bits, device in the low 12), protocol 5 and later. */
  chip: number | null;
  /** The bootloader's own description of the MCU ("STM32F42x_43x,3"), protocol 5 and later. */
  chipDes: string | null;
  /** The MCU's unique id as hex, protocol 4 and later. */
  serial: string | null;
}

export type Phase = "erase" | "program" | "verify" | "extf-erase" | "extf-program" | "extf-verify" | "reboot";
export type Progress = (phase: Phase, done: number, total: number) => void;

const u32 = (v: number) => new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
const le32 = (b: Uint8Array) => (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;

/** STM32F42x/43x chip revisions whose flash above 1 MB cannot be used (errata 2.1.10), as ArduPilot checks. */
const F427_FLAWED_REVS = new Set([0x1000, 0x1001, 0x1003, 0x1007]);

/** True when the chip is an STM32F42x/43x revision limited to 1 MB of flash. */
export function chipLimitedTo1M(chip: number | null): boolean | null {
  if (chip === null) return null;
  if ((chip & 0xfff) !== 0x419) return false;
  return F427_FLAWED_REVS.has(chip >>> 16);
}

export class Bootloader {
  info: BoardInfo | null = null;

  private link: ByteLink;

  constructor(link: ByteLink) {
    this.link = link;
  }

  private send(...parts: (number | Uint8Array)[]) {
    let n = 0;
    for (const p of parts) n += typeof p === "number" ? 1 : p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) {
      if (typeof p === "number") out[o++] = p;
      else {
        out.set(p, o);
        o += p.length;
      }
    }
    return this.link.write(out);
  }

  /** INSYNC then a status; anything but OK throws. */
  private async getSync(timeoutMs = 2000) {
    const [s] = await this.link.read(1, timeoutMs);
    if (s !== P.INSYNC) throw new BootloaderError(`The board sent 0x${s.toString(16)} where the bootloader would send INSYNC: this is not a bootloader, or it lost track.`);
    const [c] = await this.link.read(1, timeoutMs);
    if (c === P.INVALID) throw new BootloaderError("The bootloader rejected the command as invalid.");
    if (c === P.FAILED) throw new BootloaderError("The bootloader reports the operation failed.");
    if (c === P.BAD_SILICON_REV) throw new BootloaderError("This chip revision cannot be programmed this far (STM32F42x errata): use the 1 MB firmware for this board.");
    if (c !== P.OK) throw new BootloaderError(`The bootloader sent an unexpected status 0x${c.toString(16)}.`);
  }

  /** Get in step with the bootloader. Throws if nothing that answers like one is there. */
  async sync(timeoutMs = 500) {
    this.link.discardInput();
    await this.send(P.GET_SYNC, P.EOC);
    await this.getSync(timeoutMs);
  }

  /** Try to sync, without throwing: true when the bootloader answered. */
  async trySync(timeoutMs = 500): Promise<boolean> {
    try {
      await this.sync(timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  private async getInfo(param: number): Promise<number> {
    await this.send(P.GET_DEVICE, param, P.EOC);
    const v = le32(await this.link.read(4, 2000));
    await this.getSync();
    return v;
  }

  /** What board this is and how much flash it has. Must run before erasing: the bootloader refuses to erase until asked. */
  async identify(): Promise<BoardInfo> {
    await this.sync(1000);
    const blRev = await this.getInfo(P.INFO_BL_REV);
    if (blRev < BL_REV_MIN || blRev > BL_REV_MAX) throw new BootloaderError(`This bootloader speaks protocol ${blRev}; AERONEX (like Mission Planner) supports ${BL_REV_MIN} to ${BL_REV_MAX}.`);
    let extfSize = 0;
    try {
      extfSize = await this.getInfo(P.INFO_EXTF_SIZE);
    } catch {
      // Bootloaders without external flash answer INVALID; get back in step.
      extfSize = 0;
      await this.sync(1000);
    }
    const boardId = await this.getInfo(P.INFO_BOARD_ID);
    const boardRev = await this.getInfo(P.INFO_BOARD_REV);
    const flashSize = await this.getInfo(P.INFO_FLASH_SIZE);
    let chip: number | null = null;
    let chipDes: string | null = null;
    let serial: string | null = null;
    if (blRev >= 5) {
      try {
        await this.send(P.GET_CHIP, P.EOC);
        chip = le32(await this.link.read(4, 2000));
        await this.getSync();
      } catch {
        chip = null;
        await this.sync(1000);
      }
      try {
        await this.send(P.GET_CHIP_DES, P.EOC);
        const len = le32(await this.link.read(4, 2000));
        if (len > 64) throw new BootloaderError("chip description too long");
        chipDes = new TextDecoder().decode(await this.link.read(len, 2000));
        await this.getSync();
      } catch {
        chipDes = null;
        await this.sync(1000);
      }
    }
    if (blRev >= 4) {
      try {
        let hex = "";
        for (const at of [0, 4, 8]) {
          await this.send(P.GET_SN, u32(at), P.EOC);
          const w = await this.link.read(4, 2000);
          await this.getSync();
          // Each word arrives least significant byte first; print it most significant first, as uploader.py does.
          hex += [...w].reverse().map((b) => b.toString(16).padStart(2, "0")).join("");
        }
        serial = hex.toUpperCase();
      } catch {
        serial = null;
        await this.sync(1000);
      }
    }
    this.info = { blRev, boardId, boardRev, flashSize, extfSize, chip, chipDes, serial };
    return this.info;
  }

  /** Erase the firmware area. Can take 20 s or more on large chips; the bootloader answers when done. */
  async erase(onProgress?: Progress, timeoutMs = 30000) {
    await this.send(P.CHIP_ERASE, P.EOC);
    const t0 = Date.now();
    // Typical erase takes about 9 s; report progress against that.
    const tick = setInterval(() => onProgress?.("erase", Math.min(0.95, (Date.now() - t0) / 9000), 1), 250);
    try {
      while (Date.now() - t0 < timeoutMs) {
        let first: Uint8Array;
        try {
          first = await this.link.read(1, 500);
        } catch (e) {
          if (e instanceof TimeoutError) continue;
          throw e;
        }
        if (first[0] !== P.INSYNC) continue;
        const [c] = await this.link.read(1, 2000);
        if (c === P.OK) {
          onProgress?.("erase", 1, 1);
          return;
        }
        if (c === P.FAILED) throw new BootloaderError("The bootloader could not erase the flash (or the erased flash did not read back blank). Try again; if it repeats, the flash may be worn or write-protected.");
        if (c === P.INVALID) throw new BootloaderError("The bootloader refused to erase: it was not identified first. Start again.");
        throw new BootloaderError(`Unexpected status 0x${c.toString(16)} while erasing.`);
      }
      throw new BootloaderError("The board did not finish erasing within 30 seconds.");
    } finally {
      clearInterval(tick);
    }
  }

  private async progMulti(cmd: number, chunk: Uint8Array) {
    await this.send(cmd, chunk.length, chunk, P.EOC);
    await this.getSync();
  }

  /** Write the image from the start of the firmware area. */
  async program(image: Uint8Array, onProgress?: Progress, phase: Phase = "program", cmd: number = P.PROG_MULTI) {
    const total = image.length;
    for (let o = 0; o < total; o += PROG_MULTI_MAX) {
      await this.progMulti(cmd, image.subarray(o, Math.min(total, o + PROG_MULTI_MAX)));
      if ((o / PROG_MULTI_MAX) % 16 === 0) onProgress?.(phase, o, total);
    }
    onProgress?.(phase, total, total);
  }

  /** Check what was written: the board's CRC of its whole flash against the image's (protocol 3+), or a read-back (protocol 2). */
  async verify(image: Uint8Array, onProgress?: Progress) {
    const info = this.info;
    if (!info) throw new BootloaderError("Identify the board before verifying.");
    onProgress?.("verify", 0, 1);
    if (info.blRev >= 3) {
      const expect = flashCrc(image, info.flashSize);
      await this.send(P.GET_CRC, P.EOC);
      // The board reads its whole flash to compute this; allow it time.
      const got = le32(await this.link.read(4, 10000));
      await this.getSync();
      if (got !== expect) throw new BootloaderError(`Verification failed: the board's flash checksum is 0x${got.toString(16)}, the firmware's is 0x${expect.toString(16)}. Nothing was started; install again.`);
    } else {
      await this.send(P.CHIP_VERIFY, P.EOC);
      await this.getSync();
      for (let o = 0; o < image.length; o += PROG_MULTI_MAX) {
        const want = image.subarray(o, Math.min(image.length, o + PROG_MULTI_MAX));
        await this.send(P.READ_MULTI, want.length, P.EOC);
        const got = await this.link.read(want.length, 2000);
        for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) throw new BootloaderError(`Verification failed at byte ${o + i}: the flash does not hold what was written. Install again.`);
        await this.getSync();
        onProgress?.("verify", o, image.length);
      }
    }
    onProgress?.("verify", 1, 1);
  }

  /** External flash, for the few boards whose firmware has a part there. */
  async writeExternal(image: Uint8Array, size: number, onProgress?: Progress) {
    await this.send(P.EXTF_ERASE, u32(size), P.EOC);
    await this.getSync();
    // The bootloader reports erase progress as percentage bytes, then INSYNC/OK.
    let pct = 0;
    const t0 = Date.now();
    while (pct < 90 && Date.now() - t0 < 120000) {
      pct = (await this.link.read(1, 10000))[0];
      onProgress?.("extf-erase", pct, 100);
    }
    const t1 = Date.now();
    for (;;) {
      if (Date.now() - t1 > 60000) throw new BootloaderError("The board did not finish erasing its external flash.");
      try {
        const [s] = await this.link.read(1, 1000);
        if (s === P.INSYNC) {
          const [c] = await this.link.read(1, 1000);
          if (c === P.OK) break;
          if (c === P.FAILED) throw new BootloaderError("The bootloader could not erase the external flash.");
        }
      } catch (e) {
        if (!(e instanceof TimeoutError)) throw e;
      }
    }
    onProgress?.("extf-erase", 1, 1);
    await this.program(image.subarray(0, Math.ceil(size / 4) * 4), onProgress, "extf-program", P.EXTF_PROG_MULTI);
    const expect = crc32(image.subarray(0, size), 0);
    await this.send(P.EXTF_GET_CRC, u32(size), P.EOC);
    const got = le32(await this.link.read(4, 10000));
    await this.getSync();
    if (got !== expect) throw new BootloaderError(`External flash verification failed (board 0x${got.toString(16)}, file 0x${expect.toString(16)}).`);
    onProgress?.("extf-verify", 1, 1);
  }

  /** Start the new firmware. Protocol 3+ answers, and says FAILED if the first words could not be written. */
  async reboot() {
    await this.send(P.REBOOT, P.EOC);
    if ((this.info?.blRev ?? 0) >= 3) await this.getSync(2000);
  }
}
