import { afterAll, beforeAll, afterEach, expect, test } from "bun:test";
import { fixtureCompatibility } from "./fixtures/compatibility.js";
let compatibility: ReturnType<typeof fixtureCompatibility>;
beforeAll(() => { compatibility = fixtureCompatibility(); });
afterAll(() => { compatibility.mockRestore(); });
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AntigravityPlugin, INTEGRATION_ID, PLUGIN_ID } from "../src/index.js";
import {
  DIRECTORY_HEADER,
  EFFORT_HEADER,
  LOCAL_API_KEY,
  MESSAGE_HEADER,
  MODEL_HEADER,
  PROVIDER_ID,
  REQUEST_KIND_HEADER,
  SESSION_HEADER,
} from "../src/constants.js";
import { getProxyPort, getProxyRuntime } from "../src/proxy.js";
import { emitAcpCatalog } from "../src/catalog-events.js";
import { acpModelCatalog } from "../src/models.js";
import { AsyncEventQueue } from "../src/acp-process.js";
import { sessionStore } from "../src/session-store.js";

const fixture = join(import.meta.dir, "fixtures", "fake-acp.mjs");
const temporaryDirectories: string[] = [];
const cleanupTasks: Array<() => Promise<void>> = [];
const savedEnvironment = new Map<string, string | undefined>();
const environmentKeys = ["OPENCODE_ANTIGRAVITY_DATA_DIR", "GEMINI_HOME", "OPENCODE_ANTIGRAVITY_MODELS_DEV", "FAKE_ACP_PROMPT_LOG", "FAKE_ACP_RPC_LOG"];

