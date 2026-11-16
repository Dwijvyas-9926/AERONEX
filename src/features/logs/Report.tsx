import { Activity, CircleCheck, ExternalLink, Info, MinusCircle, OctagonAlert, Play, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { clock, type CheckResult, type Finding } from "../../logs/analyze";
import { useSettings } from "../../state/settingsStore";
import { useLogs } from "./store";

const SEV = {
  fail: { label: "Problem", Icon: OctagonAlert },
  warn: { label: "Check", Icon: TriangleAlert },
  info: { label: "Note", Icon: Info },
} as const;

const STATUS: Record<CheckResult["status"], { label: string; Icon: typeof Info }> = {
  fail: { label: "Problem", Icon: OctagonAlert },
  warn: { label: "Check", Icon: TriangleAlert },
  info: { label: "Note", Icon: Info },
  pass: { label: "Passed", Icon: CircleCheck },
  skipped: { label: "Not checked", Icon: MinusCircle },
};

const VERDICT = {
  fail: { title: "Problems found", sub: "Something in this flight needs fixing before the next one." },
  warn: { title: "Worth a look", sub: "Nothing serious, but some things are outside the usual limits." },
  pass: { title: "No problems found", sub: "Every check that this log could support passed." },
} as const;

function FindingCard({ x }: { x: Finding }) {
  const focus = useLogs((s) => s.focus);
  const setPreset = useLogs((s) => s.setPreset);
  const { Icon, label } = SEV[x.severity];
  return (
    <article className={`lp-finding ${x.severity}`}>
      <div className="lp-finding-ic" aria-hidden>
        <Icon size={18} />
      </div>
      <div className="lp-finding-body">
        <header>
          <span className="sr-only">{label}: </span>
          <h3>{x.title}</h3>
          <span className="lp-area">{x.area}</span>
          {x.at !== undefined && <span className="lp-at">{clock(x.at)}</span>}
        </header>
        <p>{x.detail}</p>
        {x.advice && (
          <p className="lp-advice">
            <strong>What to do:</strong> {x.advice}
          </p>
        )}
        <div className="lp-finding-actions">
          {x.chart && (
            <button className="btn btn-ghost" onClick={() => {
                setPreset(x.chart!);
                if (x.at !== undefined) focus(x.at, x.span ? Math.max(20, (x.span[1] - x.span[0]) * 2.5) : undefined, "charts");
                else useLogs.setState({ tab: "charts" });
              }}>
              <Activity size={14} /> Show on chart
            </button>
          )}
          {x.at !== undefined && (
            <button className="btn btn-ghost" onClick={() => focus(Math.max(0, x.at! - 3), undefined, "replay")}>
              <Play size={14} /> Replay from here
            </button>
          )}
          {x.source && (
            <a className="btn btn-ghost" href={x.source} target="_blank" rel="noreferrer">
              <ExternalLink size={14} /> ArduPilot guide
            </a>
          )}
        </div>
      </div>
    </article>
  );
}

export function Report() {
  const open = useLogs((s) => s.open)!;
  const units = useSettings((s) => s.units);
  const [showAll, setShowAll] = useState(false);
  const { analysis: a, flight: f } = open;
  const s = a.summary;
  const imp = units === "imperial";
  const dist = (m: number) => (imp ? `${(m * 3.28084).toFixed(0)} ft` : `${m.toFixed(m < 100 ? 1 : 0)} m`);
  const far = (m: number) => (imp ? (m > 1609 ? `${(m / 1609.34).toFixed(2)} mi` : `${(m * 3.28084).toFixed(0)} ft`) : m > 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(0)} m`);
  const speed = (v: number) => (imp ? `${(v * 2.23694).toFixed(1)} mph` : `${v.toFixed(1)} m/s`);
  const v = VERDICT[a.verdict];
  const counts = { fail: a.findings.filter((x) => x.severity === "fail").length, warn: a.findings.filter((x) => x.severity === "warn").length, info: a.findings.filter((x) => x.severity === "info").length };
  const tiles: [string, string, string?][] = [
    ["In the air", s.flightTime > 0 ? clock(s.flightTime) : "did not fly", s.flights > 1 ? `${s.flights} flights` : undefined],
    ["Distance", s.distance !== null ? far(s.distance) : "—"],
    ["Highest", s.maxAltRel !== null ? dist(s.maxAltRel) : "—", "above home"],
    ["Farthest out", s.maxFromHome !== null ? far(s.maxFromHome) : "—", "from home"],
    ["Top speed", s.maxSpeed !== null ? speed(s.maxSpeed) : "—", "over the ground"],
    ["Battery used", s.usedMah !== null ? `${s.usedMah.toFixed(0)} mAh` : "—", s.minVolt !== null ? `lowest ${s.minVolt.toFixed(2)} V${s.cells ? ` (${(s.minVolt / s.cells).toFixed(2)} V/cell)` : ""}` : undefined],
  ];
  const ranChecks = a.checks.filter((c) => c.status !== "skipped").length;
  return (
    <div className="lp-report">
      <section className={`lp-verdict ${a.verdict}`}>
        <div>
          <h2>{v.title}</h2>
          <p>{v.sub}</p>
        </div>
        <div className="lp-counts">
          {counts.fail > 0 && <span className="lp-count fail"><OctagonAlert size={14} /> {counts.fail} problem{counts.fail === 1 ? "" : "s"}</span>}
          {counts.warn > 0 && <span className="lp-count warn"><TriangleAlert size={14} /> {counts.warn} to check</span>}
          {counts.info > 0 && <span className="lp-count info"><Info size={14} /> {counts.info} note{counts.info === 1 ? "" : "s"}</span>}
          <span className="lp-count pass"><CircleCheck size={14} /> {ranChecks} of {a.checks.length} checks ran</span>
        </div>
      </section>

      <dl className="lp-tiles">
        {tiles.map(([k, val, sub]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{val}</dd>
            {sub && <dd className="lp-tile-sub">{sub}</dd>}
          </div>
        ))}
      </dl>

      <FlightStrip />

      {f.kind === "tlog" && (
        <p className="lp-note">
          <Info size={14} /> A telemetry log holds what reached the ground station, at the rates it was sent: fewer samples than the on-board log, and no record of what happened after the link dropped. For a full diagnosis, open the aircraft's .bin of the same flight.
        </p>
      )}

      <section aria-labelledby="lp-findings-h">
        <h2 id="lp-findings-h" className="lp-h2">Findings</h2>
        {a.findings.length === 0 ? (
          <p className="lp-empty">Nothing to report: every check that could run passed.</p>
        ) : (
          <div className="lp-findings">{a.findings.map((x) => <FindingCard key={x.id} x={x} />)}</div>
        )}
      </section>

      <section aria-labelledby="lp-checks-h">
        <h2 id="lp-checks-h" className="lp-h2">
          Every check
          <button className="btn btn-ghost" onClick={() => setShowAll((x) => !x)} aria-expanded={showAll}>
            {showAll ? "Hide" : `Show all ${a.checks.length}`}
          </button>
        </h2>
        {showAll && (
          <table className="lp-checks">
            <thead>
              <tr>
                <th scope="col">Check</th>
                <th scope="col">Result</th>
                <th scope="col">What was measured</th>
              </tr>
            </thead>
            <tbody>
              {a.checks.map((c) => {
                const { Icon, label } = STATUS[c.status];
                return (
                  <tr key={c.id} className={c.status}>
                    <th scope="row">
                      {c.title}
                      <small>{c.area}</small>
                    </th>
                    <td>
                      <span className="lp-status">
                        <Icon size={14} /> {label}
                      </span>
                    </td>
                    <td>{c.note}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="lp-fine">The checks compare this log with ArduPilot's published limits. They point at what to look at; they are not a certificate that the aircraft is airworthy.</p>
      </section>
    </div>
  );
}

/** The whole log as one bar: flying spans, modes, and where the findings are. */
export function FlightStrip() {
  const open = useLogs((s) => s.open)!;
  const focus = useLogs((s) => s.focus);
  const f = open.flight;
  const D = Math.max(1, f.duration);
  const pct = (t: number) => `${(Math.max(0, Math.min(D, t)) / D) * 100}%`;
  return (
    <figure className="lp-strip">
      <figcaption className="sr-only">Timeline of the log: modes, when it was flying, and findings.</figcaption>
      <div className="lp-strip-modes">
        {f.modes.map((m, k) => {
          const to = k + 1 < f.modes.length ? f.modes[k + 1].t : D;
          return (
            <span key={k} className={`lp-strip-mode m${k % 2}`} style={{ left: pct(m.t), width: `calc(${pct(to)} - ${pct(m.t)})` }} title={`${m.name} from ${clock(m.t)}`}>
              {m.name}
            </span>
          );
        })}
      </div>
      <div className="lp-strip-fly">
        {f.armed.map((x, k) => (
          <span key={`a${k}`} className="armed" style={{ left: pct(x.from), width: `calc(${pct(x.to)} - ${pct(x.from)})` }} title={`Armed ${clock(x.from)}–${clock(x.to)}`} />
        ))}
        {f.flying.map((x, k) => (
          <span key={`f${k}`} className="flying" style={{ left: pct(x.from), width: `calc(${pct(x.to)} - ${pct(x.from)})` }} title={`Flying ${clock(x.from)}–${clock(x.to)}`} />
        ))}
        {open.analysis.findings
          .filter((x) => x.at !== undefined && x.severity !== "info")
          .map((x) => (
            <button key={x.id} className={`lp-strip-pin ${x.severity}`} style={{ left: pct(x.at!) }} onClick={() => focus(x.at!, undefined, "charts")} aria-label={`${x.title}, at ${clock(x.at!)}`} title={`${clock(x.at!)} ${x.title}`} />
          ))}
      </div>
      <div className="lp-strip-axis">
        <span>0:00</span>
        <span className="lp-strip-legend">
          <i className="armed" /> armed <i className="flying" /> flying
        </span>
        <span>{clock(D)}</span>
      </div>
    </figure>
  );
}
