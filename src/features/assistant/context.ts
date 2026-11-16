/*
  What the assistant is told about the moment a question is asked: the page
  the person is on and, when they allow it, a read-only snapshot of the linked
  aircraft. It is written as short labelled lines, because the model quotes
  them back ("your GPS has 7 satellites"), and every reading says how old it
  is not: anything that has stopped updating is left out rather than shown as
  if it were current.

  Never included: the aircraft's position, home or the waypoints' places. A
  question about a drone does not need where it is, and the person has not
  been asked to share it.
*/
import { routeFor } from "../../app/routes";
import { armingChecks, usesNewerNames, withOlderNames } from "../../mavlink/paramNames";
import { isArduCopter } from "../../mavlink/identity";
import type { LinkEvent, LinkStatus, Telemetry, VehicleIdentity } from "../../state/linkStore";
import { runDiagnostics, type Finding } from "../doctor/diagnostics";
import { preflightVerdict } from "../preflight/health";
import type { FenceLimits, FenceZone } from "../../geo/fence";
import { routeLength, type Ending, type PlanPoint } from "../../state/simStore";

export interface LiveInput {
  now: number;
  path: string;
  /** False when the person has turned off sharing aircraft data. */
  share: boolean;
  status: LinkStatus;
  virtual: boolean;
  vehicle: VehicleIdentity | null;
  telemetry: Telemetry;
  events: LinkEvent[];
  params: Record<string, number>;
  paramCount: number;
  plan: { points: PlanPoint[]; ending: Ending; takeoffAlt: number };
  fence: { zones: FenceZone[]; limits: FenceLimits; sentAndSame: boolean | null };
  /** The flight log open in Flight Logs, summarised, or null. */
  log?: string | null;
}

const FRESH = 6000;
const isFresh = (s: { at: number } | undefined, now: number) => !!s && now - s.at < FRESH;
const n1 = (v: number) => (Math.round(v * 10) / 10).toString();

/** Settings worth knowing to answer most questions, by the older names; shown as the aircraft names them. */
const KEY_PARAMS = [
  "FRAME_CLASS",
  "FRAME_TYPE",
  "MOT_THST_HOVER",
  "BATT_MONITOR",
  "BATT_LOW_VOLT",
  "BATT_CRT_VOLT",
  "BATT_FS_LOW_ACT",
  "BATT_FS_CRT_ACT",
  "BATT_CAPACITY",
  "FS_THR_ENABLE",
  "FS_GCS_ENABLE",
  "FS_EKF_THRESH",
  "RTL_ALT",
  "FENCE_ENABLE",
  "FENCE_ACTION",
  "COMPASS_USE",
  "GPS_TYPE",
  "ATC_RAT_RLL_P",
  "ATC_RAT_RLL_I",
  "ATC_RAT_RLL_D",
  "ATC_RAT_PIT_P",
  "ATC_RAT_YAW_P",
  "ATC_ANG_RLL_P",
];

const ENDING: Record<Ending, string> = { rtl: "return home and land", land: "land at the last waypoint", hold: "hover at the last waypoint" };

