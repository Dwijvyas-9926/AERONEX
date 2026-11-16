/*
  A simulated ArduPilot bootloader, written from AP_Bootloader's
  bl_protocol.cpp: the same commands, the same checks (no erase or write
  until synced and identified; writes only in multiples of 4 within the
  flash; the first 8 words held back until BOOT), the same replies, and
  flash that, like real flash, can only clear bits until erased.

  It is checked against ArduPilot's own uploader.py (sitl/firmware.test.ts),
  so the uploader in AERONEX is tested against something that answers
  exactly as the reference client expects.
*/
import { crc32 } from "../crc32";

const INSYNC = 0x12, OK = 0x10, FAILED = 0x11, INVALID = 0x13, EOC = 0x20;
const RESERVE_LEAD_WORDS = 8;

export interface SimOptions {
  boardId?: number;
  boardRev?: number;
  /** Bytes of flash for firmware. */
  fwSize?: number;
  blRev?: number;
  /** MCU IDCODE (rev << 16 | dev). */
  chip?: number;
  chipDes?: string;
  extfSize?: number;
  /** Old bootloaders answer INVALID to the external flash size query. */
  noExtfInfo?: boolean;
  eraseMs?: number;
  /** Corrupt one byte as it is written: verification must catch it. */
  corruptAt?: number;
  /** Fail the erase (flash will not erase). */
  failErase?: boolean;
}

export class SimBootloader {
  o: Required<Omit<SimOptions, "corruptAt">> & { corruptAt?: number };
  flash: Uint8Array;
  firstWords = new Uint32Array(RESERVE_LEAD_WORDS).fill(0xffffffff);
  address: number;
  readAddress = 0;
  doneSync = false;
  flags = 0;
  booted = false;
  erasing = false;
  /** Bytes from the host not yet consumed. */
  private inBuf: number[] = [];
  /** Bytes to the host. */
  out: number[] = [];
  onOutput: (() => void) | null = null;
  log: string[] = [];

  constructor(opts: SimOptions = {}) {
    this.o = {
      boardId: 9,
      boardRev: 0,
      fwSize: (2048 - 16) * 1024,
      blRev: 5,
      chip: 0x20016419,
      chipDes: "STM32F42x_43x,3",
      extfSize: 0,
      noExtfInfo: false,
      eraseMs: 50,
      failErase: false,
      ...opts,
    };
    this.flash = new Uint8Array(this.o.fwSize);
    // Old firmware in flash.
    for (let i = 0; i < this.flash.length; i++) this.flash[i] = (i * 2654435761) >>> 24;
    // Forces an erase before any write is accepted.
    this.address = this.o.fwSize;
  }

