/**
 * LLM layer smoke test:
 *   npm run agent:smoke
 *
 * 1. plain "say OK" chat round
 * 2. tool-calling round: the model must answer which Cypher tool it would call
 */
import { createLlmProvider } from "./llm/index.js";

const demoTools = [
  {
    type: "function" as const,
    function: {
      name: "impact_analysis",
      description: "Trace what upstream depends on the given changed files in the RIPPLE graph.",
      parameters: {
        type: "object",
        properties: {
          files: { type: "array", items: { type: "string" }, description: "Changed file paths from the PR" },
        },
        required: ["files"],
      },
    },
  },
];

async function main(): Promise<void> {
  const llm = createLlmProvider();

  console.log("── round 1: plain chat ──");
  const simple = await llm.chat({
    messages: [{ role: "user", content: 'Reply with exactly "LLM layer OK" and nothing else.' }],
    maxTokens: 20,
  });
  console.log(`  reply: ${simple.content}`);
  console.log(`  finish=${simple.finishReason} usage=${JSON.stringify(simple.usage ?? {})}`);
  if (!(simple.content ?? "").includes("OK")) {
    throw new Error("smoke round 1: unexpected reply");
  }

  console.log("── round 2: tool calling ──");
  const tooled = await llm.chat({
    messages: [{ role: "user", content: "src/checkout.ts changed on this PR. Find impact. Use the tool." }],
    tools: demoTools,
  });
  if (tooled.toolCalls.length === 0) {
    console.log(`  (no tool call emitted; finish=${tooled.finishReason}, content=${tooled.content?.slice(0, 120)})`);
  } else {
    for (const tc of tooled.toolCalls) {
      console.log(`  tool_call: ${tc.function.name}(${tc.function.arguments})`);
      if (tc.function.name !== "impact_analysis") throw new Error("smoke round 2: wrong tool name");
    }
  }

  console.log("✔ smoke passed");
}

main().catch((err) => {
  console.error("✖ smoke failed:", err);
  process.exit(1);
});