/** The live snapshot, as text for the model. */
export function buildLiveContext(i: LiveInput): string {
  const r = routeFor(i.path);
  const out: string[] = [`Page open: ${r.label} (#${r.path}).`];

  if (!i.share) {
    out.push("Aircraft data: the person has turned off sharing aircraft data with the assistant. Nothing about their aircraft is known; ask them for any reading you need.");
    return out.join("\n");
  }

  if (i.log) out.push(`Flight log open in Flight Logs (the person is asking about it; answer from these findings and say they came from AERONEX's checks):\n${i.log}`);

  const v = i.vehicle;
  const linked = !!v && (i.status === "connected" || i.status === "stale");
  if (!linked) {
    out.push(`Link: no aircraft linked (status ${i.status}).`);
  } else {
    out.push(`Link: ${i.virtual ? "the AERONEX virtual aircraft (simulated, not real hardware)" : "a physical flight controller"}, ${i.status === "stale" ? "STALE: no heartbeat for over 3 s" : "connected"}.`);
    const copter = isArduCopter(v);
    const gen = usesNewerNames(i.params) ? ", parameter names of ArduCopter 4.7 or later" : i.paramCount > 0 ? ", parameter names of ArduCopter 4.6 or earlier" : "";
    out.push(`Vehicle: ${v.firmwareLabel} ${v.typeLabel.toLowerCase()}${copter ? " (ArduCopter: AERONEX can command it)" : " (NOT ArduCopter: AERONEX only reads it and refuses every command)"}${gen}. Mode ${v.mode ?? "unknown"}, ${v.armed ? "ARMED" : "disarmed"}. Exact firmware version and board are not reported to AERONEX.`);

    const t = i.telemetry;
    const live: string[] = [];
    if (isFresh(t.gps, i.now)) {
      const g = t.gps!.value;
      live.push(`GPS fix type ${g.fixType} (3 = 3D), ${g.satellites ?? "?"} satellites, HDOP ${g.hdop != null ? n1(g.hdop) : "?"}`);
    } else live.push(t.gps ? "GPS stopped reporting" : "no GPS reporting");
    if (isFresh(t.battery, i.now) && t.battery!.value.voltage != null) {
      const b = t.battery!.value;
      live.push(`battery ${b.voltage!.toFixed(2)} V${b.current != null ? `, ${n1(b.current)} A` : ""}${b.remaining != null ? `, ${b.remaining}% remaining` : ""}`);
    }
    if (isFresh(t.vibration, i.now)) {
      const x = t.vibration!.value;
      live.push(`vibration x ${n1(x.x)} y ${n1(x.y)} z ${n1(x.z)} m/s², clips ${x.clip0 + x.clip1 + x.clip2}`);
    }
    if (isFresh(t.ekf, i.now)) {
      const e = t.ekf!.value;
      live.push(`EKF variances velocity ${e.velVar.toFixed(2)}, position ${e.posHoriz.toFixed(2)}, height ${e.posVert.toFixed(2)}, compass ${e.compass.toFixed(2)}`);
    }
    if (isFresh(t.attitude, i.now)) {
      const a = t.attitude!.value;
      live.push(`roll ${n1((a.roll * 180) / Math.PI)}°, pitch ${n1((a.pitch * 180) / Math.PI)}°`);
    }
    if (isFresh(t.position, i.now)) live.push(`height above home ${n1(t.position!.value.relAlt)} m`);
    if (isFresh(t.rc, i.now)) live.push(`RC receiver: ${t.rc!.value.count} channels`);
    else live.push("no RC receiver data");
    out.push(`Readings: ${live.join("; ")}.`);

    const verdict = preflightVerdict({
      now: i.now,
      armed: v.armed,
      sensors: t.sensors,
      attitude: t.attitude,
      ekf: t.ekf,
      gps: t.gps,
      battery: t.battery,
      vibration: t.vibration,
      battLimits: { low: i.params.BATT_LOW_VOLT, crit: i.params.BATT_CRT_VOLT },
      events: i.events,
    });
    out.push(`Preflight Check: ${verdict.title}. ${verdict.reasons.slice(0, 4).join(" ")}${verdict.prearm.length ? ` Autopilot pre-arm reasons: ${verdict.prearm.slice(0, 4).map((p) => `"${p}"`).join(", ")}.` : ""}`.trim());

    const findings: Finding[] = runDiagnostics({ telemetry: t, params: i.params, armed: v.armed, events: i.events, now: i.now });
    const issues = findings.filter((f) => f.severity === "critical" || f.severity === "warn");
    out.push(issues.length ? `Drone Doctor: ${issues.slice(0, 6).map((f) => `[${f.severity}] ${f.title}${f.metric ? ` (${f.metric})` : ""}`).join("; ")}.` : findings.length ? "Drone Doctor: no issues found." : "Drone Doctor: waiting for data.");

    if (i.paramCount > 0) {
      const older = withOlderNames(i.params);
      const shown = KEY_PARAMS.filter((k) => Number.isFinite(older[k])).map((k) => `${k}=${+older[k].toFixed(4)}`);
      const arming = armingChecks(i.params);
      out.push(`Settings (${i.paramCount} read; shown by their pre-4.7 names and units): ${shown.join(", ")}${arming ? `; arming checks: ${arming}` : ""}.`);
    } else {
      out.push("Settings: not read yet.");
    }

    const texts = i.events.filter((e) => e.level === "vehicle" && i.now - e.at < 120_000).slice(0, 6);
    if (texts.length) out.push(`Recent messages from the aircraft (newest first): ${texts.map((e) => `"${e.text}"`).join("; ")}.`);
  }

  const p = i.plan;
  out.push(
    p.points.length
      ? `Mission plan in AERONEX: ${p.points.length} waypoint${p.points.length === 1 ? "" : "s"}, take-off to ${p.takeoffAlt} m, highest ${Math.max(...p.points.map((x) => x.alt))} m above home, about ${Math.round(routeLength(p.points, p.ending))} m long, ending: ${ENDING[p.ending]}.`
      : "Mission plan in AERONEX: empty.",
  );
  const f = i.fence;
  const on = f.limits.FENCE_ENABLE >= 1;
  out.push(
    `Fence in AERONEX's Fence tab: ${on ? "on" : "off"}, ceiling ${f.limits.FENCE_ALT_MAX} m, distance from home ${f.limits.FENCE_RADIUS} m, ${f.zones.length} zone${f.zones.length === 1 ? "" : "s"}${f.sentAndSame === null ? "" : f.sentAndSame ? "; the aircraft holds this fence" : "; differs from the aircraft's fence (not sent)"}.`,
  );
  return out.join("\n");
}
