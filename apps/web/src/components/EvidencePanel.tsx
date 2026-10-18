"use client";

/**
 * Evidence panel — clicking any node shows the exact graph facts behind it:
 * hop depth, discovery edge types, bug history with GitHub links, linked tests.
 * Nothing here is invented; every row came out of a Cypher traversal.
 */
import type { AnalyzeResponse } from "@/lib/api-types";

const SEV_CLASS: Record<string, string> = { high: "high", medium: "medium", low: "low", origin: "origin" };

export default function EvidencePanel({ data, nodeKey }: { data: AnalyzeResponse; nodeKey: string | null }) {
  const { result } = data;
  if (!nodeKey) {
    return (
      <div className="card">
        <div className="subhead">🔎 Evidence</div>
        <p className="evidence-empty">Click a node in the ripple graph to inspect its evidence.</p>
      </div>
    );
  }

  const impact = [...result.direct, ...result.ripple].find((i) => i.key === nodeKey);
  const origin = result.changedFiles.includes(nodeKey);
  const gap = result.coverageGaps.find((g) => g.key === nodeKey);
  // graph file-key evidence also covers symbols in that file
  const fileIdOf = (k: string) => (k.includes("::") ? (k.split("::")[0] ?? k) : k);
  const bugEvidence = impact
    ? impact.bugEvidence
    : result.bugEvidence.filter((b) => b.linkedNodeKey === nodeKey || fileIdOf(b.linkedNodeKey) === fileIdOf(nodeKey));
  const tests = impact?.tests ?? [];

  return (
    <div className="card">
      <div className="subhead">🔎 Evidence</div>
      <div className="evidence-head">
        {impact && <span className={`chip chip-${SEV_CLASS[impact.severity] ?? "low"}`}>{impact.severity}</span>}
        {origin && <span className="chip chip-origin">changed (origin)</span>}
        {gap && <span className="chip chip-medium">coverage gap 🕳️</span>}
        <span className="chip chip-kind">{impact?.kind ?? (origin ? "File" : "node")}</span>
      </div>
      <div className="evidence-key">{nodeKey}</div>

      {origin && !impact && <p className="evidence-dim" style={{ marginTop: 8 }}>This file was changed in the analyzed change set.</p>}

      {impact && (
        <>
          <div className="via-row" style={{ marginTop: 8 }}>
            <span className="evidence-dim">hop {impact.depth}</span>
            {impact.via.map((v, i) => (
              <span key={i} className="via-edge">
                {v}
              </span>
            ))}
          </div>
          <div className="score-track">
            <div
              className="score-fill"
              style={{
                width: `${Math.min(100, (impact.score / 12) * 100)}%`,
                background: impact.severity === "high" ? "var(--high)" : impact.severity === "medium" ? "var(--medium)" : "var(--low)",
              }}
            />
          </div>
          <div className="score-note">discovery-path score {impact.score}</div>
          {impact.feedback && (impact.feedback.confirms > 0 || impact.feedback.disproves > 0) && (
            <div className="fb-line">
              {impact.feedback.confirms >= impact.feedback.disproves ? "🔁" : "🥀"}{" "}
              <strong>
                {impact.feedback.confirms >= impact.feedback.disproves && impact.feedback.confirms > 0
                  ? `confirmed ×${impact.feedback.confirms}`
                  : `decayed ×${impact.feedback.disproves}`}
              </strong>{" "}
              by past CI runs · confidence {Math.round(impact.feedback.confidence * 100)}%
            </div>
          )}
        </>
      )}

      {gap && (
        <p className="gap-reason" style={{ marginTop: 10 }}>
          {gap.reason}
        </p>
      )}

      <div className="subhead">🐞 Bug history</div>
      {bugEvidence.length > 0 ? (
        <ul className="bug-card">
          {bugEvidence.slice(0, 6).map((b) => (
            <li key={b.bugKey} className="bug-li">
              <span className="bug-title">{b.title}</span>
              <span className="bug-meta">
                {b.state && <span className={`state-chip ${b.state === "closed" ? "state-closed" : "state-open"}`}>{b.state}</span>}
                {b.url ? (
                  <a href={b.url} target="_blank" rel="noreferrer">
                    #{b.url.split("/").pop()}
                  </a>
                ) : (
                  <span>bug#{b.bugKey.slice(0, 14)}</span>
                )}
                <code>fix {b.sha.slice(0, 8)}</code>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="evidence-dim">No bug-fix commits reached this node via the graph. 🍀</p>
      )}

      <div className="subhead">🧪 Linked tests</div>
      {tests.length > 0 ? (
        <ul className="echo-list">
          {tests.slice(0, 6).map((t) => (
            <li key={t} className="test-li">
              <span>{t}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="evidence-dim">{impact && impact.kind !== "ApiRoute" ? "No TESTED_BY edges — flagged as a coverage gap." : "— (visualized node)"}</p>
      )}
    </div>
  );
}
