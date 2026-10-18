/**
 * Ingestion orchestrator — parse + git history → graph writer → FalkorDB.
 *
 * Usage (CLI wiring in `cli.ts`):
 *   npm run ingest -- --repo ./samples/demo-ts-repo [--graph ripple] [--reset]
 */
import { GraphWriter, NODE_LABELS as L, EDGE_TYPES as E, NODE_KEY_FIELD, graphSelector, disconnectGraph } from "@ripple/core";
import { CodebaseParser, type ParseOutput } from "./parser.js";
import { mineGitHistory, isRepo, type MinedCommit } from "./git-history.js";
import { detectGithubRepo, fetchBugEvidence, writeHydration, type BugEvidenceInput, type GithubRepoRef } from "./github.js";

export interface IngestOptions {
  rootPath: string;
  reset?: boolean;
  maxCommits?: number;
  graphName?: string;
  /** Hydrate Bug nodes with live GitHub issues/commits (Phase 2). */
  github?: boolean;
}

export interface IngestReport {
  files: number;
  symbols: number;
  dependencies: number;
  calls: number;
  tests: number;
  tested: number;
  routes: number;
  commits: number;
  bugs: number;
  bugFunctionLinks: number;
  bugsHydrated: number;
  writer: { nodes: number; edges: number; batches: number };
}

export async function ingestRepo(opts: IngestOptions): Promise<IngestReport> {
  const { graph, config } = await graphSelector({ graphName: opts.graphName });

  if (opts.reset) {
    console.log(`[reset] dropping graph '${config.graphName}' …`);
    await graph.delete();
  }

  const writer = new GraphWriter(graph);
  await writer.ensureIndexes();
  console.log("[indexes] ensured");

  // ── parse codebase ───────────────────────────────────────────────────
  const parser = new CodebaseParser(opts.rootPath);
  console.log(`[parse] ${parser.fileCount} source files in project`);
  const parsed: ParseOutput = parser.parse();

  const knownFiles = new Set(parsed.files.map((f) => f.key));

  for (const f of parsed.files) {
    writer.addNode(L.FILE, { [NODE_KEY_FIELD]: f.key, path: f.path, hash: f.hash, loc: f.loc, isTest: f.isTest });
  }

  for (const sym of parsed.symbols) {
    writer.addNode(sym.kind, {
      [NODE_KEY_FIELD]: sym.key,
      name: sym.name,
      qualifiedName: sym.key,
      fileKey: sym.fileKey,
      line: sym.line,
      signature: sym.signature ?? null,
      exported: sym.exported,
    });
    writer.addEdge(E.CONTAINS, sym.fileKey, sym.key);
  }

  for (const dep of parsed.dependencies) {
    if (!knownFiles.has(dep.toFile)) continue;
    writer.addEdge(E.DEPENDS_ON, dep.fromFile, dep.toFile, { symbolsUsed: dep.symbolsUsed });
  }

  const knownNodes = new Set<string>([
    ...parsed.files.map((f) => f.key),
    ...parsed.symbols.map((s) => s.key),
  ]);
  for (const call of parsed.calls) {
    if (!knownNodes.has(call.callerKey) || !knownNodes.has(call.calleeKey)) continue;
    writer.addEdge(E.CALLS, call.callerKey, call.calleeKey, { callSite: call.callSite });
  }

  for (const test of parsed.tests) {
    writer.addNode(L.TEST, { [NODE_KEY_FIELD]: test.key, name: test.name, fileKey: test.fileKey });
  }
  for (const t of parsed.tested) {
    if (!knownNodes.has(t.subjectFileKey)) continue;
    writer.addEdge(E.TESTED_BY, t.subjectFileKey, t.testKey);
  }

  for (const route of parsed.routes) {
    writer.addNode(L.API_ROUTE, { [NODE_KEY_FIELD]: route.key, method: route.method, path: route.path });
    if (knownNodes.has(route.handler)) {
      writer.addEdge(E.HANDLED_BY, route.key, route.handler);
    }
  }

  await writer.flush();
  console.log(`[write] codebase flush: ${writer.report.nodes} nodes, ${writer.report.edges} edges`);

  // ── git history → evidence ───────────────────────────────────────────
  let commits = 0;
  let bugs = 0;
  let bugFunctionLinks = 0;
  const bugEvidence: BugEvidenceInput[] = [];
  let commitsRemainder = { nodes: 0, edges: 0, batches: 0 };
  if (await isRepo(opts.rootPath)) {
    const base = writer.report;
    const history = await mineGitHistory(opts.rootPath, opts.maxCommits ?? 500);
    console.log(`[git] mining ${history.length} commits …`);
    const ranges = symbolLineRanges(parsed);
    for (const c of history) {
      writer.addNode(L.COMMIT, {
        [NODE_KEY_FIELD]: c.sha,
        sha: c.sha,
        message: c.message,
        date: c.date,
        isBugFix: c.isBugFix,
      });
      for (const file of c.files) {
        if (!knownFiles.has(file)) continue; // file not in graph (e.g. deleted/external)
        writer.addEdge(E.TOUCHED, c.sha, file);
      }
      if (c.isBugFix) {
        const bugKey = `bug#${c.sha.slice(0, 10)}`;
        writer.addNode(L.BUG, {
          [NODE_KEY_FIELD]: bugKey,
          title: c.message,
          // kept as string-keyed map for graph props (no nested objects)
          refs: c.issueRefs,
          sha: c.sha,
        });
        bugs += 1;
        writer.addEdge(E.FIXED, c.sha, bugKey);
        for (const file of c.files) {
          if (!knownFiles.has(file)) continue;
          writer.addEdge(E.REFERS_TO, bugKey, file);
        }
        bugEvidence.push({ bugKey, heuristicTitle: c.message, issueRefs: c.issueRefs, sha: c.sha });

        // function-level attribution: intersect diff hunks with symbol ranges
        for (const st of c.statuses) {
          const hunksInFile = [
            ...(c.hunksByFile[st.path] ?? []),
            ...(st.oldPath ? (c.hunksByFile[st.oldPath] ?? []) : []),
          ];
          if (hunksInFile.length === 0) continue;
          for (const sym of ranges.get(st.path) ?? []) {
            if ((sym.kind === "Function" || sym.kind === "Class") && hunksTouch(hunksInFile, sym.start, sym.end)) {
              writer.addEdge(E.REFERS_TO, bugKey, sym.key);
              bugFunctionLinks += 1;
            }
          }
        }
      }
      commits += 1;
    }
    await writer.flush();
    const after = writer.report;
    commitsRemainder = {
      nodes: after.nodes - base.nodes,
      edges: after.edges - base.edges,
      batches: after.batches - base.batches,
    };
    console.log(`[write] history flush: +${commitsRemainder.nodes} nodes, +${commitsRemainder.edges} edges`);
  } else {
    console.log("[git] not a git repository — skipping history mining");
  }

  // ── GitHub hydration → linked evidence (Phase 2) ──
  let bugsHydrated = 0;
  if (opts.github && bugEvidence.length > 0) {
    const repoRef = await detectGithubRepo(opts.rootPath);
    if (!repoRef) {
      console.log("[github] no 'origin' remote on this repo — skipping hydration (heuristic titles kept)");
    } else {
      console.log(`[github] hydrating ${bugEvidence.length} bugs from ${repoRef.owner}/${repoRef.repo} …`);
      const hydrated = await fetchBugEvidence(repoRef, bugEvidence);
      bugsHydrated = await writeHydration(graph, hydrated);
      console.log(`[github] linked ${bugsHydrated}/${hydrated.length} bug nodes to live issues/commits`);
    }
  }

  const report = {
    files: parser.fileCount,
    symbols: parsed.symbols.length,
    dependencies: parsed.dependencies.length,
    calls: parsed.calls.length,
    tests: parsed.tests.length,
    tested: parsed.tested.length,
    routes: parsed.routes.length,
    commits,
    bugs,
    bugFunctionLinks,
    bugsHydrated,
    writer: writer.report,
  };
  await disconnectGraph();
  return report;
}

