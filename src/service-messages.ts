import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { createAcpWorker, type AcpWorkerOptions } from "./acp-process.js";
import type { AcpServerDetection } from "./acp-detect.js";
import { anthropicUsage, completionId, errorPayload, type AnthropicMessageRequest } from "./anthropic-http.js";
import { mediaBytes, reserveMedia, type MediaMaterializationBudget } from "./attachments.js";
import { historyCharacterLimit } from "./budget.js";
import { DEFAULT_SSE_HEARTBEAT_MS } from "./constants.js";
import { AgyAbortError, AgyError, AgyProtocolError, retryAfterSeconds } from "./errors.js";
import type { HostTool } from "./host-tools.js";
import type { AcpModelSelection } from "./models.js";
import { quotedHostMessage } from "./prompt.js";
import { HarnessFailureGuard, type AcpEvent } from "./protocol.js";
import { reconstruct } from "./reconstruction.js";
import { createAcpTranslationState, mapAcpEvent, type AnthropicFinishReason, type AnthropicUsage } from "./translate.js";

const MAX_UPDATE_BYTES = 1024 * 1024;
const SSE_BUFFER_BYTES = 128 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES = 8 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MESSAGE_FIELDS = new Set(["model", "system", "messages", "max_tokens", "stream", "tools", "tool_choice"]);
export const MAX_CLIENT_TOOLS = 128;
export const MAX_TOOL_ARGUMENT_BYTES = 64 * 1024;
const MODEL_FORMAT_FAILURE = "Agent execution error: model output error: encountered an improper format stop reason.\nPlease retry with a properly formatted function call.";

function invalid(message: string): never {
  throw new AgyError("invalid_request", message);
}

export type ServiceContentBlock = Extract<ContentBlock, { type: "text" | "image" }>;
export type ClientToolCall = { id: string; name: string; args: Record<string, unknown> };
export type ClientToolResult = { id: string; name?: string; args?: Record<string, unknown>; content: ServiceContentBlock[]; isError: boolean };

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toolJson(value: unknown): string {
  try { return JSON.stringify(value); }
  catch { invalid("Tool data is too deeply nested"); }
}

function functionName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function toolId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function parseTools(tools: unknown): HostTool[] {
  if (tools === undefined) return [];
  if (!Array.isArray(tools) || tools.length > MAX_CLIENT_TOOLS) invalid("tools must be an array with at most 128 functions");
  const names = new Set<string>();
  const declarations = Array.from(tools, (tool: unknown): HostTool => {
    if (!isObject(tool) || Object.keys(tool).some(key => !["type", "name", "description", "input_schema", "strict"].includes(key)) ||
        (tool.type !== undefined && tool.type !== "custom") || (tool.strict !== undefined && tool.strict !== false) ||
        !functionName(tool.name) || names.has(tool.name) || (tool.description !== undefined && typeof tool.description !== "string") ||
        !isObject(tool.input_schema) || tool.input_schema.type !== "object") {
      invalid("Each client tool must have a unique name and an object input schema. Strict schemas and server tools are unsupported");
    }
    names.add(tool.name);
    return { name: tool.name, description: tool.description, input_schema: tool.input_schema };
  });
  if (Buffer.byteLength(toolJson(declarations)) > 1024 * 1024) invalid("Tool declarations are too large");
  return declarations;
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) invalid("Content must be a string or an array of text blocks");
  return value.map((part) => {
    if (part?.type !== "text" || typeof part.text !== "string") invalid("Only text content blocks are supported");
    return part.text;
  }).join("\n");
}

function messageContent(value: unknown, budget: MediaMaterializationBudget): string | ServiceContentBlock[] {
  if (!Array.isArray(value) || !value.some(part => part?.type === "image")) return textContent(value);
  return Array.from(value, (part): ServiceContentBlock => {
    if (part?.type === "text" && typeof part.text === "string") return { type: "text", text: part.text };
    if (part?.type !== "image") invalid("Only text and inline image blocks are supported");
    const { source } = part;
    if (Object.keys(part).some(key => key !== "type" && key !== "source") ||
        source?.type !== "base64" || typeof source.data !== "string" || typeof source.media_type !== "string" ||
        Object.keys(source).some(key => key !== "type" && key !== "data" && key !== "media_type")) {
      invalid("Image blocks require a base64 source with data and media_type");
    }
    if (!IMAGE_MIME_TYPES.has(source.media_type)) invalid("Images must use PNG, JPEG, WebP or GIF");
    const bytes = mediaBytes(source.data);
    if (bytes > MAX_IMAGE_BYTES) throw new AgyError("invalid_request", "The image is too large", { code: "agy_attachment_too_large" });
    reserveMedia(budget, bytes);
    return { type: "image", mimeType: source.media_type, data: source.data };
  });
}

