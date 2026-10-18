"use client";

/**
 * Recent-analyses history panel (Phase 6).
 *
 * Lists the latest persisted `:Analysis` runs; each entry can re-run the same
 * changed-file set with one click. Older runs (pre-Phase 6) have no stored
 * changedFiles and render without the re-run button.
 */
import type { AnalysisSummary } from "@/app/api/analyses/route";

function ago(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function RecentAnalyses({
  analyses,
  disabled,
  onRerun,
}: {
  analyses: AnalysisSummary[];
  disabled: boolean;
  onRerun: (a: AnalysisSummary) => void;
}) {
  if (analyses.length === 0) {
    return (
      <div className="card recent-card recent-empty">
        <span className="subhead">🕑 Recent analyses</span>
        <span className="evidence-dim">nothing yet — runs are persisted as :Analysis nodes in FalkorDB</span>
      </div>
    );
  }
  return (
    <div className="card recent-card">
      <span className="subhead">
        🕑 Recent analyses <span className="evidence-dim">({analyses.length}, persisted in the graph)</span>
      </span>
      <div className="recent-list">
        {analyses.map((a) => (
          <div key={a.key} className="recent-row">
            <span className="recent-when" title={`key ${a.key}`}>
              {ago(a.createdAt)}
            </span>
            <span className="recent-label" title={a.narrative || a.label}>
              {a.label}
            </span>
            <span className="recent-counts">
              {a.changedFiles.length > 0 ? `⚡${a.changedFiles.length}` : ""} → {a.directCount} direct / {a.rippleCount} ripple
              {a.llmUsed ? " · 🤖" : ""}
            </span>
            {a.changedFiles.length > 0 && (
              <button className="mini-btn" disabled={disabled} onClick={() => onRerun(a)} title={`re-run: ${a.changedFiles.join(", ")}`}>
                ↻ re-run
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