/** Sorted line ranges per file: symbol start → next symbol start − 1. */
function symbolLineRanges(parsed: ParseOutput): Map<string, Array<{ key: string; kind: "Function" | "Class" | "Type"; start: number; end: number }>> {
  const fileLengths = new Map(parsed.files.map((f) => [f.key, f.loc]));
  const byFile = new Map<string, Array<{ key: string; kind: "Function" | "Class" | "Type"; start: number }>>();
  for (const s of parsed.symbols) {
    const list = byFile.get(s.fileKey) ?? [];
    list.push({ key: s.key, kind: s.kind, start: s.line });
    byFile.set(s.fileKey, list);
  }
  const result = new Map<string, Array<{ key: string; kind: "Function" | "Class" | "Type"; start: number; end: number }>>();
  for (const [fileKey, list] of byFile) {
    list.sort((a, b) => a.start - b.start);
    const fileEnd = fileLengths.get(fileKey) ?? Number.MAX_SAFE_INTEGER;
    result.set(fileKey, list.map((s, i) => ({
      ...s,
      end: i + 1 < list.length
        ? Math.max(s.start, (list[i + 1]?.start ?? fileEnd)) - 1
        : fileEnd,
    })));
  }
  return result;
}

/** Does any hunk's changed-line span intersect [symStart, symEnd]? */
function hunksTouch(hunks: Array<{ start: number; count: number }>, symStart: number, symEnd: number): boolean {
  for (const h of hunks) {
    const hStart = h.start;
    const hEnd = h.start + Math.max(h.count, 1) - 1;
    if (hEnd >= symStart && hStart <= symEnd) return true;
  }
  return false;
}
