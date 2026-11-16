/*
  The AERONEX manual the assistant answers from.

  Every page's entry starts from the same guide the ? panel shows (GUIDES),
  so the two cannot drift apart, and adds what a guide is too short to hold:
  exact limits, what the page refuses and why, the messages it shows and what
  to do about them. The numbers that matter for safety are read from the code
  that enforces them (the keyboard controller's limits, the fence defaults),
  not copied by hand, so a change there changes what the assistant says.

  The writing follows two rules, because the assistant repeats it as fact:
  only what the code does today, and nothing that sounds like more.
*/
import { GUIDES, type Guide } from "../../app/guide";
import { ROUTES, routeFor } from "../../app/routes";
import { DEFAULT_CONFIG as KF } from "../keyboard-flight/flightController";
import { ACTIONS, DEFAULT_LIMITS, GIVE_UP_M, LIMIT_RANGE, PIXHAWK_FENCE_BYTES } from "../../geo/fence";

export interface ManualTopic {
  id: string;
  title: string;
  /** The page this topic is about, when it is about one. */
  path?: string;
  /** Markdown. */
  body: string;
}

const deg = (rad: number) => Math.round((rad * 180) / Math.PI);
const link = (path: string) => `[${routeFor(path).label}](#${path})`;
const statusOf = (path: string) => {
  const s = routeFor(path).status;
  return s.kind === "ready" ? "Complete" : s.kind === "partial" ? `Working, with limits (${s.note})` : `Planned, not built yet`;
};

function guideText(g: Guide): string {
  const out = [g.purpose];
  if (g.needs.length) out.push(`Before you start:\n${g.needs.map((n) => `- ${n}`).join("\n")}`);
  out.push(`How to use it:\n${g.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`);
  if (g.terms.length) out.push(`Words on the page:\n${g.terms.map(([t, m]) => `- ${t}: ${m}`).join("\n")}`);
  return out.join("\n\n");
}

/* ------------------------------------------------------------------ */
/* Per-page detail, beyond the guide.                                  */
/* ------------------------------------------------------------------ */

const fenceActions = ACTIONS.map((a) => `- ${a.value} ${a.label}: ${a.detail}`).join("\n");

