/**
 * Shared transport for OpenAI-compatible /chat/completions endpoints
 * (OpenRouter and Ollama both speak this dialect).
 */
import type { ChatRequest, ChatMessage, ChatResponse, LlmProvider, ToolCall, ProviderName } from "./provider.js";

type WireMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: unknown[] }
  | { role: "tool"; content: string; tool_call_id: string; name?: string };

function toWire(messages: ChatMessage[]): WireMessage[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "tool",
        content: m.content ?? "",
        tool_call_id: m.toolCallId ?? m.name ?? "",
        name: m.name,
      };
    }
    if (m.role === "assistant") {
      return {
        role: "assistant",
        content: m.content ?? null,
        ...(m.toolCalls?.length ? { tool_calls: m.toolCalls } : {}),
      };
    }
    return { role: m.role, content: m.content ?? "" };
  });
}

export class OpenAiCompatibleProvider implements LlmProvider {
  constructor(
    readonly name: ProviderName,
    readonly model: string,
    private readonly baseUrl: string,
    private readonly headers: Record<string, string>,
    private readonly label: string, // for error messages
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body = {
      model: req.model ?? this.model,
      messages: toWire(req.messages),
      ...(req.tools?.length ? { tools: req.tools } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
    };

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${this.label} ${res.status}: ${text.slice(0, 400)}`);
    }

    const json = (await res.json()) as {
      model?: string;
      choices?: Array<{
        message?: { content?: string | null; tool_calls?: ToolCall[] };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const choice = json.choices?.[0];
    const finishRaw = choice?.finish_reason ?? "unknown";
    const finish = (["stop", "tool_calls", "length"].includes(finishRaw)
      ? finishRaw
      : "unknown") as ChatResponse["finishReason"];

    return {
      content: choice?.message?.content ?? null,
      toolCalls: choice?.message?.tool_calls ?? [],
      model: json.model ?? this.model,
      finishReason: finish,
      usage: json.usage
        ? {
            inputTokens: json.usage.prompt_tokens ?? 0,
            outputTokens: json.usage.completion_tokens ?? 0,
          }
        : undefined,
    };
  }
}
