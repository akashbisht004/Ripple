#!/usr/bin/env node
/**
 * Ingest CLI (Phase 1 demo milestone):
 *   npm run ingest -- --repo ./samples/demo-ts-repo [--graph ripple] [--reset] [--print-sample]
 *
 * After ingestion, prints graph stats; `--print-sample` runs the Phase-1
 * demo Cypher queries (dependents + bug history) on the ingested graph.
 */
import { connectGraph, disconnectGraph, graphSelector, healthCheckGraph, NODE_KEY_FIELD } from "@ripple/core";
import { ingestRepo } from "./orchestrator.js";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--print-sample" || a === "--reset" || a === "--github") {
      args[a.slice(2)] = true;
    } else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      // first bare positional is the repo path (npm may strip flag prefixes)
      args.repo ??= a;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repo = (args.repo as string) ?? ".";
  const graphName = typeof args.graph === "string" ? args.graph : undefined;
  const useGithub = args.github === true;

  console.log("┌──────────────────────────────────────────┐");
  console.log("│  RIPPLE · Phase 1 · FalkorDB ingestion   │");
  console.log("└──────────────────────────────────────────┘");

  const health = await healthCheckGraph();
  if (!health.ok) {
    console.error(`✖ FalkorDB unreachable (${health.error}).`);
    console.error("  Is the container up? Try: npm run db:up  (docker compose up -d)");
    process.exit(1);
  }
  console.log(`✔ FalkorDB healthy in ${health.latencyMs}ms (${process.env.FALKORDB_HOST ?? "localhost"}:${process.env.FALKORDB_PORT ?? 6379})`);

  const report = await ingestRepo({
    rootPath: repo,
    reset: args.reset === true,
    graphName,
    github: useGithub,
  });

  console.log("──────────────────── ingest summary ────────────────────");
  console.log(`  files: ${report.files}   symbols: ${report.symbols}   deps: ${report.dependencies}`);
  console.log(`  calls: ${report.calls}   tests: ${report.tests}   routes: ${report.routes}`);
  console.log(`  commits: ${report.commits}   bugs: ${report.bugs}   bug→function links: ${report.bugFunctionLinks}`);
  if (useGithub) console.log(`  github-hydrated bugs: ${report.bugsHydrated}`);
  console.log(`  written: ${report.writer.nodes} nodes / ${report.writer.edges} edges in ${report.writer.batches} batches`);

  if (args["print-sample"]) {
    await printSampleQueries();
  }

  await disconnectGraph();
}

/** Demo Cypher queries straight from docs/implementation.md §2. */
async function printSampleQueries(): Promise<void> {
  const { graph } = await graphSelector();

  console.log("\n── sample: dependency graph (files → DEPENDS_ON) ──");
  const deps = await graph.query<{ a: string; b: string; symbols: string[] }>(
    `MATCH (a:File)-[d:DEPENDS_ON]->(b:File)
     RETURN a.path AS a, b.path AS b, d.symbolsUsed AS symbols LIMIT 20`,
  );
  for (const row of deps.data ?? []) {
    console.log(`  ${row.a} → ${row.b}  [${(row.symbols ?? []).join(", ")}]`);
  }

  console.log("\n── sample: call graph (caller → callee) ──");
  const calls = await graph.query<{ a: string; b: string }>(
    `MATCH (a)-[:CALLS]->(b)
     RETURN a.key AS a, b.key AS b LIMIT 20`,
  );
  for (const row of calls.data ?? []) {
    console.log(`  ${row.a} → ${row.b}`);
  }

  console.log("\n── sample: reverse ripple for src/checkout.ts (1..3 hops) ──");
  const ripple = await graph.query<{ path: string; hops: number }>(
    `MATCH (src:File { ${NODE_KEY_FIELD}: 'src/checkout.ts' })<-[r:DEPENDS_ON|CALLS*1..3]-(affected)
     RETURN DISTINCT affected.key AS path, length(r) AS hops`,
  );
  for (const row of ripple.data ?? []) {
    console.log(`  ${row.path}  (depth ${row.hops})`);
  }

  console.log("\n── sample: bug history (Bug ← FIXED ← Commit, BUG REFERS_TO → File) ──");
  const bugs = await graph.query<{ title: string; sha: string; file: string }>(
    `MATCH (b:Bug)<-[:FIXED]-(c:Commit), (b)-[:REFERS_TO]->(file:File)
     RETURN b.title AS title, c.sha AS sha, file.path AS file LIMIT 10`,
  );
  for (const row of bugs.data ?? []) {
    console.log(`  "${row.title}" (${row.sha.slice(0, 8)}) → ${row.file}`);
  }

  console.log("\n── sample: function-level bug evidence (Cypher #3 from docs) ──");
  const fnEvidence = await graph.query<{ fn: string; title: string; sha: string }>(
    `MATCH (fn:Function)<-[:REFERS_TO]-(b:Bug)<-[:FIXED]-(c:Commit)
     RETURN fn.name AS fn, b.title AS title, c.sha AS sha LIMIT 10`,
  );
  for (const row of fnEvidence.data ?? []) {
    console.log(`  ${row.fn} ← "${row.title}" (${row.sha.slice(0, 8)})`);
  }
}

main().catch((err) => {
  console.error("✖ ingest failed:", err);
  process.exit(1);
});
