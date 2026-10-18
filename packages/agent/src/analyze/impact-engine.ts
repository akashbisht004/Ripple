/**
 * Impact engine — Phase 3's deterministic core (docs/implementation.md §5).
 *
 * Given changed file keys, computes:
 *  - direct impacts    (contained symbols, routes via HANDLED_BY)
 *  - the ripple        (level-by-level reverse traversal over DEPENDS_ON |
 *                       CALLS | HANDLED_BY, max 4 hops, weighted discovery path)
 *  - severity          high (route exposure or bug evidence) / medium ≤2 hops / low
 *  - test plan         TESTED_BY edges of changed files
 *  - coverage gaps     impacted symbols whose file has no test path
 *
 * All graph access flows through the injected `GraphOps` port, so the scoring
 * and severity rules stay pure. Every claim is a graph path — the agent never
 * guesses (docs §3.4).
 */
import type { Graph } from "falkordb";

export interface GraphOps {
  query<T>(cypher: string, params?: Record<string, unknown>): Promise<T[]>;
}

/** Adapter from the falkordb `Graph` to the engine's port. */
export function graphOpsOf(g: Graph): GraphOps {
  return {
    query: async <T>(cypher: string, params?: Record<string, unknown>) => {
      const res = (await g.query(cypher, params ? { params: params as never } : undefined)) as { data?: T[] };
      return res.data ?? [];
    },
  };
}

export type Severity = "high" | "medium" | "low";
export type NodeKind = "File" | "Function" | "Class" | "Type" | "Test" | "ApiRoute";

const EDGE_WEIGHTS: Record<string, number> = {
  DEPENDS_ON: 1,
  CALLS: 2,
  HANDLED_BY: 3,
};

export interface BugEvidence {
  bugKey: string;
  title: string;
  state: string | null;
  url: string | null;
  sha: string;
  linkedNodeKey: string;
}

/** CI-feedback weighting attached to a node from past :Analysis outcomes. */
export interface NodeFeedback {
  /** times a failing test confirmed this prediction */
  confirms: number;
  /** times the covering tests passed and decayed this prediction */
  disproves: number;
  /** mean confidence the feedback loop keeps on the FLAGGED edges */
  confidence: number;
}

export interface Impacted {
  key: string;
  kind: NodeKind;
  name: string;
  /** 1-based hop depth from changed code; 0 = direct. */
  depth: number;
  /** Edge types on the discovery path. */
  via: string[];
  /** Weighted strength of the discovery path (higher = riskier). */
  score: number;
  severity: Severity;
  /** true when the node is a test file (never a coverage gap). */
  isTest?: boolean;
  bugEvidence: BugEvidence[];
  tests: string[];
  feedback?: NodeFeedback;
}

export interface CoverageGap {
  key: string;
  kind: string;
  name: string;
  reason: string;
}

export interface TestPlanRow {
  file: string;
  test: string;
}

export interface ImpactResult {
  label: string;
  changedFiles: string[];
  outsideGraph: string[];
  direct: Impacted[];
  ripple: Impacted[];
  bugEvidence: BugEvidence[];
  testPlan: TestPlanRow[];
  coverageGaps: CoverageGap[];
  /** number of flagged nodes, for the :Analysis writeback */
  flaggedCount: number;
}

const MAX_HOPS = 4;
const useful = (s: string): boolean => Boolean(s);

/** Validate changed paths against the graph, split in/out. */
async function classifyFiles(ops: GraphOps, files: string[]): Promise<{ inGraph: string[]; outside: string[] }> {
  const inGraph: string[] = [];
  const outside: string[] = [];
  for (const key of files) {
    const rows = await ops.query<{ n: number }>(
      "MATCH (f:File { key: $key }) RETURN count(f) AS n",
      { key },
    );
    const present = Number(rows[0]?.n ?? 0);
    (present > 0 ? inGraph : outside).push(key);
  }
  return { inGraph, outside };
}

/** Changed file → contained symbols (direct blast radius). */
async function directSymbols(ops: GraphOps, fileKeys: string[]): Promise<Impacted[]> {
  const rows = await ops.query<{ skey: string; label: string; name: string }>(
    `UNWIND $keys AS k
     MATCH (f:File { key: k })-[:CONTAINS]->(s)
     RETURN s.key AS skey, labels(s)[0] AS label, s.name AS name`,
    { keys: fileKeys },
  );
  return rows
    .filter((r) => r.skey && !r.skey.includes(".test."))
    .map((r) => ({
      key: r.skey,
      kind: (r.label ?? "Function") as NodeKind,
      name: r.name ?? r.skey,
      depth: 0,
      via: [],
      severity: "medium" as Severity,
      score: 5,
      bugEvidence: [],
      tests: [],
    }));
}

