/**
 * Ollama adapter — local/offline fallback provider speaking the same
 * OpenAI-compatible dialect (`OLLAMA_BASE_URL` defaults to :11434).
 */
import type { LlmProvider, ProviderName } from "./provider.js";
import { OpenAiCompatibleProvider } from "./openai-compatible.js";

export function createOllamaProvider(model: string): LlmProvider {
  const base = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  return new OpenAiCompatibleProvider(
    "ollama" satisfies ProviderName,
    model,
    `${base.replace(/\/$/, "")}/v1`,
    {}, // Ollama needs no auth by default
    "ollama",
  );
}
