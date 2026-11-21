// @ts-check
"use strict";

/*
  Keeping AERONEX up to date.

  New versions are published as GitHub Releases of this repository. The
  installed app looks there shortly after it starts and every few hours,
  downloads a new version in the background (only the parts that changed),
  and then asks: "Restart to update". Nothing restarts on its own.

  The one rule that matters more than being up to date: an update never takes
  the ground station away from an aircraft. While a flight controller's port
  is open, or a firmware install is under way, AERONEX will not restart to
  update, and it will not install on exit either: someone who closes the app
  with an aircraft connected may be about to open it again in a hurry, and an
  installer running in between would cost them that time. The update waits
  for the next time the app is closed with nothing connected.

  The page reports whether it is busy; this side keeps the last report and
  refuses on its own account too, so a confused page cannot force a restart.

  `createUpdater` takes the updater and the app as arguments, so the rules can
  be checked without Electron.
*/

const FIRST_CHECK_MS = 15_000;
const EVERY_MS = 4 * 60 * 60 * 1000;

/** Release notes arrive as HTML from GitHub; the app shows plain text. */
function plainNotes(notes) {
  const text = Array.isArray(notes)
    ? notes
        .map((n) => (n && typeof n.note === "string" ? n.note : ""))
        .join("\n\n")
    : typeof notes === "string"
      ? notes
      : "";
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 4000);
}

/** Say what went wrong in words an operator can act on. */
function plainError(err) {
  const msg = String((err && err.message) || err || "");
  if (
    /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|net::ERR_/i.test(
      msg,
    )
  )
    return "Could not reach GitHub to look for updates. Check the internet connection.";
  if (/404|latest\.yml/i.test(msg))
    return "No published version was found to compare with.";
  if (/sha512|checksum/i.test(msg))
    return "The downloaded update did not match its published checksum, so it was thrown away.";
  return "Looking for updates did not work this time.";
}

/**
 * @param {object} deps
 * @param {any} deps.updater electron-updater's autoUpdater, or a stand-in
 * @param {string} deps.current this app's version
 * @param {(status: object) => void} deps.send tell the page
 * @param {(fn: () => void, ms: number) => any} [deps.setTimeout]
 * @param {(fn: () => void, ms: number) => any} [deps.setInterval]
 */
function createUpdater({
  updater,
  current,
  send,
  setTimeout: later = setTimeout,
  setInterval: every = setInterval,
}) {
  let busy = false;
  /** @type {{state: string, current: string, version: string|null, notes: string, percent: number, error: string|null, manual: boolean}} */
  let status = {
    state: "idle",
    current,
    version: null,
    notes: "",
    percent: 0,
    error: null,
    manual: false,
  };
  let checking = false;

  const publish = (patch) => {
    status = { ...status, ...patch };
    send({ ...status, busy });
  };

  updater.autoDownload = true;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  // electron-updater only adds its install-on-exit step if this is true when
  // a download finishes, so it stays true; `beforeQuit` decides at the moment
  // the app closes, from whether anything is connected then.
  updater.autoInstallOnAppQuit = true;

  updater.on("checking-for-update", () =>
    publish({ state: "checking", error: null }),
  );
  updater.on("update-not-available", () =>
    publish({ state: "none", error: null }),
  );
  updater.on("update-available", (info) =>
    publish({
      state: "downloading",
      version: info?.version ?? null,
      notes: plainNotes(info?.releaseNotes),
      percent: 0,
      error: null,
    }),
  );
  updater.on("download-progress", (p) =>
    publish({
      state: "downloading",
      percent: Math.max(0, Math.min(100, Math.round(p?.percent ?? 0))),
    }),
  );
  updater.on("update-downloaded", (info) =>
    publish({
      state: "ready",
      version: info?.version ?? status.version,
      notes: plainNotes(info?.releaseNotes) || status.notes,
      percent: 100,
      error: null,
    }),
  );
  updater.on("error", (err) => {
    // A version already downloaded stays ready; a failed later check does not undo it.
    if (status.state === "ready") return;
    // Offline at start-up is normal; only a check the operator asked for says so.
    publish({
      state: status.manual ? "error" : "idle",
      error: status.manual ? plainError(err) : null,
    });
  });

  async function check(manual = false) {
    if (
      checking ||
      status.state === "ready" ||
      status.state === "downloading"
    ) {
      if (manual) publish({});
      return;
    }
    checking = true;
    status.manual = manual;
    try {
      await updater.checkForUpdates();
    } catch (err) {
      if (status.state !== "ready")
        publish({
          state: manual ? "error" : "idle",
          error: manual ? plainError(err) : null,
        });
    } finally {
      checking = false;
    }
  }

  function setBusy(value) {
    busy = !!value;
    publish({});
  }

  /** Called as the app closes: install then only if nothing was connected. */
  function beforeQuit() {
    updater.autoInstallOnAppQuit = !busy;
  }

  /** Restart into the new version, if one is ready and nothing is connected. */
  function install() {
    if (status.state !== "ready")
      return { ok: false, reason: "No update is ready to install." };
    if (busy)
      return {
        ok: false,
        reason:
          "Disconnect the aircraft first. AERONEX will not restart while a flight controller is connected or firmware is being installed.",
      };
    // Silent: the same folder and shortcuts as before. Then open the new version.
    updater.quitAndInstall(true, true);
    return { ok: true, reason: null };
  }

  function start() {
    later(() => void check(false), FIRST_CHECK_MS);
    every(() => void check(false), EVERY_MS);
  }

  return {
    start,
    check,
    setBusy,
    beforeQuit,
    install,
    status: () => ({ ...status, busy }),
  };
}

module.exports = {
  createUpdater,
  plainNotes,
  plainError,
  FIRST_CHECK_MS,
  EVERY_MS,
};
