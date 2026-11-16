/*
  ArduPilot facts the assistant may state as verified: the same thresholds the
  Drone Doctor and Preflight Check apply, with their sources in ArduPilot's
  documentation (see diagnostics.ts). Moved here from the Doctor's old chat.
*/

export const REFERENCE = `
# AERONEX verified reference (ArduPilot / Copter)

## Vibration (VIBE, m/s²)
- Below 30: healthy. 30–60: marginal, can intermittently upset position/altitude hold. Above 60: nearly always causes problems — the EKF starts rejecting the accelerometers (fly-aways, "toilet-bowling").
- IMU clipping (clip0/1/2): ideally 0 for a whole flight. A few on a hard landing are fine; a count that keeps rising is a serious vibration problem.
- Fixes: soft-mount the flight controller (gel/foam), balance props and motors, ensure no rigid wires touch the board, keep the autopilot away from the frame's resonance.

## State estimation (EKF3 variances)
- Variances run 0 (trustworthy) to 1 (untrustworthy). The EKF failsafe (FS_EKF_THRESH, default 0.8) triggers when any two of compass/position/velocity variance exceed the threshold for 1 second while armed.
- High compass variance → magnetic interference or bad compass calibration. High velocity variance → GPS noise or vibration. High position variance → GPS glitching. High vertical → baro affected by prop-wash/vibration.
- FS_EKF_ACTION default 1 = switch to Land in GPS modes.

## Compass
- Calibration offset magnitude over ~600 (mGauss) indicates likely magnetic interference — compass mounted too near power wiring/ESCs/battery.
- CompassMot motor interference: below 30% is good, 30–60% marginal, above 60% bad (move the compass or use an external mast compass).
- Pre-arm "Compasses inconsistent" = two compasses disagree; "Check mag field" = field strength out of range (nearby metal).
- Fixes: recalibrate away from metal; raise/relocate the compass; prefer an external compass; disable a bad internal compass with COMPASS_USE/COMPASS_USE2.

## GPS
- fixType: 0 none, 1 no fix, 2 2D, 3 3D (needed to hold position), 4 DGPS, 5 RTK float, 6 RTK fixed.
- Satellites: 6 is a bare minimum; aim for 10+. HDOP: under ~1.4 good, up to ~2.5 marginal, higher is poor.
- Fixes: clear sky view, away from buildings; GPS mast up and away from carbon/metal; keep video/telemetry transmitters away from the antenna.

## Power / battery (LiPo)
- Per-cell: 4.2 V full, ~3.7 V nominal, 3.5 V land-now, 3.3 V damaging. Voltage sags under throttle; a large sag means an old/high-resistance pack.
- Set BATT_MONITOR (4 = analog voltage+current) and a voltage failsafe (BATT_LOW_VOLT / BATT_CRT_VOLT). BATT_ARM_VOLT blocks arming on a flat pack.
- Cell count (S) ≈ round(pack voltage / 3.7).

## Tuning (Copter PID, rate loop)
- ATC_RAT_RLL_* / ATC_RAT_PIT_* / ATC_RAT_YAW_* are the rate PIDs; ATC_ANG_* are the angle (stabilize) P gains.
- Fast, high-pitched wobble → lower rate P and D. Slow wobble/overshoot → raise P, or raise D for damping. Roll and pitch are usually tuned together on a symmetric quad.
- Change gains in small steps (±10–25%), re-test with a short low hover, props clear. Autotune can refine automatically.
- MOT_THST_HOVER (learned hover throttle): healthy around 0.25–0.35. Very low (<0.18) = over-powered (twitchy, hard to tune). High (>0.55) = under-powered (little headroom, hot motors).

## Build basics
- Set FRAME_CLASS and FRAME_TYPE for your airframe (e.g. Quad / X) before motors will spin correctly.
- Thrust-to-weight: aim for at least 2:1 (hover near half throttle). For agile flight 3–4:1.
- Motor order and spin direction must match the firmware's numbering for the frame; use the motor test (A, B, C… = the firmware's order) to verify.
- Props: match prop size/pitch to motor KV and cell count; over-propping overheats motors and ESCs.

## Arming / pre-arm
- Never disable arming checks for flight (ARMING_CHECK before ArduCopter 4.7, where 1 = all; ARMING_SKIPCHK from 4.7, where 0 = skip none) — they hide exactly the faults that cause crashes. Resolve the named condition instead.
- Common pre-arm causes: compass not calibrated / inconsistent, needs accel calibration, no GPS/EKF-not-ready, RC not calibrated, battery below arming voltage, barometer not healthy.

## ArduCopter 4.7 renames
- 4.7 renamed many parameters and moved them from centimetres/centidegrees to metres/degrees: RTL_ALT (cm) → RTL_ALT_M (m), WPNAV_SPEED (cm/s) → WP_SPD (m/s), WPNAV_ACCEL → WP_ACC, LAND_SPEED → LAND_SPD_MS, ANGLE_MAX (cdeg) → ATC_ANGLE_MAX (deg), PSC_ACCZ_P/I → PSC_D_ACC_P/I at one tenth the value. Guides written for 4.6 or older use the old names and units; check which the aircraft has in the Parameters page.

## Failsafes (ArduCopter)
- FS_GCS_ENABLE: ground-station (link-loss) failsafe; 0 off, 5 = Land. Triggers when GCS heartbeats stop for FS_GCS_TIMEOUT seconds (default 5).
- FS_THR_ENABLE: radio (RC) failsafe; 1 = RTL is the common choice.
- BATT_FS_LOW_ACT / BATT_FS_CRT_ACT: battery failsafe actions (0 = warn only), with BATT_LOW_VOLT / BATT_CRT_VOLT or BATT_LOW_MAH / BATT_CRT_MAH as the triggers.
- FENCE_ENABLE / FENCE_ACTION: geofence; the AERONEX Fence tab sets these.

## Pixhawk 2.4.8 (FMUv3 class)
- Runs ArduCopter with the Pixhawk1 target; boards with the STM32F427 1 MB flash limitation need the Pixhawk1-1M build.
- Has a safety switch: motors will not spin until it is pressed (light solid) unless BRD_SAFETY_DEFLT = 0. Has a buzzer port; the I2C port is for an external compass or other I2C devices.
- Ports: TELEM1 (SERIAL1, default MAVLink 57600 for a telemetry radio), TELEM2 (SERIAL2, often a companion computer), GPS (SERIAL3). A companion computer on TELEM2 normally uses SERIAL2_PROTOCOL = 2 (MAVLink2) and a higher baud such as 921600 (SERIAL2_BAUD = 921).
- Powered from a power module on the POWER port; do not power servos from the servo rail without a separate BEC.
`.trim();