const DETAIL: Record<string, string> = {
  "/": `
- Shows the selected aircraft profile, the link state, a first-flight checklist and the four stages (Design, Set up, Fly, Review). Every page works without the ones before it.
- Lists what this computer supports: Web Serial (needed for hardware; Chrome, Edge or Opera on desktop, on https:// or localhost), WebGL 2 (3D views and the simulator) and the Gamepad API (optional, for the simulator).
- The 3D scene on the Overview is a scripted preview, not live telemetry.`,

  "/frame-studio": `
- Five steps: Aircraft (propeller size, layout, how you fly), Components (motors, flight-controller stack, battery, camera), Material, Review, Make it.
- Layouts are four-motor only: true X (equal arms), stretched X, H, and dead cat (front arms swept out of a camera's view). No hexa or octa layouts.
- "How you fly" (smooth, hard manoeuvres, expect crashes) sets the crash load the arms are sized against. Construction is bolted plates or unibody.
- Materials: carbon fibre plate (3K twill), G10/FR4 glass laminate, aluminium 6061-T6, birch plywood, acrylic (never for arms), and printed PA-CF, PA12-CF, PETG and PLA. Carbon must be cut by a service with dust extraction: the dust is a respiratory hazard and conducts electricity.
- Stack patterns 20 x 20 mm (M2) and 30.5 x 30.5 mm (M3). Camera classes nano 14 mm, micro 19 mm, mini 21 mm, full 28 mm, or none.
- Propeller gap between neighbouring discs: 10 mm is a sensible minimum. Safety factor: 2 is normal, 3 for a first build or an unfamiliar material.
- The motor thrust figure is a representative value for the motor class unless you enter your motor's own thrust table figure. Every result (arm section, weight, hover throttle) follows from it, so a measured value matters most.
- The structural check is classical beam theory over static thrust, a hard-landing load, stiffness and bolt edge distance. It is a sizing check, not finite-element analysis and not certification.
- Review flags: overlapping propeller discs, bolt holes too near an edge, slots into holes, top plate missing arm bolts, arm stress over the allowable, arms too flexible, motor and propeller mismatch, thrust to weight under about 2:1 or very high, a top-mounted pack reaching into the propeller discs, tall standoffs, the mass hanging far below the propellers, battery overhang, strap width, a frame larger than the propellers need.
- Make it: DXF cut files at 1:1 in millimetres (one per stock thickness), the same drawings as SVG, a PDF build report followed by every part at 1:1 (print at 100%, check the printed ruler), one STL per part for printing, a hardware list with bolt lengths worked out from the stack, and a ZIP of everything. Files describe the frame exactly as drawn, faults included.
- A design can be copied into the Flight Simulator's airframe; battery capacity is then estimated from the pack's weight and motor thrust is the class figure.`,

  "/digital-twin": `
- Imports STEP/STP, GLB, glTF, OBJ or STL, up to 80 MB. The file is read in the browser and never uploaded. STEP is converted to a mesh with OpenCascade (WebAssembly), downloaded the first time.
- The model is saved with the active Aircraft Profile, so create a profile first.
- Nose and up controls are a visual correction only; they never change autopilot parameters. The scale is the size in the viewport, not a physical size.
- Modes: Inspect, Scripted flight (a figure-eight), Manual flight (keyboard, kinematic, not physics) and Live (mirrors a linked aircraft's attitude and vertical motion).
- The imported model is also the aircraft drawn in the Flight Simulator's 3D world.
- Needs WebGL 2.`,

  "/vehicle": `
- Fields: name, frame type, flight controller board, firmware, all-up mass (grams), motor-to-motor diagonal (millimetres) and notes.
- Profiles are stored in this browser only; clearing site data removes them. Deleting a profile never changes a flight controller.
- The connected aircraft's heartbeat decides what the app does. If the profile says one firmware and the aircraft reports another, the app trusts the aircraft and says so.
- The simulator uses mass and diagonal. A hexa or octa profile is simulated as a four-motor X, and the simulator says so.`,

  "/connection": `
- Needs Chrome, Edge or Opera on a desktop computer (Web Serial). Firefox and Safari cannot open serial ports. The page must be served over https:// or from localhost (npm run dev).
- USB: 115200 baud is safe; native USB ignores the setting on most boards. Telemetry radio: usually 57600, and it must match the ground radio's serial speed.
- Radio checklist: ground radio on this computer's USB; air radio on TELEM1 (or the configured port); both radios on the same air speed, net ID and band with a solid link light; ArduPilot sends MAVLink on that port (SERIALn_PROTOCOL = 2, SERIALn_BAUD = 57 for 57600).
- After connecting, the app asks for the standard data streams, so attitude, GPS, battery and RC appear within a second or two. The board id and firmware version are read from AUTOPILOT_VERSION (used by Servo Outputs to draw the right board); the firmware family, vehicle type, mode and arming state come from the heartbeat.
- "Bytes arrived but none were valid MAVLink" almost always means the wrong baud rate. "Valid frames, but none from a flight controller" means something else is talking (a radio, a gimbal).
- On its own the app sends only a 1 Hz ground-station heartbeat (ArduPilot's ground-station failsafe depends on it) and requests for telemetry and parameters. Anything that changes the aircraft is sent only when you run it, waits for the aircraft's acknowledgement, and goes only to ArduCopter.
- If heartbeats stop for 3 seconds every value is marked stale. There is no automatic reconnect: press Connect again.
- Disconnecting while armed only closes this app's serial port; the aircraft keeps flying under its own control and failsafes.
- Only serial links: no UDP, TCP or Wi-Fi telemetry, so a companion computer or MAVProxy cannot be linked directly. No MAVLink signing.`,

  "/calibration": `
- Tabs, in order: Accel & Level, Compass, Radio, Flight Modes, ESC, Motor Test. Every one needs a linked ArduCopter flight controller; nothing runs as a demo.
- Every calibration and motor action is refused while armed, and the page locks its controls. A calibration shows success only when the autopilot reports success, never on a timer.
- Accelerometer: the full six-position calibration driven by the autopilot's own prompts (level, left side, right side, nose down, nose up, on its back), the one-shot Level trim on a flat surface, and a gyro re-zero (keep completely still). Reboot after an accelerometer calibration if the autopilot asks.
- Compass: onboard calibration. Turn the aircraft through every orientation (each side pointing down, rotating a full circle each time, then nose up and upside down); the bars fill only as new parts of the sphere are seen. Do it away from the laptop, the USB cable, phones, steel and magnets; outdoors if it will not pass.
- Radio: needs a bound transmitter. Move every stick and switch to its limits, centre the sticks, capture, then save. Channels 1-4 are roll, pitch, throttle and yaw; reverse any that move the wrong way. If a value is not confirmed by the aircraft, the page says which and asks to capture again.
- Flight modes: assign a mode to each mode-switch position (FLTMODE_CH, Copter default channel 5). The live position is highlighted. Simple and Super Simple can be ticked per position.
- ESC: set the ESC protocol and output range (MOT_SPIN_ARM typical 0.10, MOT_SPIN_MIN 0.15, MOT_SPIN_MAX 0.95; DShot needs an output that supports it and a reboot), and run the all-at-once ESC calibration: props off, the button sets calibrate-on-next-boot and reboots, then follow the ESC tones with the battery connected, and power-cycle.
- Motor test: props off, aircraft secured, tick the confirmation. Each motor spins at the chosen throttle for a few seconds and stops by itself if the link is interrupted. Motors are lettered in the firmware's own order (A is the first the firmware lists for the frame); check each spins in the direction marked for its position. On the bench a battery must be connected for motors to turn.
- Completing calibration does not make an aircraft safe to fly; its own pre-arm checks decide. CompassMot and a battery-monitor setup wizard are not in the app yet (set BATT_MONITOR and its scales in Parameters).`,

  "/pid": `
- Shows ArduPilot's standard rate, angle and altitude gains, read live. Nothing is written until Upload; uploaded values apply at once, no reboot.
- Roll and pitch can be staged together (the default for a symmetric quad).
- The advisor maps what you see to a staged change: fast high-pitched wobble (lower rate D first, then rate P; rule out vibration first), slow rocking (lower rate P, then angle P), bouncing up and down (lower Accel Z P and I together, keeping about 2:1), twitchy (lower angle P), sluggish (raise angle P in small steps), nose wag (yaw rate P). Drifting or not holding position is usually compass, GPS or EKF, not PID.
- ArduCopter 4.7 renamed the vertical gains (PSC_D_*) and its acceleration gains are one tenth of 4.6's PSC_ACCZ_P and PSC_ACCZ_I; the page uses the right names and units for the firmware it sees.
- Uploading to an armed aircraft asks for confirmation. Revert goes back.
- It does not run AutoTune and has no log-based step response. To judge tuning from a flight, open its log in Flight Logs: the Attitude charts draw desired against actual roll and pitch.`,

  "/params": `
- The whole parameter list downloads when an aircraft connects; lost messages are asked for again, so it arrives whole even over a radio. "Download every parameter again" refreshes it.
- Every parameter shows ArduPilot's display name, description, units, range, step, named options and bits, and whether it needs a reboot, from the ArduCopter 4.7.2 and 4.6.3 documentation.
- Search understands plain words ("battery low", "return home altitude", "arming") as well as names (MOT_).
- Values are checked before staging: whole numbers only where the setting is a whole number, read-only settings locked, settings written by a calibration flagged ("re-run the calibration"), and an out-of-range value needs an explicit "use this value anyway".
- Edits are staged; Upload writes them and confirms each by the aircraft's echo. Settings that need a reboot are listed, and the page offers to reboot the flight controller (not while armed; over USB the port closes, so press Connect again).
- Save writes a .param file. Load compares a Mission Planner (NAME,VALUE) or QGroundControl file with the aircraft and lists the differences to tick; calibration and ID values start unticked; settings the aircraft does not have are listed apart.
- Writing to an armed aircraft asks for confirmation.`,

  "/preflight": `
- Verdicts: Ready to arm, Caution, Not ready, Waiting for data, Telemetry stale, and Armed.
- The autopilot's own pre-arm result (SYS_STATUS pre-arm bit) comes first, then its "PreArm:" reasons from the last 65 seconds, quoted as it gives them. Then sensor health, the EKF variances, GPS, vibration and battery.
- Not ready if: pre-arm checks are failing, a critical sensor is unhealthy, the EKF variance is past ArduPilot's failsafe line, the battery is low, or vibration is above 60 m/s².
- Caution if: arming checks are turned off, the EKF variance is elevated, the battery is below half or near its low-voltage limit or cannot be graded, vibration is marginal or the accelerometers clipped, or the GPS has no 3D fix (missions and Keyboard Flight need one).
- It mirrors the autopilot's reported health; it never overrides the autopilot, which decides whether it will arm. On the virtual aircraft the verdict says nothing about a real one.`,

  "/flight-data": `
- A primary flight display: artificial horizon with roll and pitch, compass tape, ground speed, climb rate, height above take-off, GPS fix and satellites, voltage and charge.
- Every value is as the aircraft reports it; the display dims when telemetry is more than 3 seconds old.
- The Metric/Imperial setting applies here (and on Connection only).
- There is no map on this page yet.`,

  "/keyboard-flight": `
- ArduCopter only, and the flight controller must be linked (real or virtual). The autopilot flies in GUIDED mode; the keys only ask it for a velocity.
- Limits, all enforced by the app's controller: take-off to ${KF.takeoffAlt} m; horizontal speed at most ${KF.maxHoriz} m/s, ramped at ${KF.horizAccel} m/s²; climb at most ${KF.maxClimb} m/s; turn at most about ${deg(KF.maxYawRate)}°/s; ceiling ${KF.maxAlt} m above take-off, braking early so it stops at the ceiling; range ${KF.maxRange} m from the take-off point, braking early, and flying back towards the take-off point is always allowed. These limits are fixed; there is no setting to raise them.
- There is no key to descend. Height only goes up (hold T) or holds; to come down press L, which lands.
- Without a fresh position and heading from the aircraft (younger than 3 seconds) there is no horizontal motion at all; the log says so.
- The checklist must be all green before T does anything: link connected, ArduCopter, GPS 3D fix, disarmed on the ground, the land-on-disconnect failsafe set (press Set: it writes FS_GCS_ENABLE = 5, Land, on every visit to the page), and the box "Props are on, the area is clear of people, and I'm ready to fly a real drone" ticked.
- T on the ground: switches to GUIDED, arms, waits up to 4 s to see it armed, then takes off to ${KF.takeoffAlt} m. At ${Math.round(KF.takeoffAlt * 0.9 * 10) / 10} m (90% of the take-off height) "you have control". If GUIDED or arming is refused, the reason is logged (GUIDED usually needs a GPS fix and passing pre-arm checks) and it lands if it had armed.
- Keys: W forward, S back, A left, D right (all relative to the nose), Q turn left, E turn right, T climb (in the air), L land and disarm on the ground, Space hold (brake to a hover). Releasing a key ramps that motion back to zero and the aircraft holds position.
- Buttons: Hold, Land, Return home (RTL: climbs to the return height, flies to home and lands) and Disarm. Disarm cuts the motors at once: in the air the aircraft falls. Use it only on the ground or as a last resort.
- Safety behaviour: the controls window opens every visit and keys do nothing while it is open; key combinations with Ctrl, Alt or ⌘ (browser shortcuts) and typing in a field are ignored; if the browser tab loses focus or is hidden, motion stops and it holds; leaving the page in the air tells it to land; if the link is lost the app stops sending and the aircraft's own ground-station failsafe takes over (Land, if Set was pressed); if someone changes mode on the radio, keyboard control lets go at once; if a land command is not taken it is re-sent every 1.5 s, and after 4 tries the log says to take over on the radio.
- Arm, mode and take-off commands are re-sent up to twice, 1.5 s apart, when no acknowledgement comes.
- In practice a real flight needs a telemetry radio, not a USB cable. Whether ArduCopter will arm with no RC receiver depends on its own pre-arm and radio-failsafe settings; the reason shows on Preflight Check. A bound RC transmitter as a backup pilot is strongly recommended.
- Rehearse on the virtual aircraft first: start it in the Flight Simulator, then open Keyboard Flight; the same keys fly it.`,

  "/simulator": `
- The virtual aircraft is a model of ArduCopter written from its documentation: 6-DOF physics (weight, thrust, motor lag, drag, wind and gusts, a battery that sags and runs down), ArduCopter's control loops, flight modes, arming checks and failsafes, driven by its parameters under their real names. It is not the firmware: no obstacles, no sensor noise, four-motor X only.
- Once started, the status bar reads Virtual aircraft and every page treats it as a connected aircraft (Preflight Check, Flight Data, Parameters, Keyboard Flight, Drone Doctor, Mission Planning). Exports made from it are marked as simulated.
- A real aircraft must be disconnected first: the app talks to one aircraft at a time.
- Airframe: copy from the Aircraft Profile (mass and diagonal) or a Frame Studio design, or type it in: weight, size, thrust of one motor at full throttle, propeller, cells, capacity. It warns if it cannot lift (thrust under weight), if thrust to weight is under 2:1 or implausibly high, or if the battery gives under three minutes. Changing the airframe restarts it on the ground at home.
- "Use the settings from my real aircraft" applies the parameters remembered from the last real aircraft connected, where the simulator models them; the rest start at ArduCopter's defaults.
- Landscape: a practice field, or the real ground around the home set in Mission Planning (needs the internet or a saved area). The aircraft collides with the ground; trees are scenery only, buildings and water are not modelled.
- Controls: Take off to 2-120 m, Fly the mission (planned in Mission Planning), Hold (BRAKE), Return (RTL), Land, and Put it back at home after a crash. Time: pause, 1x, 2x, 5x, 10x. Views: 3D world or Map; cameras Chase, Orbit, Ground, Top and Onboard.
- Faults and wind: each motor steps through 100%, 60% and 0% thrust; lose GPS; lose the radio transmitter; cut this app's heartbeat (what the ground-station failsafe watches); wind speed, direction and gust. A quadcopter cannot fly on three motors.
- Parameters changed on the Parameters page take effect at once, without restarting.
- The Scenic demo is a separate scripted flight to watch. It is not physics-based and not connected to the rest of the app.`,

  "/missions": `
- Map: Real map (satellite or other pictures over measured ground) or the practice field. Home follows a linked aircraft's GPS position and cannot be moved while it is linked; with no aircraft, use the home button. Click to add a waypoint, drag to move, arrows to reorder, Ctrl+Z to undo.
- Each waypoint has a height above home (not above the ground below it) and an optional wait. Endings: return home (climbs to RTL_ALT or stays higher if already higher, flies home, lands), land at the last waypoint, or hover at the last waypoint (nothing lands it; you must take over).
- Mission items sent: take-off, waypoints with waits, and the ending. Heights are relative to home only (no terrain-following, no absolute heights). Speed changes, region of interest, camera triggers, spline waypoints, loiter turns, DO_LAND_START and jumps are not planned; when a mission read from an aircraft or a file contains them, they are named and dropped.
- Ground data is about 30 m detail, typically right to 10 m, reaches about 15 km from home, and knows nothing of trees, buildings or wires: add their height yourself. The height profile shows the ground along the whole route.
- Plan check warns about: route below or near the ground, ground data not reaching a waypoint, flight time against the hover endurance, no low-battery failsafe (BATT_FS_LOW_ACT with BATT_LOW_VOLT or BATT_LOW_MAH), climbing above 120 m (check local law), farther than about 500 m (visual line of sight), return height raised by the last waypoint, and a hover ending.
- Predict: set the wind, the battery charge, and optionally what goes wrong (a motor loses thrust, GPS is lost, the radio transmitter is lost, this app loses the link) and when (on reaching a waypoint, or seconds after arming). The prediction flies the mission on the virtual aircraft's model with the aircraft's own settings, and reports how it ended, battery used, failsafes that fired, and settings to fix. It is a strong hint, not a promise (checked against ArduCopter 4.6 and 4.7 to within 15% on flight time).
- Sending a mission: asks first, then sends and reads the whole mission back and compares it item by item; it is not reported as sent until it reads back the same. Refused for a non-ArduCopter aircraft, for a real aircraft without a GPS 3D fix, and while the aircraft is armed ("Disarm before changing the mission"). On a real aircraft AERONEX sends and checks the mission but does not start it: arm and switch to AUTO from the transmitter or another ground station.
- Files: .waypoints (QGC WPL 110) open and save, readable by Mission Planner and QGroundControl. QGroundControl's .plan (JSON) is not supported.
- Offline: Layers > save the area for the field before going there; some picture providers do not allow saving, the ground heights always save. Map pictures: satellite with an open licence, satellite 2024 (non-commercial use), street map, sharp satellite (Esri World Imagery), sharp satellite with your MapTiler key, or another provider's tile address.
- Read the mission loads the aircraft's own mission into the plan. "Fly it live in the simulator" appears only while the virtual aircraft is linked: it sends the mission, arms and starts it there.
- No rally points.

Fence tab (geofence):
- Limits: on or off (FENCE_ENABLE, default ${DEFAULT_LIMITS.FENCE_ENABLE}); which kinds are used (FENCE_TYPE: ceiling, distance from home, zones, floor; default ${DEFAULT_LIMITS.FENCE_TYPE} = ceiling + circle + zones); ceiling FENCE_ALT_MAX (default ${DEFAULT_LIMITS.FENCE_ALT_MAX} m above home, ${LIMIT_RANGE.FENCE_ALT_MAX[0]}-${LIMIT_RANGE.FENCE_ALT_MAX[1]} m); floor FENCE_ALT_MIN (default ${DEFAULT_LIMITS.FENCE_ALT_MIN} m; it only switches on once the aircraft has climbed above it plus the margin, and is off for landing); distance from home FENCE_RADIUS (default ${DEFAULT_LIMITS.FENCE_RADIUS} m, ${LIMIT_RANGE.FENCE_RADIUS[0]}-${LIMIT_RANGE.FENCE_RADIUS[1]} m); margin FENCE_MARGIN (default ${DEFAULT_LIMITS.FENCE_MARGIN} m); and "Inside any keep-in zone is enough" (FENCE_OPTIONS bit 1, union of keep-in zones).
- Breach actions (FENCE_ACTION):
${fenceActions}
  More than ${GIVE_UP_M} m outside the fence ArduCopter lands instead, whatever is chosen. A return home is flown no higher than the ceiling less its margin.
- Zones: keep-in or keep-out, polygon (3 or more corners) or circle. Draw on the map (click each corner, click the first corner or press Enter to finish; Esc cancels), drag corners, click + on an edge to add a corner, right-click a corner to remove it. "A keep-in area round home and every waypoint" draws one with room to spare. Undo and redo cover fence edits.
- Fence check: says what ArduCopter would refuse to arm with, in its own words ("Fences enabled, but none selected", "Vehicle breaching Polygon fence", "Circle FENCE_MARGIN is greater than FENCE_RADIUS", "FENCE_ALT_MAX < FENCE_ALT_MIN", "FENCE_MARGIN too big", invalid ceiling or floor), where the route would breach and how far past the zone it would be before it stops (from its speed and braking), routes passing inside the margin, a straight return home crossing a zone, waypoints outside the distance limit or below the floor, and a return height above the ceiling.
- Storage: a Pixhawk holds about ${PIXHAWK_FENCE_BYTES} bytes of fence (a few polygons); the check says when a fence is too big unless BRD_SD_FENCE gives it room on the SD card.
- Sending the fence: asks first on a real aircraft, refused while armed ("Disarm before changing the fence"). Order: turn the fence off first if it is being turned off; send the zones and read them back after a short settle; write the other FENCE_ settings, each confirmed; turn the fence on last. Any failure stops there and says which step. Read replaces the plan's fence with the aircraft's (Undo brings yours back). The aircraft's fence is read automatically once per connection.
- The prediction and the mission's send dialog use the fence on the Fence tab, and say so when it differs from the aircraft's.`,

  "/firmware": `
- Installs ArduPilot's ArduCopter firmware (Multicopter, or Helicopter: the -heli build) over the flight controller's own USB port, in Chrome or Edge on a computer (Web Serial). Only stable releases are offered, downloaded from firmware.ardupilot.org (Copter/stable/<board>/): the release must say FIRMWARE_VERSION_TYPE_OFFICIAL or it is refused. A .apj file can be installed under Advanced (checked the same way, but not known to be stable).
- Getting to the bootloader: linked over USB and disarmed, "Restart into bootloader" sends MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN with param1 = 3, which keeps the bootloader waiting. Otherwise "Find the board": unplug USB, click, plug in, choose the board in Chrome's list; a board running ArduPilot is told to restart into its bootloader (ArduPilot refuses while armed). The bootloader is a separate USB device (often named with BL); the first time it must be chosen in the list too ("Choose the bootloader"), after that AERONEX opens it by itself. "Wait for a board I have used before" catches a previously chosen board as it is plugged in.
- It reads the board id, board revision, flash size, external flash, processor id and revision and serial number from the bootloader (protocol 2-5), and picks the build ArduPilot makes for that board id (316 boards known), using the bootloader's USB id where several boards share an id (CubePilot, Holybro…). Pixhawk1 family (Pixhawk 2.4.8 and clones, board id 9): Pixhawk1 when the STM32F427 can use 2 MB, Pixhawk1-1M when it is an early revision with the 1 MB flaw (ST errata), when the bootloader offers 1 MB, or when the bootloader is too old to report the revision. Other builds for the board (-bdshot etc.) can be chosen; SimOnHardWare builds are never picked.
- Before installing it refuses firmware for another board id (except ids ArduPilot marks compatible), firmware larger than the board's flash (suggesting -1M for the Pixhawk1 family), and firmware with an external-flash part on a board without one.
- Install: identify again, external flash first if the firmware has one, erase (about 10 s), write in 252-byte blocks, verify by the board's CRC of its whole flash against the file's (a read-back on protocol 2), then start it. About half a minute. The bootloader is never touched, so a stopped or failed install leaves the board in its bootloader and it can be installed again. Parameters are kept (stored apart from the firmware).
- The firmware server does not allow browsers to download directly; AERONEX downloads through its own dev/preview server (npm run dev / npm run preview). Hosted elsewhere it links to the file to download and install from a file.
- No bootloader update, no DFU, no PX4 firmware, and not over a telemetry radio. The How to install tab is a full guide with troubleshooting (Linux dialout group and ModemManager, cables, hubs).`,

  "/servo": `
- Shows every output of the flight controller and what it does (SERVOn_FUNCTION), live (SERVO_OUTPUT_RAW). On a Pixhawk 2.4.8 (board id 9, from AUTOPILOT_VERSION, or the aircraft profile) it draws the board and its servo rail: RC IN, SB, MAIN OUT 1-8 and AUX OUT 1-6, each a column of signal, + and − pins, with rate groups bracketed. Other boards: the outputs in ArduPilot's order with their timer groups (from ArduPilot's hwdef files, 312 boards). The virtual aircraft is laid out like a Pixhawk 2.4.8.
- Per output, by task: Payload release (gripper, function 28), A transmitter channel (pass-through 51-66 exact, or 140-155 scaled into the output's MIN/TRIM/MAX; exact ignores the output's limits), Mission or button (Disabled, 0: moved only by DO_SET_SERVO), Something else (camera shutter 10, gimbal 6/7/8, landing gear 29, parachute 27, sprayer 22/23, winch 88, motors, fixed signals, GPIO -1, scripting, any firmware function). Motor outputs are locked until "Change this output".
- Range: lowest, centre, highest (SERVOn_MIN/TRIM/MAX) and reversed. Test: move the output to a pulse (DO_SET_SERVO), which ArduPilot allows only on Disabled, gripper, sprayer and pass-through outputs; otherwise it answers "Channel n is already in use", and the page says so. Confirmed when armed.
- Payload release setup: closed (GRIP_GRAB, default 1900), open (GRIP_RELEASE, 1100), resting (GRIP_NEUTRAL, 1500), close-again time (GRIP_AUTOCLOSE). Saving writes the output's function and GRIP_ENABLE = 1 first; the other GRIP_ settings then appear and are written; GRIP_TYPE = 1 (servo). The gripper starts only after a restart: before it ArduPilot accepts DO_GRIPPER and nothing moves, so Release and Close check the output reached the position and say "restart" if not. A transmitter switch: RCn_OPTION = 19; switch low releases, high grabs, middle does nothing. Missions: DO_GRIPPER (0 release, 1 grab), not yet added by AERONEX's mission planner.
- Transmitter switches card: payload release (19), landing gear (29, low lowers, needs LGR_ENABLE), camera shutter (9, high takes a picture), parachute release (22) and on/off (21). "Find it: flip the switch" picks the channel that moves. Channels that fly the aircraft (RCMAP_ROLL/PITCH/THROTTLE/YAW, FLTMODE_CH) cannot be given a switch option here.
- Checks: a frame motor with no output or on two; a servo sharing a rate group with a motor (runs at RC_SPEED, 490 Hz by default, which can burn an analog servo; with OneShot/DShot motors it cannot drive a servo at all); pass-through on a stick or the flight-mode channel, or a channel the receiver does not send; gripper output without GRIP_ENABLE, GRIP_TYPE not servo, grab = release; a switch option on a flying channel; an output that is also a relay pin (RELAYn_PIN; AUX 1-6 are pins 50-55 on a Pixhawk); MIN not below MAX, TRIM outside, pulses beyond 800-2200 µs; outputs held still by the safety switch (BRD_SAFETY_DEFLT, BRD_SAFETY_MASK).
- Changes are held until "Save to flight controller", each confirmed by the aircraft's echo; output functions, GRIP_ENABLE/TYPE and MOT_PWM_TYPE ask for a restart. Checked against ArduCopter 4.7.2 and 4.6.3 (SITL): Disabled output moves to the pulse sent; motor output refused with ArduPilot's words; exact and scaled pass-through; gripper accepted-but-still before the restart, then release/grab and switch low/high at exactly the positions set.
- The servo rail's + pins are not powered by a Pixhawk: feed 5-6 V from a BEC.`,

  "/doctor": `
- Re-scans every 1.5 s and lists findings most serious first, each with the measured value, the likely cause, the fix and a link to the page that fixes it. Healthy checks are collapsed at the bottom.
- Eight areas: vibration (under 30 m/s² healthy, 30-60 marginal, over 60 a problem; any rising clip count), state estimate (EKF variances; failsafe line FS_EKF_THRESH, default 0.8), compass (offsets over about 600 mGauss mean interference; COMPASS_USE 0), GPS (fix type, satellites, aim for 10+, HDOP), power (BATT_MONITOR 0, pack voltage per cell), sensors (present but unhealthy), configuration (arming checks off via ARMING_CHECK before 4.7 or ARMING_SKIPCHK from 4.7, FRAME_CLASS 0, hover throttle MOT_THST_HOVER very low or above about 0.55), and pre-arm messages with their usual cause.
- Indoors, GPS and compass findings are expected. It never overrides the aircraft's own pre-arm checks.
- The AI questions that used to be asked on this page go to the AERONEX Assistant, which sees the same findings.`,

  "/telemetry": `
- Messages: every kind of MAVLink message arriving and its rate in Hz; zero means the aircraft stopped sending it.
- Link: time since the last heartbeat, and damaged (CRC) messages; a few on a radio are normal, many mean a poor link.
- Events and vehicle messages: the aircraft's own status texts (including PreArm reasons) in order, and the raw frame stream.
- Every link session (a real aircraft or the virtual one) is recorded as a .tlog in the Flight Logs library, unless "Record telemetry logs" is off in Settings.`,

  "/logs": `
- Opens ArduPilot DataFlash logs (.bin, the aircraft's on-board log, any ArduPilot version that writes FMT/FMTU) and MAVLink telemetry logs (.tlog, from Mission Planner, QGroundControl, MAVProxy or AERONEX). Read in the browser, never uploaded. Not PX4 .ulg.
- Three ways in: drop or choose a file; the log library (kept in this browser: every link session is recorded there as a .tlog automatically, plus logs opened or downloaded); or Logs on the aircraft: with the aircraft connected over MAVLink and disarmed, List logs, then Download (LOG_REQUEST protocol; lost pieces are re-requested, the log opens only when complete). Over USB a large log takes a minute or two, over a telemetry radio much longer. Erase all deletes every log on the card after a confirmation.
- Report: a verdict (Problems found / Worth a look / No problems found), summary tiles (time in the air, distance, highest, farthest, top speed, battery used and lowest voltage), a strip of modes, armed and flying time with findings pinned, then each finding: what was measured, the limit, what to do, Show on chart, Replay from here and the ArduPilot guide. "Every check" lists all 15 checks with what each measured, including ones skipped because the log lacks the data.
- The checks (flying time only, take-off and touchdown trimmed): log integrity; log ends while flying (on a .bin: likely power loss/brownout; on a .tlog: the link or recording may simply have stopped); crash and thrust loss (ERR 12 and 25, the autopilot's own messages, ending tilted over 60°); attitude tracking (desired vs actual roll/pitch: more than 30° off for 1 s = control lost, over 10° for 1 s = warning); motors (a motor within 2% of full output for 2 s, outputs differing by more than 20% of range, hover throttle above 75%); vibration per IMU (95th percentile: over 30 m/s² warning, over 60 problem) and clipping (any in flight is a warning, 100 or more a problem); compass (field 120–550 mGauss on the ground, interference with motor current or throttle: over 30% warning, over 60% problem, as compassmot); GPS (fix lost, fewer than 6 satellites a problem, fewer than 10 a warning, HDOP over 2.0, glitches); EKF test ratios (above 1 for 1 s = rejected, above FS_EKF_THRESH warning, lane switches, EKF failsafe); battery (below 3.3 V a cell a problem, 3.5 a warning, sag over 0.5 V a cell, over 80%/90% of BATT_CAPACITY used, no current sensor); board voltage outside 4.3–5.8 V or varying over 0.3 V, peripheral over-current; processor load over 90%, slow loops, dropped log messages; every ERR code and failsafe mode change decoded; altitude more than 3 m off target for 3 s; settings (pre-arm checks off, radio failsafe off, low battery does nothing, harmonic notch off, settings changed while armed).
- A .tlog has fewer samples and no desired altitude or per-IMU detail; checks that need those say so. Checks are written for ArduCopter; other vehicles' logs open, with a note.
- Charts: sets for attitude (with desired, dashed), altitude, motors, vibration (30 and 60 lines), clipping, battery, compass, GPS, EKF, board power and processor; search adds any field of any message. All charts share one time window and cursor: drag pans, scroll zooms, double-click shows the whole log, arrow keys step; mode bands shaded, events and errors as lines. Spikes are never thinned away when zoomed out.
- Replay: the logged flight in the 3D world (level ground, home at the log's home) with the flight display, battery, satellites, distance and the map with the flown path; play, pause, 0.5–20×, scrub, jump to findings; space plays/pauses and arrow keys step. The time is shared with Charts.
- Events: every mode change (with the reason, on a .bin), arming, event, decoded error and autopilot message, filterable. Parameters: search, values not at default (4.7 logs record defaults), changed during the log, and differences from the connected aircraft; save as .param. All data: every message type and field, rows from the cursor, CSV export.
- Export: report (Markdown), flight path (KML for Google Earth), parameters (.param), or the log itself from the library.`,

  "/about": `
- Explains the workflow, the safety design (ArduCopter only, no settings changed in flight without confirmation, the autopilot's own pre-arm checks, Keyboard Flight's limits, missions checked and read back) and how the app is tested (unit tests plus ArduPilot's own SITL build of ArduCopter 4.6 and 4.7).
- AERONEX is conceived, designed and engineered by Dwij Vyas.`,

  "/settings": `
- Motion (system, reduced, full), graphics quality (low, medium, high, ultra), units (Metric or Imperial; applies to Flight Data and Connection only; everything else is metric, as ArduPilot is).
- Assistant: the Anthropic API key, the model, and whether it may search the web. The key is sent only to Anthropic; AERONEX has no server. It is kept until the tab closes unless "Remember keys on this device" is on (leave it off on a shared computer).
- Reset app data removes everything AERONEX keeps in this browser: profiles, settings, keys, frame designs, the mission plan, imported models, saved map areas and the flight-log library. Nothing on a flight controller changes.
- Record telemetry logs: on by default; keeps a .tlog of every link session in the Flight Logs library.`,
};

