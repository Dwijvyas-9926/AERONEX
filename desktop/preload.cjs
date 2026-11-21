// @ts-check
"use strict";

/*
  The only door between the page and the desktop shell.

  The page gets `window.aeronexDesktop` and nothing else: no Node, no file
  system, no general message channel. Each function below is one narrow thing
  the shell does for it, and every value crossing over is checked on the way.
*/
const { contextBridge, ipcRenderer } = require("electron");

const listen = (channel, fn) => {
  const wrapped = (_e, ...args) => fn(...args);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld("aeronexDesktop", {
  /** Running in the Windows app, not a browser. */
  isDesktop: true,
  platform: process.platform,

  serial: {
    /** The shell asks which port to open; the page answers with `choose`. */
    onChoose: (fn) => listen("serial:choose", (list) => fn(Array.isArray(list) ? list : [])),
    /** Asked for a port with none plugged in. */
    onNone: (fn) => listen("serial:none", () => fn()),
    /** The id of the chosen port, or null to cancel. */
    choose: (id) => ipcRenderer.send("serial:chose", typeof id === "string" ? id : null),
  },

  secrets: {
    /** Every stored key, decrypted, read once at start. `available` is false when Windows cannot encrypt. */
    all: () => ipcRenderer.sendSync("secret:all"),
    /** Store one key (null removes it). Resolves false if it could not be stored encrypted. */
    set: (name, value) => ipcRenderer.invoke("secret:set", String(name), value === null ? null : String(value)),
  },

  /** The menu asks the page to open a page of the app. */
  onGo: (fn) => listen("go", (hash) => typeof hash === "string" && hash.startsWith("/") && fn(hash)),
  /** The menu asks for the guide. */
  onGuide: (fn) => listen("guide", () => fn()),
});
