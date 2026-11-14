import { randomUUID } from "node:crypto";
import { DEFAULT_MAX_REQUEST_BYTES, DEFAULT_REQUEST_READ_TIMEOUT_MS, envNumber } from "./constants.js";
import { AgyError, asAgyError, retryAfterSeconds } from "./errors.js";
import { warn } from "./log.js";
import type { AnthropicUsage } from "./translate.js";

export type AnthropicMessageRequest = {
  model?: unknown;
  messages?: unknown;
  system?: unknown;
  stream?: unknown;
  max_tokens?: unknown;
  stop_sequences?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  top_k?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  metadata?: unknown;
  [key: string]: unknown;
};

let warnedTemperature = false;

/** ACP owns generation sampling. Accept a finite temperature for client
 * compatibility, never claim it takes effect, and warn about it once. */
export function ignoreTemperature(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AgyError("invalid_request", "temperature must be a finite number");
  }
  if (warnedTemperature) return;
  warnedTemperature = true;
  warn("Ignoring temperature: generation sampling is owned by ACP", { reason: "unsupported_temperature" });
}

export async function readJson(
  request: Request,
  max = envNumber("OPENCODE_ANTIGRAVITY_MAX_REQUEST_BYTES", DEFAULT_MAX_REQUEST_BYTES, 1_024),
  signal?: AbortSignal,
): Promise<AnthropicMessageRequest> {
  signal?.throwIfAborted();
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > max) throw new AgyError("invalid_request", "The request body is too large", { code: "agy_request_too_large", status: 413 });
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    const deadline = Date.now() + envNumber("OPENCODE_ANTIGRAVITY_REQUEST_READ_TIMEOUT_MS", DEFAULT_REQUEST_READ_TIMEOUT_MS, 1_000);
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new AgyError("timeout", "Timed out while reading the request body", { code: "agy_request_read_timeout" });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const next = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new AgyError("timeout", "Timed out while reading the request body", { code: "agy_request_read_timeout" })), remaining);
              timer.unref?.();
            }),
          ]);
          signal?.throwIfAborted();
          if (next.done) break;
          total += next.value.byteLength;
          if (total > max) throw new AgyError("invalid_request", "The request body is too large", { code: "agy_request_too_large", status: 413 });
          chunks.push(next.value);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
    } finally {
      signal?.removeEventListener("abort", cancel);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body must be an object");
    return parsed as AnthropicMessageRequest;
  } catch (error) {
    throw new AgyError("invalid_request", "The request body is not valid JSON", { code: "agy_invalid_json", cause: error });
  }
}

export function errorType(error: AgyError): string {
  if (error.kind === "context_overflow") return "context_length_exceeded";
  if (error.kind === "auth") return "authentication_error";
  if (error.kind === "quota") return "insufficient_quota";
  if (error.kind === "rate_limit") return "rate_limit_error";
  if (error.kind === "overload") return "overloaded_error";
  if (error.kind === "refusal") return "content_policy_violation";
  if (error.code === "agy_cancelled" || error.code === "agy_client_cancelled") return "invalid_request_error";
  if (error.kind === "invalid_request" || error.kind === "unsupported" || error.kind === "unknown_model") return "invalid_request_error";
  return "api_error";
}

export function errorPayload(error: AgyError): { type: "error"; error: { type: string; message: string; code: string; retry_after?: number } } {
  const retryAfter = retryAfterSeconds(error);
  // The installed Anthropic stream decoder keeps only error.type/message.
  // Include the normalized hint in message as well as the HTTP/body fields.
  return { type: "error", error: { type: errorType(error), message: retryAfter === undefined ? error.message : `${error.message} (retry after ${retryAfter} seconds)`, code: error.code, ...(retryAfter !== undefined ? { retry_after: retryAfter } : {}) } };
}

export function errorResponse(error: unknown): Response {
  const failure = asAgyError(error);
  const retryAfter = retryAfterSeconds(failure);
  return Response.json(errorPayload(failure), {
    status: failure.status,
    headers: retryAfter ? { "Retry-After": String(retryAfter) } : undefined,
  });
}

export function completionId(): string { return `msg_${randomUUID().replace(/-/g, "")}`; }

export function anthropicUsage(usage: AnthropicUsage | undefined): Record<string, unknown> {
  return {
    input_tokens: usage?.input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
    ...(usage?.output_tokens_details ? { output_tokens_details: usage.output_tokens_details } : {}),
  };
}
