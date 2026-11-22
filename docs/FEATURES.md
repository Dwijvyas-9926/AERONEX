# AERONEX features

What each part of AERONEX does today, and what it does not. The app says the
same on each page.

## Contents

- [Supported hardware](#supported-hardware)
- [Modules](#modules)
- [Maps and ground heights](#maps-and-ground-heights)
- [Safety](#safety)

## Supported hardware

Designed for **Pixhawk 2.4.8**, **Holybro Pixhawk 6C Mini** and other
MAVLink controllers running **ArduCopter** (4.6 and 4.7 are tested against
the real firmware; see [Development](DEVELOPMENT.md#testing-against-real-arducopter)).
Other MAVLink autopilots, PX4 and ArduPlane included, are shown and their
telemetry and parameters read, but nothing that moves an aircraft is sent to
them: every mode number and flight sequence in the app is ArduCopter's.
AERONEX has been connected to a physical Pixhawk 2.4.8 running ArduCopter; the
protocol layer is also checked with real pymavlink-encoded frames and ArduPilot
SITL.

## Modules

### Vehicle Connection
- **Web Serial** connection to a flight controller over **USB** or a
  **telemetry radio** exposed as a serial device.
- A from-scratch **MAVLink 1/2 parser** that CRC-validates every frame against
  the ArduPilot dialect's `CRC_EXTRA` table. Invalid frames are counted, not
  trusted.
- **Heartbeat-based vehicle discovery**: vehicle type, firmware family
  (ArduPilot / PX4 / other), flight mode, arming state and system status, all
  read from what the vehicle actually sends. A GCS/camera/companion heartbeat is
  never mistaken for the vehicle.
- Live **attitude, GPS, battery, position, HUD and RC** telemetry when the
  vehicle sends it, each stamped and flagged **stale** after 3 s.
- Honest states throughout: *waiting for heartbeat*, *no heartbeat* (with a
  baud-rate hint when bytes arrive but don't parse), *stale*, *lost*, *error*,
  each with recovery guidance.
- **Commands only to ArduCopter, always confirmed.** Arming, modes, take-off,
  missions, calibration and parameter writes go only to an ArduPilot
  multicopter, wait for its acknowledgement, and are reported in plain words
  when refused. Anything else is shown and read, never commanded.

### Telemetry & Diagnostics
- Per-message rates, a CRC-validated raw frame table, link-health counters and
  a vehicle event/STATUSTEXT log.

### Vehicle Configuration
- Local **vehicle profiles** (frame, board, declared firmware, mass, dimensions,
  notes), kept on this computer. Profiles describe *your* airframe and never
  override what a connected controller reports; a mismatch is flagged.

### Parameters
- Every setting on the flight controller with **what it is for**: ArduPilot's
  plain name, description, units, documented range, step, named options and
  bits, and whether it needs a reboot. The text is generated from the
  ArduCopter 4.7.2 and 4.6.3 sources with ArduPilot's own `param_parse.py`
  (`scripts/param-metadata/generate.py`), the same documentation Mission
  Planner uses. The right version is picked from the names the aircraft uses,
  and helicopter frames get the helicopter definitions.
- Search by name or by what a setting does ("waypoint speed", "battery low").
- Editors that fit the value: a list of options, a switch per bit, or a number
  with its unit. Values are checked before they are staged: whole-number
  settings refuse decimals and sizes they cannot hold, read-only settings are
  locked, and a value outside the documented range needs an explicit "use it
  anyway".
- Nothing is written until Upload, which asks first and says which changes
  need a reboot; a reminder with a Reboot button stays until it is done.
- **Load a file** (Mission Planner or QGroundControl format) to see every
  difference from the aircraft and choose what to stage. Calibrations, device
  IDs and counters start unticked; values that cannot be stored cannot be
  ticked. **Save** writes a Mission-Planner-compatible `.param` file.
- On both firmware versions, every setting the real ArduCopter reports has a
  description (checked by the `sitl/` suite).

### Overview
- A live 3D hero: a procedural quadcopter flying a **scripted preview path**
  (clearly labelled as not live telemetry) over a procedural valley, with an
  attitude/heading/altitude instrument cluster driven by the same state.
- First-flight checklist, browser-capability check, and both operating modes.

### Settings
- Motion (respects `prefers-reduced-motion`), graphics preset, units, and a
  data reset.

### Digital Twin Studio
- Import your drone's assembly: **GLB, glTF, OBJ, STL**, or **STEP/STP**.
- STEP/STP is tessellated to a mesh **on this computer** by occt-import-js
  (OpenCascade in WebAssembly) — the file is never uploaded. Part names and
  per-part colours from the assembly are preserved.
- **Orientation**: pick which model axis is the nose and which is up (with
  common-export presets), auto-fit and scale. This is a visual correction only;
  it never changes autopilot parameters.
- **Test flight**: fly the imported model over a ground grid in three modes —
  *Inspect* (orbit + body-axis arrows), *Scripted* (an analytic figure-eight
  with attitude derived from the path), and *Manual* (keyboard kinematic
  control). Clearly labelled as a visual preview, not a validated physics model.
- The viewport renders imported models with the twin simulator's exact
  material scheme and lighting, so a model looks identical in both places.
- Orientation is set with intuitive Turn / Tilt / Roll buttons (90° steps), with
  a direct-axis fallback.
- The model persists with the vehicle profile: the descriptor on the profile,
  the raw bytes in IndexedDB, so it reloads after a refresh.

### Flight Simulator
- A virtual aircraft: a 6-DOF rigid-body model (thrust, drag, wind and gusts,
  a battery that sags) flown by a model of ArduCopter's control loops, flight
  modes, arming checks and failsafes, under their real parameter names.
- It speaks MAVLink through the same session as a real flight controller, so
  every page in the app works on it.
- A 3D world with five cameras, the model imported in Digital Twin, and
  generated landscapes or the measured ground around a real home point.
- Faults on demand: lose a motor, the GPS, the radio or the link. Pause, or run
  at up to 10 times speed.
- It is a model written from ArduPilot's documentation, not the firmware, with
  no sensor noise and no obstacles. The earlier scenic valley demo is still
  there as a separate tab.

### Mission Planning
- A real map (see Maps and ground heights) or a practice field. Click to add
  waypoints, drag to move them, undo and redo, reorder, set every height.
- A height profile along the whole route and an instant plan check: clearance,
  fence, flight time against the battery, height and distance.
- A Fence tab for the geofence: ceiling, floor, distance from home, margin and
  breach action (the FENCE_ settings), and keep-in and keep-out zones drawn on
  either map as areas or circles, with corners to drag, undo, and a keep-in
  drawn round the route in one click. Its check follows ArduCopter's own code
  (AC_Fence, AC_PolyFence_loader, 4.6 and 4.7): what the firmware would refuse
  to arm with, shapes that cross themselves (which ArduCopter accepts and gets
  wrong), storage, home outside a keep-in, legs that breach and where, how far
  past the edge the aircraft goes while it stops, returns home that cut
  through a zone, and the ceiling and floor against the route.
- Sending the fence turns it off first if it is being turned off, sends the
  zones and reads them back, writes the settings, and turns it on last. A
  refusal is reported in the aircraft's own words. It works round a firmware
  trap found in testing: ArduCopter 4.6 wipes a fence of one or two circles a
  moment after accepting it, if a larger fence was there before.
- Checked against ArduCopter itself in SITL (`sitl/fence.test.ts`): it holds
  exactly what is sent, refuses to arm exactly where the app says it will,
  turns back where the app says the route breaches, and keeps the return
  under the ceiling as the app says.
- Predict the flight in the simulator model with wind, battery level and a
  chosen failure.
- Plans save and open as `.waypoints` files (QGC WPL 110), which Mission
  Planner and QGroundControl also read.
- Sending a mission to a real aircraft asks first, refuses if the aircraft is
  not at the plan's home, and reads the mission back to check it.
- Heights are metres above home. Take-off, waypoints with a wait, and one
  ending (return, land, hover) are supported; other commands in a mission read
  from an aircraft are left out and named.

### Assistant
- The Ask button in the top bar (or Ctrl/⌘ J) opens it beside any page. It
  answers how to do something in AERONEX, step by step with links to the
  pages, and general drone questions: parts and compatibility, wiring,
  ArduPilot setup, tuning, failsafes, companion computers, rules.
- It answers about AERONEX from a manual built from the app itself
  (`src/features/assistant/manual.ts`): every page's guide plus its exact
  limits, refusals and messages, with the safety numbers (Keyboard Flight's
  speed, ceiling and range, the fence defaults) read from the code that
  enforces them. It is told that anything not in the manual does not exist.
- With the person's consent it sees a read-only snapshot of the page and the
  linked aircraft (mode, health, Preflight and Doctor results, key settings,
  the mission and fence), never its position. It cannot command anything.
- It may search the web and read pages (on by default, switchable in
  Settings), and shows its sources. Without a key, or offline, it searches the
  manual on the computer instead.
- The key is the person's own and goes only to Anthropic; there is no
  AERONEX server.
- Graded against a question bank of about 90 real-world questions, many of
  them traps (features AERONEX lacks, unsafe shortcuts, mismatched parts):
  `ASSISTANT_EVAL_KEY=sk-ant-… npx vitest run evals` (see the file's header
  for options; it writes a report with every answer).

### Servo Outputs
- What every output pin does (SERVOn_FUNCTION), live from what the aircraft
  sends (SERVO_OUTPUT_RAW). On a Pixhawk 2.4.8 (recognised from the board id
  in AUTOPILOT_VERSION, or the aircraft profile) a drawing of the board and
  its servo rail in the order printed on the case (RC IN, SB, MAIN OUT 8-1,
  AUX OUT 6-1) with signal, + and − pins, each output's function, its live pulse, and which outputs share a
  rate. Other boards: their outputs and timer groups from ArduPilot's hwdef
  files (`scripts/gen-outputs.mjs`, 312 boards).
- Set up by task: **payload release** (ArduPilot's gripper: closed, open and
  resting positions, auto-close, a transmitter switch, Release / Close
  buttons); **a transmitter channel** (exact pass-through, or scaled into the
  output's range; "flip the switch" finds the channel); **mission or button**
  (Disabled, moved by DO_SET_SERVO); or any other function (camera shutter,
  gimbal, landing gear, parachute, sprayer, winch, motors, GPIO, scripting).
  Range (min/centre/max, reversed) and a test that moves the output.
- Transmitter switches (RCn_OPTION): payload release, landing gear, camera
  shutter, parachute.
- Checks before saving: missing or doubled motors; a servo sharing a timer
  with motors (490 Hz, or OneShot/DShot where a servo cannot work);
  pass-through or switch options on a stick or the flight-mode channel;
  gripper settings that disagree; outputs that are also relay pins; ranges;
  the safety switch.
- As ArduPilot does it, checked on ArduCopter 4.7.2 and 4.6.3 (SITL): the
  gripper's settings appear only after GRIP_ENABLE, so they are written in a
  second step; the gripper starts only after a restart, and before it the
  firmware accepts DO_GRIPPER and does nothing, so Release and Close confirm
  the output actually moved; DO_SET_SERVO on a motor's output is refused with
  ArduPilot's own reason. Not done: relay setup, the EPM gripper, servo or
  gripper steps in AERONEX missions.

### Firmware
- Installs **ArduCopter** (multicopter, or helicopter: the `-heli` build) on
  the flight controller over its USB port, in Chrome or Edge (Web Serial).
  Only **stable** releases are offered: the latest from
  `firmware.ardupilot.org/Copter/stable/<board>/`, refused unless its
  `firmware-version.txt` says `FIRMWARE_VERSION_TYPE_OFFICIAL`. Any `.apj` can
  be installed from a file under Advanced, with the same checks.
- Speaks the ArduPilot/PX4 bootloader protocol (revisions 2–5), as ArduPilot's
  `uploader.py` does: identify, erase, write in 252-byte blocks, verify by the
  board's CRC of its whole flash (read-back on protocol 2), boot. External
  flash for the boards that have it. The bootloader is never touched, so a
  failed or interrupted install leaves the board in its bootloader; AERONEX
  reopens it (or catches it when it is plugged back in) to try again.
- Gets the board into its bootloader by itself: "Restart into bootloader" over
  an existing USB link (MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN, param1 = 3), or the
  restart command sent to a board picked while running its firmware. Boards
  chosen once are caught the moment they are plugged in.
- Picks the build from the board id, flash size, processor and bootloader USB
  id (316 boards, generated from ArduPilot's hwdef files by
  `scripts/gen-boards.mjs`). Pixhawk 2.4.8 / Pixhawk1 clones: **Pixhawk1** or
  **Pixhawk1-1M** from the STM32F427 revision (the 1 MB flash errata). Where
  different boards share a board id and bootloader (board id 50: Pixhawk 4,
  CUAV v5, PH4-mini…) it asks which board it is, as Mission Planner does.
  Refuses firmware for another board or too big for its flash.
- The firmware server sends no CORS headers, so AERONEX downloads through its
  own dev/preview server (`/ardupilot-firmware/`, set
  `AERONEX_FIRMWARE_SERVER` to point it elsewhere). Hosted as static files,
  it links to the file to download and install by hand.
- A **How to install** tab: what you need, the steps, which build, what
  happens to parameters, and troubleshooting (cables, hubs, Linux `dialout`
  and ModemManager, DFU for boards with no ArduPilot bootloader).
- Not done: bootloader update, DFU, PX4 firmware, installing over a telemetry
  radio.

### Flight Logs
- Opens ArduPilot DataFlash logs (`.bin`, any version: the format is read from
  the log's own FMT/FMTU descriptions) and MAVLink telemetry logs (`.tlog`,
  every packet checked against its checksum). Read on this computer, in a Web
  Worker; nothing is uploaded. Values match pymavlink's reader exactly on
  ArduCopter 4.6.3 and 4.7.2 logs (every message type, field and count);
  a 16 MB log reads and is checked in about a quarter of a second.
- **Library**: every link session (real or virtual aircraft) is recorded as a
  `.tlog` automatically (Settings → Record telemetry logs), written every few
  seconds so a crash of the browser loses little; logs opened or downloaded
  are kept too. IndexedDB, capped at 2 GB, cleared by Reset app data.
- **Download from the aircraft** over MAVLink (LOG_REQUEST_LIST/DATA), disarmed
  only: lost pieces are asked for again and the log is handed over only when
  every byte is in. Tested byte for byte against ArduCopter's SITL, also over a
  link losing one chunk in twenty. Erase all, with confirmation.
- **Report**: a verdict and 15 checks, each saying what it measured: log
  integrity, log ending in the air (brownout), crash and thrust loss, desired
  vs actual attitude, motor saturation and balance, vibration and clipping per
  IMU, compass field strength and change, GPS fix, satellites and HDOP, EKF test
  ratios and lane switches, battery voltage per cell, sag and capacity used,
  board voltage, loop timing, every ERR code and failsafe decoded, altitude
  tracking, and unsafe settings. Thresholds are ArduPilot's published ones (the
  wiki's log-diagnosis and vibration pages, and its own LogAnalyzer's), cited on
  each finding. Every finding jumps to the chart or the replay at its moment.
- **Charts**: preset sets plus any field of any message; shared time window and
  cursor, mode bands, event lines, thresholds; spikes are never thinned away.
- **Replay** in the simulator's 3D world with the flight display, map and
  timeline (0.5–20×). **Events**, **Parameters** (not default, changed in
  flight, differs from the connected aircraft) and **All data** (every row,
  CSV). Export a report, KML, `.param`, or the log itself.
- Not read: PX4 `.ulg`. No log-based tuning or FFT yet.

---

### Calibration
- Accelerometer (six positions and level), gyro and compass, driven by the
  autopilot's own prompts; "calibrated" is shown only on the autopilot's own
  success message.
- Radio: capture each channel's travel and save the endpoints. Nothing is
  saved unless all four sticks reached both ends (ArduPilot refuses to arm on
  a range short of 1300 to 1700 µs).
- Flight modes, ESC protocol and range.
- **ESC calibration as ArduPilot documents it.** The button sets
  `ESC_CALIBRATION = 3` and does not restart the board: started that way,
  ArduCopter sends full throttle to every ESC for five seconds, which only
  teaches an ESC that is powering up at that moment. The page warns when a
  battery is connected, and every Restart button in the app refuses while a
  calibration is waiting.
- Motor test with a props-off gate; motors stop when the link is interrupted
  and when the tab or window is left.

## Maps and ground heights

Mission Planning draws the route on a real map over measured ground. Nothing
needs an account to work:

| What | Source | Terms |
| --- | --- | --- |
| Map engine | MapLibre GL JS | Open source (BSD) |
| Ground heights | Terrain Tiles on AWS Open Data (Mapzen; SRTM and other public surveys), about 30 m detail | Open, no key, may be kept offline; credit required |
| Default picture | Sentinel-2 cloudless 2016 by EOX, 10 m detail | CC BY 4.0, may be kept offline; credit required |
| Newer picture | Sentinel-2 cloudless 2024 by EOX | Non-commercial use only |
| Street map | OpenStreetMap's tile servers | View only: their policy forbids saving areas |
| Sharp satellite | MapTiler, with the user's own key | Their free plan is non-commercial; no bulk saving |
| Sharp satellite | Esri World Imagery | Works without a key; a published app should use an Esri account; no saving |

Sharper pictures need a provider key, entered in the map's Layers panel. In the Windows app it is encrypted by Windows for your user account, and it
goes only to that provider. Tiles from the open sources are stored on the
computer as they are viewed, and "Save this area" stores a whole view, so a
saved field works with no internet.

Heights in a mission are metres above home, ArduCopter's default frame. The
height profile under the map walks the straight lines the autopilot will fly
and shows where they come closest to the ground. The ground data does not
include trees, buildings or wires.

## Safety

- The app is not a substitute for manufacturer documentation or approved flight
  procedures, and it is not flight-certified.
- A rendered interface is not a verified connection. Where hardware, firmware or
  a backend is required, the app says so instead of pretending.
- The pilot is responsible for every flight. Do a props-off bench test and a
  cautious first flight with any new aircraft or setting.
