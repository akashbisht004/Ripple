/**
 * Cypher-backed agent tools (Phase 3).
 *
 * Each tool the LLM can call is a thin shell over a FalkorDB query — the agent
 * reasons about *returned rows* and cites paths; it may never invent
 * relationships. `search_code_semantic` serves the semantic lookup without
 * embeddings by leveraging FalkorDB's per-label fulltext indexes
 * (`db.idx.fulltext.queryNodes('Function'|'File'…)`, registered by core's
 * GraphWriter); identifier terms are prefix-wildcarded, with a fuzzy
 * CONTAINS fallback.
 */
import type { GraphOps } from "./impact-engine.js";
import type { ToolSpec } from "../llm/provider.js";

export interface ToolContext {
  ops: GraphOps;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export const AGENT_TOOLS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "bug_history",
      description:
        "Was this symbol or file previously involved in a bug? Returns bug-fix commits, titles, state and URLs from the evidence graph.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "Node key: `file::symbol` for symbols or a repo file path" },
        },
        required: ["target"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_tests",
      description:
        "Which tests (TESTED_BY edges) cover the given changed file or symbol in the graph?",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "Node key: file path or `file::symbol`" },
        },
        required: ["target"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "coverage_gaps",
      description:
        "List impacted-looking functions in the given file that have NO test coverage in the graph.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Repo-relative file path" },
        },
        required: ["filePath"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_code_semantic",
      description:
        "Find code entities (functions/classes/files) by name or topic via FalkorDB fulltext index.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text query, e.g. 'token validation' or 'discount'" },
        },
        required: ["query"],
      },
    },
  },
];

export async function executeTool(ctx: ToolContext, name: string, argsRaw: string): Promise<ToolResult> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsRaw || "{}") as Record<string, unknown>;
  } catch {
    return { ok: false, error: "arguments are not valid JSON" };
  }
  switch (name) {
    case "bug_history": {
      const target = typeof args.target === "string" ? args.target : "";
      if (!target) return { ok: false, error: "`target` is required" };
      const rows = await ctx.ops.query(
        `MATCH (n { key: $target })<-[:REFERS_TO]-(b:Bug)<-[:FIXED]-(c:Commit)
         RETURN b.title AS title, b.state AS state, b.url AS url,
                left(c.sha, 10) AS sha, c.date AS date
         ORDER BY c.date DESC LIMIT 10`,
        { target },
      );
      return { ok: true, data: rows };
    }
    case "find_tests": {
      const target = typeof args.target === "string" ? args.target : "";
      if (!target) return { ok: false, error: "`target` is required" };
      const rows = await ctx.ops.query(
        `MATCH (t:Test)<-[:TESTED_BY]-(n { key: $target })
         RETURN DISTINCT t.name AS test, t.fileKey AS testFile`,
        { target },
      );
      const fileKey = target.includes("::") ? (target.split("::")[0] ?? target) : target;
      const fileRows =
        fileKey === target
          ? rows
          : await ctx.ops.query(
              `MATCH (t:Test)<-[:TESTED_BY]-(n:File { key: $fileKey })
               RETURN DISTINCT t.name AS test, t.fileKey AS testFile`,
              { fileKey },
            );
      return { ok: true, data: [...rows, ...fileRows] };
    }
    case "coverage_gaps": {
      const filePath = typeof args.filePath === "string" ? args.filePath : "";
      if (!filePath) return { ok: false, error: "`filePath` is required" };
      const uncovered = await ctx.ops.query(
        `MATCH (f:File { key: $filePath })-[:CONTAINS]->(s)
         OPTIONAL MATCH (t:Test)<-[:TESTED_BY]-(f)
         WITH s, collect(t) AS tests
         WHERE size(tests) = 0
         RETURN s.name AS symbol, s.key AS key`,
        { filePath },
      );
      return { ok: true, data: uncovered };
    }
    case "search_code_semantic": {
      const q = typeof args.query === "string" ? args.query : "";
      if (!q) return { ok: false, error: "`query` is required" };
      // FalkorDB fulltext is addressed by LABEL and tokenizes camelCase as a
      // single token — prefix-wildcard each term for identifier lookup.
      const terms = q.split(/\s+/).filter(Boolean);
      const wildcard = terms.map((t) => (t.endsWith("*") ? t : `${t}*`)).join(" ");
      const idxLabels = ["Function", "File", "Class", "ApiRoute", "Test"];
      const rows: Array<{ key: string; name: string; label: string; score: number }> = [];
      try {
        for (const label of idxLabels) {
          const got = await ctx.ops.query<{ key: string; name: string; label: string; score: number }>(
            `CALL db.idx.fulltext.queryNodes($label, $q) YIELD node, score
             RETURN coalesce(node.qualifiedName, node.key) AS key,
                    coalesce(node.name, node.path) AS name,
                    labels(node)[0] AS label,
                    score
             ORDER BY score DESC LIMIT 8`,
            { label, q: `${q} ${wildcard}` },
          );
          rows.push(...got);
        }
        if (rows.length > 0) return { ok: true, data: rows.sort((a, b) => b.score - a.score).slice(0, 10) };
      } catch {
        // no index yet → fall through to CONTAINS
      }
      const fallback = await ctx.ops.query(
        `MATCH (n) WHERE toLower(coalesce(n.name, n.path, '')) CONTAINS toLower($q)
         RETURN coalesce(n.qualifiedName, n.key) AS key,
                coalesce(n.name, n.path) AS name,
                labels(n)[0] AS label
         LIMIT 10`,
        { q },
      );
      return { ok: true, data: fallback };
    }
    default:
      return { ok: false, error: `unknown tool '${name}'` };
  }
}