function contentBlocks(content: string | ServiceContentBlock[]): ServiceContentBlock[] {
  return typeof content === "string" ? (content ? [{ type: "text", text: content }] : []) : content;
}

function parseToolUse(part: Record<string, unknown>): ClientToolCall {
  if (!toolId(part.id) || !functionName(part.name) || !isObject(part.input) ||
      Object.keys(part).some(key => !["type", "id", "name", "input"].includes(key)) ||
      Buffer.byteLength(toolJson(part.input)) > MAX_TOOL_ARGUMENT_BYTES) invalid("Invalid tool_use block");
  return { id: part.id, name: part.name, args: part.input };
}

function parseToolResult(part: Record<string, unknown>, media: MediaMaterializationBudget): ClientToolResult {
  if (!toolId(part.tool_use_id) || (part.is_error !== undefined && typeof part.is_error !== "boolean") ||
      Object.keys(part).some(key => !["type", "tool_use_id", "content", "is_error"].includes(key))) invalid("Invalid tool_result block");
  return { id: part.tool_use_id, content: contentBlocks(messageContent(part.content === undefined ? "" : part.content, media)),
    isError: part.is_error === true };
}

type ServiceHistoryMessage = { role: "user" | "assistant"; content: string | ServiceContentBlock[]; toolIds?: string[] };

function parseHistory(messages: unknown[]) {
  const media = { remaining: MAX_IMAGE_TOTAL_BYTES };
  const responses: ClientToolResult[] = [];
  const steering: ServiceContentBlock[] = [];
  const lastAssistant = messages.map(message => isObject(message) && message.role === "assistant").lastIndexOf(true);
  let pending = new Map<string, ClientToolCall>();
  const history = messages.map((message, index): ServiceHistoryMessage => {
    if (!isObject(message) || (message.role !== "user" && message.role !== "assistant") ||
        Object.keys(message).some(key => key !== "role" && key !== "content")) invalid("Messages must contain a user or assistant role and content");
    const role = message.role;
    const raw: unknown = message.content;
    const parts = Array.isArray(raw) ? raw : [];
    const toolBlocks = parts.some(part => part?.type === "tool_use" || part?.type === "tool_result");
    const previous = pending;
    pending = new Map();
    if (!toolBlocks) {
      if (previous.size) invalid("Tool results must immediately follow the assistant tool calls");
      const content = messageContent(raw, media);
      if (typeof content === "string" && !content.trim()) invalid("Messages must contain nonempty text");
      if (responses.length) steering.push(...contentBlocks(content));
      return { role, content };
    }

    const seen = new Set<string>();
    const results: ClientToolResult[] = [];
    const blocks: ServiceContentBlock[] = [];
    let ordinaryContent = false;
    for (const part of parts) {
      if (isObject(part) && part.type === "tool_use") {
        if (role !== "assistant" || previous.size || pending.size >= MAX_CLIENT_TOOLS) invalid("Unexpected tool_use block");
        const call = parseToolUse(part);
        if (pending.has(call.id)) invalid("Duplicate tool_use ID");
        pending.set(call.id, call);
        blocks.push({ type: "text", text: `[function call] ${toolJson(call)}` });
      } else if (isObject(part) && part.type === "tool_result") {
        if (role !== "user" || ordinaryContent || results.length >= MAX_CLIENT_TOOLS ||
            (!previous.size && (index !== 0 || lastAssistant !== -1))) invalid("Place tool results together, immediately after their calls and before other content");
        const result = parseToolResult(part, media);
        const call = previous.get(result.id);
        if (seen.has(result.id) || (previous.size && !call)) invalid("Duplicate or unmatched tool result ID");
        seen.add(result.id);
        if (call) Object.assign(result, { name: call.name, args: call.args });
        results.push(result);
        blocks.push({ type: "text", text: `[function result ${result.id}${result.isError ? " error" : ""}]` }, ...result.content);
      } else {
        ordinaryContent = true;
        const content = contentBlocks(messageContent([part], media));
        blocks.push(...content);
        if (index > lastAssistant && results.length) steering.push(...content);
      }
    }
    if (previous.size !== 0 && results.length !== previous.size) invalid("Return one tool result for every call");
    if (index > lastAssistant) responses.push(...results);
    return { role, content: blocks, toolIds: [...pending.keys(), ...seen] };
  });
  if (history.at(-1)?.role !== "user") invalid("The last message must be from the user");
  return { history, ...(responses.length ? { responses, steering } : {}) };
}

