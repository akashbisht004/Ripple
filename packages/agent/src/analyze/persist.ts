/**
 * Analysis writeback (Phase 3, feeds Phase 5).
 *
 * Persists every run as
 *   (:Analysis {key, label, createdAt, summary})
 *     -[:FLAGGED {depth, severity, score}]->(impacted nodes)
 * so later CI results can confirm or kill each prediction (continuous feedback).
 * FLAGGED edges start *unverified* — only the Phase 5 ci-feedback writeback
 * sets `confirmed`/`confidence`, which the impact engine then re-reads.
 */
import type { Graph } from "falkordb";
import type { AnalysisOutput } from "./agent.js";

export async function persistAnalysis(graph: Graph, out: AnalysisOutput): Promise<string> {
  const label = out.result.label;
  const analysisKey = `analysis:${label}:${Date.now()}`;

  await graph.query(
    `CREATE (a:Analysis {
       key: $key,
       label: $label,
       createdAt: timestamp(),
       narrative: $summary,
       llmUsed: $llmUsed,
       changedFiles: $changedFiles,
       directCount: $directCount,
       rippleCount: $rippleCount
     })`,
    {
      params: {
        key: analysisKey,
        label,
        summary: out.narrative,
        llmUsed: out.llmUsed,
        changedFiles: out.result.changedFiles,
        directCount: out.result.direct.length,
        rippleCount: out.result.ripple.length,
      },
    },
  );

  const rows = [...out.result.direct, ...out.result.ripple].map((imp) => ({
    key: imp.key,
    depth: imp.depth,
    severity: imp.severity,
    score: imp.score,
  }));

  if (rows.length > 0) {
    await graph.query(
      `UNWIND $rows AS row
       MATCH (a:Analysis { key: $key })
       MATCH (n { key: row.key })
       MERGE (a)-[f:FLAGGED]->(n)
       SET f.depth = row.depth, f.severity = row.severity, f.score = row.score`,
      { params: { rows, key: analysisKey } },
    );
  }

  return analysisKey;
}
