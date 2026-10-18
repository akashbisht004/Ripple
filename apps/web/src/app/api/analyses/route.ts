/**
 * GET /api/analyses — recent persisted analysis runs (Phase 6 history panel).
 * Reads the `:Analysis` nodes written by Phase 3's persistence step.
 */
import { NextResponse } from "next/server";
import { disconnectGraph, graphSelector } from "@ripple/core";
import { opsOf } from "@ripple/ci-feedback/feedback";

export const runtime = "nodejs";

export interface AnalysisSummary {
  key: string;
  label: string;
  createdAt: number;
  narrative: string;
  llmUsed: boolean;
  changedFiles: string[];
  directCount: number;
  rippleCount: number;
}

export async function GET(): Promise<NextResponse> {
  const { graph } = await graphSelector();
  try {
    const rows = (await (await opsOf(graph)).query<Record<string, unknown>>(
      `MATCH (a:Analysis)
       RETURN a.key AS key,
              a.label AS label,
              a.createdAt AS createdAt,
              left(a.narrative, 160) AS narrative,
              coalesce(a.llmUsed, false) AS llmUsed,
              coalesce(a.changedFiles, []) AS changedFiles,
              coalesce(a.directCount, 0) AS directCount,
              coalesce(a.rippleCount, 0) AS rippleCount
       ORDER BY a.createdAt DESC LIMIT 8`,
    )) as unknown as Array<Record<string, string | number | boolean | string[]>>;

    const analyses: AnalysisSummary[] = rows.map((r) => ({
      key: String(r.key ?? ""),
      label: String(r.label ?? ""),
      createdAt: Number(r.createdAt ?? 0),
      narrative: String(r.narrative ?? ""),
      llmUsed: r.llmUsed === true,
      changedFiles: Array.isArray(r.changedFiles) ? (r.changedFiles as string[]) : [],
      directCount: Number(r.directCount ?? 0),
      rippleCount: Number(r.rippleCount ?? 0),
    }));

    return NextResponse.json({ ok: true, analyses });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  } finally {
    await disconnectGraph();
  }
}
