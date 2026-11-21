import { describe, expect, it, vi } from "vitest";
import {
  createUpdater,
  plainError,
  plainNotes,
  type UpdaterStatus,
} from "../../../desktop/updater.cjs";
import { holdingAircraft } from "../updates";

/*
  The update rules of desktop/updater.cjs, against a stand-in for
  electron-updater. What matters most: no restart and no install on exit while
  an aircraft is connected, and nothing happens without the operator.
*/

/** Just enough of an event emitter for the updater's `on` and the test's `emit`. */
class Emitter {
  private handlers = new Map<string, ((arg?: unknown) => void)[]>();
  on(event: string, fn: (arg?: unknown) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
    return this;
  }
  emit(event: string, arg?: unknown) {
    for (const fn of this.handlers.get(event) ?? []) fn(arg);
  }
}

class FakeUpdater extends Emitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowPrerelease = true;
  allowDowngrade = true;
  quitAndInstall = vi.fn();
  next: (() => void) | Error = () => {};
  checkForUpdates: () => Promise<unknown> = async () => {
    this.checks++;
    if (this.next instanceof Error) throw this.next;
    this.emit("checking-for-update");
    this.next();
  };
  checks = 0;
}

function setup() {
  const updater = new FakeUpdater();
  const sent: UpdaterStatus[] = [];
  const timers: { fn: () => void; ms: number; kind: string }[] = [];
  const u = createUpdater({
    updater,
    current: "0.1.0",
    send: (s: UpdaterStatus) => sent.push(s),
    setTimeout: (fn: () => void, ms: number) =>
      timers.push({ fn, ms, kind: "once" }),
    setInterval: (fn: () => void, ms: number) =>
      timers.push({ fn, ms, kind: "every" }),
  });
  const downloaded = (version = "0.1.1") => {
    updater.emit("update-available", { version, releaseNotes: "<p>Fixes</p>" });
    updater.emit("download-progress", { percent: 42.4 });
    updater.emit("update-downloaded", {
      version,
      releaseNotes: "<p>Fixes</p>",
    });
  };
  return { updater, sent, timers, u, downloaded };
}

describe("desktop updater", () => {
  it("downloads by itself but only stable, newer versions", () => {
    const { updater } = setup();
    expect(updater.autoDownload).toBe(true);
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
    // Must be on while downloading or electron-updater never adds its exit step.
    expect(updater.autoInstallOnAppQuit).toBe(true);
  });

  it("looks shortly after start, then every few hours", () => {
    const { u, timers, updater } = setup();
    u.start();
    expect(updater.checks).toBe(0);
    expect(timers.map((t) => [t.kind, t.ms])).toEqual([
      ["once", 15_000],
      ["every", 4 * 60 * 60 * 1000],
    ]);
  });

  it("reports progress and the new version's notes as plain text", () => {
    const { u, downloaded, sent } = setup();
    downloaded();
    expect(
      sent.some((s) => s.state === "downloading" && s.percent === 42),
    ).toBe(true);
    expect(u.status()).toMatchObject({
      state: "ready",
      version: "0.1.1",
      notes: "Fixes",
      current: "0.1.0",
    });
  });

  it("restarts into the new version only when asked and nothing is connected", () => {
    const { u, updater, downloaded } = setup();
    expect(u.install().ok).toBe(false);
    downloaded();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    u.setBusy(true);
    const refused = u.install();
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/Disconnect the aircraft/);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    u.setBusy(false);
    expect(u.install().ok).toBe(true);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it("does not install on exit if an aircraft was connected as the app closed", () => {
    const { u, updater, downloaded } = setup();
    downloaded();
    u.setBusy(true);
    u.beforeQuit();
    expect(updater.autoInstallOnAppQuit).toBe(false);
    u.setBusy(false);
    u.beforeQuit();
    expect(updater.autoInstallOnAppQuit).toBe(true);
  });

  it("keeps quiet about an automatic check that fails, but explains a manual one", async () => {
    const { u, updater } = setup();
    updater.next = new Error("getaddrinfo ENOTFOUND github.com");
    await u.check(false);
    expect(u.status()).toMatchObject({ state: "idle", error: null });
    await u.check(true);
    expect(u.status().state).toBe("error");
    expect(u.status().error).toMatch(/internet connection/);
  });

  it("does not lose a downloaded version to a later failed check", async () => {
    const { u, updater, downloaded } = setup();
    downloaded();
    updater.emit("error", new Error("ETIMEDOUT"));
    expect(u.status().state).toBe("ready");
    const before = updater.checks;
    await u.check(true);
    expect(updater.checks).toBe(before);
  });

  it("does not start a second check while one is running", async () => {
    const { u, updater } = setup();
    let release!: () => void;
    updater.checkForUpdates = vi.fn(
      () => new Promise<void>((r) => (release = r)),
    );
    const a = u.check(true);
    void u.check(true);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    release();
    await a;
  });

  it("turns HTML release notes into text, without markup", () => {
    expect(
      plainNotes(
        "<h2>0.1.1</h2><ul><li>One</li><li>Two &amp; three</li></ul><script>x</script>",
      ),
    ).toBe("0.1.1\n• One\n• Two & three\nx");
    expect(plainNotes([{ version: "1", note: "<p>a</p>" }])).toBe("a");
    expect(plainNotes(null)).toBe("");
    expect(plainError(new Error("sha512 checksum mismatch"))).toMatch(
      /checksum/,
    );
  });
});

describe("holding an aircraft", () => {
  it("counts a real flight controller's port and a firmware install, not the virtual aircraft", () => {
    expect(holdingAircraft({ status: "idle", virtual: false }, "start")).toBe(
      false,
    );
    expect(
      holdingAircraft({ status: "connected", virtual: false }, "start"),
    ).toBe(true);
    expect(holdingAircraft({ status: "stale", virtual: false }, "start")).toBe(
      true,
    );
    expect(
      holdingAircraft({ status: "opening", virtual: false }, "start"),
    ).toBe(true);
    expect(
      holdingAircraft({ status: "connected", virtual: true }, "start"),
    ).toBe(false);
    expect(holdingAircraft({ status: "lost", virtual: false }, "start")).toBe(
      false,
    );
    expect(
      holdingAircraft({ status: "idle", virtual: false }, "installing"),
    ).toBe(true);
    expect(holdingAircraft({ status: "idle", virtual: false }, "waiting")).toBe(
      true,
    );
    expect(holdingAircraft({ status: "idle", virtual: false }, "done")).toBe(
      false,
    );
  });
});