/** Routes exposed through changed code. */
async function directRoutes(ops: GraphOps, fileKeys: string[]): Promise<Impacted[]> {
  const rows = await ops.query<{ rkey: string }>(
    `UNWIND $keys AS k
     MATCH (rt:ApiRoute)-[:HANDLED_BY]->(s { fileKey: k })
     RETURN DISTINCT rt.key AS rkey`,
    { keys: fileKeys },
  );
  return rows.map((r) => ({
    key: r.rkey,
    kind: "ApiRoute" as NodeKind,
    name: r.rkey,
    depth: 0,
    via: [],
    severity: "high" as Severity,
    score: 10,
    bugEvidence: [],
    tests: [],
  }));
}

/**
 * Reverse ripple BFS. One Cypher hop per level; the discovery path's score
 * decays by hop and gains the edge's weight. Deduped by node key.
 */
async function ripple(ops: GraphOps, startKeys: string[]): Promise<Impacted[]> {
  const visited = new Set<string>(startKeys);
  let frontier = [...startKeys.filter(useful)];
  const found: Impacted[] = [];

  for (let depth = 1; depth <= MAX_HOPS && frontier.length > 0; depth++) {
    const rows = await ops.query<{
      nkey: string;
      label: string;
      name: string;
      edgeType: string;
      viaKey: string;
      isTest: boolean;
    }>(
      `UNWIND $keys AS key
       MATCH (n)-[r:DEPENDS_ON|CALLS|HANDLED_BY]->(prev { key: key })
       RETURN DISTINCT n.key AS nkey,
              labels(n)[0] AS label,
              coalesce(n.name, n.key) AS name,
              type(r) AS edgeType,
              prev.key AS viaKey,
              coalesce(n.isTest, false) AS isTest`,
      { keys: frontier },
    );

    // strongest incoming edge per discovered node this level
    const nextLevel = new Map<string, Impacted>();
    for (const row of rows) {
      if (!row.nkey || visited.has(row.nkey)) continue;
      const edgeType = row.edgeType ?? "DEPENDS_ON";
      const weight = EDGE_WEIGHTS[edgeType] ?? 1;
      const prev = found.find((f) => f.key === row.viaKey);
      const prevScore = prev ? prev.score : 5; // changed files seed the BFS at 5
      const score = Math.round((prevScore * 0.5 + weight) * 10) / 10;

      const existing = nextLevel.get(row.nkey);
      if (!existing) {
        nextLevel.set(row.nkey, {
          key: row.nkey,
          kind: (row.label ?? "File") as NodeKind,
          name: row.name ?? row.nkey,
          depth,
          via: [edgeType],
          severity: "medium",
          score,
          isTest: row.isTest === true,
          bugEvidence: [],
          tests: [],
        });
      } else if (existing.score < score) {
        existing.score = score;
        existing.via.push(edgeType);
      } else {
        existing.via.push(edgeType);
      }
    }

    for (const imp of nextLevel.values()) {
      visited.add(imp.key);
      found.push(imp);
    }
    frontier = [...nextLevel.keys()];
  }
  return found;
}

/** Bug evidence for a set of node keys (Bug-[:REFERS_TO]->n ← Fixed by Commit). */
async function bugEvidenceFor(ops: GraphOps, keys: string[]): Promise<BugEvidence[]> {
  if (keys.length === 0) return [];
  const rows = await ops.query<{
    bkey: string;
    title: string;
    state: string | null;
    url: string | null;
    csha: string;
    lkey: string;
  }>(
    `UNWIND $keys AS k
     MATCH (b:Bug)-[:REFERS_TO]->(n { key: k })
     MATCH (c:Commit)-[:FIXED]->(b)
     RETURN DISTINCT b.key AS bkey, b.title AS title, b.state AS state,
            b.url AS url, c.sha AS csha, n.key AS lkey`,
    { keys },
  );
  return rows
    .filter((r) => r.bkey && r.lkey)
    .map((r) => ({
      bugKey: r.bkey,
      title: r.title ?? "",
      state: r.state ?? null,
      url: r.url ?? null,
      sha: r.csha,
      linkedNodeKey: r.lkey,
    }));
}

