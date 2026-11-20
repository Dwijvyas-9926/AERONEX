import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { defineConfig, type Plugin } from "vite";

/*
  Content Security Policy for the built app.

  Scripts only from the app itself (and WebAssembly, for the STEP importer);
  workers from the app or a blob it made (MapLibre's tile worker); no
  plugins, no <base> tricks, no form posts. Network requests may go to any
  https server, because map tiles come from whichever provider the user
  picks, including a tile address they type in, and Ask the Doctor talks to
  api.anthropic.com. Inline styles are allowed: React and the 3D libraries
  set them, and they cannot run code.

  Added at build only: the dev server injects an inline script of its own.
*/
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: data: blob:",
  "frame-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

/*
  The same policy as a response header, for hosts that can send one, with the
  two rules a <meta> policy cannot carry: who may frame the app (only itself:
  it frames its own scenic demo) and upgrading any http request to https.
  With it go the other headers a public site is expected to send.

  Hosts read them from different files. Netlify and Cloudflare Pages read
  dist/_headers, written here by the build. Vercel reads vercel.json at the
  top of the repository, which cannot be generated at build time, so the
  build checks that it says the same and fails if it has drifted.
*/
const HEADER_CSP = `${CSP}; frame-ancestors 'self'; upgrade-insecure-requests`;
const SECURITY_HEADERS: [string, string][] = [
  ["Content-Security-Policy", HEADER_CSP],
  ["Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload"],
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "SAMEORIGIN"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ["Cross-Origin-Opener-Policy", "same-origin"],
  // Web Serial for the flight controller, location for "show where I am" on the map, the clipboard for copying an answer; nothing else.
  ["Permissions-Policy", "serial=(self), geolocation=(self), clipboard-write=(self), fullscreen=(self), camera=(), microphone=(), usb=(), bluetooth=(), hid=(), midi=(), payment=(), display-capture=(), accelerometer=(), gyroscope=(), magnetometer=(), browsing-topics=()"],
];

const contentSecurityPolicy = (): Plugin => {
  let outDir = "dist";
  return {
    name: "aeronex-csp",
    apply: "build",
    configResolved(c) {
      outDir = c.build.outDir;
    },
    transformIndexHtml: (html) => {
      const at = '<meta charset="UTF-8" />';
      if (!html.includes(at)) throw new Error("index.html: charset meta not found; the security policy goes after it.");
      return html.replace(at, `${at}\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
    },
    closeBundle() {
      const lines = ["/*", ...SECURITY_HEADERS.map(([k, v]) => `  ${k}: ${v}`), "", "/assets/*", "  Cache-Control: public, max-age=31536000, immutable", "", "/sw.js", "  Cache-Control: no-cache", "", "/index.html", "  Cache-Control: no-cache", ""];
      writeFileSync(join(outDir, "_headers"), lines.join("\n"));
      // Netlify: pass firmware requests on to ArduPilot's server (see firmwareProxy below).
      writeFileSync(join(outDir, "_redirects"), "/ardupilot-firmware/*  https://firmware.ardupilot.org/:splat  200\n");
      const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as { headers: { source: string; headers: { key: string; value: string }[] }[] };
      const all = vercel.headers.find((h) => h.source === "/(.*)")?.headers ?? [];
      for (const [k, v] of SECURITY_HEADERS) {
        if (all.find((h) => h.key === k)?.value !== v) throw new Error(`vercel.json: the ${k} header differs from the one in vite.config.ts. Copy it across.`);
      }
    },
  };
};

/*
  The app, kept on the device, so it opens at the field with no internet.

  A ground station is used where there is often no signal. After one visit
  online, the service worker written here (dist/sw.js) holds the app itself:
  the page and every script, style and font of the build. It is written after
  the build, from what the build produced, so its list is never out of step.

  Left out of the first download and kept only once used: the STEP importer's
  7.6 MB WebAssembly and the legacy scenic demo's 6.3 MB bundle. Never kept:
  firmware downloads, which must be the server's current files. Map tiles are
  another matter and have their own store (geo/tileCache.ts).

  A new version waits until the app is closed, or until the user takes it
  from the notice (src/app/offline.ts): the code is never swapped under a
  session that may be linked to an aircraft.
*/
const LATER = /^_|^robots\.txt$|occt-import-js.*\.wasm$|^avion-sim-|^avion-simulator\.html$|^vendor\/|^social-card\.png$/;
const offlineApp = (): Plugin => {
  let outDir = "dist";
  return {
    name: "aeronex-offline",
    apply: "build",
    configResolved(c) {
      outDir = c.build.outDir;
    },
    closeBundle() {
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else files.push(relative(outDir, full).split("\\").join("/"));
        }
      };
      walk(outDir);
      const keep = files.filter((f) => f !== "sw.js" && !LATER.test(f)).sort();
      const hash = createHash("sha256");
      for (const f of keep) hash.update(f).update(readFileSync(join(outDir, f)));
      const version = hash.digest("hex").slice(0, 12);
      const sw = readFileSync("src/app/sw.template.js", "utf8")
        .replace("__VERSION__", version)
        .replace("__FILES__", JSON.stringify(keep.map((f) => (f === "index.html" ? "./" : `./${f}`))));
      writeFileSync(join(outDir, "sw.js"), sw);
    },
  };
};

/*
  ArduPilot's firmware server sends no CORS headers, so a web page cannot
  download firmware from it directly. The dev and preview servers pass
  /ardupilot-firmware/… on to https://firmware.ardupilot.org/… (only that
  host, read-only GETs), which is how the Firmware page fetches the latest
  stable release. Hosting AERONEX elsewhere needs the same rule; without it
  the page offers the download link and a file picker instead.
*/
const firmwareProxy = {
  "/ardupilot-firmware/": {
    // AERONEX_FIRMWARE_SERVER points it elsewhere, for testing against a copy of the server.
    target: process.env.AERONEX_FIRMWARE_SERVER ?? "https://firmware.ardupilot.org",
    changeOrigin: true,
    secure: true,
    rewrite: (p: string) => p.replace(/^\/ardupilot-firmware/, ""),
  },
};

// https://vite.dev/config/
export default defineConfig({
  base: "./",
  server: { proxy: firmwareProxy },
  preview: { proxy: firmwareProxy },
  plugins: [react(), contentSecurityPolicy(), offlineApp()],
  build: {
    chunkSizeWarningLimit: 1100,
    rolldownOptions: {
      output: {
        advancedChunks: {
          groups: [
            { name: "three", test: /node_modules\/(three|@react-three)/ },
            { name: "react", test: /node_modules\/(react|react-dom|react-router|scheduler)/ },
          ],
        },
      },
    },
  },
});
