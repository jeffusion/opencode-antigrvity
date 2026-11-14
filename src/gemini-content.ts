import { AgyError, retryAfterSeconds } from "./errors.js";
import type { HostTool } from "./host-tools.js";
import {
  collectServiceTurn, isObject, MAX_CLIENT_TOOLS, parseMessage, toolJson as json,
  type ClientToolCall, type ClientToolResult, type ServiceContentBlock, type ServiceTurnEvent,
} from "./service-messages.js";
import type { AnthropicFinishReason, AnthropicUsage } from "./translate.js";

type GeminiResultImage = { displayName?: string; image: Extract<ServiceContentBlock, { type: "image" }> };
type GeminiFunctionResponse = { id: string; name: string; response: Record<string, unknown>; images?: GeminiResultImage[] };

function resultImageBlocks(images?: GeminiResultImage[]): ServiceContentBlock[] {
  return images?.flatMap(({ displayName, image }): ServiceContentBlock[] => displayName === undefined
    ? [image]
    : [{ type: "text", text: `[tool result image ${JSON.stringify(displayName)}]` }, image]) ?? [];
}

const REQUEST_FIELDS = new Set(["contents", "systemInstruction", "generationConfig", "tools", "toolConfig"]);
const GENERATION_FIELDS = new Set(["maxOutputTokens", "candidateCount", "responseMimeType"]);
const TOOL_FIELDS = new Set(["name", "description", "parameters", "parametersJsonSchema"]);
// OpenCode's @ai-sdk/google marks reasoning history parts with thought flags; ACP rebuilds history, so only text is kept.
const TEXT_FIELDS = new Set(["text", "thought", "thoughtSignature"]);
const FINISH_REASONS = {
  end_turn: "STOP",
  stop_sequence: "STOP",
  max_tokens: "MAX_TOKENS",
  refusal: "OTHER",
} as const satisfies Record<AnthropicFinishReason, string>;

function invalid(message: string): never {
  throw new AgyError("invalid_request", message);
}

function functionName(value: unknown): value is string {
  return typeof value === "string" && /^[\w-]{1,128}$/.test(value);
}

function openApiSchema(schema: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > 64) invalid("Function parameter schema is too deeply nested");
  const normalized = { ...schema };
  if (typeof schema.type === "string") {
    const type = schema.type.toLowerCase();
    normalized.type = schema.nullable === true ? [type, "null"] : type;
  }
  delete normalized.nullable;
  if (isObject(schema.properties)) {
    normalized.properties = Object.fromEntries(Object.entries(schema.properties).map(([name, property]) =>
      [name, isObject(property) ? openApiSchema(property, depth + 1) : property]));
  }
  for (const key of ["items", "additionalProperties"]) {
    const child = schema[key];
    if (isObject(child)) normalized[key] = openApiSchema(child, depth + 1);
  }
  if (Array.isArray(schema.anyOf)) normalized.anyOf = schema.anyOf.map(child => isObject(child) ? openApiSchema(child, depth + 1) : child);
  return normalized;
}

function parseTools(value: unknown, config: unknown): { tools: HostTool[]; disabled?: true } {
  const tools: HostTool[] = [];
  const names = new Set<string>();
  if (value !== undefined) {
    if (!Array.isArray(value)) invalid("tools must be an array of functionDeclarations");
    for (const group of value) {
      if (!isObject(group) || Object.keys(group).length !== 1 || !Array.isArray(group.functionDeclarations)) {
        invalid("Only functionDeclarations tools are supported");
      }
      for (const tool of group.functionDeclarations) {
        if (!isObject(tool) || Object.keys(tool).some(key => !TOOL_FIELDS.has(key)) || !functionName(tool.name) ||
            names.has(tool.name) || (tool.description !== undefined && typeof tool.description !== "string") ||
            (tool.parameters !== undefined && !isObject(tool.parameters)) ||
            (tool.parametersJsonSchema !== undefined && !isObject(tool.parametersJsonSchema)) ||
            (tool.parameters !== undefined && tool.parametersJsonSchema !== undefined) || tools.length >= MAX_CLIENT_TOOLS) {
          invalid("Invalid or duplicate Gemini function declaration");
        }
        const schema = tool.parametersJsonSchema ?? (tool.parameters ? openApiSchema(tool.parameters) : {});
        if (schema.type !== undefined && schema.type !== "object") invalid("Function parameters must use an object schema");
        tools.push({ name: tool.name, description: tool.description, input_schema: { ...schema, type: "object" } });
        names.add(tool.name);
      }
    }
    if (Buffer.byteLength(json(tools)) > 1024 * 1024) invalid("Function declarations are too large");
  }
  if (config === undefined) return { tools };
  if (!isObject(config) || Object.keys(config).some(key => key !== "functionCallingConfig")) invalid("Unsupported toolConfig field");
  const calling = config.functionCallingConfig;
  if (calling === undefined) return { tools };
  if (!isObject(calling) || Object.keys(calling).some(key => key !== "mode") ||
      ![undefined, "MODE_UNSPECIFIED", "AUTO", "NONE"].includes(calling.mode as string | undefined)) {
    invalid("functionCallingConfig supports AUTO and NONE");
  }
  return calling.mode === "NONE" ? { tools: [], disabled: true } : { tools };
}

