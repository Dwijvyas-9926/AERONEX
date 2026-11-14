import { BookOpen, CircleAlert, Info, Power, RotateCcw, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { bitsOf, checkValue, describeValue, groupOf, groupTitle, optionLabel, trimNum, unitText, withBit, type MetaSet, type ParamDef } from "../../mavlink/paramMeta";

/*
  Everything about one parameter: what it is for in plain words, the units,
  range and options the firmware documents, and an editor that fits the kind
  of value (a list of options, a set of switches, or a number).

  The parent keys this component by parameter and value, so a new selection
  or a new value from the aircraft starts a fresh editor.
*/

const TYPE_NAMES: Record<number, string> = {
  1: "Whole number, 0 to 255",
  2: "Whole number, −128 to 127",
  3: "Whole number, 0 to 65,535",
  4: "Whole number, −32,768 to 32,767",
  5: "Whole number, 0 to 4,294,967,295",
  6: "Whole number, 32-bit",
  9: "Decimal",
};

interface Props {
  name: string;
  def: ParamDef | undefined;
  meta: MetaSet | null;
  metaFailed: boolean;
  value: number | undefined;
  staged: number | undefined;
  type: number | undefined;
  allowOutside: boolean;
  disabled: boolean;
  onStage: (value: number, allowOutside: boolean) => void;
  onUnstage: () => void;
}

export function ParamDetail({ name, def, meta, metaFailed, value, staged, type, allowOutside, disabled, onStage, onUnstage }: Props) {
  const shown = staged ?? value;
  const [draft, setDraft] = useState<string>(shown === undefined ? "" : trimNum(shown));
  const [override, setOverride] = useState(allowOutside);

  const candidate = draft.trim() === "" ? NaN : Number(draft);
  const checks = checkValue(def, candidate, type);
  const hasError = checks.some((c) => c.level === "error");
  const outside = checks.some((c) => c.level === "outside");
  const dirty = Number.isFinite(candidate) && (shown === undefined || Math.abs(candidate - shown) > 1e-9);
  const canStage = !disabled && dirty && !hasError && (!outside || override) && !def?.ro;
  const stage = () => canStage && onStage(candidate, outside);

  const set = (v: number) => setDraft(trimNum(v));

  return (
    <article className="pd" aria-label={`${name} details`}>
      <header className="pd-head">
        <span className="pd-group">{groupTitle(groupOf(name))}</span>
        <h2>{def?.n || name}</h2>
        <code className="pd-name">{name}</code>
      </header>

      {def ? (
        <p className="pd-desc">{def.d}</p>
      ) : (
        <p className="pd-desc muted">
          {meta
            ? `${meta.firmware}'s documentation has no entry for ${name}. It may come from a newer firmware, a Lua script or a feature built into this board only. Change it only if you know what it does.`
            : metaFailed
              ? "The parameter descriptions could not be loaded. Values can still be read and changed."
              : "Loading the description…"}
        </p>
      )}

      <dl className="pd-facts">
        <div>
          <dt>On the aircraft</dt>
          <dd>{value === undefined ? "—" : <><strong>{trimNum(value)}</strong> <span className="muted">{meaning(meta, def, value)}</span></>}</dd>
        </div>
        {def?.u && (
          <div>
            <dt>Units</dt>
            <dd>{def.u}{unitText(meta, def.u) !== def.u && <span className="muted"> · {unitText(meta, def.u)}</span>}</dd>
          </div>
        )}
        {def?.r && (
          <div>
            <dt>Documented range</dt>
            <dd>{trimNum(def.r[0])} to {trimNum(def.r[1])}{def.u ? ` ${def.u}` : ""}</dd>
          </div>
        )}
        {def?.i !== undefined && (
          <div>
            <dt>Step</dt>
            <dd>{trimNum(def.i)}</dd>
          </div>
        )}
        {type !== undefined && TYPE_NAMES[type] && (
          <div>
            <dt>Stored as</dt>
            <dd>{TYPE_NAMES[type]}</dd>
          </div>
        )}
        <div>
          <dt>Takes effect</dt>
          <dd>{def?.rb ? <span className="pd-flag"><Power size={13} /> After a reboot</span> : "When written"}</dd>
        </div>
      </dl>

      {(def?.adv || def?.cal || def?.vol || def?.ro) && (
        <ul className="pd-notes">
          {def.ro && <li><ShieldAlert size={14} /> Read-only. The flight controller sets this itself.</li>}
          {def.cal && <li><Info size={14} /> Written by a calibration. Re-run the calibration rather than typing a value.</li>}
          {def.vol && <li><Info size={14} /> Changes by itself as the aircraft runs.</li>}
          {def.adv && !def.ro && <li><Info size={14} /> ArduPilot marks this as an advanced setting.</li>}
        </ul>
      )}

      {!def?.ro && value !== undefined && (
        <section className="pd-edit">
          <h3>Change it</h3>
          {def?.v && !def.b && <OptionPicker def={def} value={candidate} onPick={set} disabled={disabled} />}
          {def?.b && <BitPicker def={def} value={candidate} onChange={set} disabled={disabled} />}
          <label className="pd-num">
            <span>{def?.v || def?.b ? "Value" : "New value"}</span>
            <div className="pd-num-row">
              <input
                className="input"
                inputMode="decimal"
                value={draft}
                disabled={disabled}
                aria-invalid={hasError || (outside && !override)}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && stage()}
              />
              {def?.u && <span className="pd-unit">{def.u}</span>}
            </div>
          </label>
          {Number.isFinite(candidate) && dirty && <p className="pd-means">Means: {meaning(meta, def, candidate) || trimNum(candidate)}</p>}

          {checks.length > 0 && draft.trim() !== "" && (
            <ul className="pd-checks">
              {checks.map((c) => (
                <li key={c.text} className={c.level}>
                  <CircleAlert size={14} /> {c.text}
                </li>
              ))}
            </ul>
          )}
          {outside && (
            <label className="pd-override">
              <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} disabled={disabled} />
              Use this value anyway. I have checked it is right for this aircraft.
            </label>
          )}

          <div className="pd-actions">
            <button className="btn btn-primary" disabled={!canStage} onClick={stage}>
              Stage change
            </button>
            {staged !== undefined && (
              <button className="btn btn-ghost" onClick={onUnstage} disabled={disabled}>
                <RotateCcw size={14} /> Undo edit
              </button>
            )}
          </div>
          {staged !== undefined && value !== undefined && <p className="pd-staged">Staged: {trimNum(value)} → {trimNum(staged)}. Nothing is sent until you press Upload.</p>}
        </section>
      )}

      <footer className="pd-source">
        <BookOpen size={13} /> {meta ? `From the ${meta.firmware} parameter documentation.` : "ArduPilot parameter documentation."}
      </footer>
    </article>
  );
}

