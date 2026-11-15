import { ArrowLeftRight, Check, Circle, CircleCheck, CircleX, Download, Hexagon, Info, Redo2, Route, ShieldAlert, ShieldCheck, ShieldOff, Trash2, TriangleAlert, Undo2, Upload, X } from "lucide-react";
import { NumInput } from "../../components/ui/NumInput";
import { ACTIONS, area, FENCE_TYPE, isFlag, LIMIT_RANGE, localZones, OPTION_UNION, withFlag, zoneLabel, type FenceZone, type ZoneRole } from "../../geo/fence";
import type { FenceFinding } from "../../geo/fenceCheck";
import type { LatLon } from "../../geo/geo";
import { fenceSync, useFence } from "../../state/fenceStore";
import { ZONE_COLOR, type FenceDrawing } from "./fenceLayer";

/*
  The Fence tab: the limits, the zones, what the checks found, and whether
  the aircraft holds it. Everything is said in what the aircraft will do,
  with the parameter name beside it for anyone matching it to another tool.
*/

interface Props {
  home: LatLon;
  findings: FenceFinding[];
  drawing: FenceDrawing | null;
  onDraw: (d: FenceDrawing | null) => void;
  onFinish: () => void;
  canWrapRoute: boolean;
  onWrapRoute: () => void;
  linked: boolean;
  virtual: boolean;
  /** Why the fence cannot be sent right now, if it cannot. */
  sendBlock: string | null;
  reading: boolean;
  sending: string | null;
  onSend: () => void;
  onRead: () => void;
}

const size = (m2: number) => (m2 >= 10000 ? `${(m2 / 10000).toFixed(m2 >= 1e6 ? 0 : 1)} ha` : `${Math.round(m2).toLocaleString()} m²`);
const when = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function Limit(props: { label: string; hint: string; param: string; bit?: number; value?: number; unit?: string; min?: number; max?: number; onValue?: (v: number) => void; children?: React.ReactNode }) {
  const f = useFence();
  const on = props.bit === undefined || isFlag(f.limits.FENCE_TYPE, props.bit);
  return (
    <div className={`fz-limit${on ? "" : " off"}`}>
      {props.bit !== undefined ? (
        <input
          type="checkbox"
          checked={on}
          aria-label={`Use the ${props.label.toLowerCase()}`}
          onChange={(e) => f.setLimit("FENCE_TYPE", withFlag(f.limits.FENCE_TYPE, props.bit!, e.target.checked))}
        />
      ) : (
        <span aria-hidden />
      )}
      <div className="fz-limit-text">
        <strong>{props.label}</strong>
        <small>
          {props.hint} <code>{props.param}</code>
        </small>
      </div>
      {props.value !== undefined && props.onValue ? (
        <label className="fz-limit-num">
          <NumInput className="input mp-num" aria-label={props.label} value={props.value} min={props.min} max={props.max} onChange={props.onValue} />
          <span>{props.unit}</span>
        </label>
      ) : (
        props.children
      )}
    </div>
  );
}

