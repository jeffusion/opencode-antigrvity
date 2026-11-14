import { randomUUID } from "node:crypto";
import { errorPayload, ignoreTemperature } from "./anthropic-http.js";
import { AgyError } from "./errors.js";
import {
  collectServiceTurn, isObject, MAX_CLIENT_TOOLS, MAX_TOOL_ARGUMENT_BYTES, parseMessage, sseTextChunks, toolJson,
  type ClientToolCall, type ServiceTurnEvent,
} from "./service-messages.js";
import type { AnthropicFinishReason, AnthropicUsage } from "./translate.js";

const CHAT_FIELDS = new Set(["model", "messages", "max_completion_tokens", "max_tokens", "temperature", "stream", "stream_options", "n", "store", "tools", "tool_choice", "parallel_tool_calls"]);
const FINISH_REASONS = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  refusal: "content_filter",
  tool_use: "tool_calls",
} as const satisfies Record<AnthropicFinishReason | "tool_use", string>;

function invalid(message: string): never {
  throw new AgyError("invalid_request", message);
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

function userContent(content: unknown) {
  if (!Array.isArray(content) || !content.some(part => part?.type === "image_url")) return textContent(content);
  return Array.from(content, (part: unknown) => {
    if (!isObject(part) || part.type !== "image_url") return { type: "text", text: textContent([part]) };
    const { image_url } = part;
    if (!isObject(image_url) || Object.keys(part).length !== 2 ||
        Object.keys(image_url).some(key => key !== "url" && key !== "detail") || typeof image_url.url !== "string" ||
        (image_url.detail !== undefined && image_url.detail !== "auto")) {
      invalid("image_url requires a base64 data URL and supports only auto detail");
    }
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(image_url.url);
    if (!match || match[0] !== image_url.url) invalid("image_url requires an inline base64 data URL");
    return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
  });
}

function clientTools(tools: unknown) {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools) || tools.length > MAX_CLIENT_TOOLS) invalid("tools must be an array of at most 128 function definitions");
  return Array.from(tools, (tool: unknown) => {
    if (!isObject(tool) || tool.type !== "function" || Object.keys(tool).length !== 2 || !isObject(tool.function) ||
        Object.keys(tool.function).some(key => !["name", "description", "parameters", "strict"].includes(key))) {
      invalid("Only function tools are supported");
    }
    const { name, description, parameters, strict } = tool.function;
    const schema = parameters === undefined || isObject(parameters) ? { type: "object", ...parameters } : parameters;
    return { name, description, input_schema: schema, strict: strict ?? undefined };
  });
}

function toolUses(calls: unknown) {
  if (!Array.isArray(calls) || !calls.length || calls.length > MAX_CLIENT_TOOLS) invalid("Invalid assistant tool_calls");
  return Array.from(calls, (call: unknown) => {
    if (!isObject(call) || call.type !== "function" || Object.keys(call).length !== 3 || !isObject(call.function) ||
        Object.keys(call.function).length !== 2 || typeof call.function.arguments !== "string" ||
        Buffer.byteLength(call.function.arguments) > MAX_TOOL_ARGUMENT_BYTES) invalid("Invalid assistant function call");
    let input: unknown;
    try { input = JSON.parse(call.function.arguments); }
    catch { invalid("Function arguments must be a JSON object"); }
    return { type: "tool_use", id: call.id, name: call.function.name, input };
  });
}

export function parseChatCompletion(body: Record<string, unknown>) {
  for (const key of Object.keys(body)) {
    if (!CHAT_FIELDS.has(key)) invalid("Unsupported Chat Completions request field");
  }
  const { model, messages, stream, stream_options, max_completion_tokens, max_tokens, n, store, tool_choice, parallel_tool_calls } = body;
  ignoreTemperature(body.temperature);
  if (tool_choice !== undefined && tool_choice !== "auto" && tool_choice !== "none") invalid("tool_choice supports auto and none");
  if (parallel_tool_calls !== undefined && parallel_tool_calls !== true) invalid("Serial-only tool calling is unsupported");
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
  const history: Array<{ role: "user" | "assistant"; content: unknown }> = [];
  let toolResults: unknown[] | undefined;
  for (const message of messages as unknown[]) {
    if (!isObject(message)) invalid("Each message must be an object");
    const { role, content } = message;
    const keys = ["role", "content"];
    if (role === "assistant") keys.push("tool_calls");
    if (role === "tool") keys.push("tool_call_id");
    if (Object.keys(message).some(key => !keys.includes(key))) invalid("Unsupported message field");
    if (role === "system" || role === "developer") {
      if (history.length) invalid("System and developer messages must precede user and assistant messages");
      system.push(textContent(content));
    } else if (role === "tool") {
      if (!toolResults) {
        toolResults = [];
        history.push({ role: "user", content: toolResults });
      }
      toolResults.push({ type: "tool_result", tool_use_id: message.tool_call_id, content: textContent(content) });
      continue;
    } else if (role === "user") {
      history.push({ role, content: userContent(content) });
    } else if (role === "assistant") {
      if (message.tool_calls === undefined) history.push({ role, content: textContent(content) });
      else {
        const text = content == null ? "" : textContent(content);
        history.push({ role, content: [...(text ? [{ type: "text", text }] : []), ...toolUses(message.tool_calls)] });
      }
    } else {
      invalid("Only system, developer, user, assistant and tool roles are supported");
    }
    toolResults = undefined;
  }
  const request = parseMessage({ model, messages: history, system: system.join("\n"), stream,
    max_tokens: maxTokens === undefined ? 4096 : maxTokens, tools: clientTools(body.tools),
    tool_choice: tool_choice === undefined ? undefined : { type: tool_choice } });
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

function openAIToolCall({ id, name, args }: ClientToolCall) {
  return { id, type: "function", function: { name, arguments: toolJson(args) } };
}

export async function openAIJson(events: AsyncIterable<ServiceTurnEvent>, model: string): Promise<Response> {
  const result = await collectServiceTurn(events);
  const message = { role: "assistant", content: result.calls ? result.content || null : result.content,
    ...(result.calls ? { tool_calls: result.calls.map(openAIToolCall) } : {}) };
  return Response.json({ ...completionMeta(model), object: "chat.completion", choices: [{ index: 0,
    message, finish_reason: FINISH_REASONS[result.finishReason] }], usage: openAIUsage(result.usage) });
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
  const chunk = (delta: object, reason: keyof typeof FINISH_REASONS | null = null) =>
    data({ ...meta, choices: [{ index: 0, delta, finish_reason: reason === null ? null : FINISH_REASONS[reason] }],
      ...(includeUsage ? { usage: null } : {}) });
  const finish = (reason: keyof typeof FINISH_REASONS, usage?: AnthropicUsage) => {
    const frames = [chunk({}, reason)];
    if (includeUsage) frames.push(data({ ...meta, choices: [], usage: openAIUsage(usage) }));
    frames.push("data: [DONE]\n\n");
    return frames;
  };
  return {
    start: () => [chunk({ role: "assistant", content: "" })],
    text: (delta: string) => [chunk({ content: delta })],
    finish,
    *functions(calls: ClientToolCall[]) {
      for (const [index, call] of calls.entries()) {
        yield chunk({ tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: "" } }] });
        for (const args of sseTextChunks(toolJson(call.args))) {
          yield chunk({ tool_calls: [{ index, function: { arguments: args } }] });
        }
      }
      yield* finish("tool_use");
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
