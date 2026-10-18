"use client";

/**
 * Report view — the reviewable, severity-grouped report: impact columns,
 * coverage gaps, an interactive test plan (checkbox state is local), and the
 * historical bug evidence with live GitHub links.
 */
import { useMemo, useState } from "react";
import type { AnalyzeResponse } from "@/lib/api-types";

const SEV_ORDER: Array<"high" | "medium" | "low"> = ["high", "medium", "low"];

export default function ReportView({
  data,
  selected,
  onSelect,
}: {
  data: AnalyzeResponse;
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  const { result } = data;
  const [checked, setChecked] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const g: Record<"high" | "medium" | "low", typeof result.direct> = { high: [], medium: [], low: [] };
    for (const i of [...result.direct, ...result.ripple]) (g[i.severity] ?? g.medium).push(i);
    for (const k of SEV_ORDER) g[k] = g[k] ?? [];
    return g;
  }, [result]);

  const toggle = (test: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(test)) next.delete(test);
      else next.add(test);
      return next;
    });
  };

  return (
    <div className="report-grid">
      {SEV_ORDER.map((sev) => (
        <div key={sev} className="card sev-col">
          <h3>
            {sev === "high" ? "🟥" : sev === "medium" ? "🟧" : "🟩"} {sev}
            <span className="sev-count">
              {groups[sev].length} impact{groups[sev].length === 1 ? "" : "s"}
            </span>
          </h3>
          {groups[sev].length === 0 ? (
            <p className="evidence-dim">none of this severity 🍀</p>
          ) : (
            <ul className="echo-list">
              {groups[sev].slice(0, 14).map((i) => (
                <li
                  key={i.key}
                  className={`impact-li ${selected === i.key ? "selected" : ""}`}
                  onClick={() => onSelect(i.key)}
                >
                  <div className="impact-name">{i.name}</div>
                  <div className="impact-meta">
                    <span className="chip chip-kind">{i.kind}</span>
                    <span>{i.depth === 0 ? "direct" : `hop ${i.depth}`}</span>
                    <span>score {i.score}</span>
                    {i.via.length > 0 && <code>{[...new Set(i.via)].join("·")}</code>}
                    {i.bugEvidence.length > 0 && <span className="bug-dot">🐞 {i.bugEvidence.length}</span>}
                    {i.tests.length === 0 && i.kind !== "ApiRoute" && <span>⚠ no tests</span>}
                    {i.feedback && (i.feedback.confirms > 0 || i.feedback.disproves > 0) && (
                      <span
                        className={i.feedback.confirms >= i.feedback.disproves ? "badge-confirmed" : "badge-decayed"}
                        title={`CI feedback confidence ${Math.round(i.feedback.confidence * 100)}%`}
                      >
                        {i.feedback.confirms >= i.feedback.disproves
                          ? `🔁 confirmed ×${i.feedback.confirms}`
                          : `🥀 decayed ×${i.feedback.disproves}`}
                      </span>
                    )}
                  </div>
                </li>
              ))}
              {groups[sev].length > 14 && <li className="evidence-dim">…and {groups[sev].length - 14} more</li>}
            </ul>
          )}
        </div>
      ))}

      {result.coverageGaps.length > 0 && (
        <div className="card">
          <h3>🕳️ Coverage gaps</h3>
          {result.coverageGaps.map((g) => (
            <div key={g.key} className="gap-li">
              <div className="gap-key">{g.key}</div>
              <div className="gap-reason">{g.reason}</div>
            </div>
          ))}
        </div>
      )}

      {result.testPlan.length > 0 && (
        <div className="card">
          <h3>🧪 Recommended test plan</h3>
          {result.testPlan.slice(0, 12).map((row) => (
            <label key={row.test} className={`plan-cn ${checked.has(row.test) ? "plan-done" : ""}`}>
              <input type="checkbox" checked={checked.has(row.test)} onChange={() => toggle(row.test)} />
              <span>
                <span className="plan-test">{row.test.replace(/^.*::/, "")}</span>
                <div className="plan-covers">covers {row.file}</div>
              </span>
            </label>
          ))}
          {result.testPlan.length > 12 && <div className="evidence-dim">…and {result.testPlan.length - 12} more</div>}
          <div className="plan-note">
            {checked.size}/{Math.min(result.testPlan.length, 12)} checked —{" "}
            {checked.size === Math.min(result.testPlan.length, 12) ? "ready to run ✅" : "run these first ⚠️"}
          </div>
        </div>
      )}

      {result.bugEvidence.length > 0 && (
        <div className="card">
          <h3>📜 Historical evidence</h3>
          <ul className="bug-card">
            {result.bugEvidence.slice(0, 8).map((b) => (
              <li key={b.bugKey} className="bug-li">
                <span className="bug-title">{b.url ? <a href={b.url} target="_blank" rel="noreferrer">{b.title}</a> : b.title}</span>
                <span className="bug-meta">
                  {b.state && <span className={`state-chip ${b.state === "closed" ? "state-closed" : "state-open"}`}>{b.state}</span>}
                  <a href={`https://github.com/search?q=${b.sha}`} target="_blank" rel="noreferrer">
                    <code>{b.sha.slice(0, 10)}</code>
                  </a>
                  <span>→ {b.linkedNodeKey}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.outsideGraph.length > 0 && (
        <div className="card">
          <h3>🌫️ Not in the graph</h3>
          <p className="evidence-dim">
            These changed paths were not part of the ingested repo (assets, other dirs, or the ingested checkout is stale —
            re-run <code>npm run ingest</code>):
          </p>
          <div className="outside-chips">
            {result.outsideGraph.map((p) => (
              <span key={p} className="outside-chip">
                {p}
              </span>
            ))}
          </div>
        </div>
      )}

      {data.feedback && (data.feedback.accuracy != null || data.feedback.lastRuns.length > 0) && (
        <div className="card">
          <h3>🔁 CI feedback loop</h3>
          {data.feedback.accuracy != null && (
            <p className="plan-note" style={{ marginTop: 0 }}>
              🎯 <strong>{Math.round(data.feedback.accuracy * 100)}%</strong> verified accuracy —{" "}
              {data.feedback.confirmedPredictions}/{data.feedback.verifiedPredictions} flagged predictions were confirmed
              by real CI runs; the rest decayed.
            </p>
          )}
          {data.feedback.latestTop5 && data.feedback.latestTop5.verified > 0 && (
            <p className="plan-note" style={{ marginTop: 0 }}>
              📍 {data.feedback.latestTop5.confirmed}/{data.feedback.latestTop5.verified} top-scored predictions in the
              most recent verified run were confirmed — the weighting gets tighter every run.
            </p>
          )}
          <ul className="echo-list" style={{ marginTop: 8 }}>
            {data.feedback.lastRuns.slice(0, 3).map((r) => (
              <li key={r.key} className="run-li">
                <span className="run-when">{new Date(r.at).toLocaleString()}</span>
                <span className={`state-chip ${r.source === "github" ? "state-open" : "state-closed"}`}>{r.source}</span>
                <span>↑{r.confirmedCount} confirmed · ↓{r.disprovenCount} decayed</span>
                <span className="evidence-dim">
                  ({r.failedCount} failed / {r.passedCount} passed suite files)
                </span>
              </li>
            ))}
          </ul>
          <p className="evidence-dim" style={{ marginTop: 8 }}>
            Feed more outcomes: <code>npm run ci-feedback -- --failed src/auth.test.ts</code> → then{" "}
            <code>npm run ci-feedback</code> again in the analyzer to watch severities re-weight live.
          </p>
        </div>
      )}
    </div>
  );
}
