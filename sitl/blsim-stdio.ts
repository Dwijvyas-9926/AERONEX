/*
  The simulated bootloader on stdin/stdout, so ArduPilot's own uploader.py
  can be pointed at it through a pseudo-terminal (sitl/firmware.test.ts).
  Options come as JSON in argv[2]; when the host reboots it, the flash image
  is written to argv[3].
*/
import { writeFileSync } from "node:fs";
import { SimBootloader } from "../src/firmware/__tests__/blsim";

const sim = new SimBootloader(JSON.parse(process.argv[2] ?? "{}"));
sim.onOutput = () => {
  if (sim.out.length) process.stdout.write(Uint8Array.from(sim.out.splice(0)));
};
process.stdin.on("data", (b: Buffer) => {
  sim.input(new Uint8Array(b));
  if (sim.booted) {
    writeFileSync(process.argv[3], sim.flash);
    setTimeout(() => process.exit(0), 50);
  }
});
