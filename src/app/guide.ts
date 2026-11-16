/*
  The guide: for each page, what it is for, what it needs, how to use it and
  what its words mean. Shown in the help panel (the ? button, or the ? key).

  Written for someone who has never used a ground station. Every entry answers
  the same four questions in the same order, so the panel is predictable: a
  reader who has opened it on one page knows where to look on the next.
*/
export interface Guide {
  /** One or two sentences: what this page is for. */
  purpose: string;
  /** What has to be true before the page is useful. Empty when nothing is. */
  needs: string[];
  /** How to use it, in order. */
  steps: string[];
  /** Words on the page that are not everyday English. */
  terms: [term: string, meaning: string][];
}

export const GUIDES: Record<string, Guide> = {
  "/": {
    purpose: "The starting point. It shows which aircraft is selected, whether it is linked, and what to do next.",
    needs: [],
    steps: [
      "Follow the four stages from left to right: Design, Set up, Fly, Review. You can skip any stage you do not need.",
      "Use the first-flight checklist to see what is done and what is next.",
      "No hardware yet? Open the Flight Simulator. It needs nothing plugged in.",
    ],
    terms: [
      ["Flight controller", "The small computer on the drone that keeps it level and flies it. A Pixhawk is one."],
      ["Linked", "The app is receiving data from a real flight controller."],
    ],
  },
  "/frame-studio": {
    purpose: "Designs a drone frame around the motors, electronics and battery you already have, checks it is strong enough, and gives you files a laser cutter, CNC router or 3D printer can use.",
    needs: [],
    steps: [
      "Aircraft: pick the propeller size. This sets how big everything else is.",
      "Components: enter your motors, flight-controller stack, battery and camera.",
      "Material: choose what you will cut or print it from.",
      "Review: read the checks. Fix anything marked as an error before going on.",
      "Make it: download the cutting files, the full-size part drawings and the hardware list.",
    ],
    terms: [
      ["Wheelbase", "The distance between diagonally opposite motors, in millimetres. The usual way to state a frame's size."],
      ["Stack", "The flight controller and speed controller boards, bolted on top of each other in the middle of the frame."],
      ["Thrust : weight", "How many times its own weight the motors can lift. Above 2 flies; 4 or more is agile."],
      ["DXF / STL", "File types. DXF is a flat outline for cutting; STL is a solid shape for 3D printing."],
    ],
  },
  "/digital-twin": {
    purpose: "Shows a 3D model of your aircraft and moves it the way the real one moves, so you can confirm the app and the aircraft agree about which way is forward and up.",
    needs: ["A 3D model file is optional. Without one, a standard quadcopter is shown."],
    steps: [
      "Drop in your model (STEP, GLB, glTF, OBJ or STL), or keep the default.",
      "In Inspect, turn the model until the arrows match the real aircraft's nose and top.",
      "Try Scripted flight to watch it bank and turn, or Manual flight to steer it yourself.",
      "With an aircraft linked, Live mirrors the real one: tilt the drone and the model tilts.",
    ],
    terms: [
      ["Digital twin", "A 3D copy of your aircraft on screen that follows the real one."],
      ["Roll, pitch, yaw", "Tilting left or right, tilting nose up or down, and turning to face a new direction."],
    ],
  },
  "/vehicle": {
    purpose: "Stores a description of each aircraft you fly. The app uses it to pick the right 3D model and to make the simulator fly like yours.",
    needs: [],
    steps: [
      "Give the aircraft a name and choose its frame type and flight controller.",
      "Add its weight and motor-to-motor diagonal if you know them. The simulator uses both.",
      "Have more than one aircraft? Add a profile for each and switch between them from the top bar.",
    ],
    terms: [
      ["All-up mass", "The weight of the aircraft ready to fly, battery included."],
      ["Firmware", "The software running on the flight controller, usually ArduPilot or PX4."],
    ],
  },
  "/connection": {
    purpose: "Links the app to the flight controller, so every other page can show live data and send commands.",
    needs: [
      "Chrome or Edge on a computer. Other browsers cannot open a USB serial port.",
      "A USB cable to the flight controller, or a telemetry radio plugged into the computer.",
    ],
    steps: [
      "Choose USB cable or Telemetry radio.",
      "Press Connect and pick your device from the list the browser shows.",
      "Wait a few seconds for the status to turn to Connected.",
      "Nothing arriving? Try the other baud rate: 115,200 for USB, 57,600 for most radios.",
    ],
    terms: [
      ["Baud rate", "The speed of the serial link. Both ends must use the same number."],
      ["Heartbeat", "A short message the flight controller sends once a second to say it is alive."],
      ["MAVLink", "The language flight controllers and ground stations use to talk to each other."],
      ["Telemetry radio", "A pair of small radios that carry the link without a cable."],
    ],
  },
  "/firmware": {
    purpose: "Installs ArduPilot's flight software on the flight controller over USB: the latest stable ArduCopter release, in the build made for your board.",
    needs: ["Chrome or Edge on a computer.", "A USB data cable into the flight controller's own USB port. Propellers off, battery unplugged."],
    steps: [
      "Choose Multicopter or Helicopter.",
      "Linked over USB already? Click Restart into bootloader. Otherwise unplug the board, click Find the board, plug it in and choose it in the list.",
      "If it restarts into its bootloader, choose the bootloader in the list too (the first time only).",
      "Check the board and the build AERONEX picked, then click Install. Keep the cable in until it says done.",
      "Connect to the board and calibrate if this was a new install.",
    ],
    terms: [
      ["Firmware", "The program the flight controller runs. ArduCopter is ArduPilot's firmware for multicopters and helicopters."],
      ["Bootloader", "A small program at the start of the flash that installs firmware. It is never erased, so an install can always be done again."],
      ["Stable", "A release ArduPilot has tested and released for flying, as opposed to beta or daily builds."],
      ["Pixhawk1-1M", "The build for Pixhawk 2.4.8-type boards whose processor can only use 1 MB of flash."],
      [".apj", "ArduPilot's firmware file: the program, compressed, with the board id it is for."],
    ],
  },
  "/calibration": {
    purpose: "Teaches the flight controller's sensors what level, north and full throttle are. A new or rebuilt aircraft needs this once before it can fly safely.",
    needs: ["A linked flight controller.", "Propellers off for the ESC and motor tests."],
    steps: [
      "Work through the tabs from left to right: Accel & Level, Compass, Radio, Flight Modes, ESC, Motor Test.",
      "Follow the prompts. Each step tells you how to hold or move the aircraft.",
      "Use Motor Test last to confirm each motor is in the right place and spins the right way.",
    ],
    terms: [
      ["Accelerometer", "The sensor that feels which way is down."],
      ["Compass", "The sensor that finds north. Calibrate it outdoors, away from metal."],
      ["ESC", "Electronic speed controller: the part that drives each motor."],
      ["Flight mode", "How much the autopilot helps, from fully manual to fully automatic."],
    ],
  },
  "/pid": {
    purpose: "Adjusts how strongly the aircraft corrects itself. Use it when the drone wobbles, drifts, or feels slow to respond.",
    needs: ["A linked flight controller.", "Somewhere open to test each change with a short, low hover."],
    steps: [
      "Describe what the aircraft does in the advisor, or pick one of the suggestions.",
      "Review the change it proposes. Nothing is sent yet.",
      "Press Upload, then test with a short hover. Change a little at a time.",
      "Worse than before? Press Revert to go back.",
    ],
    terms: [
      ["PID", "The three numbers that set how hard the autopilot corrects an error: now (P), over time (I) and against overshoot (D)."],
      ["Gain", "One of those numbers. Higher means a stronger correction."],
      ["Staged", "Changed on screen but not yet sent to the aircraft."],
    ],
  },
  "/params": {
    purpose: "Lists every setting stored on the flight controller. For changes the other pages do not cover.",
    needs: ["A linked flight controller. The list downloads by itself after connecting."],
    steps: [
      "Search for a setting by name, or browse by group.",
      "Edit values. They are staged, not sent.",
      "Press Upload to write them, or save the whole set to a file as a backup first.",
    ],
    terms: [
      ["Parameter", "One named setting on the flight controller, such as a limit or a sensor option."],
      ["Staged", "Changed on screen but not yet sent to the aircraft."],
    ],
  },
  "/preflight": {
    purpose: "Gives one clear answer before take-off: go, or no-go, and why.",
    needs: ["A linked flight controller.", "The aircraft outdoors, where it can see GPS satellites."],
    steps: [
      "Place the aircraft where it will take off and wait for the checks to settle.",
      "Read the verdict at the top. Anything in red must be fixed before arming.",
      "The panels below show which sensor is unhappy; Pre-arm messages give the autopilot's own reason.",
    ],
    terms: [
      ["Arm", "To switch the motors on, ready to fly. Disarmed means they cannot spin."],
      ["Pre-arm check", "A test the autopilot runs itself and uses to refuse arming."],
      ["EKF", "The autopilot's estimate of where it is and how it is moving, built from all its sensors."],
      ["GPS fix", "How well the aircraft knows its position. A 3D fix is the minimum for flying with position hold."],
    ],
  },
  "/flight-data": {
    purpose: "The live instrument panel: which way up the aircraft is, where it is heading, how fast and how high.",
    needs: ["A linked flight controller."],
    steps: [
      "Keep this page open while the aircraft is flying.",
      "Watch the battery and the link status. A greyed-out reading has stopped updating.",
    ],
    terms: [
      ["Artificial horizon", "The instrument that shows tilt: brown is ground, the lighter half is sky."],
      ["Height above take-off", "How far the aircraft is above the place it started, not above sea level."],
      ["Ground speed", "Speed across the ground, whichever way the aircraft points."],
    ],
  },
  "/keyboard-flight": {
    purpose: "Flies a real aircraft for a short test hop using the keyboard. The autopilot does the balancing; the keys only ask it to move.",
    needs: [
      "A linked flight controller with a good GPS fix.",
      "An open outdoor space, clear of people.",
      "Practice in the Flight Simulator first.",
    ],
    steps: [
      "Work through the checklist on the page until it says Ready.",
      "Press T to take off. The aircraft climbs and hovers by itself.",
      "W A S D move it, Q and E turn it. Let go and it stops and holds position.",
      "Press L to land, or Space to stop and hover at any time.",
    ],
    terms: [
      ["Guided mode", "A flight mode in which the autopilot flies and accepts simple requests such as \"move forward\"."],
      ["Return to launch", "The aircraft flies back to where it took off and lands by itself."],
    ],
  },
  "/simulator": {
    purpose: "A virtual aircraft with real flight physics and a flight controller that speaks MAVLink. Once it is started, every page in the app treats it as a connected aircraft, so you can try anything with nothing at risk.",
    needs: ["No hardware. A real aircraft must be disconnected first: the app talks to one at a time."],
    steps: [
      "Describe the aircraft: weight, size, motor thrust and battery. Copy them from your Aircraft Profile or Frame Studio design if you have one.",
      "Press Start the virtual aircraft. The top bar shows Virtual aircraft while it runs.",
      "Choose a landscape: a practice one, or the real ground around the home you set in Mission Planning. The aircraft collides with it, so a route that is too low will show it.",
      "Take off, or fly the mission you planned. Speed time up to 10× for a long flight, or pause it to look.",
      "Watch in the 3D world: Chase, Orbit, Ground, Top and Onboard cameras. If you imported a model in Digital Twin, that is the aircraft you see.",
      "Make something go wrong: stop a motor, lose GPS or the link, add wind, and watch what the failsafe settings do.",
      "Change a setting in Parameters and try again. It takes effect at once.",
    ],
    terms: [
      ["Virtual aircraft", "A simulated drone and flight controller. Nothing it reports comes from hardware."],
      ["Failsafe", "What the autopilot does by itself when something is lost: usually return home or land."],
      ["MAVLink", "The language flight controllers and ground stations use. The virtual aircraft speaks it, so the app cannot tell it from a real one."],
      ["Model", "The simulator follows ArduCopter's documented behaviour. It is not the firmware itself, so treat results as a strong hint, not a guarantee."],
    ],
  },
  "/missions": {
    purpose: "Plans a route on a real map for the aircraft to fly by itself, checks it clears the real ground, then predicts how that flight will go before you fly it: how long, how much battery, and what happens if something fails.",
    needs: ["Nothing to plan and predict. The real map needs the internet once for each place, or an area saved beforehand.", "To send a mission, a linked aircraft, real or virtual."],
    steps: [
      "Choose Real map. Link your aircraft outdoors: when its GPS has a position, home goes there by itself and stays with the aircraft. With no aircraft, press the home button on the map and click where it will take off.",
      "Click the map to place waypoints. Drag a marker to move it. Undo is Ctrl Z; the arrows in the list change the order.",
      "Set each waypoint's height, and choose how the mission ends.",
      "Read the height profile under the map and the plan check under the list. They show the ground along the whole route and anything wrong that the numbers alone reveal.",
      "Open the Predict tab. Set the wind and the battery charge you expect, and optionally something that goes wrong. Press Predict the flight.",
      "Open the Fence tab to set where the aircraft may fly: a ceiling, a floor, a distance from home, and keep-in or keep-out zones drawn on the map. Its check says what ArduCopter would refuse and where the route would breach. Send it to the aircraft from there: the zones are read back and checked before the fence is turned on.",
      "Fix the plan or the settings and predict again. Then send it to the aircraft: the app asks first and reads the mission back to check it.",
      "Save the plan to a file to keep it or to open it in Mission Planner or QGroundControl.",
      "Flying somewhere without internet? Open Layers on the map and save the area first.",
    ],
    terms: [
      ["Waypoint", "A point the aircraft flies to, with a height."],
      ["Height", "Metres above home, the place the aircraft takes off from. It is not height above the ground under the waypoint."],
      ["Clear", "How far a waypoint is above the ground beneath it. The ground data is good to about 10 m and does not include trees, buildings or wires."],
      ["Return home", "The aircraft climbs to a safe height, flies back to where it took off and lands."],
      ["Failsafe", "What the autopilot does by itself when something is lost or the battery is low."],
      ["Geofence", "Limits the autopilot enforces by itself: a ceiling, a floor, a distance from home, and drawn zones. On a breach it does what FENCE_ACTION says, usually return home."],
      ["Keep-in zone", "An area the aircraft must stay inside. Home must be inside it, or ArduCopter will not arm."],
      ["Keep-out zone", "An area the aircraft must stay out of, such as a building, a crowd or a road."],
      ["Margin", "How far inside the fence the aircraft aims to stay (FENCE_MARGIN)."],
      ["Practice field", "A made-up landscape for learning the simulator. It is not a real place."],
    ],
  },
  "/doctor": {
    purpose: "Scans the aircraft's health and explains, in plain words, what is wrong and how to fix it.",
    needs: ["A linked flight controller."],
    steps: [
      "Connect and let the scan run. It updates as data arrives.",
      "Read the findings from the top. The most serious come first.",
      "Each finding lists a cause and a fix. Press Ask about these findings to put a follow-up question to the assistant, which sees the same findings.",
    ],
    terms: [
      ["Vibration", "Shaking from the motors and propellers that confuses the sensors."],
      ["Clipping", "A sensor shaken so hard it hit its limit. Any clipping needs attention."],
      ["Voltage sag", "The battery voltage dropping under load, a sign of a tired or undersized pack."],
    ],
  },
  "/telemetry": {
    purpose: "Shows the raw data arriving over the link. Use it when something is not connecting or a reading looks wrong.",
    needs: ["A linked flight controller."],
    steps: [
      "Check Messages: each line is one kind of data and how often it arrives.",
      "Read Events and vehicle messages for the aircraft's own status reports and warnings.",
      "A rate of zero means the aircraft has stopped sending that data.",
    ],
    terms: [
      ["Message rate", "How many times a second one kind of data arrives, in Hz."],
      ["CRC error", "A message damaged on the way. A few are normal on a radio; many mean a poor link."],
    ],
  },
  "/logs": {
    purpose: "Opens a flight log and shows what happened in the flight: what the checks found and why, every reading on a chart, the flight replayed in 3D, and every event, message and parameter. Logs are read on this computer and never uploaded.",
    needs: [],
    steps: [
      "Drop a .bin (the aircraft's on-board log) or a .tlog (a telemetry log) on the page, or open one from the library. With the aircraft connected and disarmed, Logs on the aircraft downloads one from its SD card.",
      "Read the Report first: the verdict, then each finding with what was measured, the limit it broke and what to do. Show on chart and Replay from here go straight to the moment.",
      "Use Charts to look closer: pick a chart set, or search for any field in the log. Drag to pan, scroll to zoom, double-click for the whole log.",
      "Replay flies the logged flight in the 3D world with its instruments and the map; space plays and pauses, the arrow keys step.",
      "Export saves a written report, the flight path for Google Earth, the parameters as a .param file, or the log itself.",
    ],
    terms: [
      ["Flight log (.bin)", "The recording the flight controller makes on its SD card of every sensor reading during a flight, at full rate."],
      ["Telemetry log (.tlog)", "What the ground station received over the link. AERONEX records one for every session; it has fewer samples than a .bin and nothing after the link dropped."],
      ["Vibration", "How hard the flight controller is being shaken, in m/s². Under 30 is fine; over 60 nearly always causes problems."],
      ["Clipping", "Moments when vibration went past what the accelerometer can measure. It should stay at zero."],
      ["EKF test ratio", "How far a sensor disagrees with the position estimate. Under 0.5 is normal; at 1 the sensor is being rejected."],
      ["Desired vs actual", "What the autopilot asked for and what the aircraft did. A sustained gap is a failing motor, a broken arm or poor tuning."],
    ],
  },
  "/about": {
    purpose: "Explains what AERONEX is, who it is for and how the pieces fit together.",
    needs: [],
    steps: ["Read How it works for the whole workflow in four stages."],
    terms: [],
  },
  "/settings": {
    purpose: "Changes how the app looks and behaves on this computer. Nothing here is sent to an aircraft.",
    needs: [],
    steps: [
      "Lower Graphics quality if the 3D views feel slow.",
      "Choose Metric or Imperial for heights and speeds.",
      "Paste an Anthropic API key to turn on the assistant, and choose whether it may search the web and see the linked aircraft.",
    ],
    terms: [["API key", "A password that lets the app use an online service on your behalf. It stays in this browser."]],
  },
};

export const guideFor = (path: string): Guide => GUIDES[path] ?? GUIDES["/"];