/** TESTED_BY links for a set of keys (files carry links to their Tests). */
async function testsFor(ops: GraphOps, keys: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (keys.length === 0) return map;
  const rows = await ops.query<{ lkey: string; tkey: string; tname: string; tfile: string }>(
    `UNWIND $keys AS k
     MATCH (t:Test)<-[:TESTED_BY]-(n { key: k })
     RETURN DISTINCT n.key AS lkey, t.key AS tkey, t.name AS tname, t.fileKey AS tfile`,
    { keys },
  );
  for (const r of rows) {
    if (!r.lkey || !r.tkey) continue;
    const list = map.get(r.lkey) ?? [];
    const label = `${r.tfile ?? ""}::${r.tname ?? r.tkey}`;
    if (!list.includes(label)) list.push(label);
    map.set(r.lkey, list);
  }
  return map;
}

/**
 * CI-feedback weighting from prior :Analysis runs (Phase 5).
 * Aggregates verified FLAGGED outcomes per node; nodes without any verified
 * history simply don't appear in the map (no invented data).
 */
async function feedbackFor(ops: GraphOps, keys: string[]): Promise<Map<string, NodeFeedback>> {
  const map = new Map<string, NodeFeedback>();
  if (keys.length === 0) return map;
  const rows = await ops.query<{ nk: string; confirmed: boolean; confidence: number }>(
    `UNWIND $keys AS k
     MATCH (n { key: k })<-[f:FLAGGED]-(:Analysis)
     WHERE f.verified = true
     RETURN n.key AS nk, f.confirmed AS confirmed, f.confidence AS confidence`,
    { keys },
  );
  const acc = new Map<string, { confirms: number; disproves: number; confidenceSum: number; samples: number }>();
  for (const r of rows) {
    if (!r.nk) continue;
    const fb = acc.get(r.nk) ?? { confirms: 0, disproves: 0, confidenceSum: 0, samples: 0 };
    if (r.confirmed === true) fb.confirms += 1;
    else if (r.confirmed === false) fb.disproves += 1;
    if (r.confidence != null) {
      fb.confidenceSum += Number(r.confidence);
      fb.samples += 1;
    }
    acc.set(r.nk, fb);
  }
  for (const [k, fb] of acc) {
    const confidence = fb.samples > 0 ? Math.round((fb.confidenceSum / fb.samples) * 100) / 100 : 0.5;
    map.set(k, { confirms: fb.confirms, disproves: fb.disproves, confidence });
  }
  return map;
}

function fileIdOf(qualifiedKey: string): string {
  return qualifiedKey.includes("::") ? (qualifiedKey.split("::")[0] ?? qualifiedKey) : qualifiedKey;
}