export function FencePanel(p: Props) {
  const f = useFence();
  const L = f.limits;
  const sync = fenceSync(f);
  const local = localZones(f.zones, p.home);
  const keepIns = f.zones.filter((z) => z.role === "in").length;
  const badZones = new Set(p.findings.filter((x) => x.sev === "bad" && x.zone && x.scope === "fence").map((x) => x.zone));
  const action = ACTIONS.find((a) => a.value === Math.round(L.FENCE_ACTION));
  const counts = { bad: p.findings.filter((x) => x.sev === "bad").length, warn: p.findings.filter((x) => x.sev === "warn").length };

  const startDraw = (shape: "polygon" | "circle", role: ZoneRole) => p.onDraw({ shape, role, points: [] });
  const detail = (z: FenceZone, i: number) => {
    const lz = local[i];
    if (z.shape === "circle") return `${Math.round(z.radiusM)} m radius · ${size(Math.PI * z.radiusM ** 2)}`;
    return `${z.points.length} corners${lz.shape === "polygon" && z.points.length >= 3 ? ` · ${size(area(lz.pts))}` : ""}`;
  };

  /* --------------------------------------------- where it stands */
  let status: { tone: "ok" | "warn" | "info"; icon: React.ReactNode; title: string; body: string };
  if (!p.linked) {
    status = { tone: "info", icon: <Info />, title: "Not on an aircraft yet", body: "Draw and check the fence here. Link the aircraft to send it." };
  } else if (p.reading || !sync.known) {
    status = { tone: "info", icon: <Info />, title: "Reading the aircraft's fence…", body: "Its zones and FENCE_ settings, to compare with this one." };
  } else if (sync.same) {
    status = { tone: "ok", icon: <ShieldCheck />, title: `The ${p.virtual ? "virtual " : ""}aircraft holds this fence`, body: `Read back and checked at ${when(f.aircraft!.at)}.` };
  } else {
    const what = [sync.zonesDiffer ? "the zones" : "", ...sync.limitsDiffer].filter(Boolean);
    status = { tone: "warn", icon: <ShieldAlert />, title: "Not sent: the aircraft's fence is different", body: `It differs in ${what.slice(0, 4).join(", ")}${what.length > 4 ? "…" : ""}. The aircraft flies with its own until you send this one.` };
  }

  return (
    <div className="panel-body fz">
      <div className={`fz-status ${status.tone}`} role="status">
        {status.icon}
        <div>
          <strong>{status.title}</strong>
          <span>{status.body}</span>
          {f.aircraft?.notes.map((n) => (
            <span key={n} className="fz-note">
              {n}
            </span>
          ))}
        </div>
      </div>

      {/* On or off, first: everything below means nothing while it is off. */}
      <div className="fz-master">
        <div>
          <strong>Fence</strong>
          <small>
            {L.FENCE_ENABLE >= 1 ? "Enforced whenever the aircraft flies." : "Off: the aircraft ignores everything below."} <code>FENCE_ENABLE</code>
          </small>
        </div>
        <div className="segmented" role="group" aria-label="Fence on or off">
          <button aria-pressed={L.FENCE_ENABLE < 1} onClick={() => f.setLimit("FENCE_ENABLE", 0)}>
            <ShieldOff /> Off
          </button>
          <button aria-pressed={L.FENCE_ENABLE >= 1} onClick={() => f.setLimit("FENCE_ENABLE", 1)}>
            <ShieldCheck /> On
          </button>
        </div>
      </div>

      <section className="fz-section" aria-labelledby="fz-limits-h">
        <h4 id="fz-limits-h">Limits</h4>
        <div className="fz-limits">
          <Limit label="Ceiling" hint="Highest it may go, above home." param="FENCE_ALT_MAX" bit={FENCE_TYPE.ALT_MAX} value={L.FENCE_ALT_MAX} unit="m" min={LIMIT_RANGE.FENCE_ALT_MAX[0]} max={LIMIT_RANGE.FENCE_ALT_MAX[1]} onValue={(v) => f.setLimit("FENCE_ALT_MAX", v)} />
          <Limit label="Floor" hint="Lowest it may go once it has climbed past it. Off for landing." param="FENCE_ALT_MIN" bit={FENCE_TYPE.ALT_MIN} value={L.FENCE_ALT_MIN} unit="m" min={LIMIT_RANGE.FENCE_ALT_MIN[0]} max={LIMIT_RANGE.FENCE_ALT_MIN[1]} onValue={(v) => f.setLimit("FENCE_ALT_MIN", v)} />
          <Limit label="Distance from home" hint="A circle round wherever it took off." param="FENCE_RADIUS" bit={FENCE_TYPE.CIRCLE} value={L.FENCE_RADIUS} unit="m" min={LIMIT_RANGE.FENCE_RADIUS[0]} max={LIMIT_RANGE.FENCE_RADIUS[1]} onValue={(v) => f.setLimit("FENCE_RADIUS", v)} />
          <Limit label="Zones on the map" hint={f.zones.length ? `${f.zones.length} drawn below.` : "Areas to stay in or out of, drawn below."} param="FENCE_TYPE" bit={FENCE_TYPE.POLYGON} />
          <Limit label="Margin" hint="How far inside the fence it aims to stay." param="FENCE_MARGIN" value={L.FENCE_MARGIN} unit="m" min={LIMIT_RANGE.FENCE_MARGIN[0]} max={LIMIT_RANGE.FENCE_MARGIN[1]} onValue={(v) => f.setLimit("FENCE_MARGIN", v)} />
        </div>
        <label className="field fz-action">
          <span>
            On a breach <code>FENCE_ACTION</code>
          </span>
          <select className="select" value={Math.round(L.FENCE_ACTION)} onChange={(e) => f.setLimit("FENCE_ACTION", Number(e.target.value))}>
            {ACTIONS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
            {!action && <option value={Math.round(L.FENCE_ACTION)}>Value {L.FENCE_ACTION}, not a Copter action</option>}
          </select>
          <small>{action ? action.detail : "This number is not one Copter knows."} More than 100 m outside the fence, it lands instead, whatever is chosen.</small>
        </label>
        {keepIns >= 2 && (
          <div className="fz-rule">
            <span>
              With more than one keep-in zone <code>FENCE_OPTIONS</code>
            </span>
            <div className="segmented" role="group" aria-label="How keep-in zones combine">
              <button aria-pressed={!isFlag(L.FENCE_OPTIONS, OPTION_UNION)} onClick={() => f.setLimit("FENCE_OPTIONS", withFlag(L.FENCE_OPTIONS, OPTION_UNION, false))}>
                Inside all of them
              </button>
              <button aria-pressed={isFlag(L.FENCE_OPTIONS, OPTION_UNION)} onClick={() => f.setLimit("FENCE_OPTIONS", withFlag(L.FENCE_OPTIONS, OPTION_UNION, true))}>
                Inside any one is enough
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="fz-section" aria-labelledby="fz-zones-h">
        <div className="fz-zones-head">
          <h4 id="fz-zones-h">Zones</h4>
          <div className="mp-tools" role="group" aria-label="Fence tools">
            <button className="icon-btn" disabled={!f.past.length} onClick={f.undo} aria-label="Undo" title="Undo (Ctrl Z)">
              <Undo2 />
            </button>
            <button className="icon-btn" disabled={!f.future.length} onClick={f.redo} aria-label="Redo" title="Redo (Ctrl Shift Z)">
              <Redo2 />
            </button>
            <button className="icon-btn" disabled={!f.zones.length} onClick={f.clearZones} aria-label="Remove every zone" title="Remove every zone (Undo brings them back)">
              <Trash2 />
            </button>
          </div>
        </div>

        {p.drawing ? (
          <div className="fz-drawing" style={{ borderColor: ZONE_COLOR[p.drawing.role] }} role="status">
            <div>
              <strong>
                Drawing a {p.drawing.role === "in" ? "keep-in" : "keep-out"} {p.drawing.shape === "circle" ? "circle" : "area"}
              </strong>
              <span>
                {p.drawing.shape === "circle"
                  ? p.drawing.points.length
                    ? "Click the map where its edge should be."
                    : "Click the map at its centre."
                  : p.drawing.points.length < 3
                    ? `Click the map at each corner: ${p.drawing.points.length} of at least 3 placed.`
                    : `${p.drawing.points.length} corners. Click the first corner or Finish to close it; Backspace removes the last.`}
              </span>
            </div>
            <div className="fz-drawing-acts">
              {p.drawing.shape === "polygon" && (
                <button className="btn btn-sm" disabled={!p.drawing.points.length} onClick={() => p.onDraw({ ...p.drawing!, points: p.drawing!.points.slice(0, -1) })}>
                  <Undo2 /> Corner
                </button>
              )}
              {p.drawing.shape === "polygon" && (
                <button className="btn btn-sm btn-primary" disabled={p.drawing.points.length < 3} onClick={p.onFinish}>
                  <Check /> Finish
                </button>
              )}
              <button className="btn btn-sm" onClick={() => p.onDraw(null)}>
                <X /> Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="fz-add" role="group" aria-label="Add a zone">
            <button className="fz-add-btn in" onClick={() => startDraw("polygon", "in")}>
              <Hexagon /> Keep-in area
            </button>
            <button className="fz-add-btn out" onClick={() => startDraw("polygon", "out")}>
              <Hexagon /> Keep-out area
            </button>
            <button className="fz-add-btn out" onClick={() => startDraw("circle", "out")}>
              <Circle /> Keep-out circle
            </button>
            <button className="fz-add-btn in" onClick={() => startDraw("circle", "in")}>
              <Circle /> Keep-in circle
            </button>
            <button className="fz-add-btn" disabled={!p.canWrapRoute} onClick={p.onWrapRoute} title={p.canWrapRoute ? "A keep-in area round home and every waypoint, with room to spare" : "Add waypoints first"}>
              <Route /> Keep-in round the route
            </button>
          </div>
        )}

        {f.zones.length === 0 && !p.drawing ? (
          <p className="fz-empty">No zones. A keep-in area is the safest fence there is: the aircraft cannot leave it whatever goes wrong with the mission.</p>
        ) : (
          <ul className="fz-list">
            {f.zones.map((z, i) => {
              const sel = f.selected === z.id;
              return (
                <li key={z.id} className={`fz-zone${sel ? " sel" : ""}${badZones.has(z.id) ? " bad" : ""}`}>
                  <button className="fz-zone-main" aria-pressed={sel} onClick={() => f.select(sel ? null : z.id)}>
                    <i className={`fz-swatch ${z.role} ${z.shape}`} style={{ borderColor: ZONE_COLOR[z.role], background: z.role === "out" ? `${ZONE_COLOR.out}33` : "transparent" }} aria-hidden />
                    <span>
                      <strong>{zoneLabel(f.zones, z.id)}</strong>
                      <small>{detail(z, i)}</small>
                    </span>
                    {badZones.has(z.id) && <CircleX className="fz-zone-bad" aria-label="Has a problem" />}
                  </button>
                  <button className="icon-btn" title={z.role === "in" ? "Make it a keep-out zone" : "Make it a keep-in zone"} aria-label={`Make ${zoneLabel(f.zones, z.id)} a ${z.role === "in" ? "keep-out" : "keep-in"} zone`} onClick={() => f.updateZone(z.id, { role: z.role === "in" ? "out" : "in" })}>
                    <ArrowLeftRight />
                  </button>
                  <button className="icon-btn" title="Remove" aria-label={`Remove ${zoneLabel(f.zones, z.id)}`} onClick={() => f.removeZone(z.id)}>
                    <Trash2 />
                  </button>
                  {sel && (
                    <div className="fz-zone-edit">
                      {z.shape === "circle" ? (
                        <label className="fz-limit-num">
                          <span>Radius</span>
                          <NumInput className="input mp-num" aria-label="Radius" value={Math.round(z.radiusM * 10) / 10} min={1} max={100000} onChange={(v) => f.updateZone(z.id, { radiusM: v })} />
                          <span>m</span>
                        </label>
                      ) : null}
                      <small>{z.shape === "circle" ? "Drag its centre or its edge on the map." : "Drag a corner on the map to move it. Click a + on an edge to add a corner; right-click a corner to remove it."}</small>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="mp-check" aria-live="polite">
        <h4>Fence check</h4>
        {counts.bad + counts.warn === 0 && (
          <p className="mp-check-ok">
            <CircleCheck aria-hidden /> Nothing ArduPilot would refuse, and nothing in the plan crosses it.
          </p>
        )}
        <ul>
          {p.findings.map((c) => (
            <li key={c.text} className={c.sev}>
              {c.sev === "bad" ? <CircleX aria-hidden /> : c.sev === "warn" ? <TriangleAlert aria-hidden /> : <Info aria-hidden />}
              <span>
                {c.zone ? (
                  <button className="link-btn" onClick={() => f.select(c.zone!)}>
                    {c.text}
                  </button>
                ) : (
                  c.text
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="fz-send">
        <button className="btn btn-primary" disabled={!p.linked || !!p.sendBlock || !!p.sending || !!p.drawing} onClick={p.onSend} title={!p.linked ? "Link an aircraft first" : p.sendBlock ?? (p.drawing ? "Finish the zone being drawn first" : undefined)}>
          <Upload /> {p.sending ?? `Send fence to ${p.virtual ? "virtual aircraft" : "aircraft"}`}
        </button>
        <button className="btn" disabled={!p.linked || p.reading || !!p.sending} onClick={p.onRead} title={p.linked ? "Replace this fence with the one on the aircraft (Undo brings this one back)" : "Link an aircraft first"}>
          <Download /> {p.reading ? "Reading…" : "Read from aircraft"}
        </button>
      </div>
    </div>
  );
}