function meaning(meta: MetaSet | null, def: ParamDef | undefined, value: number): string {
  if (!def) return "";
  const text = describeValue(meta, def, value);
  // describeValue falls back to "value unit"; next to the number that is noise.
  return text === trimNum(value) || text === `${trimNum(value)} ${def.u}` ? "" : text;
}

function OptionPicker({ def, value, onPick, disabled }: { def: ParamDef; value: number; onPick: (v: number) => void; disabled: boolean }) {
  const known = optionLabel(def, value) !== undefined;
  return (
    <label className="pd-select">
      <span>Option</span>
      <select className="select" value={known ? String(value) : ""} disabled={disabled} onChange={(e) => e.target.value !== "" && onPick(Number(e.target.value))}>
        {!known && <option value="">{Number.isFinite(value) ? `${trimNum(value)}: not a documented option` : "Choose…"}</option>}
        {def.v!.map(([v, label]) => (
          <option key={v} value={String(v)}>
            {v}: {label}
          </option>
        ))}
      </select>
    </label>
  );
}

function BitPicker({ def, value, onChange, disabled }: { def: ParamDef; value: number; onChange: (v: number) => void; disabled: boolean }) {
  const base = Number.isInteger(value) && value >= 0 ? value : 0;
  const on = new Set(bitsOf(base));
  return (
    <fieldset className="pd-bits" disabled={disabled}>
      <legend>Switches</legend>
      {def.b!.map(([bit, label]) => (
        <label key={bit}>
          <input type="checkbox" checked={on.has(bit)} onChange={(e) => onChange(withBit(base, bit, e.target.checked))} />
          <span>{label}</span>
          <small>bit {bit}</small>
        </label>
      ))}
    </fieldset>
  );
}
