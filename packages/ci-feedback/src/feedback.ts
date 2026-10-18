/**
 * Phase 5 — CI feedback loop writeback (docs/implementation.md §4 Phase 5).
 *
 * CI outcomes are written back onto the persisted `(:Analysis)-[:FLAGGED]`
 * predictions so later analyses can read the weighting:
 *   - confirmed  : predicted-affected component's test FAILED
 *                  → FLAGGED.confirmed=true, confidence ↑
 *   - disproven  : predicted-affected component's tests PASSED
 *                  → FLAGGED.confirmed=false, confidence ×0.7
 * Every scored run is recorded as `(:CiRun)-[:SCORED]->(:Analysis)` so the
 * UI can surface "confirmed in the last N CI runs" + an accuracy badge.
 *
 * All graph access goes through the injected `FalkorOps` port (same shape as
 * the impact engine's GraphOps) so the logic stays testable.
 */
import type { Graph } from "falkordb";

export interface FalkorOps {
  query<T>(cypher: string, params?: Record<string, unknown>): Promise<T[]>;
}

/** Adapter from the falkordb `Graph` to the ops port (mirrors the engine's). */
export function opsOf(g: Graph): FalkorOps {
  return {
    query: async <T>(cypher: string, params?: Record<string, unknown>) => {
      const res = (await g.query(cypher, { params: (params ?? {}) as never })) as { data?: T[] };
      return res.data ?? [];
    },
  };
}

export interface CiRecordInput {
  /** exact `:Analysis.label` match (github PR mode supplies `${owner}/${repo}#${n}`) */
  label?: string;
  /** explicit analysis key; overrides label matching */
  analysisKey?: string;
  /** failing test FILE paths (tolerant: `src/x.test.ts:42` → `src/x.test.ts`) */
  failed: string[];
  /** passing test FILE paths */
  passed: string[];
  /** free-text provenance kept on the :CiRun node */
  ref?: string;
  source: "github" | "manual";
}

export interface CiRecordResult {
  ok: boolean;
  runKey?: string;
  analysisKey?: string;
  label?: string;
  confirmed: string[];
  disproven: string[];
  verifiedCount: number;
  verifiedRunsTotal: number;
  message: string;
}

/**
 * Pure outcome matcher: any failing covering test confirms; otherwise an
 * explicitly-passing covering test disprovens; unknown stays unverified.
 * Symbol-level flags (`file::symbol`) inherit their file's coverage — the
 * impact engine does exactly the same for test plans.
 */
export function matchCiOutcomes(
  flaggedKeys: string[],
  nodeTestFiles: Map<string, Set<string>>,
  failSet: Set<string>,
  passSet: Set<string>,
): Map<string, "confirmed" | "disproven"> {
  const outcome = new Map<string, "confirmed" | "disproven">();
  for (const k of flaggedKeys) {
    const ownerKey = k.includes("::") ? (k.split("::")[0] ?? k) : k;
    const covering = new Set<string>([...(nodeTestFiles.get(k) ?? []), ...(nodeTestFiles.get(ownerKey) ?? [])]);
    const files = [...covering];
    if (files.some((f) => failSet.has(f))) outcome.set(k, "confirmed");
    else if (files.length > 0 && files.some((f) => passSet.has(f))) outcome.set(k, "disproven");
  }
  return outcome;
}

/** Most recent analysis, optionally pinned to a label. */
async function resolveAnalysis(ops: FalkorOps, input: CiRecordInput): Promise<{ key: string; label: string } | null> {
  const rows = await ops.query<{ key: string; label: string }>(
    input.label
      ? `MATCH (a:Analysis { label: $label })
         RETURN a.key AS key, a.label AS label
         ORDER BY a.createdAt DESC LIMIT 1`
      : `MATCH (a:Analysis)
         RETURN a.key AS key, a.label AS label
         ORDER BY a.createdAt DESC LIMIT 1`,
    { label: input.label ?? "" },
  );
  const row = rows[0];
  return row?.key ? { key: row.key, label: row.label ?? "" } : null;
}

const AGGREGATE_RE = /\.(test|spec)\.[jt]sx?$|__tests__\/|(^|\/)tests?\//i;

/** `src/auth.test.ts:42`, `b/src/auth.test.ts`, `./src/auth.test.ts::name` → `src/auth.test.ts`.
 *  Non-test-looking entries are returned untouched (annoying formats tolerated). */
