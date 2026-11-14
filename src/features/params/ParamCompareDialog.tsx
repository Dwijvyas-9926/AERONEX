import { FileUp, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DiffReason, ParamDiff } from "../../mavlink/paramFile";
import { defFor, describeValue, trimNum, type MetaSet } from "../../mavlink/paramMeta";

/*
  Loading a parameter file never writes anything. It shows what differs from
  the aircraft, lets the operator choose, and stages the chosen values; Upload
  on the page is still the only thing that sends.

  Rows start unticked when copying them across aircraft is risky (sensor
  calibrations, device IDs, counters) or when the value falls outside the
  documented range. Values that cannot be stored cannot be ticked at all.
*/

const REASON_TEXT: Record<DiffReason, string> = {
  calibration: "Belongs to one aircraft (calibration or ID)",
  "read-only": "Read-only",
  "changes by itself": "Changes by itself",
  "outside range": "Outside the documented range",
  invalid: "Cannot be stored",
};

const LOCKED = new Set<DiffReason>(["read-only", "invalid"]);

interface Props {
  fileName: string;
  diff: ParamDiff;
  badLines: number;
  meta: MetaSet | null;
  vehicle: Record<string, number>;
  onStage: (rows: { name: string; value: number; outside: boolean }[]) => void;
  onClose: () => void;
}

export function ParamCompareDialog({ fileName, diff, badLines, meta, vehicle, onStage, onClose }: Props) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(diff.changed.filter((r) => !r.caution).map((r) => r.name)));
  const [showMissing, setShowMissing] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const selectable = useMemo(() => diff.changed.filter((r) => !r.caution || !LOCKED.has(r.caution)), [diff]);
  const toggle = (name: string, on: boolean) =>
    setPicked((s) => {
      const n = new Set(s);
      if (on) n.add(name);
      else n.delete(name);
      return n;
    });

  const stage = () => {
    onStage(diff.changed.filter((r) => picked.has(r.name)).map((r) => ({ name: r.name, value: r.file, outside: r.caution === "outside range" })));
  };

  return (
    <div className="pm-scrim" onClick={onClose}>
      <div className="pm-dialog" role="dialog" aria-modal="true" aria-labelledby="pm-title" onClick={(e) => e.stopPropagation()}>
        <header className="pm-head">
          <FileUp size={18} />
          <div>
            <h2 id="pm-title">Compare with {fileName}</h2>
            <p>
              {diff.changed.length} different · {diff.same} the same
              {diff.missing.length > 0 && <> · {diff.missing.length} not on this aircraft</>}
              {badLines > 0 && <> · {badLines} unreadable {badLines === 1 ? "line" : "lines"}</>}
            </p>
          </div>
          <button ref={closeRef} className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        {diff.changed.length === 0 ? (
          <p className="pm-empty">Every setting in the file already matches the aircraft. Nothing to change.</p>
        ) : (
          <>
            <p className="pm-note">Ticked rows are staged when you press Stage. Nothing is written to the aircraft until you press Upload on the page. Rows that belong to one particular aircraft start unticked.</p>
            <div className="pm-table" role="table">
              <div className="pm-row pm-row-head" role="row">
                <span role="columnheader">
                  <input
                    type="checkbox"
                    aria-label="Tick every row that can be staged"
                    checked={selectable.length > 0 && selectable.every((r) => picked.has(r.name))}
                    onChange={(e) => setPicked(e.target.checked ? new Set(selectable.map((r) => r.name)) : new Set())}
                  />
                </span>
                <span role="columnheader">Setting</span>
                <span role="columnheader">On the aircraft</span>
                <span role="columnheader">In the file</span>
              </div>
              {diff.changed.map((r) => {
                const def = defFor(meta, r.name, vehicle);
                const locked = !!r.caution && LOCKED.has(r.caution);
                return (
                  <label key={r.name} className={`pm-row${locked ? " locked" : ""}${r.caution ? " caution" : ""}`} role="row">
                    <span role="cell">
                      <input type="checkbox" disabled={locked} checked={picked.has(r.name)} onChange={(e) => toggle(r.name, e.target.checked)} />
                    </span>
                    <span role="cell" className="pm-name">
                      <code>{r.name}</code>
                      {def?.n && <small>{def.n}</small>}
                      {r.caution && <em>{REASON_TEXT[r.caution]}</em>}
                    </span>
                    <span role="cell" className="pm-val">
                      {trimNum(r.vehicle)}
                      <small>{shortMeaning(meta, def, r.vehicle)}</small>
                    </span>
                    <span role="cell" className="pm-val pm-new">
                      {trimNum(r.file)}
                      <small>{shortMeaning(meta, def, r.file)}</small>
                    </span>
                  </label>
                );
              })}
            </div>
          </>
        )}

        {diff.missing.length > 0 && (
          <div className="pm-missing">
            <button className="btn btn-ghost btn-sm" onClick={() => setShowMissing((v) => !v)}>
              {showMissing ? "Hide" : "Show"} the {diff.missing.length} {diff.missing.length === 1 ? "setting" : "settings"} this aircraft does not have
            </button>
            {showMissing && <p className="pm-missing-list">{diff.missing.join(", ")}</p>}
            <p className="muted">These come from another firmware version or a feature that is not enabled here. They are left out.</p>
          </div>
        )}

        <footer className="pm-foot">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={picked.size === 0} onClick={stage}>
            Stage {picked.size} {picked.size === 1 ? "change" : "changes"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function shortMeaning(meta: MetaSet | null, def: ReturnType<typeof defFor>, v: number): string {
  if (!def) return "";
  const t = describeValue(meta, def, v);
  return t === trimNum(v) ? "" : t;
}
