/**
 * Offline unit tests for the impact engine's scoring / severity rules (Phase 6).
 *
 * Runs against a hand-rolled fake `GraphOps` — no FalkorDB needed:
 *   node --import tsx --test packages/agent/tests/impact-engine.test.ts
 *
 * Fixture graph (edges point from dependant → dependency):
 *   (/api/x HANDLED_BY src/a.ts::discount · not exercised here)
 *   src/b.ts::caller  CALLS      src/a.ts::discount         (hop 1)
 *   src/b.ts   DEPENDS_ON src/a.ts            (hop 1)
 *   src/c.ts   DEPENDS_ON src/b.ts            (hop 2)
 *   src/d.ts   DEPENDS_ON src/c.ts            (hop 3 → low severity)
 *   Bug bug1 REFERS_TO src/a.ts, FIXED by commit sha123 (inherited by the symbol)
 *   src/a.ts TESTED_BY src/a.test.ts::tests pricing (inherited by the symbol)
 *   CI feedback: src/a.ts::discount confirmed (conf .9) · src/b.ts::caller disproven (conf .63)
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeImpact, type GraphOps } from "../src/analyze/impact-engine.js";

const CONTAINED = [
  { skey: "src/a.ts::discount", label: "Function", name: "discount" },
];
const RIPPLE_EDGES: Record<string, Array<{ nkey: string; edgeType: string }>> = {
  "src/a.ts::discount": [{ nkey: "src/b.ts::caller", edgeType: "CALLS" }],
  "src/a.ts": [{ nkey: "src/b.ts", edgeType: "DEPENDS_ON" }],
  "src/b.ts": [{ nkey: "src/c.ts", edgeType: "DEPENDS_ON" }],
  "src/c.ts": [{ nkey: "src/d.ts", edgeType: "DEPENDS_ON" }],
  "src/d.ts": [],
  "src/b.ts::caller": [],
};
const BUG_ROWS = [
  { bkey: "bug1", title: "discount applied twice", state: "closed", url: "http://x", csha: "sha123", lkey: "src/a.ts" },
];
const TEST_ROWS = [{ lkey: "src/a.ts", tkey: "t1", tname: "tests pricing", tfile: "src/a.test.ts" }];
const FEEDBACK_ROWS = [
  { nk: "src/a.ts::discount", confirmed: true, confidence: 0.9 },
  { nk: "src/b.ts::caller", confirmed: false, confidence: 0.63 },
];

const fakeOps = (inGraph: Set<string>): GraphOps => {
  const query = async (cypher: string, params?: Record<string, unknown>): Promise<unknown[]> => {
    const keys = ((params?.keys as string[] | undefined) ?? []) as string[];
    if (cypher.includes("count(f) AS n")) {
      return [{ n: inGraph.has(params?.key as string) ? 1 : 0 }];
    }
    if (cypher.includes("CONTAINS]->(s)")) {
      return keys.filter((k) => k === "src/a.ts").map(() => CONTAINED[0]);
    }
    if (cypher.includes("ApiRoute)-[:HANDLED_BY]")) return [];
    if (cypher.includes("DEPENDS_ON|CALLS|HANDLED_BY]->(prev")) {
      return keys.flatMap((key) =>
        (RIPPLE_EDGES[key] ?? []).map((e) => ({
          nkey: e.nkey,
          label: e.nkey.startsWith("src/") ? "File" : "Function",
          name: e.nkey.split("::").pop(),
          edgeType: e.edgeType,
          viaKey: key,
          isTest: false,
        })),
      );
    }
    if (cypher.includes("Bug)-[:REFERS_TO]")) {
      return keys.length > 0 ? BUG_ROWS : [];
    }
    if (cypher.includes(":Test)<-[:TESTED_BY]")) {
      return keys.includes("src/a.ts") ? TEST_ROWS : [];
    }
    if (cypher.includes(":FLAGGED]-(:Analysis)")) {
      return FEEDBACK_ROWS.filter((r) => keys.includes(r.nk));
    }
    throw new Error(`fake ops: unmatched cypher: ${cypher.slice(0, 60)}`);
  };
  return { query: query as GraphOps["query"] };
};

describe("computeImpact (fake graph)", () => {
  it("classifies files outside the graph", async () => {
    const res = await computeImpact(fakeOps(new Set(["src/a.ts"])), {
      label: "t",
      files: ["src/a.ts", "src/unknown.ts", "src/also-unknown.ts"],
    });
    assert.deepEqual(res.outsideGraph, ["src/unknown.ts", "src/also-unknown.ts"]);
    assert.equal(res.changedFiles.length, 3);
  });

  it("scores ripple paths by weighted distance (CALLS 2, DEPENDS_ON 1, ×0.5 decay)", async () => {
    const res = await computeImpact(fakeOps(new Set(["src/a.ts"])), { label: "t", files: ["src/a.ts"] });
    const by = (k: string) => [...res.direct, ...res.ripple].find((i) => i.key === k);
    // DEPENDS_ON over the file: 5*0.5 + 1 = 3.5 (no CI feedback on this node)
    assert.equal(by("src/b.ts")?.score, 3.5);
    assert.equal(by("src/b.ts")?.depth, 1);
    // hop 2: 3.5*0.5 + 1 = 2.75, engine rounds to 1 decimal → 2.8
    assert.equal(by("src/c.ts")?.depth, 2);
    assert.equal(by("src/c.ts")?.score, 2.8);
    assert.equal(by("src/c.ts")?.severity, "medium");
    // hop 3: 2.75*0.5 + 1 = 2.375 → rounded 2.4, and depth > 2 ⇒ low
    assert.equal(by("src/d.ts")?.depth, 3);
    assert.equal(by("src/d.ts")?.severity, "low");
    // the CALLS edge alone would give 4.5, but the fixture's decay feedback
    // (−1.5) already applies — covered in the re-weighting test below
    assert.equal(by("src/b.ts::caller")?.via[0], "CALLS");
  });

  it("inherits bug evidence and tests from the file onto symbols", async () => {
    const res = await computeImpact(fakeOps(new Set(["src/a.ts"])), { label: "t", files: ["src/a.ts"] });
    const disc = [...res.direct, ...res.ripple].find((i) => i.key === "src/a.ts::discount");
    assert.ok(disc);
    assert.equal(disc.bugEvidence[0]?.bugKey, "bug1");
    assert.equal(disc.bugEvidence[0]?.sha, "sha123");
    assert.deepEqual(disc.tests, ["src/a.test.ts::tests pricing"]);
    // bug evidence drives severity high even at depth 0
    assert.equal(disc.severity, "high");
    // total bug evidence deduped to one record
    assert.equal(res.bugEvidence.length, 1);
  });

  it("re-weights severity/score from CI feedback (confirmed ↑, decayed ↓)", async () => {
    const res = await computeImpact(fakeOps(new Set(["src/a.ts"])), { label: "t", files: ["src/a.ts"] });
    const disc = [...res.direct, ...res.ripple].find((i) => i.key === "src/a.ts::discount");
    const caller = res.ripple.find((i) => i.key === "src/b.ts::caller");
    assert.equal(disc?.feedback?.confirms, 1);
    assert.equal(disc?.feedback?.confidence, 0.9);
    // confirmed: severity bumped (high→high), score +2
    assert.equal(disc?.score, 7);
    // disproven (confirms==0): medium→low, score −1.5 → 3
    assert.equal(caller?.severity, "low");
    assert.equal(caller?.score, 3);
    assert.equal(caller?.feedback?.disproves, 1);
  });

  it("builds a deduped test plan anchored to the covering nodes", async () => {
    const res = await computeImpact(fakeOps(new Set(["src/a.ts"])), { label: "t", files: ["src/a.ts"] });
    assert.deepEqual(res.testPlan, [{ file: "src/a.ts::discount", test: "src/a.test.ts::tests pricing" }]);
  });

  it("reports coverage gaps per unique file, excluding tested files", async () => {
    const res = await computeImpact(fakeOps(new Set(["src/a.ts"])), { label: "t", files: ["src/a.ts"] });
    const gapFiles = res.coverageGaps.map((g) => g.key).sort();
    // one gap record per untested file: the File-keyed row is discovered
    // before src/b.ts::caller, so it wins the dedupe — c/d stay distinct
    assert.deepEqual(gapFiles, ["src/b.ts", "src/c.ts", "src/d.ts"]);
  });

  it("flags every evaluated node", async () => {
    const res = await computeImpact(fakeOps(new Set(["src/a.ts"])), { label: "t", files: ["src/a.ts"] });
    // src/a.ts::discount, src/b.ts::caller, src/b.ts, src/c.ts, src/d.ts
    assert.equal(res.flaggedCount, 5);
    assert.equal(res.direct.length, 1);
    assert.equal(res.ripple.length, 4);
  });

  it("returns an empty shell when nothing is in the graph", async () => {
    const res = await computeImpact(fakeOps(new Set()), { label: "t", files: ["src/ghost.ts"] });
    assert.equal(res.flaggedCount, 0);
    assert.deepEqual(res.outsideGraph, ["src/ghost.ts"]);
  });
});