/** Main entry: changed file paths → full evidence-backed impact analysis. */
export async function computeImpact(ops: GraphOps, input: { label: string; files: string[] }): Promise<ImpactResult> {
  const { inGraph, outside } = await classifyFiles(ops, input.files);
  if (inGraph.length === 0) {
    return {
      label: input.label,
      changedFiles: input.files,
      outsideGraph: outside,
      direct: [],
      ripple: [],
      bugEvidence: [],
      testPlan: [],
      coverageGaps: [],
      flaggedCount: 0,
    };
  }

  const directSymbolsList = await directSymbols(ops, inGraph);
  const directRoutesList = await directRoutes(ops, inGraph);
  const direct = [...directSymbolsList, ...directRoutesList];

  const indirect = await ripple(ops, [...inGraph, ...direct.map((d) => d.key)]);

  // ── evidence pass ──────────────────────────────────────────────────
  const directKeys = direct.map((d) => d.key);
  const rippleKeys = indirect.map((r) => r.key);
  const directFileKeys = [...inGraph, ...directSymbolsList.map((s) => s.key)];
  const rippleFileAndSymbolKeys = [...indirect.map((r) => r.key)];

  const bugs = [
    ...(await bugEvidenceFor(ops, directFileKeys)),
    ...(await bugEvidenceFor(ops, rippleFileAndSymbolKeys)),
  ];
  // dedupe by bug identity; keep the most specific link (symbol over file)
  const bugIndex = new Map<string, BugEvidence>();
  for (const b of bugs) {
    const existing = bugIndex.get(b.bugKey);
    if (!existing || (existing.linkedNodeKey.includes("::") === false && b.linkedNodeKey.includes("::"))) {
      bugIndex.set(b.bugKey, b);
    }
  }
  const dedupedBugs: BugEvidence[] = [...bugIndex.values()];
  const bugKeysForNode = new Map<string, BugEvidence[]>();
  for (const b of dedupedBugs) {
    const list = bugKeysForNode.get(b.linkedNodeKey) ?? [];
    list.push(b);
    bugKeysForNode.set(b.linkedNodeKey, list);
  }
  // file-level evidence also covers symbols in that file
  for (const [fileKey, evs] of [...bugKeysForNode.entries()]) {
    if (fileKey.includes("::")) continue;
    for (const s of [...directSymbolsList, ...indirect]) {
      if (fileIdOf(s.key) === fileKey && !bugKeysForNode.has(s.key)) {
        bugKeysForNode.set(s.key, evs);
      }
    }
  }

  const testMap = await testsFor(ops, [...inGraph, ...rippleKeys]);
  // symbols inherit their file's tests
  for (const s of [...directSymbolsList, ...indirect]) {
    const fileKey = fileIdOf(s.key);
    if (!testMap.has(s.key) && testMap.has(fileKey)) {
      testMap.set(s.key, testMap.get(fileKey) ?? []);
    }
  }

  // Phase 5: historical CI outcomes for every predicted-affected node
  const feedbackMap = await feedbackFor(ops, [...directKeys, ...rippleKeys]);

  const withEvidence: Impacted[] = [...direct, ...indirect].map((imp) => {
    const myBugs = bugKeysForNode.get(imp.key) ?? [];
    const fileKey = fileIdOf(imp.key);
    const tests = imp.kind === "Test" ? [] : (testMap.get(imp.key) ?? []);

    let severity: Severity = imp.depth <= 2 ? "medium" : "low";
    const routeExposed = imp.via.includes("HANDLED_BY") || imp.kind === "ApiRoute";
    if (routeExposed || myBugs.length > 0) severity = "high";

    // Phase 5: past CI outcomes re-weight this prediction (confirmed ↑, decayed ↓)
    const fb = feedbackMap.get(imp.key);
    if (fb) {
      if (fb.confirms > fb.disproves) {
        severity = severity === "low" ? "medium" : "high";
      } else if (fb.disproves > fb.confirms && fb.confirms === 0) {
        severity = severity === "high" ? "medium" : "low";
      }
    }
    const score = fb
      ? Math.round((imp.score + (fb.confirms > 0 && fb.confirms >= fb.disproves ? 2 : -1.5)) * 10) / 10
      : imp.score;

    return { ...imp, score, bugEvidence: myBugs, tests, severity, feedback: fb };
  });

  const directImpacts = withEvidence.filter((i) => i.depth === 0);
  const rippleImpacts = withEvidence.filter((i) => i.depth > 0);

  // coverage gaps: impacted code whose file has no test links anywhere
  const gapCandidates = withEvidence.filter(
    (i) => i.kind !== "Test" && i.kind !== "ApiRoute" && !i.isTest && i.tests.length === 0,
  );
  const dedupedGaps: CoverageGap[] = [];
  const gapFiles = new Set<string>();
  for (const g of gapCandidates) {
    const fileKey = fileIdOf(g.key);
    if (gapFiles.has(fileKey)) continue;
    gapFiles.add(fileKey);
    dedupedGaps.push({
      key: g.kind === "File" ? fileKey : g.key,
      kind: g.kind === "File" ? "File" : g.kind,
      name: g.kind === "File" ? fileKey : g.name,
      reason: `No TESTED_BY edge reaches any symbol in ${fileKey}`,
    });
  }

  // one row per unique test, anchored to the most important node it covers
  const seenTests = new Set<string>();
  const testPlan: TestPlanRow[] = [];
  const orderedNodes = [...directKeys, ...rippleKeys];
  for (const node of orderedNodes) {
    for (const test of testMap.get(node) ?? []) {
      if (seenTests.has(test)) continue;
      seenTests.add(test);
      testPlan.push({ file: node, test });
    }
  }

  return {
    label: input.label,
    changedFiles: input.files,
    outsideGraph: outside,
    direct: sortImpacts(directImpacts),
    ripple: sortImpacts(rippleImpacts),
    bugEvidence: dedupedBugs,
    testPlan,
    coverageGaps: dedupedGaps,
    flaggedCount: withEvidence.length,
  };
}

function sortImpacts(list: Impacted[]): Impacted[] {
  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  return [...list].sort(
    (a, b) => order[a.severity] - order[b.severity] || b.score - a.score || a.key.localeCompare(b.key),
  );
}