afterEach(async () => {
  await Promise.all(cleanupTasks.splice(0).map((cleanup) => cleanup()));
  for (const key of environmentKeys) {
    const value = savedEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnvironment.clear();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

test("V2 setup registers provider models, integration auth, request hook, and cleanup", async () => {
  for (const key of environmentKeys) savedEnvironment.set(key, process.env[key]);
  const root = await temporaryDirectory("agy-v2-plugin-");
  const sessionDirectory = await temporaryDirectory("agy-v2-session-");
  const concurrentDirectory = await temporaryDirectory("agy-v2-concurrent-session-");
  const geminiHome = await temporaryDirectory("agy-v2-gemini-");
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = join(root, "data");
  process.env.GEMINI_HOME = geminiHome;
  process.env.OPENCODE_ANTIGRAVITY_MODELS_DEV = "0";
  process.env.FAKE_ACP_PROMPT_LOG = join(root, "event-prompts.jsonl");
  process.env.FAKE_ACP_RPC_LOG = join(root, "rpc.jsonl");
  await chmod(fixture, 0o755);

  const providers: any[] = [];
  let providerTransform: ((editor: any) => void) | undefined;
  const methods: any[] = [];
  const savedMarkers: any[] = [];
  let marker: any;
  const sessionDirectories = new Map<string, string>();
  const hooks = new Map<string, { callback: (event: any) => Promise<void>; options?: unknown }>();
  const subscriptions: AsyncEventQueue<any>[] = [];
  const processedEvents = new Set<string>();
  const hostModels = new Map<string, any>();
  const hostModelUpdates: any[] = [];
  let configuredSystem: string | undefined = "Search carefully. Do not write files.";
  let agentLookupFailure = false;
  const context = {
    agent: { get: async ({ agentID }: { agentID: string }) => {
      if (agentLookupFailure) throw new Error("Agent lookup failed");
      return { data: { id: agentID, system: configuredSystem } };
    } },
    event: { subscribe: ({ signal }: { signal: AbortSignal }) => {
      const queue = new AsyncEventQueue<any>(); subscriptions.push(queue);
      signal.addEventListener("abort", () => queue.close(), { once: true });
      return { async *[Symbol.asyncIterator]() {
        while (true) {
          const next = await queue.next(); if (next.done) return;
          yield next.value;
          processedEvents.add(next.value.id);
        }
      } };
    } },
    location: { directory: root },
    options: {},
    integration: {
      connection: {
        active: async () => marker ? { id: "local-marker" } : undefined,
        resolve: async () => marker,
      },
      connect: { key: async (input: any) => { savedMarkers.push(input); marker = { type: "key", key: input.key }; } },
      transform: async (callback: (editor: any) => void) => {
        callback({
          update: () => undefined,
          method: { update: (input: any) => methods.push(input) },
        });
        return { dispose: async () => undefined };
      },
    },
    provider: {
      reload: async () => { providerTransform?.({ add: (input: any) => providers.push(input) }); },
      transform: async (callback: (editor: any) => void) => {
        providerTransform = callback;
        callback({ add: (input: any) => providers.push(input) });
        return { dispose: async () => undefined };
      },
    },
    session: {
      switchModel: async (input: any) => { hostModelUpdates.push(input); hostModels.set(input.sessionID, input.model); },
      context: async () => { throw new Error("ACP must not read host compaction checkpoints"); },
      hook: async (name: string, callback: (event: any) => Promise<void>, options?: unknown) => {
        hooks.set(name, { callback, options });
        return { dispose: async () => hooks.delete(name) };
      },
      get: async ({ sessionID }: { sessionID: string }) => ({
        location: { directory: sessionDirectories.get(sessionID) ?? sessionDirectory },
        model: hostModels.get(sessionID),
      }),
    },
  };

  const cleanup = await (AntigravityPlugin as any).setup(context);
  cleanupTasks.push(cleanup);
  expect(PLUGIN_ID).toBe("opencode-antigravity");
  expect(INTEGRATION_ID).toBe(PROVIDER_ID);
  expect(savedMarkers).toEqual([{ integrationID: PROVIDER_ID, key: LOCAL_API_KEY }]);
  expect(typeof cleanup).toBe("function");

  const provider = providers[0];
  expect(provider.info).toMatchObject({
    id: PROVIDER_ID,
    name: "Antigravity",
    activation: "enabled",
    integrationID: INTEGRATION_ID,
    package: "@opencode/ai/providers/anthropic",
    settings: { baseURL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/v1$/), apiKey: LOCAL_API_KEY },
  });
  const flash = provider.models.find((model: { id: string }) => model.id === "gemini-3.8-flash");
  expect(flash.variants.map((variant: { id: string }) => variant.id)).toEqual(["high", "medium", "low"]);
  expect(flash.capabilities.tools).toBe(true);
  expect(flash.limit).toEqual({ context: 1_048_576, output: 65_536 });

  expect(methods.some((method) => method.integrationID === PROVIDER_ID && method.method.type === "key")).toBe(true);

  for (const kind of ["context", "compaction", "generate", "title"]) {
    const hook = hooks.get(kind)!;
    expect(hook.options).toEqual({ providerID: PROVIDER_ID });
    const request = { options: { temperature: 0.5, reasoningEffort: "high", maxTokens: 1024 } };
    await hook.callback(request);
    expect(request.options).toEqual({ maxTokens: 1024 });
  }

  const modelRequest = hooks.get("model.request")!;
  const retry = hooks.get("retry")!;
  const retryEvent = { error: { type: "rate-limit", message: "rate limit; retry in 2 minutes" }, decision: { retry: true, delay: 10 } };
  await retry.callback(retryEvent);
  expect(retryEvent.decision.delay).toBe(120_000);
  const rejectedRetry = { ...retryEvent, decision: { retry: false } };
  await retry.callback(rejectedRetry);
  expect(rejectedRetry.decision).toEqual({ retry: false });
  const closedPoolRetry = { error: { type: "api-error", message: "The Antigravity session pool has been shut down" }, decision: { retry: true, delay: 10 } };
  await retry.callback(closedPoolRetry);
  expect(closedPoolRetry.decision).toEqual({ retry: false });
  expect(modelRequest.options).toEqual({ providerID: PROVIDER_ID });
  const event = {
    sessionID: "session-v2",
    agent: "build",
    model: { providerID: PROVIDER_ID, id: "gemini-3.8-flash", variant: "high" },
    kind: "primary",
    baseURL: "http://old.invalid/v1",
    headers: { Authorization: "must-not-forward", authorization: "must-not-forward" },
  };
  await modelRequest.callback(event);
  expect(event.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  expect(event.headers["x-api-key"]).toBe(LOCAL_API_KEY);
  expect(event.headers[MODEL_HEADER]).toBe("gemini-3.8-flash");
  expect(event.headers[EFFORT_HEADER]).toBe("high");
  expect(event.headers[DIRECTORY_HEADER]).toBe(sessionDirectory);
  expect(event.headers[SESSION_HEADER]).toBe("session-v2");
  expect(event.headers[REQUEST_KIND_HEADER]).toBe("chat");
  expect(event.headers).not.toHaveProperty("Authorization");
  expect(event.headers).not.toHaveProperty("authorization");
  expect(event.headers).not.toHaveProperty(MESSAGE_HEADER);

  const httpRequest = hooks.get("http.request")!;
  expect(httpRequest.options).toEqual({ providerID: PROVIDER_ID });
  const sendPure = async (sessionID: string, messages: unknown[]) => {
    const routed = { ...event, sessionID, headers: {} };
    await modelRequest.callback(routed);
    const outgoing = { ...routed, request: new Request(routed.baseURL + "/messages", {
      method: "POST", headers: { ...routed.headers, "content-type": "application/json" },
      body: JSON.stringify({ model: "gemini-3.8-flash", system: "GENERATED_SKILLS_AGENTS_ENV", messages, tools: [] }),
    }) };
    await httpRequest.callback(outgoing);
    const response = await fetch(outgoing.request);
    expect(response.status).toBe(200);
    return response.json();
  };
  const intro = "You are a subagent spawned by another session.\nFirst task";
  const pureMessages = [{ role: "user", content: intro }];
  const firstPure = await sendPure("pure-system", pureMessages);
  const promptLog = async () => (await readFile(process.env.FAKE_ACP_PROMPT_LOG!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect((await promptLog()).at(-1).prompt).toEqual([
    { type: "text", text: "<instruction>\nSearch carefully. Do not write files.\n</instruction>" },
    { type: "text", text: intro },
  ]);
  const binding = async (id: string) => (await sessionStore.entries()).find(([, record]) => record.conversation?.hostSessionID === id)![1];
  const beforeContinue = await binding("pure-system");
  const continuation = [...pureMessages, { role: "assistant", content: firstPure.content }, { role: "user", content: "Continue the task" }];
  await sendPure("pure-system", continuation);
  expect((await promptLog()).at(-1).prompt).toEqual([
    { type: "text", text: "<instruction>\nSearch carefully. Do not write files.\n</instruction>" },
    { type: "text", text: "Continue the task" },
  ]);
  expect((await binding("pure-system")).sessionId).toBe(beforeContinue.sessionId);
  for (const [index, system] of ["", " \n\t", undefined].entries()) {
    configuredSystem = system;
    await sendPure(`empty-system-${index}`, pureMessages);
    expect((await promptLog()).at(-1).prompt).toEqual([{ type: "text", text: intro }]);
  }
  // Clearing a configured system must retire the remote instructions as well.
  await sendPure("pure-system", [...continuation, { role: "user", content: "Continue without instructions" }]);
  expect((await binding("pure-system")).sessionId).not.toBe(beforeContinue.sessionId);
  expect(JSON.stringify((await promptLog()).at(-1).prompt)).not.toContain("Search carefully");
  expect(JSON.stringify((await promptLog()).at(-1).prompt)).not.toContain("GENERATED_SKILLS");
  agentLookupFailure = true;
  const lookupRequest = { ...event, request: new Request("http://localhost/messages", { method: "POST", body: "{}" }) };
  await expect(httpRequest.callback(lookupRequest)).rejects.toThrow("Agent lookup failed");
  agentLookupFailure = false;

  const rpcLog = (await readFile(process.env.FAKE_ACP_RPC_LOG!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const initialize = rpcLog.filter(rpc => rpc.method === "initialize");
  expect(initialize.length).toBeGreaterThan(0);
  for (const rpc of initialize) expect(rpc.params).toEqual({ protocolVersion: 1, clientCapabilities: {} });

  const titleEvent = { ...event, kind: "title", headers: {} };
  await modelRequest.callback(titleEvent);
  expect(titleEvent.headers[REQUEST_KIND_HEADER]).toBe("title");
  const compactionEvent = { ...event, kind: "compaction", headers: {} };
  await modelRequest.callback(compactionEvent);
  expect(compactionEvent.headers[REQUEST_KIND_HEADER]).toBe("compaction");
  const generateEvent = { ...event, kind: "generate", headers: {} };
  await modelRequest.callback(generateEvent);
  expect(generateEvent.headers[REQUEST_KIND_HEADER]).toBe("generate");
  const defaultVariantEvent = { ...event, model: { ...event.model, variant: "default" }, headers: {} };
  await modelRequest.callback(defaultVariantEvent);
  expect(defaultVariantEvent.headers).not.toHaveProperty(EFFORT_HEADER);

  sessionDirectories.set("concurrent-session-a", concurrentDirectory);
  sessionDirectories.set("concurrent-session-b", concurrentDirectory);
  await Promise.all(["concurrent-session-a", "concurrent-session-b"].map((sessionID) =>
    modelRequest.callback({ ...event, sessionID, headers: {} }),
  ));

  const waitEvent = async (id: string) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (processedEvents.has(id)) return;
      await Bun.sleep(10);
    }
    throw new Error(`Lifecycle subscriber did not process ${id}`);
  };
  const committed = { id: "evt_deduplication_commit", type: "session.compaction.ended", data: { sessionID: "deduplication-host" } };
  const failed = { id: "evt_deduplication_old_failure", type: "session.compaction.failed", data: { sessionID: "deduplication-host" } };
  subscriptions[0].push(failed);
  subscriptions[0].push(committed);
  await waitEvent(committed.id);
  const toolEvent = { ...event, sessionID: "deduplication-host", headers: {} };
  await modelRequest.callback(toolEvent);
  const toolMessages: any[] = [{ role: "user", content: "FAKE_MCP_PERMISSION DUPLICATE_EVENT_NEW_WORK" }];
  const tools = [{ name: "shell", input_schema: { type: "object", properties: { index: { type: "integer" } } } }];
  const sendTools = () => fetch(toolEvent.baseURL + "/messages", { method: "POST", headers: { ...toolEvent.headers, "content-type": "application/json" }, body: JSON.stringify({ model: "gemini-3.8-flash", messages: toolMessages, tools }) });
  const parked = await (await sendTools()).json();
  expect(parked.stop_reason).toBe("tool_use");
  const toolRpcLog = (await readFile(process.env.FAKE_ACP_RPC_LOG!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const toolSession = toolRpcLog.find(rpc => rpc.method === "session/new" && rpc.params.mcpServers.length);
  expect(toolSession.params.mcpServers[0].name).toBe("external_tool");
  const call = parked.content.find((part: any) => part.type === "tool_use");
  const parkedBinding = (await sessionStore.entries()).find(([, record]) => record.conversation?.hostSessionID === "deduplication-host")!;
  subscriptions[0].push({ id: "evt_compaction_started", type: "session.compaction.started", data: { sessionID: "deduplication-host" } });
  subscriptions[0].push(committed);
  subscriptions[0].push(failed);
  subscriptions[0].push({ id: "evt_deduplication_barrier", type: "session.compaction.ended", data: { sessionID: "deduplication-barrier" } });
  await waitEvent("evt_deduplication_barrier");
  expect(await sessionStore.get(parkedBinding[0])).toEqual(parkedBinding[1]);
  toolMessages.push({ role: "assistant", content: parked.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "NEW_WORK_RESULT_PRESERVED" }] });
  const continued = await (await sendTools()).json();
  expect(continued.stop_reason).toBe("end_turn");
  expect(JSON.stringify(continued)).toContain("NEW_WORK_RESULT_PRESERVED");
  expect((await sessionStore.get(parkedBinding[0]))!.sessionId).toBe(parkedBinding[1].sessionId);
  const submitted = (await readFile(process.env.FAKE_ACP_PROMPT_LOG!, "utf8")).trim().split("\n").map(line => JSON.parse(line)).filter(entry => entry.text.includes("DUPLICATE_EVENT_NEW_WORK"));
  expect(submitted).toHaveLength(1);

  const fallbackEvent = { ...event, sessionID: "fallback-selection", model: { ...event.model, variant: "default" }, headers: {} };
  await modelRequest.callback(fallbackEvent);
  hostModels.set("fallback-selection", { providerID: PROVIDER_ID, id: "gemini-3.8-flash", variant: "medium" });
  expect((await fetch(fallbackEvent.baseURL + "/messages", { method: "POST", headers: { ...fallbackEvent.headers, "content-type": "application/json" }, body: JSON.stringify({ model: "gemini-3.8-flash", messages: [{ role: "user", content: "FAKE_FALLBACK_AVAILABLE" }] }) })).status).toBe(200);
  expect(await sessionStore.contextSnapshot("fallback-selection")).toMatchObject({ requestedModel: "gemini-3.8-flash-high", model: "gemini-3.8-flash-low" });
  expect(hostModelUpdates).toHaveLength(0);
  expect(hostModels.get("fallback-selection").variant).toBe("medium");

  const terminalEvent = { ...event, sessionID: "terminal-accepted", headers: {} };
  await modelRequest.callback(terminalEvent);
  const terminal = await (await fetch(terminalEvent.baseURL + "/messages", {
    method: "POST", headers: { ...terminalEvent.headers, "content-type": "application/json" },
    body: JSON.stringify({ model: "gemini-3.8-flash", messages: [{ role: "user", content: "FAKE_MCP" }], tools: [{ name: "StructuredOutput", input_schema: { type: "object" } }] }),
  })).json();
  expect(terminal.stop_reason).toBe("tool_use");
  const [terminalKey] = (await sessionStore.entries()).find(([, record]) => record.conversation?.hostSessionID === "terminal-accepted")!;
  const { sessionPool } = await import("../src/session-pool.js");
  expect((await sessionPool.status(terminalKey)).active).toBe(true);
  subscriptions[0].push({ id: "evt_terminal_accepted", type: "session.tool.success", data: { sessionID: "terminal-accepted", id: terminal.content[0].id, assistantMessageID: "msg_terminal_a", content: [{ type: "text", text: "host validated" }], executed: true } });
  subscriptions[0].push({ id: "evt_terminal_barrier", type: "session.compaction.ended", data: { sessionID: "terminal-barrier" } });
  await waitEvent("evt_terminal_barrier");
  expect((await sessionPool.status(terminalKey)).active).toBe(true);
  expect((await sessionStore.toolCall(terminalKey, terminal.content[0].id))?.result).toBeUndefined();
  const afterTerminal = await (await fetch(terminalEvent.baseURL + "/messages", {
    method: "POST", headers: { ...terminalEvent.headers, "content-type": "application/json" },
    body: JSON.stringify({ model: "gemini-3.8-flash", messages: [{ role: "user", content: "FAKE_MCP" }, { role: "assistant", content: terminal.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: terminal.content[0].id, content: "ORIGINAL_HOST_STRUCTURED_RESULT" }, { type: "text", text: "continue after accepted output" }] }], tools: [{ name: "StructuredOutput", input_schema: { type: "object" } }] }),
  })).json();
  expect(afterTerminal.stop_reason).toBe("end_turn");
  expect(afterTerminal.content.some((p: any) => p.type === "tool_use")).toBe(false);
  expect(JSON.stringify(afterTerminal)).toContain("ORIGINAL_HOST_STRUCTURED_RESULT");
  expect((await sessionStore.toolCall(terminalKey, terminal.content[0].id))?.delivery).toBe("locally-handed-off");

  const terminalB = await (await fetch(terminalEvent.baseURL + "/messages", {
    method: "POST", headers: { ...terminalEvent.headers, "content-type": "application/json" },
    body: JSON.stringify({ model: "gemini-3.8-flash", messages: [{ role: "user", content: "FAKE_MCP TERMINAL_B" }], tools: [{ name: "StructuredOutput", input_schema: { type: "object" } }] }),
  })).json();
  expect(terminalB.stop_reason).toBe("tool_use");
  subscriptions[0].push({ id: "evt_delayed_execution_a", type: "session.execution.succeeded", data: { sessionID: "terminal-accepted" } });
  subscriptions[0].push({ id: "evt_duplicate_tool_a", type: "session.tool.success", data: { sessionID: "terminal-accepted", id: terminal.content[0].id } });
  subscriptions[0].push({ id: "evt_delayed_barrier", type: "session.compaction.ended", data: { sessionID: "delayed-barrier" } });
  await waitEvent("evt_delayed_barrier");
  expect((await sessionPool.status(terminalKey)).active).toBe(true);
  expect((await sessionStore.toolCall(terminalKey, terminalB.content[0].id))?.result).toBeUndefined();

  subscriptions[0].close(new Error("synthetic unexpected lifecycle disconnect"));
  for (let i = 0; i < 200 && subscriptions.length < 2; i++) await Bun.sleep(10);
  expect(subscriptions.length).toBe(2);
  expect((await sessionPool.status(terminalKey)).active).toBe(false);
  expect((await sessionStore.get(terminalKey))?.conversation?.resumable).toBe(false);
  subscriptions[1].push({ id: "evt_missed_host_checkpoint", type: "session.compaction.ended", data: { sessionID: "deduplication-host" } });
  subscriptions[1].push({ id: "evt_reconnected_barrier", type: "session.compaction.ended", data: { sessionID: "reconnected-barrier" } });
  await waitEvent("evt_reconnected_barrier");
  subscriptions[1].push({ id: "evt_deleted_terminal", type: "session.deleted", data: { sessionID: "terminal-accepted" } });
  subscriptions[1].push({ id: "evt_deleted_barrier", type: "session.compaction.ended", data: { sessionID: "deleted-barrier" } });
  await waitEvent("evt_deleted_barrier");
  expect(await sessionStore.get(terminalKey)).toBeUndefined();
  expect(await sessionStore.toolCall(terminalKey, terminalB.content[0].id)).toBeUndefined();
  expect(await sessionStore.isHostDeleted("terminal-accepted")).toBe(true);
  const lateDeleted = await fetch(terminalEvent.baseURL + "/messages", { method: "POST", headers: { ...terminalEvent.headers, "content-type": "application/json" }, body: JSON.stringify({ model: "gemini-3.8-flash", messages: [{ role: "user", content: "late deleted request" }] }) });
  expect(lateDeleted.status).toBe(400);

  const runtime = getProxyRuntime()!;
  emitAcpCatalog(runtime.manager.scope, acpModelCatalog(fixture, "test", [["future-opaque", "Future model"]]));
  expect(providers.at(-1).models.map((model: any) => model.id)).toEqual(["future-opaque"]);
  expect(runtime.catalog.exactModels.map((model) => model.id)).toEqual(["future-opaque"]);

  // Two plugin instances acquire the same root. Each acquisition must release
  // at the proxy's single ownership layer, including identical workspace roots.
  const peerCleanup = await (AntigravityPlugin as any).setup(context);
  await Promise.all([cleanup(), cleanup()]);
  expect(getProxyPort()).not.toBeNull();
  await peerCleanup();
  cleanupTasks.pop();
  expect(getProxyPort()).toBeNull();

  // Reloading a location reuses the automatic local marker, not another account.
  const secondCleanup = await (AntigravityPlugin as any).setup(context);
  cleanupTasks.push(secondCleanup);
  expect(savedMarkers).toHaveLength(1);
});