export function parseMessage(body: AnthropicMessageRequest) {
  if (Object.keys(body).some(key => !MESSAGE_FIELDS.has(key))) invalid("Unsupported Messages request field");
  const { model, messages, max_tokens, stream, tool_choice } = body;
  if (typeof model !== "string" || !model.trim() || model.length > 256) invalid("model must be a nonempty model ID");
  if (typeof max_tokens !== "number" || !Number.isSafeInteger(max_tokens) || max_tokens <= 0) invalid("max_tokens must be a positive integer");
  if (stream !== undefined && typeof stream !== "boolean") invalid("stream must be a boolean");
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 256) invalid("messages must contain 1 to 256 entries");
  const tools = parseTools(body.tools);
  if (tool_choice !== undefined && (!isObject(tool_choice) ||
      (tool_choice.type !== "auto" && tool_choice.type !== "none") ||
      Object.keys(tool_choice).some(key => key !== "type" && key !== "disable_parallel_tool_use") ||
      (tool_choice.disable_parallel_tool_use !== undefined && tool_choice.disable_parallel_tool_use !== false))) {
    invalid("tool_choice supports auto and none. Forced and serial-only tool calling are unsupported");
  }
  const input = parseHistory(messages);
  const disabled = isObject(tool_choice) && tool_choice.type === "none";
  if (input.responses?.length && disabled) invalid("Cannot disable tools while returning tool results");
  return { model, ...input, maxTokens: max_tokens, stream: stream === true,
    system: body.system === undefined ? "" : textContent(body.system), ...(tools.length && !disabled ? { tools } : {}) };
}

export type Turn = {
  directory: string;
  detection: AcpServerDetection;
  selected: AcpModelSelection;
  request: ReturnType<typeof parseMessage>;
  signal: AbortSignal;
  mcp?: Pick<AcpWorkerOptions, "mcpServers" | "waitingForTools">;
};

export async function* textTurn({ directory, detection, selected, request, signal, mcp }: Turn): AsyncGenerator<AcpEvent> {
  const last = request.history.length - 1;
  const groups = request.history.map((message, index) => {
    const operative = index === last;
    const { content, role } = message;
    const blocks: ContentBlock[] = typeof content === "string"
      ? [{ type: "text", text: operative ? content : quotedHostMessage(message) }]
      : operative ? content : [{ type: "text", text: `[${role}]` }, ...content];
    return { message, operative, blocks, toolIds: message.toolIds };
  });
  const prompt = reconstruct(groups, request.system, selected.acpModel, historyCharacterLimit(), request.maxTokens);
  signal.throwIfAborted();
  const workspace = await mkdtemp(join(directory, "request-"));
  let worker: Awaited<ReturnType<typeof createAcpWorker>> | undefined;
  try {
    worker = await createAcpWorker({
      cwd: workspace,
      executable: detection.executable,
      executableArgs: detection.args,
      model: selected.acpModel,
      effort: selected.effort,
      hostTools: true,
      utilityDirectory: workspace,
      maxUpdateBytes: MAX_UPDATE_BYTES,
      ...mcp,
    }, signal);
    const guard = new HarnessFailureGuard({
      text: MODEL_FORMAT_FAILURE,
      error: () => new AgyError("process", "Antigravity reported malformed model output", { code: "agy_model_output_format" }),
    });
    for await (const update of worker.runTurn(prompt, signal)) {
      signal.throwIfAborted();
      if (update.event === "update" && update.update.sessionUpdate !== "agent_message_chunk" &&
          update.update.sessionUpdate !== "agent_thought_chunk") continue;
      for (const event of guard.push(update)) {
        if (event.event === "result" || event.update.sessionUpdate === "agent_message_chunk") yield event;
      }
    }
  } finally {
    try { await worker?.stop(true); }
    finally { await rm(workspace, { recursive: true, force: true }); }
  }
}