function parseImage(inlineData: unknown, named = false): GeminiResultImage {
  if (!isObject(inlineData) || typeof inlineData.data !== "string" || typeof inlineData.mimeType !== "string" ||
      Object.keys(inlineData).some(key => key !== "data" && key !== "mimeType" && !(named && key === "displayName"))) {
    invalid("An inline image must contain base64 data and a MIME type");
  }
  const { data, mimeType, displayName } = inlineData;
  if (displayName !== undefined && (typeof displayName !== "string" || !displayName.trim() || displayName.length > 256)) {
    invalid("Invalid tool result image displayName");
  }
  const padded = data.length % 4 && !data.includes("=") ? data.padEnd(Math.ceil(data.length / 4) * 4, "=") : data;
  return { image: { type: "image", data: padded, mimeType }, displayName };
}

function parseResultImages(parts: unknown, response: Record<string, unknown>): GeminiResultImage[] | undefined {
  if (parts === undefined) return undefined;
  if (!Array.isArray(parts) || parts.length > MAX_CLIENT_TOOLS) invalid("Invalid functionResponse image parts");
  const names = new Set<string>();
  const images = parts.map(part => {
    if (!isObject(part) || Object.keys(part).length !== 1) invalid("Only inline images are supported in functionResponse parts");
    const result = parseImage(part.inlineData, true);
    if (result.displayName !== undefined) {
      if (names.has(result.displayName)) invalid("Duplicate tool result image displayName");
      names.add(result.displayName);
    }
    return result;
  });
  const checkRefs = (value: unknown, depth: number): void => {
    if (depth > 64) invalid("Tool response is too deeply nested");
    if (Array.isArray(value)) {
      for (const child of value) checkRefs(child, depth + 1);
    } else if (isObject(value)) {
      if (Object.keys(value).length === 1 && Object.hasOwn(value, "$ref")) {
        if (typeof value.$ref !== "string" || !names.delete(value.$ref)) invalid("Unknown or repeated functionResponse image reference");
      } else {
        for (const child of Object.values(value)) checkRefs(child, depth + 1);
      }
    }
  };
  checkRefs(response, 0);
  return images;
}

type GeminiCallPart = { type: "function_call"; id?: string; name: string; args?: Record<string, unknown>; text: string };
type GeminiInputPart = ServiceContentBlock | GeminiCallPart | { type: "function_result"; result: GeminiFunctionResponse };

function parseContent(content: unknown, allowTools = true) {
  if (!isObject(content) || Object.keys(content).some(key => key !== "role" && key !== "parts")) {
    invalid("Content must contain only role and parts");
  }
  const { role, parts } = content;
  if (role !== undefined && role !== "user" && role !== "model") invalid("Only user and model roles are supported");
  if (!Array.isArray(parts) || parts.length === 0) invalid("Content must contain at least one part");
  const blocks = Array.from(parts, (part: unknown): GeminiInputPart => {
    if (allowTools && isObject(part)) {
      const { functionCall, functionResponse } = part;
      if (functionCall !== undefined) {
        if (role !== "model" || !isObject(functionCall) || !functionName(functionCall.name) ||
            (functionCall.id !== undefined && (typeof functionCall.id !== "string" || !functionCall.id || functionCall.id.length > 128)) ||
            (functionCall.args !== undefined && !isObject(functionCall.args)) ||
            Object.keys(functionCall).some(key => !["id", "name", "args"].includes(key)) ||
            Object.keys(part).some(key => key !== "functionCall" && key !== "thoughtSignature")) {
          invalid("Invalid model functionCall");
        }
        const { id, name, args } = functionCall;
        return { type: "function_call", id, name, args, text: `[function call] ${json(functionCall)}` };
      }
      if (functionResponse !== undefined) {
        if (role === "model" || !isObject(functionResponse) || !functionName(functionResponse.name) ||
            typeof functionResponse.id !== "string" || !functionResponse.id || functionResponse.id.length > 128 ||
            !isObject(functionResponse.response) ||
            Object.keys(functionResponse).some(key => !["id", "name", "response", "parts"].includes(key)) || Object.keys(part).length !== 1) {
          invalid("Invalid functionResponse. A JSON response, name, and call ID are required");
        }
        const { id, name, response, parts } = functionResponse;
        const images = parseResultImages(parts, response);
        return { type: "function_result", result: { id, name, response, ...(images ? { images } : {}) } };
      }
    }
    if (isObject(part)) {
      if (Object.keys(part).every(key => TEXT_FIELDS.has(key)) && typeof part.text === "string" &&
          (part.thought === undefined || typeof part.thought === "boolean") &&
          (part.thoughtSignature === undefined || typeof part.thoughtSignature === "string")) {
        return { type: "text", text: part.text };
      }
      if (part.inlineData !== undefined && Object.keys(part).every(key => key === "inlineData" || key === "mediaResolution")) {
        const resolution = part.mediaResolution;
        if (resolution !== undefined && (!isObject(resolution) || Object.keys(resolution).length !== 1 ||
            (resolution.level !== "MEDIA_RESOLUTION_LOW" && resolution.level !== "MEDIA_RESOLUTION_HIGH"))) {
          invalid("Unsupported image mediaResolution");
        }
        return parseImage(part.inlineData).image;
      }
    }
    invalid("Unsupported content part");
  });
  return { role: role === "model" ? "assistant" : "user", blocks };
}

