/**
 * Shared shape of POST /api/analyze's response — mirroring the Phase 3
 * engine/agent output so the client and graph views can type against it.
 */
import type { ImpactResult } from "@ripple/agent/analyze/impact-engine";
import type { FeedbackStats } from "@ripple/ci-feedback/feedback";

export interface GraphNode {
  key: string;
  kind: string;
  name: string;
  depth: number;
  origin: boolean;
  /** severity for UI coloring; null for origin (changed) nodes */
  severity: "high" | "medium" | "low" | null;
}

export interface GraphEdge {
  src: string;
  dst: string;
  type: "CONTAINS" | "DEPENDS_ON" | "CALLS" | "HANDLED_BY";
}

export interface GraphView {
  nodes: GraphNode[];
  edges: GraphEdge[];
  changed: string[];
  truncated: boolean;
}

export interface AnalyzeResponse {
  ok: true;
  label: string;
  prTitle?: string;
  source: "github" | "files" | "diff";
  narrative: string;
  llmUsed: boolean;
  toolCalls: Array<{ name: string; args: string }>;
  analysisKey: string;
  result: ImpactResult;
  graph: GraphView;
  feedback: FeedbackStats;
}

export interface AnalyzeError {
  ok: false;
  error: string;
}