export function publicFailure(error: unknown, signal?: AbortSignal): AgyError {
  if (signal?.aborted) {
    const reason: unknown = signal.reason;
    if (reason instanceof AgyError) return reason;
    if (reason instanceof DOMException && reason.name === "TimeoutError") return new AgyError("timeout", "The request exceeded the service time limit");
    return new AgyAbortError();
  }
  if (error instanceof AgyError) {
    if (["invalid_request", "unknown_model", "unsupported"].includes(error.kind)) return error;
    const retryAfter = retryAfterSeconds(error);
    return new AgyError(error.kind, "Antigravity could not complete the request", {
      code: error.code, status: error.status, details: { retryAfter },
    });
  }
  return new AgyError("internal", "The service could not complete the request");
}

export type ServiceTurnEvent = AcpEvent | { event: "function_calls"; calls: ClientToolCall[] };

export async function collectServiceTurn(events: AsyncIterable<ServiceTurnEvent>) {
  let content = "";
  let terminal: Extract<ReturnType<typeof mapAcpEvent>, { kind: "result" }> | Extract<ServiceTurnEvent, { event: "function_calls" }> | undefined;
  const translation = createAcpTranslationState();
  for await (const event of events) {
    if (event.event === "function_calls") {
      terminal = event;
      continue;
    }
    const mapped = mapAcpEvent(event, translation);
    if (mapped.kind === "error") throw mapped.error;
    if (mapped.kind === "text") content += mapped.text;
    if (mapped.kind === "result") terminal = mapped;
  }
  if (!terminal) throw new AgyError("protocol", "The ACP agent ended a turn without a result", { code: "agy_acp_missing_result" });
  return "event" in terminal
    ? { content, finishReason: "tool_use" as const, calls: terminal.calls }
    : { content, finishReason: terminal.finishReason, usage: terminal.usage, rawUsage: terminal.result.usage };
}

type ServiceFinishReason = AnthropicFinishReason | "tool_use";

function anthropicToolCall({ id, name, args }: ClientToolCall) {
  return { type: "tool_use" as const, id, name, input: args };
}

function message(id: string, model: string, text: string, reason: ServiceFinishReason | null, usage?: AnthropicUsage, calls: ClientToolCall[] = []) {
  return { id, type: "message", role: "assistant", model,
    content: [...(text ? [{ type: "text", text }] : []), ...calls.map(anthropicToolCall)],
    stop_reason: reason, stop_sequence: null, usage: anthropicUsage(usage) };
}

export async function jsonMessage(events: AsyncIterable<ServiceTurnEvent>, model: string): Promise<Response> {
  const result = await collectServiceTurn(events);
  return Response.json(message(completionId(), model, result.content, result.finishReason, result.usage, result.calls));
}

type StreamFrames = {
  start(): string[];
  text(delta: string): string[];
  finish(reason: AnthropicFinishReason, usage?: AnthropicUsage, rawUsage?: unknown): string[];
  functions?(calls: ClientToolCall[]): Iterable<string>;
  error(error: AgyError): string;
  ping?: string | null;
};

