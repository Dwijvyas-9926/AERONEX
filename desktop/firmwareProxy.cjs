// @ts-check
"use strict";

/*
  Firmware downloads in the Windows app.

  ArduPilot's firmware server sends no CORS headers, so a page cannot fetch
  from it directly. The web version's server passes /ardupilot-firmware/…
  on to it (vite.config.ts); here the app's own aeronex:// handler does the
  same, through Chromium's network stack. Only that one server, only reads,
  and only plain paths: nothing the page asks for can reach anywhere else.
*/

// AERONEX_FIRMWARE_SERVER points tests at a stand-in, as it does for the web version's server.
const FIRMWARE_SERVER = (process.env.AERONEX_FIRMWARE_SERVER || "https://firmware.ardupilot.org").replace(/\/+$/, "");
const PREFIX = "/ardupilot-firmware/";

/**
 * The firmware server URL for an aeronex:// path, or null if the path is not
 * a firmware request or is not a plain, safe path.
 * @param {string} pathname the URL's pathname, still percent-encoded
 */
function firmwareTarget(pathname) {
  if (!pathname.startsWith(PREFIX)) return null;
  let rest;
  try {
    rest = decodeURIComponent(pathname.slice(PREFIX.length));
  } catch {
    return null;
  }
  // Folders and file names as ArduPilot uses them: letters, digits, - _ . and /.
  if (!/^[A-Za-z0-9._\-/]*$/.test(rest)) return null;
  if (rest.split("/").some((part) => part === ".." || part === ".")) return null;
  if (rest.startsWith("/") || rest.includes("//")) return null;
  return `${FIRMWARE_SERVER}/${rest}`;
}

/**
 * Answer a firmware request with the server's reply.
 * @param {Request} request
 * @param {(url: string, init: object) => Promise<Response>} fetchFn Electron's net.fetch
 * @returns {Promise<Response> | null} null when the request is not for firmware
 */
function proxyFirmware(request, fetchFn) {
  const url = new URL(request.url);
  const target = firmwareTarget(url.pathname);
  if (!url.pathname.startsWith(PREFIX)) return null;
  if (!target || request.method !== "GET") return Promise.resolve(new Response("Not found", { status: 404 }));
  return fetchFn(target, { method: "GET", cache: "no-store", redirect: "follow" }).then(
    (r) => new Response(r.body, { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "application/octet-stream", "cache-control": "no-store" } }),
    () => new Response("The firmware server could not be reached.", { status: 502 }),
  );
}

module.exports = { firmwareTarget, proxyFirmware, FIRMWARE_SERVER };
