import { Maximize2, Plane, Plus, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { clock } from "../../logs/analyze";
import { isNumeric } from "../../logs/types";
import { fieldPanel, panelsFor, PRESETS } from "../../logs/series";
import { Plot, type Band, type Marker } from "./Plot";
import { clampView } from "./plotView";
import { useLogs } from "./store";

export function Charts() {
  const open = useLogs((s) => s.open)!;
  const preset = useLogs((s) => s.preset);
  const setPreset = useLogs((s) => s.setPreset);
  const custom = useLogs((s) => s.custom);
  const setCustom = useLogs((s) => s.setCustom);
  const view = useLogs((s) => s.view);
  const setView = useLogs((s) => s.setView);
  const cursor = useLogs((s) => s.cursor);
  const setCursor = useLogs((s) => s.setCursor);
  const f = open.flight;
  const full: [number, number] = useMemo(() => [0, Math.max(1, f.duration)], [f]);

  const panels = useMemo(() => panelsFor(f, preset), [f, preset]);
  // Which chart sets this log can fill: worked out once per log, not on every cursor move.
  const available = useMemo(() => new Set(PRESETS.filter((p) => panelsFor(f, p.id).length > 0).map((p) => p.id)), [f]);
  const extra = useMemo(
    () =>
      custom
        .map((key) => {
          const [msg, field] = splitKey(key);
          const t = f.raw.tables.get(msg);
          return t ? fieldPanel(t, field) : null;
        })
        .filter((p) => p !== null),
    [custom, f],
  );
  const bands: Band[] = useMemo(() => f.modes.map((m, k) => ({ from: m.t, to: k + 1 < f.modes.length ? f.modes[k + 1].t : f.duration, label: m.name })), [f]);
  const markers: Marker[] = useMemo(
    () =>
      f.timeline
        .filter((it) => it.kind === "error" || (it.kind === "event" && it.tone !== "note") || it.kind === "mode" || it.kind === "arm")
        .map((it) => ({ t: it.t, tone: it.tone === "bad" ? "bad" : it.tone === "warn" ? "warn" : "note", label: it.text })),
    [f],
  );
  const all = [...panels, ...extra];
  const flight = f.flying.length ? ([f.flying[0].from - 5, f.flying[f.flying.length - 1].to + 5] as [number, number]) : null;

  return (
    <div className="lp-charts">
      <div className="lp-chart-bar">
        <div className="lp-seg" role="radiogroup" aria-label="Chart set">
          {PRESETS.map((p) => {
            const has = available.has(p.id);
            return (
              <button key={p.id} role="radio" aria-checked={preset === p.id} className={preset === p.id ? "on" : ""} disabled={!has} title={has ? undefined : "Not in this log"} onClick={() => setPreset(p.id)}>
                {p.label}
              </button>
            );
          })}
        </div>
        <div className="lp-chart-tools">
          <span className="lp-window">
            {clock(view[0])}–{clock(view[1])}
          </span>
          {flight && (
            <button className="btn btn-ghost" onClick={() => setView(clampView(flight, full))} title="Show the time in the air">
              <Plane size={15} /> Flight
            </button>
          )}
          <button className="btn btn-ghost" onClick={() => setView(full)} title="Show the whole log (or double-click a chart)">
            <Maximize2 size={15} /> Whole log
          </button>
        </div>
      </div>
      <FieldPicker onAdd={(k) => !custom.includes(k) && setCustom([...custom, k])} />
      {custom.length > 0 && (
        <div className="lp-custom-keys">
          {custom.map((k) => (
            <span key={k} className="lp-chip">
              {k}
              <button onClick={() => setCustom(custom.filter((x) => x !== k))} aria-label={`Remove ${k}`}>
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <p className="lp-hint">Drag to pan, scroll to zoom, double-click for the whole log. The shaded bands are flight modes; the thin lines are events and errors.</p>
      {all.length === 0 && <p className="lp-empty">This log has no data for this chart set.</p>}
      <div className="lp-stack">
        {all.map((p, i) => (
          <Plot key={p.id} panel={p} view={view} full={full} cursor={cursor} bands={bands} markers={markers} onCursor={setCursor} onView={setView} axis={i === all.length - 1 || all.length < 3} height={all.length > 3 ? 130 : 170} />
        ))}
      </div>
    </div>
  );
}

const splitKey = (k: string): [string, string] => {
  const i = k.indexOf(".");
  return [k.slice(0, i), k.slice(i + 1)];
};

/** Search every numeric field in the log and add it as a chart. */
function FieldPicker({ onAdd }: { onAdd: (key: string) => void }) {
  const open = useLogs((s) => s.open)!;
  const [q, setQ] = useState("");
  const [focus, setFocus] = useState(false);
  const fields = useMemo(() => {
    const out: { key: string; unit: string; count: number }[] = [];
    for (const t of open.flight.raw.tables.values()) {
      t.fields.forEach((fname, i) => {
        if (fname === "TimeUS" || fname === "time_boot_ms" || fname === "time_usec" || !isNumeric(t.cols[i])) return;
        out.push({ key: `${t.name}.${fname}`, unit: t.units[i], count: t.count });
      });
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : 1));
  }, [open]);
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hits = words.length ? fields.filter((x) => words.every((w) => x.key.toLowerCase().includes(w))).slice(0, 40) : [];
  return (
    <div className="lp-picker">
      <label className="lp-search">
        <Search size={15} />
        <input
          className="input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => setFocus(true)}
          onBlur={() => setTimeout(() => setFocus(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && hits[0]) {
              onAdd(hits[0].key);
              setQ("");
            }
          }}
          placeholder={`Add any field to the charts: ${fields.length.toLocaleString()} in this log (try “BAT Curr” or “RCOU C3”)`}
          aria-label="Search the log's fields"
        />
      </label>
      {focus && hits.length > 0 && (
        <ul className="lp-picker-list" role="listbox">
          {hits.map((h) => (
            <li key={h.key}>
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onAdd(h.key);
                  setQ("");
                }}
              >
                <Plus size={13} /> <span>{h.key}</span>
                <small>
                  {h.unit && `${h.unit} · `}
                  {h.count.toLocaleString()} samples
                </small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
