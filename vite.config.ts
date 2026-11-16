import react from "@vitejs/plugin-react";
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

const contentSecurityPolicy = (): Plugin => ({
  name: "aeronex-csp",
  apply: "build",
  transformIndexHtml: (html) => {
    const at = '<meta charset="UTF-8" />';
    if (!html.includes(at)) throw new Error("index.html: charset meta not found; the security policy goes after it.");
    return html.replace(at, `${at}\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
  },
});

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
  plugins: [react(), contentSecurityPolicy()],
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
