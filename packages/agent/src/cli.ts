#!/usr/bin/env node
/**
 * Analyze CLI — Phase 3 demo milestone:
 *
 *   npm run analyze -- --files src/billing.ts                 (offline demo mode)
 *   npm run analyze -- --pr https://github.com/o/r/pull/123 --repo path/to/clone
 *   npm run analyze -- --diff ./pr-123.patch
 *
 * Requires the repo to be ingested first:  `npm run ingest -- --repo <checkout>`
 */
import { disconnectGraph, graphSelector, healthCheckGraph } from "@ripple/core";
import { analyze } from "./analyze/agent.js";
import { renderMarkdown } from "./analyze/report.js";
import { persistAnalysis } from "./analyze/persist.js";
import {
  diffFileToPrInput,
  fetchPrInput,
  fetchPullRequestMeta,
  filesArgToPrInput,
  prUrlToRef,
  type PrInput,
} from "./github/pr-fetcher.js";

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

async function resolveInput(args: Record<string, string | boolean>): Promise<PrInput> {
  if (typeof args.pr === "string") {
    const ref = prUrlToRef(args.pr);
    if (!ref) {
      throw new Error("Could not parse PR URL. Expected https://github.com/<owner>/<repo>/pull/<n>");
    }
    const [meta, input] = await Promise.all([fetchPullRequestMeta(ref), fetchPrInput(ref)]);
    return { ...input, label: `${ref.owner}/${ref.repo}#${ref.prNumber}`, prTitle: meta.title };
  }
  if (typeof args.files === "string") return filesArgToPrInput(args.files);
  if (typeof args.diff === "string") return diffFileToPrInput(args.diff);
  throw new Error(
    "No input given. Use one of:  --pr <github PR url>   |   --files src/a.ts,src/b.ts   |   --diff ./pr.patch",
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const staticTitle = typeof args.title === "string" ? args.title : undefined;

  console.log("┌──────────────────────────────────────────┐");
  console.log("│  RIPPLE · Phase 3 · impact analysis      │");
  console.log("└──────────────────────────────────────────┘");

  const health = await healthCheckGraph();
  if (!health.ok) {
    console.error(`✖ FalkorDB unreachable (${health.error}). Run: npm run db:up && npm run ingest -- --repo <path>`);
    process.exit(1);
  }
  console.log(`✔ FalkorDB healthy in ${health.latencyMs}ms`);

  const inputRaw = await resolveInput(args);
  const prTitle = staticTitle ?? inputRaw.prTitle;

  const { graph } = await graphSelector();
  const out = await analyze(graph, { label: inputRaw.label, files: inputRaw.files.map((f) => f.path), prTitle });
  const analysisKey = await persistAnalysis(graph, out);
  await disconnectGraph();

  console.log("");
  console.log(renderMarkdown(out));
  console.log(`── persisted as :Analysis ${analysisKey} ──`);
}

main().catch((err: Error) => {
  console.error("✖ analyze failed:", err.message ?? err);
  process.exit(1);
});
