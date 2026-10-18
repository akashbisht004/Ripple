/**
 * LLM provider interface — the seam the rest of RIPPLE codes against.
 *
 * Phase 3's tool-calling agent consumes this; Phase 1 ships OpenRouter
 * (default) and Ollama adapters sharing one OpenAI-compatible wire format.
 *
 * Per docs/implementation.md §3.4: every provider speaks "chat with optional
 * tools" — callers never import a specific vendor SDK.
 */

/** Chat roles we support; `tool` results are matched by `tool_call_id`. */
export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ProviderName = "openrouter" | "ollama";

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  /** Present on assistant messages that emitted tool calls. */
  toolCalls?: ToolCall[];
  /** Present on role=tool messages. */
  toolCallId?: string;
  /** Present on role=tool messages: which tool answered. */
  name?: string;
}

/** A callable tool the agent exposes to the model. */
export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    /** JSON Schema for the arguments object. */
    parameters: Record<string, unknown>;
  };
}

/** A provider's answer. */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** String-encoded JSON arguments. */
    arguments: string;
  };
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatResponse {
  content: string | null;
  toolCalls: ToolCall[];
  model: string;
  finishReason: "stop" | "tool_calls" | "length" | "error" | "unknown";
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LlmProvider {
  readonly name: ProviderName;
  readonly model: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}
