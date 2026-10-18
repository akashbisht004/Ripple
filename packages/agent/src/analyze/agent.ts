/**
 * Analysis runner — the Phase 3 "brain".
 *
 * 1. the impact engine computes the deterministic, evidence-backed result
 * 2. an LLM (if configured) runs a bounded tool loop over the Cypher tools to
 *    gather top-impact context, then writes the narrative summary
 * 3. without an LLM key the runner still produces the full report — the
 *    narrative falls back to mechanically generated text (demo-safe)
 */
import type { Graph } from "falkordb";
import { createLlmProvider, type ChatMessage, type LlmProvider } from "../llm/index.js";
import { computeImpact, graphOpsOf, type ImpactResult } from "./impact-engine.js";
import { AGENT_TOOLS, executeTool } from "./tools.js";

const SYSTEM_PROMPT = [
  "You are RIPPLE, a code-review impact-analysis agent.",
  "A deterministic impact engine already traversed the FalkorDB graph and computed:",
  "direct impacts, the reverse ripple (who depends on the changed code), bug evidence",
  "from git history, and coverage gaps. You must NEVER invent relationships — you",
  "may only report what the engine output shows or what the provided tools return.",
  "Use `bug_history`/`find_tests`/`search_code_semantic` to probe anything you want to explain.",
  "Then answer with a short, factual narrative (max 8 bullet-ish lines) explaining:",
  "1) the riskiest part of the change and why (bug history / route exposure / depth),",
  "2) which tests should run first, 3) what is not tested at all.",
].join(" ");

const MAX_TOOL_ROUNDS = 5;

export interface AnalysisOutput {
  result: ImpactResult;
  narrative: string;
  llmUsed: boolean;
  toolCalls: Array<{ name: string; args: string }>;
}

export async function analyze(
  graph: Graph,
  input: { label: string; files: string[]; prTitle?: string },
): Promise<AnalysisOutput> {
  const ops = graphOpsOf(graph);
  const result = await computeImpact(ops, { label: input.label, files: input.files });

  let llm: LlmProvider;
  try {
    llm = createLlmProvider();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[agent] no LLM configured (${msg.slice(0, 60)}…) — deterministic report only`);
    return { result, narrative: fallbackNarrative(result), llmUsed: false, toolCalls: [] };
  }

  const toolCalls: Array<{ name: string; args: string }> = [];
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: buildEngineContext(input, result),
    },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const resp = await llm.chat({
      messages,
      tools: AGENT_TOOLS,
      temperature: 0.2,
      maxTokens: 600,
    });

    if (resp.toolCalls.length > 0) {
      messages.push({ role: "assistant", content: resp.content, toolCalls: resp.toolCalls });
      for (const tc of resp.toolCalls) {
        const outcome = await executeTool({ ops }, tc.function.name, tc.function.arguments);
        toolCalls.push({ name: tc.function.name, args: tc.function.arguments });
        messages.push({
          role: "tool",
          content: JSON.stringify(outcome).slice(0, 4000),
          toolCallId: tc.id,
          name: tc.function.name,
        });
      }
      continue;
    }

    const narrative = (resp.content ?? "").trim();
    if (narrative) {
      return { result, narrative, llmUsed: true, toolCalls };
    }
  }
  // model kept calling tools / returned nothing usable
  return { result, narrative: fallbackNarrative(result), llmUsed: true, toolCalls };
}

function buildEngineContext(input: { label: string; files: string[]; prTitle?: string }, result: ImpactResult): string {
  const impactRows = [...result.direct, ...result.ripple]
    .map(
      (i) =>
        `${i.severity.toUpperCase()} d${i.depth} ${i.kind} ${i.key} via [${i.via.join(",") || "changed"}] score=${i.score}${i.feedback ? ` ci=${i.feedback.confirms > i.feedback.disproves ? `confirmed x${i.feedback.confirms}` : `decayed x${i.feedback.disproves}`}@${i.feedback.confidence}` : ""}${i.bugEvidence.length ? ` bugs=${i.bugEvidence.map((b) => b.bugKey).join(",")}` : ""}${i.tests.length ? ` tests=${i.tests.length}` : " NO_TESTS"}`,
    )
    .join("\n");
  const gaps = result.coverageGaps.map((g) => `${g.kind} ${g.key}`).join(", ") || "none";
  const plan = result.testPlan.map((t) => t.test).slice(0, 10).join(", ") || "none in graph";
  return [
    `PR: ${input.label}${input.prTitle ? ` — “${input.prTitle}”` : ""}`,
    `Changed files: ${input.files.join(", ")}`,
    result.outsideGraph.length ? `Paths not in graph (informational): ${result.outsideGraph.join(", ")}` : "",
    "\nEngine impact table (deterministic, from FalkorDB):\n" + (impactRows || "(no graph matches)"),
    `\nBug evidence: ${result.bugEvidence.map((b) => `${b.bugKey} "${b.title}" ${b.state ?? ""} ${b.url ?? ""}`).join("; ") || "none"}`,
    `\nCoverage gaps: ${gaps}\nTest plan: ${plan}`,
    "\nWrite the narrative now.",
  ]
    .filter(Boolean)
    .join("\n");
}

function fallbackNarrative(result: ImpactResult): string {
  const high = [...result.direct, ...result.ripple].filter((i) => i.severity === "high");
  const lines: string[] = [];
  if (high.length > 0) {
    lines.push(
      `Riskiest: ${high.slice(0, 3).map((i) => `${i.kind} ${i.name}`).join(", ")} (${high.length} high-severity impact${high.length > 1 ? "s" : ""}).`,
    );
  } else {
    lines.push(`No high-severity impacts found at up to 4 hops (${result.ripple.length} indirect impacts tracked).`);
  }
  if (result.bugEvidence.length > 0) {
    lines.push(
      `Bug history: ${result.bugEvidence.slice(0, 3).map((b) => `"${b.title}" (${b.sha.slice(0, 8)})`).join("; ")}.`,
    );
  }
  lines.push(
    result.testPlan.length > 0
      ? `Run first: ${result.testPlan.slice(0, 4).map((t) => t.test).join(", ")}${result.testPlan.length > 4 ? " …" : ""}.`
      : "No tests linked to the changed code in the graph.",
  );
  lines.push(
    result.coverageGaps.length > 0
      ? `Coverage gaps: ${result.coverageGaps.slice(0, 4).map((g) => g.key).join(", ")}${result.coverageGaps.length > 4 ? " …" : ""}.`
      : "All impacted code has test coverage.",
  );
  return lines.join(" ");
}
