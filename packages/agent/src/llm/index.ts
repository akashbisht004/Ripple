/**
 * LLM factory — env-driven provider selection.
 *
 *   LLM_PROVIDER=openrouter (default) | ollama
 *   LLM_MODEL=<provider model id>
 *
 * Fallthrough defaults keep `npm run agent:smoke` one command on a fresh clone.
 */
import type { LlmProvider, ProviderName } from "./provider.js";
import { createOpenRouterProvider } from "./openrouter.js";
import { createOllamaProvider } from "./ollama.js";

const DEFAULT_OPENROUTER_MODEL = "openai/gpt-4o-mini";
const DEFAULT_OLLAMA_MODEL = "llama3.1";

export function getProviderConfig(): { provider: ProviderName; model: string } {
  const provider = (process.env.LLM_PROVIDER ?? "openrouter").toLowerCase() as ProviderName;
  if (provider !== "openrouter" && provider !== "ollama") {
    throw new Error(
      `Unknown LLM_PROVIDER '${provider}'. Supported: openrouter, ollama (LLM_PROVIDER=openrouter is the default).`,
    );
  }
  const model = process.env.LLM_MODEL?.trim() || (provider === "openrouter" ? DEFAULT_OPENROUTER_MODEL : DEFAULT_OLLAMA_MODEL);
  return { provider, model };
}

export function createLlmProvider(): LlmProvider {
  const { provider, model } = getProviderConfig();
  console.log(`[llm] provider=${provider} model=${model}`);
  return provider === "openrouter" ? createOpenRouterProvider(model) : createOllamaProvider(model);
}

export * from "./provider.js";
