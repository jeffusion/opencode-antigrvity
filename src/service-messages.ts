import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createAcpWorker } from "./acp-process.js";
import type { AcpServerDetection } from "./acp-detect.js";
import { anthropicUsage, completionId, errorPayload, type AnthropicMessageRequest } from "./anthropic-http.js";
import { historyCharacterLimit } from "./budget.js";
import { DEFAULT_SSE_HEARTBEAT_MS } from "./constants.js";
import { AgyAbortError, AgyError, AgyProtocolError, retryAfterSeconds } from "./errors.js";
import type { AcpModelSelection } from "./models.js";
import { quotedHostMessage } from "./prompt.js";
import { HarnessFailureGuard, type AcpEvent } from "./protocol.js";
import { reconstruct } from "./reconstruction.js";
import { collectTurn, mapAcpEvent, type AnthropicFinishReason, type AnthropicUsage } from "./translate.js";

const MAX_UPDATE_BYTES = 1024 * 1024;
const SSE_BUFFER_BYTES = 128 * 1024;
const MESSAGE_FIELDS = new Set(["model", "system", "messages", "max_tokens", "stream"]);
const MODEL_FORMAT_FAILURE = "Agent execution error: model output error: encountered an improper format stop reason.\nPlease retry with a properly formatted function call.";

function invalid(message: string): never {
  throw new AgyError("invalid_request", message);
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) invalid("Content must be a string or an array of text blocks");
  return value.map((part) => {
    if (part?.type !== "text" || typeof part.text !== "string") invalid("Only text content blocks are supported");
    return part.text;
  }).join("\n");
}

export function parseMessage(body: AnthropicMessageRequest) {
  if (Object.keys(body).some(key => !MESSAGE_FIELDS.has(key))) invalid("Unsupported request field. Supported fields are model, messages, system, max_tokens and stream");
  const { model, messages, max_tokens, stream } = body;
  if (typeof model !== "string" || !model.trim() || model.length > 256) invalid("model must be a nonempty model ID");
  if (typeof max_tokens !== "number" || !Number.isSafeInteger(max_tokens) || max_tokens <= 0) invalid("max_tokens must be a positive integer");
  if (stream !== undefined && typeof stream !== "boolean") invalid("stream must be a boolean");
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 256) invalid("messages must contain 1 to 256 entries");
  const history = messages.map((message) => {
    if ((message?.role !== "user" && message?.role !== "assistant") ||
        Object.keys(message).some(key => key !== "role" && key !== "content")) invalid("Messages must contain a user or assistant role and text content");
    const content = textContent(message.content);
    if (!content.trim()) invalid("Messages must contain nonempty text");
    return { role: message.role as "user" | "assistant", content };
  });
  if (history.at(-1)?.role !== "user") invalid("The last message must be from the user");
  return { model, history, maxTokens: max_tokens, stream: stream === true, system: body.system === undefined ? "" : textContent(body.system) };
}

type Turn = {
  directory: string;
  detection: AcpServerDetection;
  selected: AcpModelSelection;
  request: ReturnType<typeof parseMessage>;
  signal: AbortSignal;
};

export async function* textTurn({ directory, detection, selected, request, signal }: Turn): AsyncGenerator<AcpEvent> {
  const last = request.history.length - 1;
  const groups = request.history.map((message, index) => ({
    message,
    operative: index === last,
    blocks: [{ type: "text" as const, text: index === last ? message.content : quotedHostMessage(message) }],
  }));
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

function message(id: string, model: string, text: string, reason: AnthropicFinishReason | null, usage?: AnthropicUsage) {
  return { id, type: "message", role: "assistant", model, content: text ? [{ type: "text", text }] : [],
    stop_reason: reason, stop_sequence: null, usage: anthropicUsage(usage) };
}

export async function jsonMessage(events: AsyncIterable<AcpEvent>, model: string): Promise<Response> {
  const result = await collectTurn(events);
  return Response.json(message(completionId(), model, result.content, result.finishReason, result.usage));
}

type StreamFrames = {
  start(): string[];
  text(delta: string): string[];
  finish(reason: AnthropicFinishReason, usage?: AnthropicUsage, rawUsage?: unknown): string[];
  error(error: AgyError): string;
  ping?: string | null;
};

export function anthropicStream(model: string): StreamFrames {
  const id = completionId();
  const frame = (payload: { type: string } & Record<string, unknown>) =>
    `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
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
      const frames = [];
      if (hasText) frames.push(frame({ type: "content_block_stop", index: 0 }));
      frames.push(frame({ type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: anthropicUsage(usage) }),
        frame({ type: "message_stop" }));
      return frames;
    },
    error: error => frame(errorPayload(error)),
    ping: frame({ type: "ping" }),
  };
}

export async function streamTurn(
  events: AsyncGenerator<AcpEvent>, frames: StreamFrames, signal: AbortSignal, cancel: () => void, settled: () => void,
): Promise<Response> {
  const first = await events.next();
  if (first.done) throw new AgyProtocolError("The ACP agent ended without a response");
  const initial = mapAcpEvent(first.value);
  if (initial.kind === "error") {
    await events.return(undefined);
    throw initial.error;
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
      const send = async (messages: string[]) => {
        for (const message of messages) {
          const frame = encoder.encode(message);
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
          for (let next: IteratorResult<AcpEvent> = first; !next.done; next = await events.next()) {
            signal.throwIfAborted();
            const mapped = mapAcpEvent(next.value);
            if (mapped.kind === "error") throw mapped.error;
            if (mapped.kind === "result") terminal = mapped;
            if (mapped.kind !== "text") continue;
            for (let offset = 0; offset < mapped.text.length;) {
              // Bound the encoded frame even when JSON escaping expands text.
              let end = Math.min(offset + 8192, mapped.text.length);
              const last = mapped.text.charCodeAt(end - 1);
              if (end < mapped.text.length && last >= 0xd800 && last <= 0xdbff) end--;
              await send(frames.text(mapped.text.slice(offset, end)));
              offset = end;
            }
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
