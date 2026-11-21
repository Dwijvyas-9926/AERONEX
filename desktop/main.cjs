// @ts-check
"use strict";

/*
  AERONEX for Windows: the desktop shell.

  The ground station itself is the same build that runs in a browser
  (`dist/`), unchanged. This process puts a window around it and gives it the
  three things a browser cannot:

   - the flight controller's serial port, chosen in AERONEX's own list rather
     than the browser's chrome;
   - the API keys kept encrypted by Windows, not in a readable file;
   - a window that remembers where it was, and a menu.

  The page is served over an `aeronex://` scheme of this app's own rather than
  from `file://`: modules, the content security policy and the serial port all
  need a real, secure origin.

  Everything here is written as if the page could be hostile, because one day a
  mistake in it might be: the renderer gets no Node, no file system, and no way
  to navigate anywhere but this app.
*/

const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, net, protocol, safeStorage, session, shell } = require("electron");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const APP_SCHEME = "aeronex";
const ROOT = path.join(__dirname, "..", "dist");
const DEV_SERVER = process.env.AERONEX_DEV_SERVER || null;
const isWindows = process.platform === "win32";

/** Where this install keeps its own files (window position, encrypted keys). */
const userFile = (name) => path.join(app.getPath("userData"), name);

/* ------------------------------------------------------------ the app's own pages */

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain",
  ".map": "application/json",
};

/**
 * Serve one file out of the build.
 *
 * Only what the build produced, and only from inside it: a path that climbs
 * out of `dist` is refused rather than resolved.
 */
async function serve(request) {
  const url = new URL(request.url);
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  const file = path.join(ROOT, rel);
  const inside = path.relative(ROOT, file);
  if (inside.startsWith("..") || path.isAbsolute(inside)) return new Response("Not found", { status: 404 });
  try {
    const body = await fsp.readFile(file);
    const type = TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": type,
        // The policy the built page carries anyway, as a header too, and one
        // rule a page cannot set for itself: nothing may frame this app.
        "content-security-policy":
          "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https: data: blob:; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

/* --------------------------------------------------------------- the serial port */

/*
  Choosing the flight controller.

  A browser shows its own list of ports; Electron hands the list to the app
  instead. AERONEX shows it in its own dialog, so the names, the USB
  identities and the wording match the Connection page. `pick` holds the
  question that is open, so a second request cannot answer the first.
*/
let pick = null;

function endPick(portId) {
  if (!pick) return;
  const { done, timer } = pick;
  pick = null;
  clearTimeout(timer);
  done(portId ?? "");
}

function wireSerial(ses, win) {
  ses.on("select-serial-port", (event, ports, webContents, callback) => {
    event.preventDefault();
    if (webContents !== win.webContents) return callback("");
    endPick(null);
    const list = ports.map((p) => ({
      id: p.portId,
      name: p.portName ?? "",
      display: p.displayName ?? "",
      vendorId: p.vendorId ? Number.parseInt(p.vendorId, 16) : null,
      productId: p.productId ? Number.parseInt(p.productId, 16) : null,
      serial: p.serialNumber ?? "",
    }));
    // Nothing plugged in: say so rather than leaving the page waiting.
    if (list.length === 0) {
      callback("");
      win.webContents.send("serial:none");
      return;
    }
    // A port unplugged while the list is open would otherwise hold it open for ever.
    const timer = setTimeout(() => endPick(null), 5 * 60 * 1000);
    pick = { done: callback, timer };
    win.webContents.send("serial:choose", list);
  });

  // A port the operator picked stays available to `navigator.serial.getPorts()`
  // for this run, so reconnecting after a reboot needs no second question.
  ses.setDevicePermissionHandler((details) => details.deviceType === "serial" && details.origin === `${APP_SCHEME}://app`);
  ses.setPermissionCheckHandler((_wc, permission) => permission === "serial");
  ses.setPermissionRequestHandler((_wc, permission, done) => done(permission === "serial"));
}

ipcMain.on("serial:chose", (_e, id) => endPick(typeof id === "string" ? id : null));

/* ------------------------------------------------------------------ the API keys */

/*
  The Anthropic and map keys.

  In a browser they live in the page's own storage. Installed, that is a
  readable file in a predictable place, so here they are encrypted by Windows
  itself (DPAPI, through Electron's safeStorage) and kept in one file beside
  the app's settings. If Windows cannot encrypt — a rare, broken profile — no
  key is written at all rather than written in the clear, and the app says so.
*/
const KEYS_FILE = () => userFile("keys.dat");

function readSecrets() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return {};
    const raw = fs.readFileSync(KEYS_FILE());
    return JSON.parse(safeStorage.decryptString(raw));
  } catch {
    return {};
  }
}

