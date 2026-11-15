import {
  area,
  breachAt,
  FENCE_TYPE,
  GIVE_UP_M,
  isFlag,
  legBreach,
  legClearance,
  LIMIT_RANGE,
  localZones,
  OPTION_UNION,
  PIXHAWK_FENCE_BYTES,
  selfCrossings,
  storageBytes,
  toBoundary,
  zoneLabel,
  zonesToWire,
  type FenceLimits,
  type FenceZone,
  type LocalZone,
  type P,
} from "./fence";
import { type LatLon } from "./geo";

/*
  Checking a fence before it goes to the aircraft.

  Three kinds of trouble, and the order they are worst in:

  1. The aircraft will refuse it. ArduPilot's pre-arm checks
     (AC_Fence::pre_arm_check) and its fence loader turn away a fence that
     breaks their rules. That is safe but stops the flight on the field, so
     each rule is checked here with the firmware's own message alongside.
  2. The aircraft will take it and it is wrong. A crossed polygon is accepted
     and silently has holes; a keep-in that leaves home outside, or a
     keep-out across the route, turns the mission round part way. These are
     the dangerous ones and are marked as problems.
  3. It works, with a catch: a waypoint inside the margin, a return home that
     cuts through a keep-out, a floor the landing would cross.

  Each finding says which zone, so the page can point at it.
*/

export interface FenceFinding {
  sev: "bad" | "warn" | "note";
  text: string;
  /** Fence findings concern the fence; route findings also belong in the plan check. */
  scope: "fence" | "route";
  zone?: string;
}

export interface FenceCheckInput {
  zones: FenceZone[];
  limits: FenceLimits;
  home: LatLon;
  /** Other settings, when known: FENCE_MARGIN_XY, FENCE_AUTOENABLE, FENCE_ALT_MAX_TP, FENCE_ALT_MIN_TP, OA_TYPE, RTL_ALT (cm), BRD_SD_FENCE, WPNAV_SPEED (cm/s), WPNAV_ACCEL (cm/s²). */
  other?: Record<string, number | undefined>;
  plan?: {
    points: { n: number; e: number; alt: number }[];
    takeoffAlt: number;
    ending: "rtl" | "land" | "hold";
  };
}

