/*
  What the app's own pages may use, and nothing else: no camera, microphone,
  notifications, screen capture, or anything asked for by a page from
  elsewhere.
  - serial: the flight controller, on the port the operator picks.
  - geolocation: only when the operator presses "My location" on a map. The
    position comes from Windows (see the switch at the top of main.cjs), stays
    in the map and is sent nowhere.
  - clipboard-sanitized-write: copying an assistant answer. Write only;
    reading the clipboard stays refused.
*/
const ALLOWED_PERMISSIONS = new Set([
  "serial",
  "geolocation",
  "clipboard-sanitized-write",
]);

/**
 * @param {{ scheme: string, devServer?: string | null }} opts
 * @returns {(permission: string, url: unknown) => boolean}
 */
function createPermissionRule({ scheme, devServer = null }) {
  const devOrigin = devServer ? new URL(devServer).origin : null;
  return (permission, url) => {
    if (!ALLOWED_PERMISSIONS.has(permission)) return false;
    let u;
    try {
      u = new URL(String(url ?? ""));
    } catch {
      return false;
    }
    if (u.protocol === `${scheme}:` && u.host === "app") return true;
    // `npm run desktop:dev` loads the pages from the Vite server instead.
    return devOrigin !== null && u.origin === devOrigin;
  };
}

module.exports = { ALLOWED_PERMISSIONS, createPermissionRule };
