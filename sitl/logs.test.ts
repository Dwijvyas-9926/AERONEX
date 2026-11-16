import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sleep, tcpSerialPort, until } from "./harness";

/*
  Downloading logs from real ArduCopter, and reading what comes down.

  ArduCopter's SITL build writes DataFlash logs to its logs/ folder exactly as
  a Pixhawk writes them to its SD card. The app lists them over MAVLink,
  downloads one through its real serial path, and the bytes are compared with
  the file on disk, byte for byte: first over a clean link, then over a link
  that loses one chunk in twenty each way, which the download has to recover
  from by asking again. The downloaded log is then read and checked.

      SITL_BIN=…/arducopter SITL_DEFAULTS=…/copter.parm npx vitest run sitl/logs

  Skipped without SITL_BIN.
*/
const BIN = process.env.SITL_BIN;
const DEFAULTS = process.env.SITL_DEFAULTS;
const SPEEDUP = Number(process.env.SITL_SPEEDUP ?? 5);
const REPORT = process.env.SITL_REPORT;
const INSTANCE = Number(process.env.SITL_INSTANCE ?? 2);
const PORT = 5760 + 10 * INSTANCE;

const store = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
vi.stubGlobal("window", Object.assign(globalThis, { addEventListener: () => undefined, removeEventListener: () => undefined }));
Object.defineProperty(globalThis.navigator, "serial", { value: { addEventListener: () => undefined, getPorts: async () => [] }, configurable: true });

const report: string[] = [];
const say = (line: string) => {
  report.push(line);
  console.log(line);
};

describe.skipIf(!BIN)("log download from real ArduCopter (SITL)", () => {
  let proc: ChildProcess;
  let dir: string;
  let link: { loss: number; dropped: number };
  let app: {
    linkManager: (typeof import("../src/services/link/linkManager"))["linkManager"];
    commandLink: (typeof import("../src/services/link/commandLink"))["commandLink"];
    useLink: (typeof import("../src/state/linkStore"))["useLink"];
    dl: typeof import("../src/services/link/logDownload");
    load: typeof import("../src/logs/load");
  };

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "aeronex-logs-"));
    const args = ["--model", "quad", "--speedup", String(SPEEDUP), "--home", "23.0225,72.5714,53,0", `-I${INSTANCE}`, "--wipe"];
    if (DEFAULTS) args.push("--defaults", DEFAULTS);
    proc = spawn(BIN!, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout!.on("data", (b) => (out += String(b)));
    proc.stderr!.on("data", (b) => (out += String(b)));
    await until("the simulator to listen", () => new RegExp(`bind port ${PORT}|Waiting for connection`).test(out), 30000);
    app = {
      linkManager: (await import("../src/services/link/linkManager")).linkManager,
      commandLink: (await import("../src/services/link/commandLink")).commandLink,
      useLink: (await import("../src/state/linkStore")).useLink,
      dl: await import("../src/services/link/logDownload"),
      load: await import("../src/logs/load"),
    };
    const port = tcpSerialPort("127.0.0.1", PORT);
    link = port.link;
    await app.linkManager.connect(port.serial);
    await until("a heartbeat from ArduCopter", () => app.useLink.getState().status === "connected", 30000);
    // Log while disarmed, so the simulator writes a log without flying; then stop, so it is closed.
    await app.commandLink.setParam("LOG_DISARMED", 1);
    await sleep(15000);
    await app.commandLink.setParam("LOG_DISARMED", 0);
    await sleep(3000);
  }, 180000);

  afterAll(async () => {
    try {
      await app?.linkManager.disconnect("Test finished.");
    } catch {
      /* closing */
    }
    proc?.kill("SIGKILL");
    if (REPORT) writeFileSync(REPORT, report.join("\n") + "\n");
  });

  const onDisk = () =>
    readdirSync(path.join(dir, "logs"))
      .filter((f) => /^\d+\.BIN$/i.test(f))
      .map((f) => ({ f, id: parseInt(f, 10), size: statSync(path.join(dir, "logs", f)).size }));

  it("lists the logs the aircraft has, as its card holds them", async () => {
    const list = await app.dl.listAircraftLogs();
    say(`The aircraft lists: ${list.map((l) => `#${l.id} ${l.size} B`).join(", ")}; on its card: ${onDisk().map((d) => `${d.f} ${d.size} B`).join(", ")}`);
    expect(list.length).toBeGreaterThan(0);
    for (const l of list) {
      const d = onDisk().find((x) => x.id === l.id);
      expect(d).toBeDefined();
      expect(l.size).toBeLessThanOrEqual(d!.size);
    }
  }, 30000);

  it("downloads a log byte for byte, then reads it", async () => {
    const list = await app.dl.listAircraftLogs();
    const last = list[list.length - 1];
    let ticks = 0;
    const t0 = Date.now();
    const buf = await app.dl.downloadAircraftLog(last, () => ticks++);
    const ms = Date.now() - t0;
    const file = readFileSync(path.join(dir, "logs", onDisk().find((d) => d.id === last.id)!.f));
    const got = new Uint8Array(buf);
    const diff = got.findIndex((v, i) => v !== file[i]);
    say(`Log #${last.id}: ${got.length} B in ${ms} ms (${((got.length / ms) * 1000 / 1024).toFixed(0)} KB/s), ${ticks} progress updates; first difference from the card: ${diff < 0 ? "none" : diff}`);
    expect(got.length).toBe(last.size);
    expect(diff).toBe(-1);
    const loaded = app.load.loadLog(buf, `Log ${last.id}.bin`);
    say(`  reads as ${loaded.flight.firmware}: ${loaded.flight.raw.stats.messages} messages, ${loaded.flight.raw.tables.size} types, ${loaded.flight.params.size} parameters, ${loaded.flight.raw.stats.skipped} bytes skipped`);
    expect(loaded.flight.raw.stats.skipped).toBe(0);
    expect(loaded.flight.firmware).toMatch(/ArduCopter V4\./);
    expect(loaded.flight.params.size).toBeGreaterThan(500);
  }, 180000);

  it("recovers every byte over a link that loses one chunk in twenty", async () => {
    const list = await app.dl.listAircraftLogs();
    const last = list[list.length - 1];
    link.loss = 0.05;
    link.dropped = 0;
    try {
      const buf = await app.dl.downloadAircraftLog(last);
      const file = readFileSync(path.join(dir, "logs", onDisk().find((d) => d.id === last.id)!.f));
      const got = new Uint8Array(buf);
      let same = got.length === last.size;
      for (let i = 0; i < got.length && same; i++) if (got[i] !== file[i]) same = false;
      say(`Over a lossy link (${link.dropped} chunks dropped): ${got.length} B, identical to the card: ${same}`);
      expect(link.dropped).toBeGreaterThan(0);
      expect(same).toBe(true);
    } finally {
      link.loss = 0;
    }
  }, 300000);

  it("refuses to download while armed", async () => {
    app.useLink.setState({ vehicle: { ...app.useLink.getState().vehicle!, armed: true } });
    try {
      expect(() => app.dl.listAircraftLogs()).toThrow(/Disarm/);
    } finally {
      app.useLink.setState({ vehicle: { ...app.useLink.getState().vehicle!, armed: false } });
    }
  });
});