function writeSecrets(all) {
  if (!safeStorage.isEncryptionAvailable()) return false;
  try {
    fs.writeFileSync(KEYS_FILE(), safeStorage.encryptString(JSON.stringify(all)), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

ipcMain.on("secret:all", (e) => {
  e.returnValue = { available: safeStorage.isEncryptionAvailable(), values: readSecrets() };
});
ipcMain.handle("secret:set", (_e, name, value) => {
  const all = readSecrets();
  if (value === null) delete all[name];
  else all[name] = String(value);
  return writeSecrets(all);
});

/* ----------------------------------------------------------------- the window */

const DEFAULT_WINDOW = { width: 1440, height: 900 };

function readWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(userFile("window.json"), "utf8"));
    const ok = (n) => typeof n === "number" && Number.isFinite(n);
    if (!ok(s.width) || !ok(s.height)) return DEFAULT_WINDOW;
    return { width: Math.max(900, s.width), height: Math.max(600, s.height), x: ok(s.x) ? s.x : undefined, y: ok(s.y) ? s.y : undefined, maximised: !!s.maximised };
  } catch {
    return DEFAULT_WINDOW;
  }
}

function saveWindowState(win) {
  if (win.isDestroyed()) return;
  try {
    const b = win.isMaximized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds();
    fs.writeFileSync(userFile("window.json"), JSON.stringify({ ...b, maximised: win.isMaximized() }));
  } catch {
    /* a window that cannot be remembered still opens at its usual size */
  }
}

function createWindow() {
  const state = readWindowState();
  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 880,
    minHeight: 600,
    show: false,
    backgroundColor: "#f6f3ec",
    title: "AERONEX Ground Station",
    icon: path.join(__dirname, "build", "icon.png"),
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  if (state.maximised) win.maximize();
  win.once("ready-to-show", () => win.show());

  let saveTimer = null;
  const remember = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWindowState(win), 400);
  };
  win.on("resize", remember);
  win.on("move", remember);
  win.on("close", () => {
    clearTimeout(saveTimer);
    saveWindowState(win);
    endPick(null);
  });

  wireSerial(win.webContents.session, win);

  /*
    The renderer may go nowhere but this app. A link to ArduPilot's
    documentation, or to the Anthropic console, opens in the real browser,
    where the operator can see the address they are visiting.
  */
  const external = (url) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  };
  win.webContents.setWindowOpenHandler(({ url }) => external(url));
  win.webContents.on("will-navigate", (e, url) => {
    const here = DEV_SERVER ? DEV_SERVER : `${APP_SCHEME}://app`;
    if (!url.startsWith(here)) {
      e.preventDefault();
      external(url);
    }
  });
  win.webContents.on("will-attach-webview", (e) => e.preventDefault());

  void win.loadURL(DEV_SERVER ?? `${APP_SCHEME}://app/index.html`);
  return win;
}

/* -------------------------------------------------------------------- the menu */

function buildMenu(win) {
  const go = (hash) => () => win.webContents.send("go", hash);
  const template = [
    {
      label: "&File",
      submenu: [
        { label: "Open a flight log…", accelerator: "CmdOrCtrl+O", click: go("/logs") },
        { type: "separator" },
        { label: "Settings", accelerator: "CmdOrCtrl+,", click: go("/settings") },
        { type: "separator" },
        { role: "quit", label: "Exit" },
      ],
    },
    {
      label: "&Aircraft",
      submenu: [
        { label: "Connection", click: go("/connection") },
        { label: "Preflight check", click: go("/preflight") },
        { label: "Flight data", click: go("/flight-data") },
        { label: "Mission planning", click: go("/missions") },
        { type: "separator" },
        { label: "Flight simulator", click: go("/simulator") },
      ],
    },
    {
      label: "&View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "&Help",
      submenu: [
        { label: "Guide", accelerator: "F1", click: () => win.webContents.send("guide") },
        { label: "About AERONEX", click: go("/about") },
        { type: "separator" },
        { label: "ArduPilot documentation", click: () => void shell.openExternal("https://ardupilot.org/copter/") },
        {
          label: "Where my data is kept",
          click: () => {
            void shell.openPath(app.getPath("userData"));
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------- start-up */

// One window per install: a second aircraft on a second copy would fight over the port.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let main = null;
  app.on("second-instance", () => {
    if (!main) return;
    if (main.isMinimized()) main.restore();
    main.focus();
  });

  app.whenReady().then(() => {
    nativeTheme.themeSource = "light";
    protocol.handle(APP_SCHEME, serve);
    // Nothing in this app asks for a camera, a microphone or a location from
    // the desktop; only the serial port, allowed per window above.
    session.defaultSession.setPermissionRequestHandler((_wc, _p, done) => done(false));
    main = createWindow();
    buildMenu(main);
    main.webContents.on("render-process-gone", (_e, details) => {
      dialog.showErrorBox("AERONEX stopped unexpectedly", `The window closed because of a fault (${details.reason}). Any aircraft stays as it was; AERONEX sends nothing while it is not running.\n\nStart AERONEX again to carry on.`);
    });
  });

  app.on("window-all-closed", () => app.quit());
}

// Nothing here needs the network stack's http module; this keeps the linter honest.
void net;
void isWindows;
