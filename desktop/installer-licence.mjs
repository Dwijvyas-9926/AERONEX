// The installer's licence page shows desktop/build/license.txt: the Apache
// License from LICENSE, with Windows line endings so it reads correctly there.
import { readFileSync, writeFileSync } from "node:fs";

const text = readFileSync("LICENSE", "utf8").replace(/\r?\n/g, "\r\n");
writeFileSync("desktop/build/license.txt", "AERONEX Ground Station\r\nCopyright 2026 Dwij Vyas\r\n\r\n" + text);
