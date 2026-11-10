import { AgyError, retryAfterSeconds } from "./errors.js";
import type { AcpEvent } from "./protocol.js";
import { parseMessage } from "./service-messages.js";
import { collectTurn, type AnthropicFinishReason, type AnthropicUsage } from "./translate.js";

const REQUEST_FIELDS = new Set(["contents", "systemInstruction", "generationConfig"]);
const GENERATION_FIELDS = new Set(["maxOutputTokens", "candidateCount", "responseMimeType"]);
const FINISH_REASONS = {
  end_turn: "STOP",
  stop_sequence: "STOP",
  max_tokens: "MAX_TOKENS",
  refusal: "OTHER",
} as const satisfies Record<AnthropicFinishReason, string>;

function invalid(message: string): never {
  throw new AgyError("invalid_request", message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseContent(content: unknown) {
  if (!isObject(content) || Object.keys(content).some(key => key !== "role" && key !== "parts")) {
    invalid("Content must contain only role and parts");
  }
  const { role, parts } = content;
  if (role !== undefined && role !== "user" && role !== "model") invalid("Only user and model roles are supported");
  if (!Array.isArray(parts) || parts.length === 0) invalid("Content must contain at least one text part");
  const text = Array.from(parts, (part: unknown) => {
    if (!isObject(part) || typeof part.text !== "string" || Object.keys(part).some(key => key !== "text")) {
      invalid("Only text parts are supported");
    }
    return part.text;
  }).join("\n");
  return { role: role === "model" ? "assistant" : "user", content: text };
}

export function parseGeminiContent(body: Record<string, unknown>, model: string, stream: boolean): ReturnType<typeof parseMessage> {
  if (Object.keys(body).some(key => !REQUEST_FIELDS.has(key))) invalid("Unsupported GenerateContent request field");
  const { contents, systemInstruction, generationConfig = {} } = body;
  if (!isObject(generationConfig) || Object.keys(generationConfig).some(key => !GENERATION_FIELDS.has(key))) {
    invalid("generationConfig supports only maxOutputTokens, candidateCount and responseMimeType");
  }
  const { maxOutputTokens = 4096, candidateCount, responseMimeType } = generationConfig;
  if (candidateCount !== undefined && candidateCount !== 1) invalid("candidateCount must be 1");
  if (responseMimeType !== undefined && responseMimeType !== "text/plain") invalid("responseMimeType must be text/plain");
  if (typeof maxOutputTokens !== "number" || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    invalid("maxOutputTokens must be a positive integer");
  }
  if (!Array.isArray(contents) || contents.length === 0 || contents.length > 256) invalid("contents must contain 1 to 256 entries");
  return parseMessage({
    model, stream, max_tokens: maxOutputTokens,
    messages: Array.from(contents, parseContent),
    system: systemInstruction === undefined ? undefined : parseContent(systemInstruction).content,
  });
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function usageMetadata(raw: unknown) {
  if (isObject(raw)) {
    // ACP's input total includes cache reads and writes. The translated totals use zero placeholders for missing values.
    const promptTokenCount = tokenCount(raw.inputTokens ?? raw.input_tokens);
    const candidatesTokenCount = tokenCount(raw.outputTokens ?? raw.output_tokens);
    const cachedContentTokenCount = tokenCount(raw.cachedReadTokens ?? raw.cacheReadTokens ?? raw.cache_read_tokens ?? raw.cachedInputTokens);
    const thoughtsTokenCount = tokenCount(raw.thoughtTokens ?? raw.thinking_tokens ?? raw.reasoning_tokens);
    const totalTokenCount = tokenCount(raw.totalTokens ?? raw.total_tokens);
    if ([promptTokenCount, candidatesTokenCount, cachedContentTokenCount, thoughtsTokenCount, totalTokenCount].some(count => count !== undefined)) {
      return { promptTokenCount, candidatesTokenCount, cachedContentTokenCount, thoughtsTokenCount, totalTokenCount };
    }
  }
}

function response(modelVersion: string, text?: string, reason?: AnthropicFinishReason, usage?: ReturnType<typeof usageMetadata>) {
  return {
    candidates: [{
      index: 0,
      content: text === undefined ? undefined : { role: "model", parts: [{ text }] },
      finishReason: reason === undefined ? undefined : FINISH_REASONS[reason],
    }],
    modelVersion,
    usageMetadata: usage,
  };
}

export async function geminiJson(events: AsyncIterable<AcpEvent>, model: string): Promise<Response> {
  const { content, finishReason, result } = await collectTurn(events);
  return Response.json(response(model, content, finishReason, usageMetadata(result.usage)));
}

function data(payload: object): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const ERROR_STATUS: Record<number, string> = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  408: "DEADLINE_EXCEEDED",
  409: "ABORTED",
  413: "RESOURCE_EXHAUSTED",
  429: "RESOURCE_EXHAUSTED",
  499: "CANCELLED",
  500: "INTERNAL",
  502: "UNAVAILABLE",
  503: "UNAVAILABLE",
  504: "DEADLINE_EXCEEDED",
};

function errorPayload(error: AgyError, retryAfter = retryAfterSeconds(error)) {
  const code = error.kind === "unknown_model" ? 404 : error.status;
  return { error: {
    code,
    message: error.message,
    status: ERROR_STATUS[code] ?? "UNKNOWN",
    ...(retryAfter === undefined ? {} : {
      details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: `${retryAfter}s` }],
    }),
  } };
}

export function geminiStream(model: string) {
  return {
    start: () => [],
    text: (delta: string) => [data(response(model, delta))],
    finish: (reason: AnthropicFinishReason, _usage?: AnthropicUsage, rawUsage?: unknown) =>
      [data(response(model, undefined, reason, usageMetadata(rawUsage)))],
    error: (error: AgyError) => data(errorPayload(error)),
    // The Python SDK parses SSE comment lines as JSON.
    ping: null,
  };
}

export function geminiErrorResponse(error: AgyError): Response {
  const retryAfter = retryAfterSeconds(error);
  const payload = errorPayload(error, retryAfter);
  return Response.json(payload, { status: payload.error.code,
    headers: retryAfter === undefined ? undefined : { "Retry-After": String(retryAfter) } });
}
