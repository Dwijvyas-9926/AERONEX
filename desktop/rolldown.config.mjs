// Bundles the desktop shell (main.cjs, updater.cjs and electron-updater) into
// one file, so the installer carries the updater without node_modules.
import { defineConfig } from "rolldown";

export default defineConfig({
  input: "desktop/main.cjs",
  platform: "node",
  external: ["electron", /^node:/],
  output: { file: "desktop/main.bundle.cjs", format: "cjs", sourcemap: false },
});