/* ------------------------------------------------------------------ */
/* Cross-cutting topics.                                               */
/* ------------------------------------------------------------------ */

const pageList = ROUTES.map((r) => `- ${link(r.path)}: ${r.blurb} Status: ${statusOf(r.path)}.`).join("\n");

const TOPICS: ManualTopic[] = [
  {
    id: "aeronex",
    title: "What AERONEX is",
    body: `AERONEX is a ground control station for ArduCopter multicopters that runs in a web browser. It takes an aircraft from a frame design to a calibrated, checked aircraft, flies it and diagnoses it. It links to the flight controller over a USB cable or a telemetry radio (MAVLink 1 and 2, every frame checked against its checksum), needs nothing installed, and has a virtual aircraft so every page can be learned with no hardware.

- Hardware needs Chrome, Edge or Opera on a desktop computer (Web Serial), on https:// or localhost. Everything else works in any modern browser.
- It runs entirely on this computer. There is no AERONEX server and no account. Aircraft data never leaves the computer, except what the assistant sends to Anthropic when asked a question.
- Commands (arm, modes, take-off, missions, fence, motor tests, calibration) go only to a multicopter running ArduCopter. PX4, ArduPlane, Rover and others are shown and read, never commanded.
- Tested with unit tests and against ArduPilot's own SITL build of ArduCopter 4.6 and 4.7. It is not flight-certified; before a first real flight do a props-off bench check of connection, Preflight verdict, a parameter write, the motor test and a mission send and read-back on the real aircraft.
- Keys anywhere: Ctrl/⌘ K searches pages, ? opens the page guide, Ctrl/⌘ J opens the assistant.

Pages:
${pageList}`,
  },
  {
    id: "limits",
    title: "What AERONEX cannot do (yet)",
    body: `Say so plainly when asked for any of these, and point to what does it today.
- Installing firmware: only ArduCopter (multicopter and helicopter) stable releases are offered; other vehicles, beta and daily builds only by installing a .apj file. No bootloader update and no DFU (boards without an ArduPilot-compatible bootloader need ArduPilot's DFU method once). Not over a telemetry radio.
- Command PX4, ArduPlane, ArduRover or ArduSub: read-only. Missions, Keyboard Flight, calibration and motor tests are ArduCopter only.
- Flight logs: PX4 .ulg logs are not read (Flight Logs reads ArduPilot .bin and MAVLink .tlog). No log-based PID tuning or step-response analysis, and no FFT of the IMU (set up the harmonic notch with ArduPilot's own Filter Review tool). Log download needs a MAVLink link; logs on the SD card can also be copied from its APM/LOGS folder.
- Links other than serial: no UDP, TCP, Wi-Fi or WebSocket, so no direct companion-computer or MAVProxy connection. No MAVLink signing. One aircraft at a time.
- Missions: only take-off, waypoints with waits, and a return/land/hover ending, heights above home. No survey grids, terrain following, speed changes, ROI, camera triggers, splines, loiter turns, jumps, rally points or QGroundControl .plan files.
- Tuning: no AutoTune run and no log-based tuning. No CompassMot, no battery-monitor wizard.
- Servo Outputs: servo payloads (gripper) only, not the electro-permanent magnet gripper; no relay setup page (RELAYn_PIN is checked for conflicts); no winch, sprayer, parachute or camera setup beyond choosing the output (their own settings are on the Parameters page); no servo or gripper steps in AERONEX missions yet.
- Frame Studio and the simulator: four-motor layouts only. Digital Twin flight is a visual preview, not physics.
- The Metric/Imperial setting changes only Flight Data and Connection.
- It cannot see video, read a log file, or see the aircraft beyond what its telemetry says.`,
  },
  {
    id: "safety",
    title: "Safety built into AERONEX",
    body: `- ArduCopter only: every command checks the linked vehicle first and refuses others with "AERONEX flies ArduCopter only". Disarming is always allowed.
- Commands wait for the aircraft's acknowledgement; arm, mode and take-off are re-sent up to twice when none comes. A refusal is reported in words, never assumed to have worked. Calibrations, reboots and mission start are never re-sent.
- Nothing is written to an armed aircraft without a confirmation; calibration and motor-test controls are locked while armed; motor actions need a props-off confirmation and stop by themselves if the link is interrupted.
- Missions and fences are read back and compared before they are reported as sent; missions need a GPS 3D fix on a real aircraft and are refused while armed.
- The app sends a 1 Hz ground-station heartbeat while linked. If the tab closes or the link drops it stops, which is what triggers the aircraft's ground-station failsafe, if FS_GCS_ENABLE is set.
- Simulated data is always labelled (status bar, banners, exported files).

Rules for any real aircraft: propellers off for anything on the bench (calibrations, motor test, ESC setup, first power-up after wiring changes); fly in an open area away from people, roads and buildings; keep it in sight; follow local aviation law (many countries limit small aircraft to 120 m above ground and require registration); never disable arming checks for flight; set battery and link-loss failsafes; charge and store LiPo packs on a fireproof surface, never puncture or over-discharge one (land at about 3.5 V per cell under load).`,
  },
  {
    id: "first-flight",
    title: "Workflow: a new ArduCopter quad from first power-up to first flight",
    body: `1. Firmware: ${link("/firmware")} installs the latest stable ArduCopter over USB and picks the build for the board (for a Pixhawk 2.4.8, Pixhawk1 or Pixhawk1-1M from the processor revision).
2. Link: ${link("/connection")} over USB (115200).
3. Frame: in ${link("/params")} set FRAME_CLASS (1 = Quad) and FRAME_TYPE (1 = X for most quads), then reboot.
4. Calibrate in ${link("/calibration")}, props off: Accel & Level, Compass, Radio, Flight Modes, ESC.
5. Motor Test (props off, battery connected): each motor in the firmware's order spins the right way.
6. Failsafes in ${link("/params")}: battery (BATT_MONITOR, BATT_LOW_VOLT, BATT_FS_LOW_ACT, BATT_CRT_VOLT, BATT_FS_CRT_ACT), radio (FS_THR_ENABLE), ground station (FS_GCS_ENABLE), and a geofence in ${link("/missions")}.
7. Check: ${link("/preflight")} outdoors with a GPS 3D fix, and ${link("/doctor")}.
8. Rehearse on the virtual aircraft in ${link("/simulator")}, with your aircraft's settings.
9. First flight: props on, open field, a short low hover in a self-levelling mode (Stabilize or AltHold on the RC transmitter), or a hop with ${link("/keyboard-flight")}. Land, then check ${link("/doctor")} for vibration.`,
  },
  {
    id: "keyboard-howto",
    title: "Workflow: fly with Keyboard Flight",
    body: `1. Rehearse first: ${link("/simulator")} > Start the virtual aircraft, then fly it from ${link("/keyboard-flight")} with the same keys.
2. Real aircraft: ArduCopter, calibrated, failsafes set, props on, outdoors in an open area clear of people. Link it with a telemetry radio (a USB cable tethers it). Wait for a GPS 3D fix.
3. Open ${link("/keyboard-flight")}. Read the controls window and close it ("Got it").
4. Work the checklist: link connected, ArduCopter, GPS 3D fix, disarmed, press Set for the land-on-disconnect failsafe (FS_GCS_ENABLE = 5), tick the confirmation. It must say Ready.
5. Press T. It switches to GUIDED, arms and climbs to ${KF.takeoffAlt} m; the log says when you have control.
6. Fly: W/S forward and back, A/D left and right, Q/E turn, hold T to climb. At most ${KF.maxHoriz} m/s, ${KF.maxAlt} m up, ${KF.maxRange} m from the take-off point. Let go of every key and it holds.
7. Space holds at any time. Return home flies back and lands. Keep the tab focused: losing focus holds it.
8. Press L to land; it disarms on the ground. Disarm is for the ground or a last resort only.
If T does nothing, the checklist is not complete. If the log says GUIDED or arming was rejected, open ${link("/preflight")} for the autopilot's reason.`,
  },
  {
    id: "mission-howto",
    title: "Workflow: plan, check and fly a mission",
    body: `1. ${link("/missions")} > Real map. Link the aircraft outdoors so home goes to its GPS position (or place home by hand).
2. Click to place waypoints, set heights and waits, choose the ending (return home is the usual one).
3. Read the height profile and the plan check; fix anything red.
4. Fence tab: draw a keep-in area round the route ("A keep-in area round home and every waypoint"), set the ceiling and the action, check it, and send it.
5. Predict tab: set the wind and battery, try a failure, press Predict the flight. Fix and predict again.
6. Rehearse: "Fly it live in the simulator", or Fly the mission in ${link("/simulator")}.
7. Send the mission (disarmed, GPS 3D fix). It is read back and compared.
8. Fly: arm and start it the usual way (AUTO mode from the transmitter, or Mission Planner/QGroundControl). AERONEX sends and checks missions; on a real aircraft it does not start them.`,
  },
  {
    id: "troubleshooting",
    title: "Common problems in AERONEX and what to do",
    body: `- "Can't talk to serial devices": use Chrome, Edge or Opera on desktop; open the app from localhost (npm run dev) or https.
- No device in the browser's list: a charge-only USB cable, a missing driver (Windows, some radios), or another program (Mission Planner, QGroundControl) holding the port; close it.
- Connected but nothing arrives / "bytes but no valid MAVLink": wrong baud rate (USB 115200, radio 57600); for a radio, check the air radio's port has SERIALn_PROTOCOL = 2.
- Values go grey: no update for 3 s; the link is poor or lost.
- The aircraft will not arm: ${link("/preflight")} quotes the autopilot's own PreArm reason; ${link("/doctor")} explains common ones (compass not calibrated, accelerometer needs calibration, GPS/EKF not ready, RC not calibrated, battery below arming voltage, barometer). Fix the cause; never disable arming checks for flight.
- "AERONEX flies ArduCopter only": the aircraft reports another firmware or vehicle type. Commands stay blocked; check FRAME_CLASS on an ArduCopter build, or use that firmware's own ground station.
- Keyboard Flight T does nothing: the checklist is not complete (often the failsafe Set or the confirmation box).
- Mission send refused: no GPS 3D fix, armed, or not ArduCopter. "Does not hold what was sent": send again and do not fly until it reads back the same.
- Compass calibration stuck: rotate through every orientation, especially nose up and upside down, away from metal and the laptop; try outdoors.
- Motors do not spin in Motor Test: battery connected, props off; on boards with a safety switch, press it until solid (or BRD_SAFETY_DEFLT = 0).
- The map is blank offline: save the area beforehand in Layers.
- The assistant says the key was rejected: paste it again in ${link("/settings")}; a model "not available" error means choose another model there.`,
  },
  {
    id: "assistant",
    title: "The AERONEX Assistant itself",
    body: `- Opens from the Ask button in the top bar or Ctrl/⌘ J, on every page. It knows this manual and, if allowed, sees a read-only snapshot of the linked aircraft and the page you are on.
- It cannot press buttons, change settings or fly the aircraft.
- It uses your own Anthropic API key (${link("/settings")}). Anthropic bills it per use; AERONEX has no server. Web search, when allowed in Settings, is billed by Anthropic per search.
- What is sent with a question: the conversation, this manual, the page name, and, if "Share aircraft data" is on, the aircraft's firmware family, mode, arming state, health readings, a few settings, Preflight and Doctor results, and the mission and fence summary. Never its position.
- Without a key it searches this manual on the computer and shows the matching sections.`,
  },
];

/** Every topic: the cross-cutting ones, then one per page in menu order. */
export const MANUAL: ManualTopic[] = [
  ...TOPICS,
  ...ROUTES.map((r) => ({
    id: `page:${r.path}`,
    title: `${r.label} page (${r.path === "/" ? "#/" : `#${r.path}`})`,
    path: r.path,
    body: `Status: ${statusOf(r.path)}.\n\n${guideText(GUIDES[r.path])}\n\nDetails:${(DETAIL[r.path] ?? "").trimEnd()}`,
  })),
];

/** The manual as one document, as the assistant reads it. */
export function manualText(): string {
  return MANUAL.map((t) => `## ${t.title}\n\n${t.body.trim()}`).join("\n\n");
}

/** Detail written for these pages; tests check every route has some. */
export const DETAILED_PATHS = Object.keys(DETAIL);
