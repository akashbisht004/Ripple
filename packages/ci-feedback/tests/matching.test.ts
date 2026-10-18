/**
 * Offline unit tests for the CI outcome matcher (Phase 6).
 * Pure logic only — no DB needed:
 *   node --import tsx --test packages/ci-feedback/tests/matching.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchCiOutcomes, normalizeTestPath } from "../src/feedback.js";

describe("normalizeTestPath", () => {
  it("strips line:col suffixes", () => {
    assert.equal(normalizeTestPath("src/auth.test.ts:42"), "src/auth.test.ts");
    assert.equal(normalizeTestPath("src/auth.test.ts:12:9"), "src/auth.test.ts");
  });

  it("strips path prefixes and named blocks", () => {
    assert.equal(normalizeTestPath("b/src/auth.test.ts"), "src/auth.test.ts");
    assert.equal(normalizeTestPath("./src/auth.test.ts::describe block"), "src/auth.test.ts");
  });

  it("keeps clean paths", () => {
    assert.equal(normalizeTestPath("src/auth.test.ts"), "src/auth.test.ts");
  });
});

describe("matchCiOutcomes", () => {
  const flagged = ["src/billing.ts::computeDiscount", "src/checkout.ts"];

  it("confirms when any covering test fails (symbol inherits file coverage)", () => {
    const cov = new Map([
      ["src/billing.ts", new Set(["src/billing.test.ts"])],
      ["src/checkout.ts", new Set(["src/checkout.test.ts"])],
    ]);
    const out = matchCiOutcomes(flagged, cov, new Set(["src/billing.test.ts"]), new Set());
    assert.equal(out.get("src/billing.ts::computeDiscount"), "confirmed");
    assert.equal(out.has("src/checkout.ts"), false);
  });

  it("disproves when covering tests explicitly pass", () => {
    const cov = new Map([["src/checkout.ts", new Set(["src/checkout.test.ts"])]]);
    const out = matchCiOutcomes(flagged, cov, new Set(), new Set(["src/checkout.test.ts"]));
    assert.equal(out.get("src/checkout.ts"), "disproven");
  });

  it("leaves nodes without test coverage unverified", () => {
    const out = matchCiOutcomes(flagged, new Map(), new Set(), new Set());
    assert.equal(out.size, 0);
  });

  it("failing beats passing on the same node", () => {
    const cov = new Map([["src/checkout.ts", new Set(["a.test.ts", "b.test.ts"])]]);
    const out = matchCiOutcomes(flagged, cov, new Set(["a.test.ts"]), new Set(["b.test.ts"]));
    assert.equal(out.get("src/checkout.ts"), "confirmed");
  });
});