function historyParts(parts: GeminiInputPart[]) {
  return parts.flatMap((part): ServiceContentBlock[] => {
    if (part.type === "function_call") return [{ type: "text", text: part.text }];
    if (part.type !== "function_result") return [part];
    const { images, ...result } = part.result;
    return [{ type: "text", text: `[function result] ${json(result)}` }, ...resultImageBlocks(images)];
  }).map(block => block.type === "image"
    ? { type: "image", source: { type: "base64", data: block.data, media_type: block.mimeType } }
    : block);
}

export function parseGeminiContent(body: Record<string, unknown>, model: string, stream: boolean) {
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
  const parsed = Array.from(contents, content => parseContent(content));
  const responses: ClientToolResult[] = [];
  const steering: ServiceContentBlock[] = [];
  const lastModel = parsed.map(content => content.role).lastIndexOf("assistant");
  const continuation = parsed.findIndex((content, index) => index > lastModel && content.blocks.some(part => part.type === "function_result"));
  if (continuation >= 0) {
    const echoes = new Map<string, GeminiCallPart>();
    for (const part of parsed[lastModel]?.blocks ?? []) {
      if (part.type !== "function_call" || part.id === undefined) continue;
      if (echoes.has(part.id)) invalid("Duplicate model functionCall ID");
      echoes.set(part.id, part);
    }
    for (const { blocks } of parsed.slice(continuation)) {
      for (const part of blocks) {
        if (part.type === "function_result") {
          if (steering.length) invalid("Place all function responses before subsequent user text and images");
          if (responses.length >= MAX_CLIENT_TOOLS) invalid("Too many function responses");
          const { id, name, response, images } = part.result;
          const echo = echoes.get(id);
          if (echoes.size && !echo) invalid("functionResponse ID must match an echoed functionCall");
          if (echo && echo.name !== name) invalid("functionResponse name must match the echoed functionCall");
          responses.push({ id, name, args: echo?.args, content: [{ type: "text", text: json(response) }, ...resultImageBlocks(images)],
            isError: Object.hasOwn(response, "error") });
        } else {
          if (part.type === "function_call") invalid("Unexpected functionCall after functionResponse");
          steering.push(part);
        }
      }
    }
  }
  const { tools, disabled } = parseTools(body.tools, body.toolConfig);
  if (responses.length && disabled) invalid("Cannot switch to tool mode NONE while resuming a function call");
  const request = parseMessage({
    model, stream, max_tokens: maxOutputTokens,
    messages: parsed.map(({ role, blocks }) => ({ role, content: historyParts(blocks) })),
    system: systemInstruction === undefined ? undefined : historyParts(parseContent(systemInstruction, false).blocks),
  });
  for (const [index, { blocks }] of parsed.entries()) {
    const ids = blocks.flatMap(part => {
      if (part.type === "function_result") return [part.result.id];
      return part.type === "function_call" && part.id !== undefined ? [part.id] : [];
    });
    if (ids.length) request.history[index].toolIds = ids;
  }
  return { ...request, ...(tools.length ? { tools } : {}), ...(responses.length ? { responses, steering } : {}) };
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

type GeminiPart = { text: string } | { functionCall: ClientToolCall };

function response(modelVersion: string, parts?: GeminiPart[], reason?: AnthropicFinishReason, usage?: ReturnType<typeof usageMetadata>) {
  return {
    candidates: [{
      index: 0,
      content: parts === undefined ? undefined : { role: "model", parts },
      finishReason: reason === undefined ? undefined : FINISH_REASONS[reason],
    }],
    modelVersion,
    usageMetadata: usage,
  };
}

export async function geminiJson(events: AsyncIterable<ServiceTurnEvent>, model: string): Promise<Response> {
  const result = await collectServiceTurn(events);
  if (result.finishReason === "tool_use") {
    const calls = result.calls.map(functionCall => ({ functionCall }));
    return Response.json(response(model, result.content ? [{ text: result.content }, ...calls] : calls, "end_turn"));
  }
  return Response.json(response(model, [{ text: result.content }], result.finishReason, usageMetadata(result.rawUsage)));
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
    text: (delta: string) => [data(response(model, [{ text: delta }]))],
    functions: (calls: ClientToolCall[]) => calls.map((functionCall, index) =>
      data(response(model, [{ functionCall }], index === calls.length - 1 ? "end_turn" : undefined))),
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
