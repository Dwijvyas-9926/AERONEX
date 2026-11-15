import { BookOpen, ChevronRight, Download, FileDown, FileUp, ListTree, Loader2, PencilLine, Power, RotateCcw, Search, TriangleAlert, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ConnectPrompt } from "../../components/ui/ConnectPrompt";
import { compareParams, parseParamFile, type ParamDiff } from "../../mavlink/paramFile";
import { checkValue, defFor, describeValue, groupOf, groupTitle, matchesSearch, trimNum, type MetaSet, type ParamDef } from "../../mavlink/paramMeta";
import { commandLink } from "../../services/link/commandLink";
import { useLink } from "../../state/linkStore";
import { confirmAction, notify } from "../../state/notifyStore";
import { useParams } from "../../state/paramStore";
import { useParamEdits, type ParamEdits } from "../common/useParamEdits";
import { ParamCompareDialog } from "./ParamCompareDialog";
import { ParamDetail } from "./ParamDetail";
import { useRebootNeeded } from "./rebootStore";
import { useParamMeta } from "./useParamMeta";

/*
  Every parameter on the flight controller, with what it is for. Names come
  with ArduPilot's own plain name and description, values with their meaning
  (the option they select, the bits they set, their units). Edits are staged
  and checked against the documented range and the way the controller stores
  the value; nothing is written until Upload.
*/

type Show = "all" | "standard" | "edited";
const MAX_RESULTS = 300;

