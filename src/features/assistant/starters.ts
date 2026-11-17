/* Questions offered in an empty conversation: the page's own first, then general ones. */
export const PAGE_STARTERS: Record<string, string[]> = {
  "/": ["I have a new Pixhawk 2.4.8. What do I do first?", "What can AERONEX do, and what can't it do yet?"],
  "/frame-studio": ["Which material should I cut my first frame from?", "What motor and propeller size suit a 5-inch frame?", "How do I order the DXF from a laser-cutting service?"],
  "/digital-twin": ["My STEP model imports sideways. How do I fix it?", "Which file format should I export from my CAD tool?"],
  "/vehicle": ["How do I measure my aircraft's all-up mass and diagonal?"],
  "/connection": ["My Pixhawk connects but no data arrives. Why?", "How do I set up a SiK telemetry radio with a Pixhawk?"],
  "/firmware": ["Which firmware does my Pixhawk 2.4.8 need?", "The board restarted but the bootloader never connected. What now?"],
  "/calibration": ["What order should I calibrate everything in?", "My compass calibration won't finish. What now?", "How do I check motor order and spin direction?"],
  "/servo": ["How do I set up a payload drop servo on my Pixhawk 2.4.8?", "How do I make a servo follow a switch on my transmitter?"],
  "/pid": ["My quad wobbles fast when it hovers. What should I change?", "Should I use AutoTune instead of tuning by hand?"],
  "/params": ["Which failsafe settings should I set before the first flight?", "How do I restore my settings from a .param file?"],
  "/preflight": ["Why won't my drone arm?", "Explain what Preflight Check is telling me right now."],
  "/flight-data": ["What should I watch on Flight Data during a first hover?"],
  "/keyboard-flight": ["Give me a step-by-step guide to fly my Pixhawk 2.4.8 with Keyboard Flight.", "Why does pressing T not take off?"],
  "/simulator": ["How do I rehearse a motor failure in the simulator?", "How close is the simulator to real ArduCopter?"],
  "/missions": ["How do I plan, check and send my first mission?", "How do I plan a payload drop with my gripper?", "How should I set up a geofence for a small field?"],
  "/doctor": ["Explain my Drone Doctor findings and how to fix each one.", "What causes high vibration and how do I reduce it?"],
  "/telemetry": ["What message rates are normal on a telemetry radio?"],
  "/logs": ["How can I analyse an ArduPilot flight log today?"],
  "/about": ["What is the safest way to start with AERONEX?"],
  "/settings": ["How do I get an Anthropic API key for this assistant?"],
};

export const GENERAL_STARTERS = ["How do I connect a Raspberry Pi companion computer to a Pixhawk?", "Is a 2306 2400 KV motor OK on 6S with 5-inch props?"];

export const startersFor = (path: string): string[] => [...(PAGE_STARTERS[path] ?? PAGE_STARTERS["/"]), ...GENERAL_STARTERS].slice(0, 4);