const m = (v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)} km` : `${Math.round(v)} m`);
const m1 = (v: number) => `${Math.abs(v) < 10 ? v.toFixed(1) : Math.round(v)} m`;

/** The horizontal margin ArduPilot keeps from the zones and the circle (FENCE_MARGIN_XY when set, else FENCE_MARGIN). */
export function marginXY(limits: FenceLimits, other?: Record<string, number | undefined>): number {
  const xy = other?.FENCE_MARGIN_XY;
  return typeof xy === "number" && xy > 0 ? xy : limits.FENCE_MARGIN;
}

/** Whether the fence will be live in flight: switched on, or switched on by arming (FENCE_AUTOENABLE). */
export function fenceLive(limits: FenceLimits, other?: Record<string, number | undefined>): boolean {
  return limits.FENCE_ENABLE >= 1 || (other?.FENCE_AUTOENABLE ?? 0) > 0;
}

export function checkFence(inp: FenceCheckInput): FenceFinding[] {
  const out: FenceFinding[] = [];
  const { zones, limits: L, home, other, plan } = inp;
  const type = Math.round(L.FENCE_TYPE);
  const live = fenceLive(L, other);
  const marg = marginXY(L, other);
  const union = isFlag(L.FENCE_OPTIONS, OPTION_UNION);
  const usesZones = isFlag(type, FENCE_TYPE.POLYGON);
  const usesCircle = isFlag(type, FENCE_TYPE.CIRCLE);
  const usesCeiling = isFlag(type, FENCE_TYPE.ALT_MAX);
  const usesFloor = isFlag(type, FENCE_TYPE.ALT_MIN);
  const label = (z: { id: string }) => zoneLabel(zones, z.id);
  const local = localZones(zones, home);
  // A refusal is a problem only once the fence is on; before that it is a warning of what will happen.
  const refusal = live ? "bad" : "warn";

  /* ------------------------------------------------ whether it is on */
  const auto = Math.round(other?.FENCE_AUTOENABLE ?? 0);
  if (!live) {
    // Off with zones drawn is a fence that looks like protection and is not; off with nothing drawn is a choice.
    out.push({ sev: zones.length ? "warn" : "note", scope: "fence", text: zones.length ? "The fence is off (FENCE_ENABLE 0), so the zones drawn here are not enforced. Turn it on and send it to the aircraft." : "The fence is off (FENCE_ENABLE 0). Nothing below is enforced until it is turned on and sent to the aircraft." });
  } else if (L.FENCE_ENABLE < 1 && auto === 3) {
    out.push({ sev: "note", scope: "fence", text: "The fence is off on the ground and switches itself on when the aircraft arms (FENCE_AUTOENABLE 3)." });
  }
  if (auto === 1 || auto === 2) {
    out.push({ sev: "warn", scope: "fence", text: `FENCE_AUTOENABLE is ${auto}: the fence only switches on after an automatic take-off, so a flight started by hand has none. ArduPilot is retiring this value; 3 (on when armed) is its replacement.` });
  }

  /* ------------------------------------------- what it is made of */
  const present = (type & (FENCE_TYPE.ALT_MAX | FENCE_TYPE.CIRCLE | FENCE_TYPE.ALT_MIN)) | (usesZones && zones.length ? FENCE_TYPE.POLYGON : 0);
  if (live && !present) {
    out.push({
      sev: "bad",
      scope: "fence",
      text: usesZones
        ? "The fence is on but holds nothing: only zones are chosen, and none are drawn. ArduPilot refuses to arm (\"Fences enabled, but none selected\"). Draw a zone, or choose a ceiling or a distance from home."
        : "The fence is on but no kind of fence is chosen. ArduPilot refuses to arm (\"Fences enabled, but none selected\").",
    });
  }
  if (zones.length && !usesZones) {
    out.push({ sev: "warn", scope: "fence", text: `${zones.length === 1 ? "The zone drawn is" : `The ${zones.length} zones drawn are`} not used: "Zones on the map" is off in the fence type (FENCE_TYPE). Turn it on, or the aircraft ignores them.` });
  }
  if (live && L.FENCE_ACTION === 0) {
    out.push({ sev: "warn", scope: "fence", text: "On a breach the aircraft only reports it (FENCE_ACTION 0) and keeps flying through the fence. Choose an action if the fence is there to stop it." });
  }

  /* ------------------------------------------------- the numbers */
  const range = (name: keyof typeof LIMIT_RANGE, what: string) => {
    const [lo, hi] = LIMIT_RANGE[name];
    const v = L[name];
    if (v < lo || v > hi) out.push({ sev: "warn", scope: "fence", text: `${what} is ${v} (${name}), outside the ${lo} to ${hi} ArduPilot allows for it.` });
  };
  if (usesCeiling) range("FENCE_ALT_MAX", "The ceiling");
  if (usesFloor) range("FENCE_ALT_MIN", "The floor");
  if (usesCircle) range("FENCE_RADIUS", "The distance from home");
  range("FENCE_MARGIN", "The margin");

  if (L.FENCE_ALT_MAX < 0) out.push({ sev: refusal, scope: "fence", text: `The ceiling is below zero. ArduPilot refuses to arm ("Invalid FENCE_ALT_MAX value").` });
  if (L.FENCE_ALT_MIN < -100) out.push({ sev: refusal, scope: "fence", text: `The floor is below -100 m. ArduPilot refuses to arm ("Invalid FENCE_ALT_MIN value").` });
  if (L.FENCE_ALT_MAX < L.FENCE_ALT_MIN) {
    out.push({ sev: refusal, scope: "fence", text: `The ceiling (${m(L.FENCE_ALT_MAX)}) is below the floor (${m(L.FENCE_ALT_MIN)}). ArduPilot refuses to arm ("FENCE_ALT_MAX < FENCE_ALT_MIN").` });
  } else if (L.FENCE_ALT_MAX - L.FENCE_ALT_MIN <= 2 * L.FENCE_MARGIN) {
    out.push({ sev: refusal, scope: "fence", text: `Between the floor (${m(L.FENCE_ALT_MIN)}) and the ceiling (${m(L.FENCE_ALT_MAX)}) there is no room once the ${m1(L.FENCE_MARGIN)} margin is kept from each. ArduPilot refuses to arm ("FENCE_MARGIN too big").` });
  }
  // ArduPilot checks the radius against the margin whether or not the circle is in use.
  if (L.FENCE_RADIUS < marg) {
    out.push({ sev: refusal, scope: "fence", text: `The distance from home (${m(L.FENCE_RADIUS)}) is less than the margin (${m1(marg)}). ArduPilot refuses to arm ("Circle FENCE_MARGIN is greater than FENCE_RADIUS"), even with the circle not in use.` });
  }
  const maxFrame = other?.FENCE_ALT_MAX_TP;
  const minFrame = other?.FENCE_ALT_MIN_TP;
  const FRAMES = ["above sea level", "above home", "above the EKF origin", "above the ground"];
  if (usesCeiling && maxFrame !== undefined && Math.round(maxFrame) !== 1) {
    out.push({ sev: "warn", scope: "fence", text: `The ceiling is measured ${FRAMES[Math.round(maxFrame)] ?? `in frame ${maxFrame}`} (FENCE_ALT_MAX_TP), not above home. The checks here compare it with heights above home, so they may not match what the aircraft does.` });
  }
  if (usesFloor && minFrame !== undefined && Math.round(minFrame) !== 1) {
    out.push({ sev: "warn", scope: "fence", text: `The floor is measured ${FRAMES[Math.round(minFrame)] ?? `in frame ${minFrame}`} (FENCE_ALT_MIN_TP), not above home. The checks here compare it with heights above home.` });
  }

  /* ---------------------------------------------------- the shapes */
  for (const z of zones) {
    const lz = local.find((x) => x.id === z.id)!;
    if (z.shape === "polygon" && lz.shape === "polygon") {
      if (z.points.length < 3) {
        out.push({ sev: "bad", scope: "fence", zone: z.id, text: `${label(z)} has ${z.points.length} ${z.points.length === 1 ? "corner" : "corners"}. An area needs at least 3; the aircraft refuses fewer ("Invalid vertex count").` });
        continue;
      }
      if (z.points.length > 255) out.push({ sev: "bad", scope: "fence", zone: z.id, text: `${label(z)} has ${z.points.length} corners. The aircraft takes at most 255 in one area.` });
      const dup = lz.pts.findIndex((p, i) => {
        const q = lz.pts[(i + 1) % lz.pts.length];
        return Math.hypot(p.n - q.n, p.e - q.e) < 0.1;
      });
      if (dup >= 0) {
        out.push({ sev: "bad", scope: "fence", zone: z.id, text: `${label(z)} has two corners in the same place (${dup + 1} and ${((dup + 1) % lz.pts.length) + 1}). Remove one.` });
      }
      if (dup < 0 && onALine(lz.pts)) {
        out.push({ sev: "bad", scope: "fence", zone: z.id, text: `${label(z)} has no area: its corners lie on a line.` });
        continue;
      }
      const crossed = selfCrossings(lz.pts);
      if (!crossed.length && dup < 0 && area(lz.pts) < 1) {
        out.push({ sev: "bad", scope: "fence", zone: z.id, text: `${label(z)} is smaller than a square metre. Draw it again.` });
      }
      if (crossed.length) {
        const [i, j] = crossed[0];
        out.push({
          sev: "bad",
          scope: "fence",
          zone: z.id,
          text: `${label(z)} crosses itself: the edge from corner ${i + 1} meets the edge from corner ${j + 1}. ArduPilot accepts a shape like this and decides inside and outside by counting edges, so parts of it are not where they look. Drag the corners so no edges cross.`,
        });
      }
    } else if (z.shape === "circle") {
      if (!(z.radiusM > 0)) out.push({ sev: "bad", scope: "fence", zone: z.id, text: `${label(z)} has no radius. The aircraft refuses it ("Non-positive circle radius").` });
      else if (z.role === "in" && usesZones && z.radiusM < marg) {
        out.push({ sev: refusal, scope: "fence", zone: z.id, text: `${label(z)} (${m1(z.radiusM)} across from its centre) is smaller than the ${m1(marg)} margin. ArduPilot refuses to arm ("Polygon fence margin is greater than inclusion circle radius").` });
      }
    }
    const c = lz.shape === "circle" ? lz.c : lz.pts[0];
    if (c && Math.hypot(c.n, c.e) > 25000) out.push({ sev: "warn", scope: "fence", zone: z.id, text: `${label(z)} is ${m(Math.hypot(c.n, c.e))} from home. Is it in the right place?` });
  }

  /* ---------------------------------------------- what fits on board */
  if (zones.length) {
    const sd = other?.BRD_SD_FENCE ?? 0;
    const room = sd > 0 ? sd * 1024 : PIXHAWK_FENCE_BYTES;
    const bytes = storageBytes(zones);
    const items = zonesToWire(zones).length;
    if (bytes > room || items > Math.floor(room / 8)) {
      out.push({
        sev: "warn",
        scope: "fence",
        text: `${items} fence items need ${bytes} bytes. A Pixhawk keeps ${room} bytes for the fence${sd > 0 ? " on its SD card (BRD_SD_FENCE)" : ""}, so the aircraft may refuse this one ("Fence exceeds storage size"). Use fewer corners${sd > 0 ? "" : ", or give the fence room on the SD card with BRD_SD_FENCE"}.`,
      });
    }
  }

  /* ------------------------------------------------ the zones in use */
  // The ones that will act: the drawn shapes that are whole, when zones are chosen.
  const sound = local.filter((z) => (z.shape === "circle" ? z.r > 0 : z.pts.length >= 3 && !selfCrossings(z.pts).length));
  const acting = usesZones ? sound : [];
  const homeP: P = { n: 0, e: 0 };

  if (acting.length) {
    const z = breachAt(acting, homeP, union);
    if (z) {
      const otherIn = acting.filter((x) => x.role === "in" && x.id !== z.id && breachAt([x], homeP, false) === null);
      out.push({
        sev: refusal,
        scope: "fence",
        zone: z.id,
        text:
          z.role === "out"
            ? `Home is inside ${label(z)}. The aircraft takes off in a keep-out zone and ArduPilot refuses to arm ("Vehicle breaching Polygon fence").`
            : !union && otherIn.length
              ? `Home is outside ${label(z)} though inside ${label(otherIn[0])}. With more than one keep-in zone the aircraft must be inside all of them, so ArduPilot refuses to arm. To fly inside any one of them, turn on "Inside any keep-in zone is enough".`
              : `Home is outside ${label(z)}. The aircraft must take off inside every keep-in zone; ArduPilot refuses to arm here ("Vehicle breaching Polygon fence"). Move the zone round home, or check home is where the aircraft will take off.`,
    });
    } else {
      // Close to an edge: the margin is breached from the start.
      const near = acting.map((x) => ({ x, d: toBoundary(x, homeP) })).sort((a, b) => a.d - b.d)[0];
      if (near && near.d < marg) {
        out.push({ sev: "warn", scope: "fence", zone: near.x.id, text: `Home is ${m1(near.d)} from the edge of ${label(near.x)}, inside the ${m1(marg)} margin. Take off further from it.` });
      }
    }
  }

  /* -------------------------------------------------------- the route */
  if (!plan || !plan.points.length) return out;
  const pts = plan.points;
  const name = (i: number) => (i < 0 ? "home" : `waypoint ${i + 1}`);
  const legs: { from: number; to: number; a: P; b: P }[] = [];
  // Take-off goes straight up from home, so the first leg starts there.
  for (let i = 0; i < pts.length; i++) legs.push({ from: i - 1, to: i, a: i === 0 ? homeP : pts[i - 1], b: pts[i] });
  const backHome = plan.ending === "rtl";
  if (backHome) legs.push({ from: pts.length - 1, to: -1, a: pts[pts.length - 1], b: homeP });
  const onWord = actionWords(L.FENCE_ACTION);

  // Zones, leg by leg.
  if (acting.length) {
    const hit: string[] = [];
    let first: { leg: (typeof legs)[number]; br: NonNullable<ReturnType<typeof legBreach>> } | null = null;
    for (const leg of legs) {
      const br = legBreach(acting, leg.a, leg.b, union);
      if (br) {
        first ??= { leg, br };
        hit.push(`${name(leg.from)} to ${name(leg.to)}`);
      }
    }
    if (first) {
      const { leg, br } = first;
      const along = Math.hypot(br.at.n - leg.a.n, br.at.e - leg.a.e);
      const verb = br.zone.role === "out" ? `enters ${label(br.zone)}` : `leaves ${label(br.zone)}`;
      const where = along < 1 ? `at ${name(leg.from)}` : `${m(along)} after ${name(leg.from)}`;
      // A breach is noticed at the edge, at cruise speed: the aircraft carries on while it stops.
      const v = (other?.WPNAV_SPEED ?? 0) / 100;
      const acc = (other?.WPNAV_ACCEL ?? 0) / 100;
      const stop = v > 0 && acc > 0 ? (v * v) / (2 * acc) : 0;
      const past = stop >= 2 ? ` At its ${Math.round(v)} m/s cruise it needs about ${Math.round(stop)} m to stop, so expect it that far ${br.zone.role === "out" ? "inside the zone" : "outside"} before it turns.` : "";
      out.push({
        sev: live ? "bad" : "warn",
        scope: "route",
        zone: br.zone.id,
        text: `The route ${verb} ${where}, on the way to ${name(leg.to)}. ${live ? `The fence stops the mission there: ${onWord}.${past}` : "Once the fence is on, the mission will stop there."}${hit.length > 1 ? ` ${hit.length} legs breach the zones in all (${hit.slice(0, 4).join("; ")}${hit.length > 4 ? "; …" : ""}).` : ""}`,
      });
    } else {
      // Inside the margin: allowed, but the aircraft reports it and an operator should know.
      let closest = { d: Infinity, zone: null as LocalZone | null, leg: legs[0] };
      for (const leg of legs) {
        const c = legClearance(acting, leg.a, leg.b);
        if (c.m < closest.d) closest = { d: c.m, zone: c.zone, leg };
      }
      if (closest.zone && closest.d < marg) {
        out.push({ sev: "warn", scope: "route", zone: closest.zone.id, text: `The route passes ${m1(closest.d)} from the edge of ${label(closest.zone)}, between ${name(closest.leg.from)} and ${name(closest.leg.to)}. That is inside the ${m1(marg)} margin: GPS drift or wind can carry it across.` });
      }
    }

    // Coming home early: straight back from wherever it is, through whatever lies between.
    const oa = Math.round(other?.OA_TYPE ?? 0);
    const crossHome: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      if (legBreach(acting, pts[i], homeP, union)) crossHome.push(i);
    }
    if (crossHome.length) {
      const names = crossHome.slice(0, 5).map((i) => i + 1).join(", ");
      const planned = oa === 2 || oa === 3;
      out.push({
        sev: planned ? "note" : "warn",
        scope: "route",
        text: planned
          ? `From waypoint${crossHome.length > 1 ? "s" : ""} ${names} the straight way home crosses a zone. Object avoidance (OA_TYPE ${oa}, Dijkstra) plans round fences in Auto and RTL, so a return from there should go round it.`
          : `From waypoint${crossHome.length > 1 ? "s" : ""} ${names}${crossHome.length > 5 ? " and others" : ""}, the straight way home crosses a zone. A return home (low battery, lost radio, or a fence breach) flies straight back and does not steer round it: it would breach on the way and land there. Move the zone, or the route, or plan around it with OA_TYPE 2.`,
      });
    }
  }

  // The circle round home.
  if (usesCircle) {
    const dist = pts.map((w) => Math.hypot(w.n, w.e));
    const far = Math.max(...dist);
    const i = dist.indexOf(far);
    if (far >= L.FENCE_RADIUS) {
      out.push({ sev: live ? "bad" : "warn", scope: "route", text: `Waypoint ${i + 1} is ${m(far)} from home, outside the ${m(L.FENCE_RADIUS)} distance limit (FENCE_RADIUS). ${live ? `The aircraft turns back at the limit: ${onWord}.` : "Once the fence is on, the mission stops at the limit."}` });
    } else if (far > L.FENCE_RADIUS - marg) {
      out.push({ sev: "warn", scope: "route", text: `Waypoint ${i + 1} is ${m(far)} from home, within ${m1(marg)} of the ${m(L.FENCE_RADIUS)} distance limit.` });
    }
  }

  // The ceiling.
  const heights = [plan.takeoffAlt, ...pts.map((w) => w.alt)];
  if (usesCeiling) {
    const top = Math.max(...heights);
    const at = heights.indexOf(top);
    const where = at === 0 ? "The take-off" : `Waypoint ${at}`;
    if (top >= L.FENCE_ALT_MAX) {
      out.push({ sev: live ? "bad" : "warn", scope: "route", text: `${where} goes to ${m(top)}, at or above the ${m(L.FENCE_ALT_MAX)} ceiling (FENCE_ALT_MAX). ${live ? `The aircraft breaches there: ${onWord}.` : "Once the fence is on, the aircraft will breach there."}` });
    } else if (top > L.FENCE_ALT_MAX - L.FENCE_MARGIN) {
      out.push({ sev: "warn", scope: "route", text: `${where} goes to ${m(top)}, within the ${m1(L.FENCE_MARGIN)} margin below the ${m(L.FENCE_ALT_MAX)} ceiling.` });
    }
    const rtl = (other?.RTL_ALT ?? 0) / 100;
    const cap = L.FENCE_ALT_MAX - L.FENCE_MARGIN;
    if (live && backHome && rtl > cap) {
      out.push({ sev: "note", scope: "route", text: `The return home is set for ${m(rtl)} (RTL_ALT), above the ceiling less its margin. ArduPilot flies it at ${m(cap)} instead.` });
    }
  }

  // The floor: it switches on once the aircraft first climbs past it with the margin, and off for the landing.
  if (usesFloor) {
    const on = L.FENCE_ALT_MIN + L.FENCE_MARGIN;
    const firstAbove = heights.findIndex((h) => h >= on);
    if (firstAbove < 0) {
      out.push({ sev: "note", scope: "route", text: `The plan never climbs above ${m(on)}, so the floor (${m(L.FENCE_ALT_MIN)} plus the margin) never switches on.` });
    } else {
      for (let k = firstAbove + 1; k < heights.length; k++) {
        if (heights[k] <= L.FENCE_ALT_MIN) {
          out.push({ sev: live ? "bad" : "warn", scope: "route", text: `Waypoint ${k} is at ${m(heights[k])}, below the ${m(L.FENCE_ALT_MIN)} floor (FENCE_ALT_MIN) the aircraft has already risen above. ${live ? `It breaches there: ${onWord}.` : "Once the fence is on, it will breach there."}` });
          break;
        }
        if (heights[k] < on) {
          out.push({ sev: "warn", scope: "route", text: `Waypoint ${k} is at ${m(heights[k])}, within the ${m1(L.FENCE_MARGIN)} margin above the ${m(L.FENCE_ALT_MIN)} floor.` });
          break;
        }
      }
    }
  }

  return out;
}

/** All the corners within half a metre of one straight line. */
function onALine(pts: P[]): boolean {
  const a = pts[0];
  const b = pts.reduce((f, p) => (Math.hypot(p.n - a.n, p.e - a.e) > Math.hypot(f.n - a.n, f.e - a.e) ? p : f), a);
  const len = Math.hypot(b.n - a.n, b.e - a.e);
  if (len < 0.5) return true;
  return pts.every((p) => Math.abs((b.e - a.e) * (p.n - a.n) - (b.n - a.n) * (p.e - a.e)) / len < 0.5);
}

/** What the aircraft does on a breach, as a clause. */
export function actionWords(action: number): string {
  switch (Math.round(action)) {
    case 0:
      return "it only reports the breach and carries on";
    case 2:
      return "it lands where it is";
    case 3:
      return "it retraces its path home (SmartRTL), or returns home";
    case 4:
      return "it brakes and holds there";
    case 5:
      return "it retraces its path home (SmartRTL), or lands";
    default:
      return `it returns home, and lands where it is if it is more than ${GIVE_UP_M} m outside`;
  }
}
