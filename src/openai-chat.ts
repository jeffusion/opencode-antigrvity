import { randomUUID } from "node:crypto";
import { errorPayload } from "./anthropic-http.js";
import { AgyError } from "./errors.js";
import type { AcpEvent } from "./protocol.js";
import { parseMessage } from "./service-messages.js";
import { collectTurn, type AnthropicFinishReason, type AnthropicUsage } from "./translate.js";

const CHAT_FIELDS = new Set(["model", "messages", "max_completion_tokens", "max_tokens", "stream", "stream_options", "n", "store"]);
const FINISH_REASONS = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  refusal: "content_filter",
} as const satisfies Record<AnthropicFinishReason, string>;

function invalid(message: string): never {
  throw new AgyError("invalid_request", message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) invalid("Message content must be a string or an array of text parts");
  return Array.from(content, (part: unknown) => {
    if (!isObject(part) || part.type !== "text" || typeof part.text !== "string" ||
        Object.keys(part).some(key => key !== "type" && key !== "text")) invalid("Only text content parts are supported");
    return part.text;
  }).join("\n");
}

export function parseChatCompletion(body: Record<string, unknown>) {
  for (const key of Object.keys(body)) {
    if (!CHAT_FIELDS.has(key)) invalid("Unsupported Chat Completions request field");
  }
  const { model, messages, stream, stream_options, max_completion_tokens, max_tokens, n, store } = body;
  if (n !== undefined && n !== 1) invalid("n must be 1");
  if (store !== undefined && store !== false) invalid("store must be false");
  if (max_completion_tokens !== undefined && max_tokens !== undefined) invalid("Specify only one of max_completion_tokens and max_tokens");
  const maxTokens = max_completion_tokens === undefined ? max_tokens : max_completion_tokens;
  let includeUsage = false;
  if (stream_options !== undefined) {
    if (stream !== true || !isObject(stream_options) || Object.keys(stream_options).some(key => key !== "include_usage") ||
        (stream_options.include_usage !== undefined && typeof stream_options.include_usage !== "boolean")) {
      invalid("stream_options supports only boolean include_usage and requires stream: true");
    }
    includeUsage = stream_options.include_usage === true;
  }
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 256) invalid("messages must contain 1 to 256 entries");
  const system: string[] = [];
  const history: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const message of messages as unknown[]) {
    if (!isObject(message) || Object.keys(message).some(key => key !== "role" && key !== "content")) invalid("Messages must contain only role and content");
    const { role, content } = message;
    if (role === "system" || role === "developer") {
      if (history.length) invalid("System and developer messages must precede user and assistant messages");
      system.push(textContent(content));
    } else if (role === "user" || role === "assistant") {
      history.push({ role, content: textContent(content) });
    } else {
      invalid("Only system, developer, user and assistant roles are supported");
    }
  }
  const request = parseMessage({ model, messages: history, system: system.join("\n"), stream,
    max_tokens: maxTokens === undefined ? 4096 : maxTokens });
  return { request, includeUsage };
}

function completionMeta(model: string) {
  return { id: `chatcmpl-${randomUUID().replace(/-/g, "")}`, created: Math.floor(Date.now() / 1000), model };
}

function openAIUsage(usage?: AnthropicUsage) {
  // ACP prompt totals include both cache reads and writes.
  const prompt_tokens = (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0);
  const completion_tokens = usage?.output_tokens ?? 0;
  return { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
}

export async function openAIJson(events: AsyncIterable<AcpEvent>, model: string): Promise<Response> {
  const result = await collectTurn(events);
  return Response.json({ ...completionMeta(model), object: "chat.completion", choices: [{ index: 0,
    message: { role: "assistant", content: result.content }, finish_reason: FINISH_REASONS[result.finishReason] }],
    usage: openAIUsage(result.usage) });
}

function data(payload: object): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function openAIError(error: AgyError) {
  const payload = errorPayload(error).error;
  return { error: { ...payload, code: error.kind === "unknown_model" ? "model_not_found" : payload.code, param: null } };
}

export function openAIStream(model: string, includeUsage: boolean) {
  const meta = { ...completionMeta(model), object: "chat.completion.chunk" };
  const chunk = (delta: { role?: "assistant"; content?: string }, reason: AnthropicFinishReason | null = null) =>
    data({ ...meta, choices: [{ index: 0, delta, finish_reason: reason === null ? null : FINISH_REASONS[reason] }],
      ...(includeUsage ? { usage: null } : {}) });
  return {
    start: () => [chunk({ role: "assistant", content: "" })],
    text: (delta: string) => [chunk({ content: delta })],
    finish(reason: AnthropicFinishReason, usage?: AnthropicUsage) {
      const frames = [chunk({}, reason)];
      if (includeUsage) frames.push(data({ ...meta, choices: [], usage: openAIUsage(usage) }));
      frames.push("data: [DONE]\n\n");
      return frames;
    },
    error: (error: AgyError) => data(openAIError(error)),
  };
}

export function openAIErrorResponse(error: AgyError): Response {
  const body = openAIError(error);
  const retryAfter = body.error.retry_after;
  return Response.json(body, { status: error.kind === "unknown_model" ? 404 : error.status,
    headers: retryAfter === undefined ? undefined : { "Retry-After": String(retryAfter) } });
}
