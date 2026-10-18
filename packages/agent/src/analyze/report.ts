/**
 * Markdown report renderer — demo milestone output for Phase 3.
 * Keeps every claim traceable: severity groups, ripple paths, bug evidence
 * with live links, plus the Cypher used by agent tools.
 */
import type { AnalysisOutput } from "./agent.js";
import type { Impacted } from "./impact-engine.js";

const SEVERITY_ICONS: Record<string, string> = { high: "🟥", medium: "🟧", low: "🟩" };

export function renderMarkdown(out: AnalysisOutput): string {
  const { result, narrative, llmUsed, toolCalls } = out;
  const lines: string[] = [];

  lines.push(`## RIPPLE impact report — ${result.label}`);
  lines.push("");

  lines.push(
    `Changed: ${result.changedFiles.length} file(s)` +
      (result.outsideGraph.length ? ` (${result.outsideGraph.length} not in graph: ${result.outsideGraph.slice(0, 3).join(", ")}${result.outsideGraph.length > 3 ? "…" : ""})` : ""),
  );
  lines.push(
    `Impacts: ${result.direct.length} direct · ${result.ripple.length} indirect (≤${result.flaggedCount} flagged)`,
  );
  lines.push("");

  // agent narrative first (the "why")
  lines.push(`### Summary${llmUsed ? " (LLM, tool-verified)" : " (deterministic — no LLM configured)"}`);
  lines.push("");
  lines.push(narrative);
  if (toolCalls.length > 0) {
    lines.push("");
    lines.push(`_Tools consulted: ${toolCalls.map((t) => t.name).join(", ")}_`);
  }
  lines.push("");

  const section = (title: string, list: Impacted[]): void => {
    if (list.length === 0) return;
    lines.push(`### ${title}`);
    lines.push("");
    for (const i of list.slice(0, 12)) {
      const bugs = i.bugEvidence
        .map((b) => `${b.url ? `[bug](${b.url})` : "**bug**"} “${b.title}” (${b.sha.slice(0, 8)})`)
        .join(" · ");
      const tests = i.tests.length > 0 ? `tests: ${i.tests.slice(0, 3).join(", ")}${i.tests.length > 3 ? "…" : ""}` : null;
      const fbLine =
        i.feedback && (i.feedback.confirms > 0 || i.feedback.disproves > 0)
          ? `  - CI feedback: ${i.feedback.confirms > i.feedback.disproves ? `🔁 confirmed ×${i.feedback.confirms}` : `🥀 decayed ×${i.feedback.disproves}`} (confidence ${i.feedback.confidence})`
          : null;
      lines.push(
        `- ${SEVERITY_ICONS[i.severity] ?? "⚪"} \`${i.key}\` — ${i.kind}, depth ${i.depth}, score ${i.score}${i.via.length ? `, via ${i.via.join("→") || "-"}` : ""}`,
      );
      if (fbLine) lines.push(fbLine);
      if (bugs) lines.push(`  - bug history: ${bugs}`);
      if (tests) lines.push(`  - ${tests}`);
    }
    if (list.length > 12) lines.push(`- …and ${list.length - 12} more`);
    lines.push("");
  };

  section("Direct impacts", result.direct);
  section("The ripple (indirect)", result.ripple);

  // coverage gaps + test plan
  if (result.coverageGaps.length > 0) {
    lines.push("### Coverage gaps 🕳️");
    lines.push("");
    for (const g of result.coverageGaps.slice(0, 10)) {
      lines.push(`- \`${g.key}\` (${g.kind}) — ${g.reason}`);
    }
    lines.push("");
  }

  if (result.testPlan.length > 0) {
    lines.push("### Recommended test plan");
    lines.push("");
    for (const t of result.testPlan.slice(0, 10)) {
      lines.push(`- [ ] \`${t.test}\` (covers \`${t.file}\`)`);
    }
    if (result.testPlan.length > 10) {
      lines.push(`- …and ${result.testPlan.length - 10} more`);
    }
    lines.push("");
  }

  // bug evidence with live GitHub links
  if (result.bugEvidence.length > 0) {
    lines.push("### Historical evidence");
    lines.push("");
    for (const b of result.bugEvidence.slice(0, 8)) {
      const url = b.url ? ` — ${b.url}` : "";
      const state = b.state ? ` [${b.state}]` : "";
      lines.push(`- ${b.bugKey}: “${b.title}”${state}${url} (fix commit ${b.sha.slice(0, 8)})`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
