import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { blockBudget } from "./budget.js";
import { HOST_MCP_SERVER_NAME } from "./constants.js";
import { AgyAbortError, AgyError, AgyProtocolError } from "./errors.js";
import type { HostTool } from "./host-tools.js";
import { acceptsMcpSse, mcpProgressResponse, readMcpBody } from "./mcp-http.js";
import type { AcpEvent } from "./protocol.js";
import {
  isObject, MAX_CLIENT_TOOLS, MAX_TOOL_ARGUMENT_BYTES, textTurn, toolJson,
  type ClientToolCall, type ClientToolResult, type ServiceContentBlock, type ServiceTurnEvent, type Turn,
} from "./service-messages.js";

export type ToolProtocol = "anthropic" | "openai" | "gemini";

const MAX_MCP_BODY_BYTES = 128 * 1024;
const TOOL_WAIT_MS = 180_000;
const BATCH_WINDOW_MS = 25;

type McpToolResult = Pick<ClientToolResult, "content" | "isError">;
type PendingCall = {
  call: ClientToolCall;
  result: ReturnType<typeof Promise.withResolvers<McpToolResult>>;
};

/** A call ID can resume exactly one paused ACP turn through the authenticated service. */
export class ClientToolTurn {
  private readonly controller = new AbortController();
  private readonly pending = new Map<string, PendingCall>();
  private readonly requests = new Set<string>();
  private readonly token = randomUUID();
  private readonly closed = Promise.withResolvers<void>();
  private readonly server: Bun.Server<undefined>;
  private readonly events: AsyncGenerator<AcpEvent>;
  private next?: Promise<IteratorResult<AcpEvent>>;
  private wake?: () => void;
  private reported: ClientToolCall[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private callCount = 0;
  private readonly acpModel: string;

  constructor(
    turn: Omit<Turn, "signal" | "mcp">, private readonly tools: HostTool[],
    readonly protocol: ToolProtocol, private readonly waitMs = TOOL_WAIT_MS,
  ) {
    this.model = turn.selected.requestedModel;
    this.acpModel = turn.selected.acpModel;
    this.server = Bun.serve({
      hostname: "127.0.0.1", port: 0, idleTimeout: 0, maxRequestBodySize: MAX_MCP_BODY_BYTES,
      fetch: request => this.mcp(request),
    });
    this.events = textTurn({ ...turn, signal: this.controller.signal, mcp: {
      mcpServers: [{ type: "http", name: HOST_MCP_SERVER_NAME, url: new URL(this.token, this.server.url).href, headers: [] }],
      waitingForTools: () => this.pending.size > 0,
    } });
  }

  readonly model: string;
  get done(): Promise<void> { return this.closed.promise; }
  owns(id: string): boolean { return this.reported.some(call => call.id === id); }

  resume(protocol: ToolProtocol, model: string, responses: ClientToolResult[], steering: ServiceContentBlock[] = []): void {
    const byId = new Map(responses.map(response => [response.id, response]));
    if (protocol !== this.protocol || model !== this.model || byId.size !== responses.length ||
        this.reported.length !== byId.size || !this.reported.length || this.reported.some(call => {
          const result = byId.get(call.id);
          return !result || (result.name !== undefined && result.name !== call.name) ||
            (result.args !== undefined && !isDeepStrictEqual(result.args, call.args));
        })) {
      throw new AgyError("invalid_request", "Return one matching tool result for each call from this protocol and model");
    }
    const results = this.reported.map(({ id }) => {
      const { content, isError } = byId.get(id)!;
      return { id, content, isError };
    });
    if (steering.length) {
      const last = results.at(-1)!;
      last.content = [...last.content, { type: "text", text: "[subsequent user message]" }, ...steering];
    }
    blockBudget(this.acpModel, results.flatMap(result => result.content));
    clearTimeout(this.timer);
    this.reported = [];
    for (const { id, ...result } of results) {
      const pending = this.pending.get(id)!;
      this.pending.delete(id);
      pending.result.resolve(result);
    }
  }

  async *segment(signal: AbortSignal): AsyncGenerator<ServiceTurnEvent> {
    let parked = false;
    let batchDeadline: number | undefined;
    const cancel = () => { void this.close(signal.reason).catch(() => undefined); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      while (true) {
        this.controller.signal.throwIfAborted();
        if (!this.next) {
          this.next = this.events.next();
          void this.next.catch(error => { void this.close(error).catch(() => undefined); });
        }
        const tool = Promise.withResolvers<undefined>();
        // A timer lets ready ACP updates drain before a call is reported, even
        // when downstream backpressure paused the previous generator yield.
        let batchTimer: ReturnType<typeof setTimeout> | undefined;
        if (this.pending.size > 0) {
          batchDeadline ??= performance.now() + BATCH_WINDOW_MS;
          batchTimer = setTimeout(() => tool.resolve(undefined), Math.max(0, batchDeadline - performance.now()));
        } else this.wake = () => tool.resolve(undefined);
        const event = await Promise.race([this.next, tool.promise]).finally(() => clearTimeout(batchTimer));
        this.wake = undefined;
        this.controller.signal.throwIfAborted();
        if (!event) {
          if (!batchTimer) continue;
          const calls = [...this.pending.values()].map(pending => pending.call);
          yield { event: "function_calls", calls };
          this.controller.signal.throwIfAborted();
          this.reported = calls;
          this.timer = setTimeout(() => { void this.close().catch(() => undefined); }, this.waitMs);
          this.timer.unref();
          parked = true;
          return;
        }
        this.next = undefined;
        if (event.done) return;
        yield event.value;
        if (event.value.event === "result") {
          await this.events.next();
          return;
        }
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      if (!parked) await this.close();
    }
  }

  async close(reason: unknown = new AgyAbortError()): Promise<void> {
    if (this.controller.signal.aborted) return this.done;
    this.controller.abort(reason);
    clearTimeout(this.timer);
    this.reported = [];
    for (const pending of this.pending.values()) pending.result.reject(reason);
    this.pending.clear();
    this.wake?.();
    try {
      await this.events.return(undefined);
    } finally {
      try { await this.server.stop(true); }
      finally { this.closed.resolve(); }
    }
  }

  private async mcp(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== `/${this.token}` || request.headers.has("origin") || this.controller.signal.aborted) {
      return new Response(null, { status: 404 });
    }
    if (request.method !== "POST") return new Response(null, { status: request.method === "DELETE" ? 204 : 405 });
    let id: unknown = null;
    const reply = (value: { result: unknown } | { error: { code: number; message: string } }) =>
      Response.json({ jsonrpc: "2.0", id, ...value });
    try {
      const rpc: unknown = JSON.parse(await readMcpBody(request, MAX_MCP_BODY_BYTES));
      if (!isObject(rpc) || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") throw new AgyProtocolError("Invalid MCP request");
      id = rpc.id ?? null;
      const params = isObject(rpc.params) ? rpc.params : {};
      if (rpc.id === undefined) {
        if (rpc.method === "notifications/cancelled" && this.requests.has(JSON.stringify(params.requestId))) {
          void this.close().catch(() => undefined);
        }
        return new Response(null, { status: 202 });
      }
      if (rpc.method === "initialize") {
        const version = params.protocolVersion;
        return reply({ result: {
          protocolVersion: version === "2025-06-18" || version === "2024-11-05" ? version : "2025-03-26",
          capabilities: { tools: {} }, serverInfo: { name: HOST_MCP_SERVER_NAME, version: "1" },
        } });
      }
      if (rpc.method === "ping") return reply({ result: {} });
      if (rpc.method === "tools/list") return reply({ result: {
        tools: this.tools.map(({ name, description, input_schema }) => ({ name, description, inputSchema: input_schema })),
      } });
      if (rpc.method !== "tools/call") return reply({ error: { code: -32601, message: "Method not found" } });

      this.controller.signal.throwIfAborted();
      request.signal.throwIfAborted();
      const { name, arguments: args = {} } = params;
      if (typeof name !== "string" || !this.tools.some(tool => tool.name === name) ||
          !isObject(args)) throw new AgyProtocolError("Invalid or unavailable MCP tool call");
      const argsJson = toolJson(args);
      if (Buffer.byteLength(argsJson) > MAX_TOOL_ARGUMENT_BYTES) throw new AgyProtocolError("MCP tool arguments are too large");
      const key = JSON.stringify(id);
      if (this.requests.has(key) || this.callCount >= MAX_CLIENT_TOOLS) throw new AgyProtocolError("Duplicate MCP request ID or tool call limit exceeded");
      this.callCount++;
      // Match echoed arguments against the JSON value the client receives.
      const call: ClientToolCall = { id: `call_${randomUUID()}`, name, args: JSON.parse(argsJson) };
      const result = Promise.withResolvers<McpToolResult>();
      this.requests.add(key);
      this.pending.set(call.id, { call, result });
      const cancel = () => { void this.close().catch(() => undefined); };
      request.signal.addEventListener("abort", cancel, { once: true });
      this.wake?.();
      const running = result.promise.finally(() => {
        request.signal.removeEventListener("abort", cancel);
        this.requests.delete(key);
      });
      const progress = isObject(params._meta) ? params._meta.progressToken : undefined;
      if ((typeof progress === "string" || typeof progress === "number") && acceptsMcpSse(request)) {
        return mcpProgressResponse(id, progress, running, cancel);
      }
      return reply({ result: await running });
    } catch (error) {
      return reply({ error: { code: -32603, message: error instanceof Error ? error.message : "MCP request failed" } });
    }
  }
}
