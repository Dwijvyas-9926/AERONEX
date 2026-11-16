/*
  Writes DataFlash logs for tests, the way ArduPilot's AP_Logger does: an FMT
  for each type, then messages of A3 95 type and the packed fields. Values
  are given in the units the reader returns (c/C/e/E hundredths and L
  degrees are packed back to their stored integers).
*/
const SIZE: Record<string, number> = { a: 64, b: 1, B: 1, h: 2, H: 2, i: 4, I: 4, f: 4, d: 8, n: 4, N: 16, Z: 64, c: 2, C: 2, e: 4, E: 4, L: 4, M: 1, q: 8, Q: 8, g: 2 };

export type Val = number | string;

export class DfWriter {
  private chunks: Uint8Array[] = [];
  private formats = new Map<number, string>();

  constructor() {
    this.define(128, "FMT", "BBnNZ", "Type,Length,Name,Format,Columns");
  }

  /** Describe a message type (writes its FMT). */
  define(type: number, name: string, format: string, columns: string): this {
    const len = 3 + [...format].reduce((s, ch) => s + SIZE[ch], 0);
    this.formats.set(type, format);
    if (type !== 128 || this.chunks.length === 0) this.write(128, [type, len, name, format, columns]);
    return this;
  }

  /** One message. */
  write(type: number, values: Val[]): this {
    const format = this.formats.get(type)!;
    const len = 3 + [...format].reduce((s, ch) => s + SIZE[ch], 0);
    const b = new Uint8Array(len);
    const dv = new DataView(b.buffer);
    b[0] = 0xa3;
    b[1] = 0x95;
    b[2] = type;
    let o = 3;
    [...format].forEach((ch, k) => {
      const v = values[k];
      const n = typeof v === "number" ? v : 0;
      switch (ch) {
        case "b": dv.setInt8(o, n); break;
        case "B": case "M": dv.setUint8(o, n); break;
        case "h": dv.setInt16(o, n, true); break;
        case "H": dv.setUint16(o, n, true); break;
        case "i": dv.setInt32(o, n, true); break;
        case "I": dv.setUint32(o, n, true); break;
        case "f": dv.setFloat32(o, n, true); break;
        case "d": dv.setFloat64(o, n, true); break;
        case "c": dv.setInt16(o, Math.round(n * 100), true); break;
        case "C": dv.setUint16(o, Math.round(n * 100), true); break;
        case "e": dv.setInt32(o, Math.round(n * 100), true); break;
        case "E": dv.setUint32(o, Math.round(n * 100), true); break;
        case "L": dv.setInt32(o, Math.round(n * 1e7), true); break;
        case "q": dv.setBigInt64(o, BigInt(Math.round(n)), true); break;
        case "Q": dv.setBigUint64(o, BigInt(Math.round(n)), true); break;
        case "g": dv.setUint16(o, n, true); break; // raw half-float bits
        case "n": case "N": case "Z": {
          const s = String(v ?? "");
          for (let i = 0; i < Math.min(s.length, SIZE[ch]); i++) b[o + i] = s.charCodeAt(i);
          break;
        }
        case "a": break;
      }
      o += SIZE[ch];
    });
    this.chunks.push(b);
    return this;
  }

  /** Raw bytes (junk, a torn message). */
  raw(bytes: number[] | Uint8Array): this {
    this.chunks.push(Uint8Array.from(bytes));
    return this;
  }

  bytes(): Uint8Array {
    const n = this.chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(n);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  buffer(): ArrayBuffer {
    return this.bytes().buffer as ArrayBuffer;
  }
}

/** Type numbers and layouts as ArduCopter 4.7 writes them. */
export const T = { PARM: 64, MODE: 65, EV: 66, ERR: 67, MSG: 68, ATT: 70, CTUN: 71, POS: 72, GPS: 73, BAT: 74, VIBE: 75, XKF4: 76, RCOU: 77, MAG: 78, ORGN: 79, PM: 80, POWR: 81, VER: 82, FMTU: 83, UNIT: 84, MULT: 85 };

/** A writer with ArduCopter's message layouts already described. */
export function copterLog(): DfWriter {
  return new DfWriter()
    .define(T.UNIT, "UNIT", "QbZ", "TimeUS,Id,Label")
    .define(T.MULT, "MULT", "Qbd", "TimeUS,Id,Mult")
    .define(T.FMTU, "FMTU", "QBNN", "TimeUS,FmtType,UnitIds,MultIds")
    .define(T.PARM, "PARM", "QNff", "TimeUS,Name,Value,Default")
    .define(T.MODE, "MODE", "QMBB", "TimeUS,Mode,ModeNum,Rsn")
    .define(T.EV, "EV", "QB", "TimeUS,Id")
    .define(T.ERR, "ERR", "QBB", "TimeUS,Subsys,ECode")
    .define(T.MSG, "MSG", "QZ", "TimeUS,Message")
    .define(T.ATT, "ATT", "QccccCCB", "TimeUS,DesRoll,Roll,DesPitch,Pitch,DesYaw,Yaw,AEKF")
    .define(T.CTUN, "CTUN", "Qffffffeffff", "TimeUS,ThI,ABst,ThO,ThH,DAlt,Alt,BAlt,DSAlt,SAlt,TAlt,DCRt")
    .define(T.POS, "POS", "QLLfff", "TimeUS,Lat,Lng,Alt,RelHomeAlt,RelOriginAlt")
    .define(T.GPS, "GPS", "QBBIHBcLLeffff", "TimeUS,I,Status,GMS,GWk,NSats,HDop,Lat,Lng,Alt,Spd,GCrs,VZ,Yaw")
    .define(T.BAT, "BAT", "QBfffff", "TimeUS,Inst,Volt,VoltR,Curr,CurrTot,EnrgTot")
    .define(T.VIBE, "VIBE", "QBfffI", "TimeUS,IMU,VibeX,VibeY,VibeZ,Clip")
    .define(T.XKF4, "XKF4", "QBccccBB", "TimeUS,C,SV,SP,SH,SM,SS,PI")
    .define(T.RCOU, "RCOU", "QHHHHHHHH", "TimeUS,C1,C2,C3,C4,C5,C6,C7,C8")
    .define(T.MAG, "MAG", "QBhhh", "TimeUS,I,MagX,MagY,MagZ")
    .define(T.ORGN, "ORGN", "QBLLe", "TimeUS,Type,Lat,Lng,Alt")
    .define(T.PM, "PM", "QHHHIH", "TimeUS,NLon,NL,MaxT,Mem,Load")
    .define(T.POWR, "POWR", "QffHH", "TimeUS,Vcc,VServo,Flags,AccFlags")
    .define(T.VER, "VER", "QBBBBZ", "TimeUS,Maj,Min,Pat,FWT,FWS");
}