  private reply(...bytes: number[]) {
    this.out.push(...bytes);
    this.onOutput?.();
  }
  private word(v: number) {
    this.reply(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  }
  private sync() {
    this.reply(INSYNC, OK);
  }
  private bad() {
    this.reply(INSYNC, INVALID);
  }
  private fail() {
    this.reply(INSYNC, FAILED);
  }
  private get identified() {
    return this.doneSync && (this.flags & 0xb) === 0xb;
  }
  private readWord(a: number) {
    return (this.flash[a] | (this.flash[a + 1] << 8) | (this.flash[a + 2] << 16) | (this.flash[a + 3] << 24)) >>> 0;
  }

  /** Bytes from the host. Commands are handled as soon as they are complete. */
  input(bytes: Uint8Array) {
    for (const b of bytes) this.inBuf.push(b);
    this.pump();
  }

  /** How many bytes a command needs, or -1 when it cannot know yet. */
  private need(): number {
    const c = this.inBuf[0];
    switch (c) {
      case 0x21: case 0x23: case 0x24: case 0x29: case 0x2c: case 0x2e: case 0x30: case 0x40:
        return 2;
      case 0x22:
        return 3;
      case 0x2a: case 0x2b: case 0x2d:
        return c === 0x2d ? 3 : 6;
      case 0x27:
        return this.inBuf.length < 2 ? -1 : 3 + this.inBuf[1];
      case 0x28:
        return 3;
      default:
        return 1;
    }
  }

  private pump() {
    while (this.inBuf.length && !this.erasing && !this.booted) {
      const n = this.need();
      if (n < 0 || this.inBuf.length < n) return;
      const cmd = this.inBuf.splice(0, n);
      this.handle(cmd);
    }
  }

  private handle(cmd: number[]) {
    const c = cmd[0];
    const eocOk = cmd[cmd.length - 1] === EOC;
    switch (c) {
      case 0x21: // GET_SYNC
        if (!eocOk) return this.bad();
        this.doneSync = true;
        return this.sync();
      case 0x22: { // GET_DEVICE
        if (!eocOk) return this.bad();
        const arg = cmd[1];
        this.readAddress = 0;
        const v = { 1: this.o.blRev, 2: this.o.boardId, 3: this.o.boardRev, 4: this.o.fwSize, 6: this.o.noExtfInfo ? undefined : this.o.extfSize }[arg as 1];
        if (v === undefined) return this.bad();
        this.word(v);
        this.flags |= 1 << (arg - 1);
        return this.sync();
      }
      case 0x23: // CHIP_ERASE
        if (!this.identified || !eocOk) return this.bad();
        this.erasing = true;
        this.log.push("erase");
        setTimeout(() => {
          this.erasing = false;
          if (this.o.failErase) {
            this.fail();
          } else {
            this.flash.fill(0xff);
            this.address = 0;
            this.sync();
          }
          this.pump();
        }, this.o.eraseMs);
        return;
      case 0x27: { // PROG_MULTI
        if (!this.identified) return this.bad();
        const len = cmd[1];
        if (len % 4 || this.address + len > this.o.fwSize || !eocOk) return this.bad();
        const data = cmd.slice(2, 2 + len);
        // Holding back the first words is the ArduPilot bootloader's (protocol 3 and later).
        if (this.o.blRev >= 3 && this.address < RESERVE_LEAD_WORDS * 4) {
          const k = Math.min(RESERVE_LEAD_WORDS * 4 - this.address, len);
          for (let i = 0; i < k; i += 4) this.firstWords[(this.address + i) / 4] = (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24)) >>> 0;
          for (let i = 0; i < k; i++) data[i] = 0xff;
        }
        for (let i = 0; i < len; i++) {
          let v = data[i];
          if (this.o.corruptAt === this.address + i) v ^= 0x40;
          // Flash can only clear bits; writing over unerased data fails the read-back.
          const nv = this.flash[this.address + i] & v;
          if (nv !== v) return this.fail();
          this.flash[this.address + i] = nv;
        }
        this.address += len;
        return this.sync();
      }
      case 0x29: { // GET_CRC
        if (!eocOk) return this.bad();
        let sum = 0;
        const w = new Uint8Array(4);
        for (let p = 0; p < this.o.fwSize; p += 4) {
          const v = p < RESERVE_LEAD_WORDS * 4 && this.firstWords[0] !== 0xffffffff ? this.firstWords[p / 4] : this.readWord(p);
          w[0] = v & 0xff;
          w[1] = (v >>> 8) & 0xff;
          w[2] = (v >>> 16) & 0xff;
          w[3] = (v >>> 24) & 0xff;
          sum = crc32(w, sum);
        }
        this.word(sum);
        return this.sync();
      }
      case 0x28: { // READ_MULTI
        const len = cmd[1];
        if (len % 4 || this.readAddress + len > this.o.fwSize || !eocOk) return this.bad();
        for (let i = 0; i < len; i += 4) {
          const a = this.readAddress;
          this.word(this.readWord(a));
          this.readAddress += 4;
        }
        return this.sync();
      }
      case 0x24: // CHIP_VERIFY (protocol 2)
        if (!eocOk) return this.bad();
        this.readAddress = 0;
        return this.sync();
      case 0x2c: // GET_CHIP
        if (!eocOk) return this.bad();
        this.word(this.o.chip);
        return this.sync();
      case 0x2e: { // GET_CHIP_DES
        if (!eocOk) return this.bad();
        const d = new TextEncoder().encode(this.o.chipDes).slice(0, 20);
        this.word(d.length);
        this.reply(...d);
        return this.sync();
      }
      case 0x2b: // GET_SN
        if (!eocOk) return this.bad();
        this.word(0x12345678 + cmd[1]);
        return this.sync();
      case 0x2a: // GET_OTP
        if (!eocOk) return this.bad();
        this.word(0);
        return this.sync();
      case 0x30: // BOOT
        if (!eocOk) return this.bad();
        if (this.firstWords[0] !== 0xffffffff) {
          for (let i = 0; i < RESERVE_LEAD_WORDS; i++) {
            const v = this.firstWords[i];
            for (let k = 0; k < 4; k++) this.flash[i * 4 + k] &= (v >>> (8 * k)) & 0xff;
          }
          this.firstWords.fill(0xffffffff);
        }
        this.log.push("boot");
        this.sync();
        this.booted = true;
        return;
      default:
        // Unknown bytes are skipped, as the bootloader does.
        return;
    }
  }

  /** The firmware as it sits in flash after booting. */
  image(n: number) {
    return this.flash.slice(0, n);
  }
}
