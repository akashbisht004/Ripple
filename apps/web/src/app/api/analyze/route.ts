/**
 * POST /api/analyze — the Phase 4 server bridge.
 *
 * Body: { prUrl?: string, files?: string, title?: string }
 *   - prUrl  → GitHub PR via octokit-free fetcher (Phase 3 path)
 *   - files  → comma-separated repo paths (offline demo mode)
 *
 * Runs the same Phase 3 pipeline as the CLI (impact engine → LLM agent →
 * persistence) and additionally excavates the actual graph edges among the
 * impacted nodes so the UI can draw the ripple exactly as FalkorDB sees it.
 */
import { NextResponse } from "next/server";
import { disconnectGraph, graphSelector, healthCheckGraph } from "@ripple/core";
import { analyze } from "@ripple/agent/analyze/agent";
import { persistAnalysis } from "@ripple/agent/analyze/persist";
import {
  graphOpsOf,
  type GraphOps,
  type ImpactResult,
} from "@ripple/agent/analyze/impact-engine";
import {
  fetchPrInput,
  fetchPullRequestMeta,
  filesArgToPrInput,
  prUrlToRef,
} from "@ripple/agent/github/pr-fetcher";
import { feedbackStats, opsOf, type FeedbackStats } from "@ripple/ci-feedback/feedback";
import type { PrInput } from "@ripple/agent/github/pr-fetcher";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_GRAPH_NODES = 160;

interface AnalyzeBody {
  prUrl?: string;
  files?: string;
  title?: string;
}

async function resolveInput(body: AnalyzeBody): Promise<PrInput> {
  if (body.prUrl) {
    const ref = prUrlToRef(body.prUrl);
    if (!ref) {
      throw new InputError("Could not parse PR URL. Expected https://github.com/<owner>/<repo>/pull/<n>");
    }
    const [meta, input] = await Promise.all([fetchPullRequestMeta(ref), fetchPrInput(ref)]);
    return { ...input, label: `${ref.owner}/${ref.repo}#${ref.prNumber}`, prTitle: meta.title };
  }
  if (body.files) return filesArgToPrInput(body.files);
  throw new InputError("No input given. Provide a PR URL or a comma-separated file list.");
}

class InputError extends Error {}

export async function POST(req: Request): Promise<NextResponse> {
  let body: AnalyzeBody;
  try {
    body = (await req.json()) as AnalyzeBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const health = await healthCheckGraph();
    if (!health.ok) {
      return NextResponse.json(
        { ok: false, error: `FalkorDB unreachable (${health.error}). Run: npm run db:up && npm run ingest -- --repo <path>` },
        { status: 503 },
      );
    }

    const input = await resolveInput(body);
    const prTitle = body.title?.trim() || input.prTitle;

    const { graph } = await graphSelector();
    const out = await analyze(graph, {
      label: input.label,
      files: input.files.map((f) => f.path),
      prTitle,
    });
    const analysisKey = await persistAnalysis(graph, out);

    const graphView = await buildGraphView(graphOpsOf(graph), out.result);
    const feedback: FeedbackStats = await feedbackStats(opsOf(graph));

    await disconnectGraph();

    return NextResponse.json({
      ok: true,
      label: input.label,
      prTitle: prTitle || undefined,
      source: input.source,
      narrative: out.narrative,
      llmUsed: out.llmUsed,
      toolCalls: out.toolCalls,
      analysisKey,
      result: out.result,
      graph: graphView,
      feedback,
    });
  } catch (err) {
    await disconnectGraph();
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof InputError ? 400 : /GitHub .+ failed/.test(message) ? 502 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}

/** Excavate real edges among the impacted nodes — the UI draws what the DB holds. */
async function buildGraphView(ops: GraphOps, result: ImpactResult) {
  const nodeSet = new Set<string>();
  const origins = new Set<string>(result.changedFiles);
  const nodes = new Map<string, GraphNode>();
  const addNode = (
    key: string,
    kind: string,
    name: string,
    depth: number,
    origin: boolean,
    severity: "high" | "medium" | "low" | null,
  ) => {
    if (!nodeSet.has(key)) {
      nodeSet.add(key);
      nodes.set(key, { key, kind, name, depth, origin, severity });
    }
  };

  for (const f of result.changedFiles) addNode(f, "File", f, 0, true, null);
  for (const i of [...result.direct, ...result.ripple]) {
    addNode(i.key, i.kind, i.name, i.depth, false, i.severity);
  }

  const keys = [...nodeSet];
  if (keys.length === 0) return { nodes: [], edges: [], changed: [...origins], truncated: false };

  const [linkRows, containsRows] = await Promise.all([
    ops.query<{ src: string; dst: string; t: string }>(
      `UNWIND $keys AS k
       MATCH (a { key: k })-[r:CALLS|DEPENDS_ON|HANDLED_BY]->(b)
       WHERE b.key IN $keys
       RETURN DISTINCT a.key AS src, b.key AS dst, type(r) AS t`,
      { keys },
    ),
    ops.query<{ src: string; dst: string }>(
      `UNWIND $keys AS k
       MATCH (f:File { key: k })-[:CONTAINS]->(s)
       WHERE s.key IN $keys
       RETURN DISTINCT f.key AS src, s.key AS dst`,
      { keys },
    ),
  ]);

  const edges: GraphEdge[] = [
    ...containsRows
      .filter((r) => r.src && r.dst)
      .map((r) => ({ src: r.src, dst: r.dst, type: "CONTAINS" as const })),
    ...linkRows
      .filter((r) => r.src && r.dst)
      .map((r) => ({ src: r.src, dst: r.dst, type: (r.t || "DEPENDS_ON") as GraphEdge["type"] })),
  ];

  // keep the strongest nodes if the ripple is huge (demo-safety)
  const truncated = nodeSet.size > MAX_GRAPH_NODES;
  if (truncated) {
    const ranked = [...result.direct, ...result.ripple].sort((a, b) => b.score - a.score);
    const keep = new Set(origins);
    for (const i of ranked) {
      if (keep.size >= MAX_GRAPH_NODES) break;
      keep.add(i.key);
    }
    for (const k of [...nodeSet]) {
      if (!keep.has(k)) {
        nodeSet.delete(k);
        nodes.delete(k);
      }
    }
    for (let i = edges.length - 1; i >= 0; i--) {
      const e = edges[i] as GraphEdge;
      if (!nodeSet.has(e.src) || !nodeSet.has(e.dst)) edges.splice(i, 1);
    }
  }

  return { nodes: [...nodes.values()], edges, changed: [...origins], truncated };
}

interface GraphNode {
  key: string;
  kind: string;
  name: string;
  depth: number;
  origin: boolean;
  /** severity for UI coloring; null for origin (changed) nodes */
  severity: "high" | "medium" | "low" | null;
}

interface GraphEdge {
  src: string;
  dst: string;
  type: "CONTAINS" | "DEPENDS_ON" | "CALLS" | "HANDLED_BY";
}