export function normalizeTestPath(raw: string): string {
  let p = raw.trim().replace(/\\/g, "/");
  p = p.replace(/^b\//, "").replace(/^\.\//, "");
  p = p.replace(/(:\d+)+$/g, ""); // path.ts:42:9 → path.ts
  p = p.split("::")[0] ?? p;
  return p.trim();
}

/**
 * Record a CI outcome against the latest (or given) analysis.
 * Matching: FLAGGED file-level nodes carry `TESTED_BY` edges to `:Test`
 * nodes; symbol-level nodes inherit their file's outcome (mirroring the
 * impact engine's test inheritance).
 */
export async function recordCiResults(graph: Graph, input: CiRecordInput): Promise<CiRecordResult> {
  const ops = opsOf(graph);
  const analysis = await resolveAnalysis(ops, input);
  if (!analysis) {
    return {
      ok: false,
      confirmed: [],
      disproven: [],
      verifiedCount: 0,
      verifiedRunsTotal: 0,
      message: `No :Analysis run found${input.label ? ` with label "${input.label}"` : ""}. Run an analysis first (npm run analyze / UI).`,
    };
  }

  // 1. the prediction set (direct + ripple flags of this analysis)
  const flaggedRows = await ops.query<{ k: string }>(
    `MATCH (:Analysis { key: $ak })-[f:FLAGGED]->(n)
     RETURN n.key AS k`,
    { ak: analysis.key },
  );
  const flaggedKeys = [...new Set(flaggedRows.map((r) => r.k).filter(Boolean))];
  if (flaggedKeys.length === 0) {
    return emptyResult(analysis, `Analysis ${analysis.key} has no FLAGGED predictions to verify.`);
  }

  // 2. which flagged nodes are covered by which test FILES.
  //    Symbol-level flags (`file::symbol`) inherit their file's TESTED_BY
  //    edges — the impact engine does exactly the same for test plans.
  const coverageKeys = [...new Set(flaggedKeys.map((k) => (k.includes("::") ? (k.split("::")[0] ?? k) : k)).concat(flaggedKeys))];
  const covRows = await ops.query<{ nk: string; tf: string | null }>(
    `UNWIND $keys AS nkey
     MATCH (n { key: nkey })-[:TESTED_BY]->(t:Test)
     RETURN n.key AS nk, t.fileKey AS tf`,
    { keys: coverageKeys },
  );
  const nodeTestFiles = new Map<string, Set<string>>();
  for (const r of covRows) {
    if (!r.tf) continue;
    const set = nodeTestFiles.get(r.nk) ?? new Set<string>();
    set.add(r.tf);
    nodeTestFiles.set(r.nk, set);
  }

  // failed/passed test-file sets (normalized)
  const failSet = new Set(input.failed.map(normalizeTestPath).filter(Boolean));
  const passSet = new Set(input.passed.map(normalizeTestPath).filter(Boolean));

  // 3. per-node outcome (pure matcher, unit-tested in tests/matching.test.ts)
  const outcome = matchCiOutcomes(flaggedKeys, nodeTestFiles, failSet, passSet);

  const confirmedKeys = [...outcome.entries()].filter(([, v]) => v === "confirmed").map(([k]) => k);
  const disprovenKeys = [...outcome.entries()].filter(([, v]) => v === "disproven").map(([k]) => k);

  // 4. writeback — confirmations strengthen; disprovens decay
  if (confirmedKeys.length > 0) {
    await ops.query(
      `UNWIND $rows AS row
       MATCH (:Analysis { key: $ak })-[f:FLAGGED]->(n { key: row.k })
       SET f.confirmed = true, f.verified = true, f.verifiedAt = timestamp(),
           f.confirms = coalesce(f.confirms, 0) + 1,
           f.confidence = CASE WHEN f.confidence IS NULL THEN 0.9
                               WHEN f.confidence + 0.15 > 1.0 THEN 1.0
                               ELSE f.confidence + 0.15 END`,
      { ak: analysis.key, rows: confirmedKeys.map((k) => ({ k })) },
    );
  }
  if (disprovenKeys.length > 0) {
    await ops.query(
      `UNWIND $rows AS row
       MATCH (:Analysis { key: $ak })-[f:FLAGGED]->(n { key: row.k })
       SET f.confirmed = false, f.verified = true, f.verifiedAt = timestamp(),
           f.disproves = coalesce(f.disproves, 0) + 1,
           f.confidence = CASE WHEN f.confidence IS NULL THEN 0.35 ELSE f.confidence * 0.7 END`,
      { ak: analysis.key, rows: disprovenKeys.map((k) => ({ k })) },
    );
  }

  // 5. record the run so the UI can render the "last N CI runs" story
  const stats = await feedbackStats(ops);  const runKey = `ci-run:${analysis.key}:${Date.now()}`;
  await ops.query(
    `CREATE (r:CiRun {
       key: $rkey, at: timestamp(), source: $source, ref: $ref,
       label: $label, failedCount: $fc, passedCount: $pc,
       confirmedCount: $cc, disprovenCount: $dc
     })
     WITH r
     MATCH (a:Analysis { key: $ak })
     MERGE (r)-[:SCORED]->(a)`,
    {
      rkey: runKey,
      source: input.source,
      ref: input.ref ?? (input.label ? "unspecified ref" : "latest analysis"),
      label: analysis.label,
      fc: failSet.size,
      pc: passSet.size,
      cc: confirmedKeys.length,
      dc: disprovenKeys.length,
      ak: analysis.key,
    },
  );

  const verb =
    confirmedKeys.length || disprovenKeys.length
      ? `confirmed ${confirmedKeys.length}, disproven ${disprovenKeys.length}`
      : "no flagged predictions matched the CI files (recorded, nothing to confirm)";
  return {
    ok: true,
    runKey,
    analysisKey: analysis.key,
    label: analysis.label,
    confirmed: confirmedKeys,
    disproven: disprovenKeys,
    verifiedCount: confirmedKeys.length + disprovenKeys.length,
    verifiedRunsTotal: stats.verifiedPredictions,
    message: `CI outcome recorded against ${analysis.key} — ${verb}.`,
  };
}

function emptyResult(analysis: { key: string; label: string }, message: string): CiRecordResult {
  return {
    ok: false,
    analysisKey: analysis.key,
    label: analysis.label,
    confirmed: [],
    disproven: [],
    verifiedCount: 0,
    verifiedRunsTotal: 0,
    message,
  };
}

/* ── stats ──────────────────────────────────────────────── */

export interface CiRunRow {
  key: string;
  label: string;
  at: number;
  source: string;
  failedCount: number;
  passedCount: number;
  confirmedCount: number;
  disprovenCount: number;
}

export interface FeedbackStats {
  /** total verified prediction edges across all analyses */
  verifiedPredictions: number;
  confirmedPredictions: number;
  /** confirmed / verified (null when nothing verified yet) */
  accuracy: number | null;
  lastRuns: CiRunRow[];
  /** newest analysis with verified edges: how many of its top-5 scored predictions were right */
  latestTop5: { confirmed: number; verified: number } | null;
}

export async function feedbackStats(ops: FalkorOps): Promise<FeedbackStats> {
  const outcomeRows = await ops.query<{ confirmed: boolean }>(
    `MATCH (:Analysis)-[f:FLAGGED]->()
     WHERE f.verified = true
     RETURN f.confirmed AS confirmed`,
  );
  const verifiedPredictions = outcomeRows.length;
  const confirmedPredictions = outcomeRows.filter((r) => r.confirmed === true).length;

  const runRows = await ops.query<{
    key: string;
    label: string;
    at: number;
    source: string;
    fc: number;
    pc: number;
    cc: number;
    dc: number;
  }>(
    `MATCH (r:CiRun)
     RETURN r.key AS key, r.label AS label, r.at AS at, r.source AS source,
            r.failedCount AS fc, r.passedCount AS pc,
            r.confirmedCount AS cc, r.disprovenCount AS dc
     ORDER BY r.at DESC LIMIT 5`,
  );
  const lastRuns: CiRunRow[] = runRows.map((r) => ({
    key: r.key,
    label: r.label ?? "",
    at: Number(r.at ?? 0),
    source: r.source ?? "unknown",
    failedCount: Number(r.fc ?? 0),
    passedCount: Number(r.pc ?? 0),
    confirmedCount: Number(r.cc ?? 0),
    disprovenCount: Number(r.dc ?? 0),
  }));

  // newest analysis (by createdAt) that has verified predictions → top-5 hit rate
  const rows = await ops.query<{ akey: string; at: number; score: number; confirmed: boolean }>(
    `MATCH (a:Analysis)-[f:FLAGGED]->()
     WHERE f.verified = true
     RETURN a.key AS akey, a.createdAt AS at, f.score AS score, f.confirmed AS confirmed`,
  );
  let latestTop5: FeedbackStats["latestTop5"] = null;
  const byAnalysis = new Map<string, { at: number; rows: Array<{ score: number; confirmed: boolean }> }>();
  for (const r of rows) {
    const entry = byAnalysis.get(r.akey) ?? { at: Number(r.at ?? 0), rows: [] };
    if (Number(r.at ?? 0) > entry.at) entry.at = Number(r.at ?? 0);
    entry.rows.push({ score: Number(r.score ?? 0), confirmed: r.confirmed === true });
    byAnalysis.set(r.akey, entry);
  }
  const newest = [...byAnalysis.entries()].sort((a, b) => b[1].at - a[1].at)[0];
  if (newest) {
    const top5 = [...newest[1].rows].sort((a, b) => b.score - a.score).slice(0, 5);
    latestTop5 = { confirmed: top5.filter((r) => r.confirmed).length, verified: top5.length };
  }

  return {
    verifiedPredictions,
    confirmedPredictions,
    accuracy: verifiedPredictions > 0 ? confirmedPredictions / verifiedPredictions : null,
    lastRuns,
    latestTop5,
  };
}
