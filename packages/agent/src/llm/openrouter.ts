/**
 * OpenRouter adapter — default RIPPLE provider.
 *
 * Any OpenRouter model id works (e.g. `openai/gpt-4o-mini`,
 * `anthropic/claude-sonnet-4.5`, `meta-llama/llama-3.3-70b-instruct`).
 */
import type { LlmProvider, ProviderName } from "./provider.js";
import { OpenAiCompatibleProvider } from "./openai-compatible.js";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export function createOpenRouterProvider(model: string): LlmProvider {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is not set. Get a key at https://openrouter.ai/settings/keys, then add it to .env",
    );
  }
  return new OpenAiCompatibleProvider(
    "openrouter" satisfies ProviderName,
    model,
    OPENROUTER_BASE,
    {
      Authorization: `Bearer ${apiKey}`,
      ...(process.env.OPENROUTER_APP_URL ? { "HTTP-Referer": process.env.OPENROUTER_APP_URL } : {}),
      ...(process.env.OPENROUTER_APP_TITLE ? { "X-Title": process.env.OPENROUTER_APP_TITLE } : {}),
    },
    "openrouter",
  );
}
