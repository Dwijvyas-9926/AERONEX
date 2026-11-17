import { PackageOpen, X } from "lucide-react";
import { NumInput } from "../../components/ui/NumInput";
import { deliverySentence, releaseKey, switchMethod, type Delivery, type Method, type ReleaseOption } from "../../mission/payload";

/*
  A payload delivery, as a row of the mission list under its waypoint: what
  the aircraft will do there in one sentence, and the few numbers that decide
  it. Every number is the one the mission is written from.
*/
interface Props {
  wp: number;
  delivery: Delivery;
  /** Height of the waypoint above home, m. */
  cruise: number;
  /** Ground there above home, m; null where it is not known. */
  ground: number | null;
  options: ReleaseOption[];
  port: (servo: number) => string;
  params: Record<string, number | undefined>;
  onChange: (d: Delivery) => void;
  onRemove: () => void;
}

export function DeliveryRow({ wp, delivery: d, cruise, ground, options, port, params, onChange, onRemove }: Props) {
  const set = (patch: Partial<Delivery>) => onChange({ ...d, ...patch });
  const key = releaseKey(d.release);
  // The release in use is always offered, even when the aircraft lacks it: the check says why.
  const shown = options.some((o) => releaseKey(o.release) === key) ? options : [...options, { release: d.release, label: d.release.kind === "gripper" ? "Gripper" : `Servo on ${port(d.release.servo)}`, problem: "Not on this aircraft" }];
  const lowerOnly = d.method === "lower";
  return (
    <tr className={`mp-cmd deliver ${d.method}`}>
      <td className="c-n">
        <PackageOpen aria-label={`Payload delivery at waypoint ${wp}`} />
      </td>
      <td className="c-what" colSpan={6}>
        <div className="mp-dl">
        <div className="mp-dl-head">
          <div>
            <strong>{d.method === "drop" ? `Drop the payload at waypoint ${wp}` : `Lower the payload to the ground at waypoint ${wp}`}</strong>
            <small>{deliverySentence(d, cruise, ground, port, params)}</small>
          </div>
          <button className="icon-btn" aria-label={`Remove the delivery at waypoint ${wp}`} title="Remove the delivery (the waypoint stays)" onClick={onRemove}>
            <X />
          </button>
        </div>
        <div className="mp-dl-grid">
          <div className="segmented mp-dl-method" role="group" aria-label={`How the payload is delivered at waypoint ${wp}`}>
            {(
              [
                ["drop", "Drop from a height"],
                ["lower", "Lower to the ground"],
              ] as [Method, string][]
            ).map(([k, label]) => (
              <button key={k} aria-pressed={d.method === k} onClick={() => onChange(switchMethod(d, k))}>
                {label}
              </button>
            ))}
          </div>
          <label className="field mp-dl-release">
            <span>Let go with</span>
            <select
              className="select"
              value={key}
              disabled={lowerOnly}
              title={lowerOnly ? "Lowering to the ground opens only a gripper." : undefined}
              onChange={(e) => {
                const o = shown.find((x) => releaseKey(x.release) === e.target.value);
                if (!o) return;
                // A servo keeps the positions already set for it.
                set({ release: o.release.kind === "servo" && d.release.kind === "servo" && d.release.servo === o.release.servo ? d.release : o.release });
              }}
            >
              {shown.map((o) => (
                <option key={releaseKey(o.release)} value={releaseKey(o.release)} disabled={lowerOnly && o.release.kind !== "gripper"}>
                  {o.label}
                  {o.problem ? " (not ready)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{d.method === "drop" ? "Let go at, m above ground" : "Lower from, m above ground"}</span>
            <NumInput className="input" aria-label={`Waypoint ${wp} ${d.method === "drop" ? "release" : "lowering start"} height above the ground`} value={d.heightM} min={1} max={500} step="any" onChange={(v) => set({ heightM: v })} />
          </label>
          <label className="field">
            <span>Payload, kg</span>
            <NumInput className="input" aria-label={`Waypoint ${wp} payload weight`} value={d.kg} min={0} max={50} step="any" onChange={(v) => set({ kg: v })} />
          </label>
          {d.method === "drop" ? (
            <>
              <label className="field">
                <span>Hold still before, s</span>
                <NumInput className="input" aria-label={`Waypoint ${wp} seconds to hold still before letting go`} value={d.settleS} min={1} max={120} onChange={(v) => set({ settleS: Math.round(v) })} />
              </label>
              <label className="field">
                <span>Wait after, s</span>
                <NumInput className="input" aria-label={`Waypoint ${wp} seconds to wait after letting go`} value={d.afterS} min={1} max={120} onChange={(v) => set({ afterS: Math.round(v) })} />
              </label>
            </>
          ) : (
            <>
              <label className="field">
                <span>Give up after, m down</span>
                <NumInput className="input" aria-label={`Waypoint ${wp} metres to descend before giving up`} value={d.giveUpM} min={1} max={500} onChange={(v) => set({ giveUpM: Math.round(v) })} />
              </label>
              <label className="field">
                <span>Hangs below, m</span>
                <NumInput className="input" aria-label={`Waypoint ${wp} how far the payload hangs below the aircraft`} value={d.hangM} min={0} max={30} step="any" onChange={(v) => set({ hangM: v })} />
              </label>
            </>
          )}
          {d.release.kind === "servo" && d.method === "drop" && (
            <>
              <label className="field">
                <span>Open, µs</span>
                <NumInput className="input" aria-label={`Waypoint ${wp} servo pulse that lets go`} value={d.release.open} min={500} max={2500} onChange={(v) => d.release.kind === "servo" && set({ release: { ...d.release, open: Math.round(v) } })} />
              </label>
              <label className="field">
                <span>Closed, µs</span>
                <NumInput className="input" aria-label={`Waypoint ${wp} servo pulse that holds`} value={d.release.closed} min={500} max={2500} onChange={(v) => d.release.kind === "servo" && set({ release: { ...d.release, closed: Math.round(v) } })} />
              </label>
            </>
          )}
        </div>
        </div>
      </td>
    </tr>
  );
}
