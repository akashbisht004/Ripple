#!/usr/bin/env node
/**
 * CI feedback CLI — Phase 5:
 *
 *   npm run ci-feedback -- --pr https://github.com/o/r/pull/123          (GitHub checks mode)
 *   npm run ci-feedback -- --failed src/auth.test.ts                     (manual mode)
 *   npm run ci-feedback -- --failed src/auth.test.ts --passed src/billing.test.ts
 *   npm run ci-feedback -- --label "o/r#123" --failed .                  (pin a specific analysis run)
 *
 * Manual mode exists for the offline demo (no real CI needed): feed the same
 * test file paths CI would report and the graph learns from it the same way.
 */
import { disconnectGraph, graphSelector, healthCheckGraph } from "@ripple/core";
import { recordCiResults, feedbackStats, opsOf, type CiRecordResult, type FeedbackStats } from "./feedback.js";
import { fetchCiTestFiles, prUrlToRef } from "./github-ci.js";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

function listArg(value: string | boolean | undefined): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log("┌──────────────────────────────────────────┐");
  console.log("│  RIPPLE · Phase 5 · CI feedback loop     │");
  console.log("└──────────────────────────────────────────┘");

  const health = await healthCheckGraph();
  if (!health.ok) {
    console.error(`✖ FalkorDB unreachable (${health.error}). Run: npm run db:up && npm run ingest -- --repo <path>`);
    process.exit(1);
  }
  console.log(`✔ FalkorDB healthy in ${health.latencyMs}ms`);

  const { graph } = await graphSelector();

  let result: CiRecordResult;
  try {
    if (typeof args.pr === "string") {
      const ref = prUrlToRef(args.pr);
      if (!ref) throw new Error("Could not parse PR URL. Expected https://github.com/<owner>/<repo>/pull/<n>");
      console.log(`→ fetching failed checks for ${ref.owner}/${ref.repo}#${ref.prNumber}…`);
      const ci = await fetchCiTestFiles(ref);
      if (ci.failed.length === 0) {
        console.log(
          `⚠ no failing test files extracted${ci.unparseableRuns.length ? ` (${ci.unparseableRuns.length} failed check run(s) had no file annotations: ${ci.unparseableRuns.slice(0, 3).join(", ")})` : ""} — falling back to manual paths if provided`,
        );
      }
      result = await recordCiResults(graph, {
        label: ci.label,
        failed: ci.failed,
        passed: listArg(args.passed),
        ref: `checks on ${ci.headSha.slice(0, 8)}`,
        source: "github",
      });
    } else {
      const failed = listArg(args.failed);
      const passed = listArg(args.passed);
      if (failed.length === 0 && passed.length === 0) {
        throw new Error("No CI results given. Use --failed/--passed file lists or --pr <github PR url>.");
      }
      result = await recordCiResults(graph, {
        label: typeof args.label === "string" ? args.label : undefined,
        analysisKey: typeof args.analysis === "string" ? args.analysis : undefined,
        failed,
        passed,
        ref: "manual CLI",
        source: "manual",
      });
    }
  } finally {
    await disconnectGraph();
  }

  if (!result.ok) {
    console.error(`✖ ${result.message}`);
    process.exit(1);
  }

  console.log(`✔ ${result.message}`);
  console.log(
    `  run     : ${result.runKey ?? "-"}\n  analysis: ${result.analysisKey ?? "-"}\n  verified: ${result.verifiedCount} prediction(s)`,
  );
  if (result.confirmed.length) {
    console.log(`  confirmed : ${result.confirmed.slice(0, 6).join(", ")}${result.confirmed.length > 6 ? " …" : ""}`);
  }
  if (result.disproven.length) {
    console.log(`  disproven : ${result.disproven.slice(0, 6).join(", ")}${result.disproven.length > 6 ? " …" : ""}`);
  }
  console.log("");
  const { graph: g2 } = await graphSelector();
  const stats: FeedbackStats = await feedbackStats(opsOf(g2));
  await disconnectGraph();

  if (stats.accuracy !== null) {
    const pct = Math.round(stats.accuracy * 100);
    console.log(`🎯 prediction accuracy so far: ${pct}% (${stats.confirmedPredictions}/${stats.verifiedPredictions} verified)`);
  }
  if (stats.latestTop5 && stats.latestTop5.verified > 0) {
    console.log(
      `📍 most recent verified run: ${stats.latestTop5.confirmed}/${stats.latestTop5.verified} of the top-scored predictions confirmed`,
    );
  }
  for (const r of stats.lastRuns.slice(0, 3)) {
    console.log(`   ↳ ${new Date(r.at).toLocaleString()} · ${r.source} · ${r.confirmedCount}↑ ${r.disprovenCount}↓ (failed ${r.failedCount} / passed ${r.passedCount} suite files)`);
  }
  console.log("\n→ re-run the analysis to see the weighting applied.");
}

main().catch((err: Error) => {
  console.error("✖ ci-feedback failed:", err.message ?? err);
  process.exit(1);
});