export function FullParamsPage() {
  const vehicle = useLink((s) => s.vehicle);
  const status = useLink((s) => s.status);
  const values = useParams((s) => s.values);
  const types = useParams((s) => s.types);
  const count = useParams((s) => s.count);
  const received = useParams((s) => s.received);
  const list = useParams((s) => s.list);
  const connected = !!vehicle && (status === "connected" || status === "stale");
  const canSend = !!vehicle && status === "connected";
  const edits = useParamEdits();
  const { meta, failed: metaFailed } = useParamMeta();
  const rebootNames = useRebootNeeded((s) => s.names);

  const [search, setSearch] = useState("");
  const [show, setShow] = useState<Show>("all");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  // Edits the operator explicitly allowed outside the documented range.
  const [outsideOk, setOutsideOk] = useState<Set<string>>(new Set());
  const [compare, setCompare] = useState<{ fileName: string; diff: ParamDiff; bad: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // The link downloads the full list when a vehicle connects; this only
  // makes sure it is here or on its way (it may have stopped short).
  useEffect(() => {
    if (canSend) void commandLink.ensureParamList();
  }, [canSend]);

  // A closed link may come back as a rebooted controller.
  useEffect(() => {
    if (!connected) useRebootNeeded.getState().clear();
  }, [connected]);

  const names = useMemo(() => Object.keys(values).sort(), [values]);
  const defs = useMemo(() => {
    const m: Record<string, ParamDef | undefined> = {};
    for (const n of names) m[n] = defFor(meta, n, values);
    return m;
    // Definitions depend on the names and on FRAME_CLASS (helicopter variants), not every value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [names, meta, values.FRAME_CLASS]);

  const visible = useMemo(() => {
    return names.filter((n) => {
      if (show === "edited") return n in edits.edits;
      if (show === "standard") return !defs[n]?.adv;
      return true;
    });
  }, [names, defs, show, edits.edits]);

  const q = search.trim();
  const matches = useMemo(() => (q ? visible.filter((n) => matchesSearch(n, defs[n], q)) : []), [q, visible, defs]);

  const groups = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const n of visible) {
      const g = groupOf(n);
      (m.get(g) ?? m.set(g, []).get(g)!).push(n);
    }
    return [...m.entries()].sort((a, b) => groupTitle(a[0]).localeCompare(groupTitle(b[0])));
  }, [visible]);

  const refresh = () => {
    if (!canSend) return;
    void commandLink.requestAllParams();
  };

  const stage = (name: string, value: number, outside: boolean) => {
    edits.setEdit(name, value);
    setOutsideOk((s) => {
      const n = new Set(s);
      if (outside) n.add(name);
      else n.delete(name);
      return n;
    });
  };
  const unstage = (name: string) => {
    edits.clearEdit(name);
    setOutsideOk((s) => {
      const n = new Set(s);
      n.delete(name);
      return n;
    });
  };
  const revertAll = () => {
    edits.revert();
    setOutsideOk(new Set());
  };

  const upload = async () => {
    const staged = Object.entries(edits.edits);
    // A value that cannot be stored never goes; one outside the range goes only if it was allowed.
    const blocked = staged.filter(([n, v]) => {
      const c = checkValue(defs[n], v, types[n]);
      return c.some((x) => x.level === "error") || (c.some((x) => x.level === "outside") && !outsideOk.has(n));
    });
    if (blocked.length) {
      notify("error", "Not uploaded", `${blocked.map(([n]) => n).join(", ")} ${blocked.length === 1 ? "needs" : "need"} a look first. Select ${blocked.length === 1 ? "it" : "them"} to see why.`);
      return;
    }
    const outside = staged.filter(([n]) => outsideOk.has(n)).map(([n]) => n);
    const reboot = staged.filter(([n]) => defs[n]?.rb).map(([n]) => n);
    const lines = [
      `${staged.length} ${staged.length === 1 ? "setting" : "settings"} will be written to the flight controller and take effect immediately${reboot.length ? `, except ${reboot.join(", ")}, which ${reboot.length === 1 ? "needs" : "need"} a reboot` : ""}.`,
      outside.length ? `Outside the documented range, by your choice: ${outside.join(", ")}.` : "",
    ].filter(Boolean);
    const ok = await confirmAction({
      title: `Upload ${staged.length} ${staged.length === 1 ? "change" : "changes"}?`,
      body: lines.join(" "),
      confirmLabel: "Upload",
      tone: outside.length ? "danger" : undefined,
    });
    if (!ok) return;
    const written = await edits.upload();
    setOutsideOk((s) => new Set([...s].filter((n) => !written.includes(n))));
    const needReboot = written.filter((n) => defs[n]?.rb);
    if (needReboot.length) useRebootNeeded.getState().add(needReboot);
    const failed = staged.length - written.length;
    if (written.length) notify(failed ? "warn" : "success", `${written.length} ${written.length === 1 ? "setting" : "settings"} written`, failed ? `${failed} could not be confirmed and stay staged.` : needReboot.length ? "Reboot the flight controller for the marked ones to take effect." : undefined);
  };

  const reboot = async () => {
    if (vehicle?.armed) {
      notify("error", "Disarm first", "The flight controller cannot be rebooted while armed.");
      return;
    }
    const ok = await confirmAction({
      title: "Reboot the flight controller?",
      body: "It restarts and the link drops for a few seconds. Over USB the port closes: press Connect again once it is back. Keep the propellers off or clear.",
      confirmLabel: "Reboot",
    });
    if (!ok) return;
    await commandLink.reboot();
    useRebootNeeded.getState().clear();
    notify("info", "Rebooting", "Reconnect when the flight controller is back.");
  };

  // Save every loaded parameter to a Mission-Planner-compatible .param file.
  const saveToFile = () => {
    if (!names.length) return;
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
    const virtual = useLink.getState().virtual;
    const header =
      `# AERONEX parameter file\n` +
      (virtual ? `# SIMULATED: read from the AERONEX virtual aircraft, not a flight controller\n` : "") +
      `# ${vehicle?.firmwareLabel ?? "MAVLink"} · system ${vehicle?.sysid ?? "?"} · ${d.toISOString()}\n` +
      `# ${names.length} parameters${edits.count ? " — note: unsaved edits in the app are NOT included" : ""}\n`;
    const body = names.map((n) => `${n},${values[n]}`).join("\n");
    const blob = new Blob([header + body + "\n"], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `aeronex-params-${virtual ? "virtual-" : ""}${stamp}.param`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const loadFile = async (file: File) => {
    if (file.size > 2_000_000) {
      notify("error", "File too large", "A parameter file is a few tens of kilobytes. Check you picked the right file.");
      return;
    }
    const parsed = parseParamFile(await file.text());
    if (parsed.format === "empty") {
      notify("error", "No parameters found", `${file.name} has no lines in the Mission Planner (NAME,VALUE) or QGroundControl format.`);
      return;
    }
    setCompare({ fileName: file.name, diff: compareParams(parsed.values, values, meta, types), bad: parsed.bad.length });
  };

  if (!connected) {
    return (
      <div className="page-pad">
        <header className="page-head">
          <div>
            <h1>Parameters</h1>
            <p>Every setting on the flight controller, with what it does, in ArduPilot's own words.</p>
          </div>
        </header>
        <ConnectPrompt
          title="Connect an aircraft to read its parameters"
          items={[
            { icon: BookOpen, title: "What each one is for", detail: "Plain names, descriptions, units, ranges and options from ArduCopter's own documentation." },
            { icon: PencilLine, title: "Checked, staged edits", detail: "Values are checked against the documented range before anything is written." },
            { icon: FileDown, title: "Files in and out", detail: "Save a .param file, or load one and pick which differences to apply." },
          ]}
        >
          The parameter list lives on the flight controller and is downloaded when it connects. Lost messages are asked for again, so the list arrives whole even over a telemetry radio.
        </ConnectPrompt>
      </div>
    );
  }

  const downloading = list === "downloading";
  const incomplete = list === "incomplete" && count != null && received < count;
  const sel = selected && selected in values ? selected : null;
  const editedCount = edits.count;

  return (
    <div className="page-pad">
      <header className="page-head">
        <div>
          <h1>Parameters</h1>
          <p>
            {received.toLocaleString()}
            {count ? ` of ${count.toLocaleString()}` : ""} settings from {vehicle!.firmwareLabel}. Select one to see what it does.
          </p>
        </div>
        <span className="pill plain" title={meta?.source}>
          <BookOpen size={13} /> {meta ? `${meta.firmware} documentation` : metaFailed ? "Descriptions unavailable" : "Loading descriptions…"}
        </span>
      </header>

      <div className="pid-actionbar fp-toolbar">
        <div className="fp-search">
          <Search size={16} />
          <input className="input" placeholder="Search by name or by what it does (e.g. waypoint speed, MOT_)" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search parameters" />
        </div>
        <div className="segmented" role="group" aria-label="Which parameters to show">
          <button aria-pressed={show === "all"} onClick={() => setShow("all")}>All</button>
          <button aria-pressed={show === "standard"} onClick={() => setShow("standard")} title="Hide the settings ArduPilot marks as advanced">Standard</button>
          <button aria-pressed={show === "edited"} onClick={() => setShow("edited")}>Edited{editedCount ? ` (${editedCount})` : ""}</button>
        </div>
        <div className="pid-actionbar-btns">
          <input
            ref={fileInput}
            type="file"
            accept=".param,.parm,.params,.txt"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void loadFile(f);
            }}
          />
          <button className="btn btn-ghost" disabled={!names.length || downloading || incomplete} onClick={() => fileInput.current?.click()} title="Compare a .param file with the aircraft and choose what to apply">
            <FileUp size={15} /> Load file
          </button>
          <button className="btn btn-ghost" disabled={!names.length} onClick={saveToFile} title="Save every parameter to a .param file">
            <Download size={15} /> Save file
          </button>
          <button className="btn btn-ghost" disabled={!canSend || downloading} onClick={refresh} title="Download every parameter again">
            <RotateCcw size={15} /> Refresh
          </button>
          <button className="btn btn-ghost" disabled={!editedCount || edits.uploading} onClick={revertAll}>
            Revert
          </button>
          <button className="btn btn-primary" disabled={!canSend || !editedCount || edits.uploading} onClick={() => void upload()}>
            {edits.uploading ? <Loader2 className="spin" /> : <Upload />} Upload{editedCount ? ` (${editedCount})` : ""}
          </button>
        </div>
      </div>

      {rebootNames.length > 0 && (
        <div className="callout warn fp-reboot">
          <Power />
          <span>
            <strong>Reboot to apply.</strong> {rebootNames.join(", ")} {rebootNames.length === 1 ? "takes" : "take"} effect only after the flight controller restarts.
          </span>
          <button className="btn btn-sm" disabled={!canSend || !!vehicle?.armed} onClick={() => void reboot()}>
            Reboot now
          </button>
        </div>
      )}

      {downloading && (
        <div className="fp-progress" role="status">
          <Loader2 className="spin" size={15} /> Downloading parameters… {received.toLocaleString()}
          {count ? ` of ${count.toLocaleString()}` : ""}
          {count ? <progress max={count} value={received} aria-label="Parameter download" /> : null}
        </div>
      )}

      {incomplete && (
        <div className="callout warn fp-reboot">
          <TriangleAlert />
          <span>
            <strong>{(count! - received).toLocaleString()} parameters did not arrive.</strong> The flight controller stopped answering before the list was whole. The ones shown are current; ask again for the rest.
          </span>
          <button className="btn btn-sm" disabled={!canSend} onClick={() => void commandLink.ensureParamList()}>
            Download the missing ones
          </button>
        </div>
      )}

      {names.length === 0 && !downloading && <p className="muted">Waiting for parameters…</p>}

      <div className="fp-layout">
        <section className="panel fp-panel" aria-label="Parameter list">
          {q ? (
            matches.length === 0 ? (
              <p className="muted fp-empty">No setting matches “{search}”{show !== "all" ? " in this view" : ""}.</p>
            ) : (
              <div className="fp-list">
                {matches.slice(0, MAX_RESULTS).map((n) => (
                  <ParamRow key={n} name={n} def={defs[n]} meta={meta} edits={edits} selected={sel === n} onSelect={setSelected} />
                ))}
                {matches.length > MAX_RESULTS && <p className="muted fp-cap">Showing the first {MAX_RESULTS} of {matches.length} matches. Narrow the search to see the rest.</p>}
              </div>
            )
          ) : show === "edited" && visible.length === 0 ? (
            <p className="muted fp-empty">No edits staged. Select a setting and change it, or load a file.</p>
          ) : (
            groups.map(([g, gnames]) => {
              const isOpen = open.has(g) || show === "edited";
              const changed = gnames.filter((n) => n in edits.edits).length;
              return (
                <div key={g} className="fp-group">
                  <button
                    className="fp-group-head"
                    aria-expanded={isOpen}
                    onClick={() =>
                      setOpen((s) => {
                        const n = new Set(s);
                        if (n.has(g)) n.delete(g);
                        else n.add(g);
                        return n;
                      })
                    }
                  >
                    <ChevronRight size={16} className={`fp-caret${isOpen ? " open" : ""}`} />
                    <strong>{groupTitle(g)}</strong>
                    {groupTitle(g) !== g && <code className="fp-prefix">{g}</code>}
                    <span className="fp-group-count">{gnames.length}</span>
                    {changed > 0 && <span className="fp-mod">{changed} edited</span>}
                  </button>
                  {isOpen && (
                    <div className="fp-list">
                      {gnames.map((n) => (
                        <ParamRow key={n} name={n} def={defs[n]} meta={meta} edits={edits} selected={sel === n} onSelect={setSelected} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </section>

        <aside className="panel fp-detail" aria-live="polite">
          {sel ? (
            <ParamDetail
              key={`${sel}:${edits.edits[sel] ?? values[sel]}:${outsideOk.has(sel)}`}
              name={sel}
              def={defs[sel]}
              meta={meta}
              metaFailed={metaFailed}
              value={values[sel]}
              staged={edits.edits[sel]}
              type={types[sel]}
              allowOutside={outsideOk.has(sel)}
              disabled={!canSend || edits.uploading}
              onStage={(v, outside) => stage(sel, v, outside)}
              onUnstage={() => unstage(sel)}
            />
          ) : (
            <div className="fp-detail-empty">
              <ListTree size={22} />
              <p>Select a setting to see what it does, its units and range, and to change it.</p>
              <p className="muted">Search understands plain words: try “battery low”, “return home altitude” or “arming”.</p>
            </div>
          )}
        </aside>
      </div>

      {compare && (
        <ParamCompareDialog
          fileName={compare.fileName}
          diff={compare.diff}
          badLines={compare.bad}
          meta={meta}
          vehicle={values}
          onClose={() => setCompare(null)}
          onStage={(rows) => {
            for (const r of rows) stage(r.name, r.value, r.outside);
            setCompare(null);
            setShow("edited");
            notify("info", `${rows.length} ${rows.length === 1 ? "change" : "changes"} staged`, "Review them under Edited, then Upload.");
          }}
        />
      )}
    </div>
  );
}

function ParamRow({ name, def, meta, edits, selected, onSelect }: { name: string; def: ParamDef | undefined; meta: MetaSet | null; edits: ParamEdits; selected: boolean; onSelect: (n: string) => void }) {
  const value = useParams((s) => s.values[name]);
  const pending = useParams((s) => s.pending[name]);
  const staged = edits.edits[name];
  const modified = staged !== undefined && (value === undefined || Math.abs(staged - value) > 1e-9);
  const shown = staged ?? value;
  const meaning = shown === undefined ? "" : describeValue(meta, def, shown);
  const extra = shown !== undefined && meaning !== trimNum(shown) ? meaning : "";

  return (
    <button className={`fp-row${modified ? " modified" : ""}${selected ? " selected" : ""}`} onClick={() => onSelect(name)} aria-current={selected || undefined}>
      <span className="fp-names">
        <code className="fp-name">{name}</code>
        <span className="fp-title">{def?.n ?? ""}</span>
      </span>
      <span className="fp-value">
        {modified && value !== undefined && <span className="fp-was">{trimNum(value)} →</span>}
        <strong>{shown === undefined ? "—" : trimNum(shown)}</strong>
        {extra && <span className="fp-meaning">{extra.replace(`${trimNum(shown!)} `, "")}</span>}
      </span>
      <span className="fp-flags">
        {def?.rb ? <Power size={13} aria-label="Needs a reboot" /> : null}
        {pending?.state === "writing" && <Loader2 size={13} className="spin fp-saving" aria-label="Writing" />}
        {pending?.state === "failed" && <TriangleAlert size={13} className="fp-failed" aria-label="Write not confirmed" />}
      </span>
    </button>
  );
}