export function* sseTextChunks(text: string): Iterable<string> {
  for (let offset = 0; offset < text.length;) {
    // Bound the encoded frame even when JSON escaping expands text.
    let end = Math.min(offset + 8192, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    yield text.slice(offset, end);
    offset = end;
  }
}

export function anthropicStream(model: string): StreamFrames {
  const id = completionId();
  const frame = (payload: { type: string } & Record<string, unknown>) =>
    `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
  const stop = (index: number) => frame({ type: "content_block_stop", index });
  const finish = (reason: ServiceFinishReason, usage?: AnthropicUsage) => [
    frame({ type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: anthropicUsage(usage) }),
    frame({ type: "message_stop" }),
  ];
  let hasText = false;
  return {
    start: () => [frame({ type: "message_start", message: message(id, model, "", null) })],
    text(delta) {
      const frames = [];
      if (!hasText) {
        frames.push(frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
        hasText = true;
      }
      frames.push(frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } }));
      return frames;
    },
    finish(reason, usage) {
      return [...(hasText ? [stop(0)] : []), ...finish(reason, usage)];
    },
    *functions(calls) {
      if (hasText) yield stop(0);
      for (const [offset, call] of calls.entries()) {
        const index = offset + Number(hasText);
        yield frame({ type: "content_block_start", index, content_block: { ...anthropicToolCall(call), input: {} } });
        for (const partial_json of sseTextChunks(toolJson(call.args))) {
          yield frame({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } });
        }
        yield stop(index);
      }
      yield* finish("tool_use");
    },
    error: error => frame(errorPayload(error)),
    ping: frame({ type: "ping" }),
  };
}

export async function streamTurn(
  events: AsyncGenerator<ServiceTurnEvent>, frames: StreamFrames, signal: AbortSignal, cancel: () => void, settled: () => void,
): Promise<Response> {
  const first = await events.next();
  if (first.done) throw new AgyProtocolError("The ACP agent ended without a response");
  if (first.value.event !== "function_calls") {
    const initial = mapAcpEvent(first.value);
    if (initial.kind === "error") {
      await events.return(undefined);
      throw initial.error;
    }
  }
  const encoder = new TextEncoder();
  let cancelled = false;
  let waitingForReader: (() => void) | undefined;
  const wake = () => {
    waitingForReader?.();
    waitingForReader = undefined;
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const hasRoom = (frame: Uint8Array) => frame.byteLength <= (controller.desiredSize ?? 0);
      const send = async (messages: Iterable<string>) => {
        for (const message of messages) {
          const frame = encoder.encode(message);
          if (frame.byteLength > SSE_BUFFER_BYTES) throw new AgyProtocolError("SSE frame exceeds the buffer size");
          while (!hasRoom(frame)) {
            signal.throwIfAborted();
            await new Promise<void>(resolve => { waitingForReader = resolve; });
          }
          signal.throwIfAborted();
          controller.enqueue(frame);
        }
      };
      const ping = frames.ping === null ? undefined : encoder.encode(frames.ping ?? ": ping\n\n");
      signal.addEventListener("abort", wake, { once: true });
      const heartbeat = ping && setInterval(() => {
        if (!signal.aborted && !waitingForReader && hasRoom(ping)) controller.enqueue(ping);
      }, DEFAULT_SSE_HEARTBEAT_MS);
      void (async () => {
        try {
          let terminal: Extract<ReturnType<typeof mapAcpEvent>, { kind: "result" }> | undefined;
          await send(frames.start());
          for (let next: IteratorResult<ServiceTurnEvent> = first; !next.done; next = await events.next()) {
            signal.throwIfAborted();
            if (next.value.event === "function_calls" && frames.functions) {
              await send(frames.functions(next.value.calls));
              if (!(await events.next()).done) throw new AgyProtocolError("Unexpected event after function calls");
              controller.close();
              return;
            }
            if (next.value.event === "function_calls") throw new AgyProtocolError("Unexpected function calls");
            const mapped = mapAcpEvent(next.value);
            if (mapped.kind === "error") throw mapped.error;
            if (mapped.kind === "result") terminal = mapped;
            if (mapped.kind !== "text") continue;
            for (const delta of sseTextChunks(mapped.text)) await send(frames.text(delta));
          }
          if (!terminal) throw new AgyProtocolError("The ACP agent ended without a response");
          await send(frames.finish(terminal.finishReason, terminal.usage, terminal.result.usage));
          controller.close();
        } catch (error) {
          if (!cancelled) {
            const frame = encoder.encode(frames.error(publicFailure(error, signal)));
            if (hasRoom(frame)) { controller.enqueue(frame); controller.close(); }
            else controller.error(new Error("The SSE response could not be delivered"));
          }
        } finally {
          if (heartbeat) clearInterval(heartbeat);
          signal.removeEventListener("abort", wake);
          cancel();
          try { await events.return(undefined); }
          finally { settled(); }
        }
      })().catch(() => undefined);
    },
    pull: wake,
    cancel() {
      cancelled = true;
      cancel();
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: SSE_BUFFER_BYTES }));
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" } });
}
