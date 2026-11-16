import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fixtureCompatibility } from "./fixtures/compatibility.js";
let compatibility: ReturnType<typeof fixtureCompatibility>;
beforeAll(() => { compatibility = fixtureCompatibility(); });
afterAll(() => { compatibility.mockRestore(); });
import { createAcpWorker, selectPermissionOption, type AcpWorkerOptions } from "../src/acp-process.js";
import { onAcpCatalog } from "../src/catalog-events.js";
import { HOST_MCP_SERVER_NAME } from "../src/constants.js";
import type { AcpModelCatalog } from "../src/models.js";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";

const fixture = join(import.meta.dir, "fixtures", "fake-acp.mjs");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const EXACT_15 = ["gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low", "fake-model-low"];

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) { /* drain */ }
}

const REGISTERED_MCP: NonNullable<AcpWorkerOptions["mcpServers"]> = [
  { type: "http", name: HOST_MCP_SERVER_NAME, url: "http://127.0.0.1:9/mcp", headers: [] },
];

async function toolPermissionText(environment: Record<string, string>, options: Partial<AcpWorkerOptions> = {}): Promise<string> {
  await chmod(fixture, 0o755);
  const worker = await createAcpWorker({
    cwd: process.cwd(), executable: fixture, executableArgs: [], model: "fake-model-low", stallTimeoutMs: 10_000,
    mcpServers: REGISTERED_MCP, mcpToolNames: ["read_file"], environment, ...options,
  });
  let text = "";
  try {
    for await (const event of worker.runTurn("FAKE_TOOL_PERMISSION")) {
      if (event.event === "update" && event.update.sessionUpdate === "agent_message_chunk" && event.update.content.type === "text") {
        text += event.update.content.text;
      }
    }
  } finally { await worker.stop(true); }
  return text;
}

describe("ACP process manager", () => {
  test("runs two serialized turns through one persistent worker", async () => {
    await chmod(fixture, 0o755);
    const worker = await createAcpWorker({ cwd: process.cwd(), executable: fixture, executableArgs: [], model: "fake-model-low", stallTimeoutMs: 10_000 });
    const responses: string[] = [];
    try {
      for await (const event of worker.runTurn("remember FAKE_MEMORY")) {
        if (event.event === "update" && (event.update as { sessionUpdate?: string }).sessionUpdate === "agent_message_chunk") {
          const content = (event.update as { content?: { text?: string } }).content;
          if (content?.text) responses.push(content.text);
        }
      }
      for await (const event of worker.runTurn("what did you remember")) {
        if (event.event === "update" && (event.update as { sessionUpdate?: string }).sessionUpdate === "agent_message_chunk") {
          const content = (event.update as { content?: { text?: string } }).content;
          if (content?.text) responses.push(content.text);
        }
      }
    } finally {
      await worker.stop(true);
    }
    expect(responses.join("")).toContain("FAKE_MEMORY");
    expect(worker.state).toBe("closed");
  });

  test("cancels a stalled turn and closes the process", async () => {
    await chmod(fixture, 0o755);
    const worker = await createAcpWorker({ cwd: process.cwd(), executable: fixture, executableArgs: [], model: "fake-model-low", stallTimeoutMs: 30_000 });
    const controller = new AbortController();
    const turn = (async () => {
      for await (const _event of worker.runTurn("FAKE_HANG", controller.signal)) {
        // The fixture intentionally emits no result.
      }
    })();
    setTimeout(() => controller.abort(), 25).unref?.();
    await expect(turn).rejects.toThrow(/cancel/i);
    expect(worker.state).toBe("closed");
  });

  test("keeps a turn alive while ACP updates continue past the setup timeout", async () => {
    await chmod(fixture, 0o755);
    let activityCount = 0;
    const worker = await createAcpWorker({
      cwd: process.cwd(),
      executable: fixture, executableArgs: [],
      model: "fake-model-low",
      printTimeoutMs: 5_000,
      stallTimeoutMs: 500,
      onActivity: () => { activityCount += 1; },
    });
    let response = "";
    try {
      // Setup RPCs use printTimeoutMs. A streamed turn must use the idle
      // watchdog instead, so make the distinction visible without waiting
      // five minutes for this test.
      worker.options.printTimeoutMs = 50;
      for await (const event of worker.runTurn("FAKE_SLOW_STREAM")) {
        if (event.event === "update" && event.update.sessionUpdate === "agent_message_chunk" && event.update.content.type === "text") {
          response += event.update.content.text;
        }
      }
    } finally {
      await worker.stop(true);
    }
    expect(response).toContain("FAKE_SLOW_STREAM_OK");
    expect(activityCount).toBeGreaterThan(0);
    expect(worker.state).toBe("closed");
  });

  test("times out a turn only after the ACP stream goes quiet", async () => {
    await chmod(fixture, 0o755);
    let activityCount = 0;
    const worker = await createAcpWorker({
      cwd: process.cwd(),
      executable: fixture, executableArgs: [],
      model: "fake-model-low",
      printTimeoutMs: 5_000,
      stallTimeoutMs: 60,
      onActivity: () => { activityCount += 1; },
    });
    const turn = (async () => {
      for await (const _event of worker.runTurn("FAKE_HANG")) {
        // The fixture intentionally emits no update or result.
      }
    })();
    await expect(turn).rejects.toThrow(/without receiving an ACP stream update/i);
    expect(activityCount).toBe(0);
    expect(worker.state).toBe("closed");
  });

  test("stops an idle worker even when the consumer is paused after an update", async () => {
    await chmod(fixture, 0o755);
    const worker = await createAcpWorker({
      cwd: process.cwd(),
      executable: fixture, executableArgs: [],
      model: "fake-model-low",
      printTimeoutMs: 5_000,
      stallTimeoutMs: 60,
    });
    const iterator = worker.runTurn("FAKE_PAUSE_STREAM")[Symbol.asyncIterator]();
    try {
      const first = await iterator.next();
      expect(first.done).toBe(false);
      await sleep(700);
      expect(worker.state).toBe("closed");
    } finally {
      await iterator.return?.();
      await worker.stop(true);
    }
  });

  test("does not time out after the ACP result has already arrived", async () => {
    await chmod(fixture, 0o755);
    const worker = await createAcpWorker({
      cwd: process.cwd(),
      executable: fixture, executableArgs: [],
      model: "fake-model-low",
      printTimeoutMs: 5_000,
      stallTimeoutMs: 60,
    });
    const iterator = worker.runTurn("FAKE_STREAM")[Symbol.asyncIterator]();
    try {
      await iterator.next();
      await sleep(150);
      expect(worker.state).not.toBe("closed");
      while (!(await iterator.next()).done) {
        // Drain the queued ACP events and terminal result.
      }
    } finally {
      await iterator.return?.();
      await worker.stop(true);
    }
  });

  test("rejects native tool permission requests", async () => {
    await chmod(fixture, 0o755);
    const worker = await createAcpWorker({ cwd: process.cwd(), executable: fixture, executableArgs: [], model: "fake-model-low" });
    let sawTool = false;
    let stopReason: string | undefined;
    try {
      for await (const event of worker.runTurn("FAKE_PERMISSION")) {
        if (event.event === "update" && (event.update as { sessionUpdate?: string }).sessionUpdate === "tool_call") sawTool = true;
        if (event.event === "result") stopReason = event.result.stopReason;
      }
    } finally {
      await worker.stop(true);
    }
    expect(sawTool).toBe(false);
    expect(stopReason).toBe("cancelled");
  });

  test("allows an exactly registered host MCP tool announced by the same session", async () => {
    expect(await toolPermissionText({ FAKE_ACP_PERMISSION_CASE: "allow" })).toContain("PERMISSION:allow");
  });

  for (const permissionCase of [
    "no-notification",
    "unseen-call-id",
    "unknown-name",
    "suffix-name",
    "other-server",
    "native-tool",
    "title-only",
    "no-allow-once",
    "wrong-session-notification",
    "wrong-session-request",
  ]) {
    test(`denies a permission request that is not an exact seen host MCP call (${permissionCase})`, async () => {
      expect(await toolPermissionText({ FAKE_ACP_PERMISSION_CASE: permissionCase })).toContain("PERMISSION:deny");
    });
  }

  test("denies every MCP permission request without a registered tool list", async () => {
    expect(await toolPermissionText({ FAKE_ACP_PERMISSION_CASE: "allow" }, { mcpToolNames: undefined })).toContain("PERMISSION:deny");
  });

  test("denies a machine-matched tool when HOST_MCP_SERVER_NAME is not registered", async () => {
    const text = await toolPermissionText({ FAKE_ACP_PERMISSION_CASE: "allow" }, {
      mcpServers: [{ type: "http", name: "other-server", url: "http://127.0.0.1:9/mcp", headers: [] }],
    });
    expect(text).toContain("PERMISSION:deny");
  });

  test("does not reuse tool calls seen during a failed session load", async () => {
    const text = await toolPermissionText(
      { FAKE_ACP_LOAD_MODE: "missing", FAKE_ACP_LOAD_SEEN: "1", FAKE_ACP_PERMISSION_CASE: "reuse-old-seen" },
      { sessionId: "agy-stale-session" },
    );
    expect(text).toContain("PERMISSION:deny");
  });

  test("a permission request without a tool call id is never allowed", () => {
    const params = {
      sessionId: "session-1",
      toolCall: { toolCallId: undefined, title: "Read host file" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    } as unknown as RequestPermissionRequest;
    expect(selectPermissionOption(params, {
      sessionId: "session-1",
      seenToolCalls: new Map([["call-1", `mcp_${HOST_MCP_SERVER_NAME}_read_file`]]),
      toolNames: ["read_file"],
      serverRegistered: true,
    })).toBe("deny");
  });

  test("session creation carries no PAR tool metadata and leaves instructions outside _meta", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "agy-session-meta-"));
    const rpcLog = join(root, "rpc.jsonl");
    const worker = await createAcpWorker({
      cwd: process.cwd(), executable: fixture, executableArgs: [], model: "fake-model-low",
      environment: { FAKE_ACP_RPC_LOG: rpcLog },
    });
    try {
      const rpcs = (await readFile(rpcLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      const created = rpcs.find((rpc) => rpc.method === "session/new");
      expect(created.params._meta).toBeUndefined();
      expect(created.params.mcpServers).toEqual([]);
    } finally {
      await worker.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("never sends authenticate even with an explicit OAuth method", async () => {
    await chmod(fixture, 0o755);
    const worker = await createAcpWorker({ cwd: process.cwd(), executable: fixture, executableArgs: [], environment: { OPENCODE_ANTIGRAVITY_ACP_AUTH_METHOD: "oauth-personal", FAKE_ACP_REJECT_AUTHENTICATE: "1" } });
    expect(worker.init?.authMethods?.[0]?.id).toBe("oauth-personal");
    await worker.stop(true);
  });

  test("authentication required does not trigger an interactive retry", async () => {
    await expect(createAcpWorker({ cwd: process.cwd(), executable: fixture, executableArgs: [],
      environment: { FAKE_ACP_REQUIRE_AUTH: "1", FAKE_ACP_REJECT_AUTHENTICATE: "1" } })).rejects.toThrow("Sign in through the agy CLI");
  });

  test("reports an ACP server exit before a result as a process failure", async () => {
    await chmod(fixture, 0o755);
    const worker = await createAcpWorker({ cwd: process.cwd(), executable: fixture, executableArgs: [], model: "fake-model-low", stallTimeoutMs: 10_000 });
    const turn = (async () => {
      for await (const _event of worker.runTurn("FAKE_EXIT")) {
        // The fixture exits before emitting a result.
      }
    })();
    await expect(turn).rejects.toThrow(/ACP|ended/i);
    expect(worker.state).toBe("closed");
  });

  test("1.5 keeps every exact sibling while grouped setters only move selection", async () => {
    await chmod(fixture, 0o755);
    const events: Array<AcpModelCatalog | undefined> = [];
    const unlisten = onAcpCatalog((scope, catalog) => { if (scope === "model15") events.push(catalog); });
    const root = await mkdtemp(join(tmpdir(), "agy-model15-"));
    const rpcLog = join(root, "rpc.jsonl");
    const worker = await createAcpWorker({
      cwd: process.cwd(), executable: fixture, executableArgs: [], model: "gemini-3.8-flash-low",
      environment: { FAKE_ACP_MODEL_1_5: "1", FAKE_ACP_RPC_LOG: rpcLog }, catalogScope: "model15",
    });
    try {
      expect(worker.catalog?.exactModels.map((model) => model.id)).toEqual(EXACT_15);
      expect(worker.catalog?.models.map((model) => model.id)).toContain("gemini-3.8-flash");
      // A family read-back is not an exact executed model.
      expect(worker.actualModel).toBeUndefined();
      const discoveredAt = worker.catalog!.discoveredAt;
      await drain(worker.runTurn("FAKE_MODEL15_ECHO"));
      expect(worker.catalog!.exactModels.map((model) => model.id)).toEqual(EXACT_15);
      expect(worker.catalog!.discoveredAt).toBe(discoveredAt);
      expect(events.filter(Boolean)).toHaveLength(1);
      const setters = (await readFile(rpcLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
        .filter((rpc) => rpc.method === "session/set_config_option");
      // The concrete wire ID is sent; selection notifications never replace the directory.
      expect(setters.map((rpc) => rpc.params.value)).toEqual(["gemini-3.8-flash-low"]);
    } finally {
      unlisten();
      await worker.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a changed grouped choice set forces exactly one full refresh and invents no IDs", async () => {
    await chmod(fixture, 0o755);
    const events: Array<AcpModelCatalog | undefined> = [];
    const unlisten = onAcpCatalog((scope, catalog) => { if (scope === "model15b") events.push(catalog); });
    const worker = await createAcpWorker({
      cwd: process.cwd(), executable: fixture, executableArgs: [], model: "gemini-3.8-flash-low",
      environment: { FAKE_ACP_MODEL_1_5: "1" }, catalogScope: "model15b",
    });
    try {
      await drain(worker.runTurn("FAKE_MODEL15_NEW_CHOICES"));
      await drain(worker.runTurn("FAKE_MODEL15_NEW_CHOICES"));
      expect(events.filter((catalog) => catalog === undefined)).toHaveLength(1);
      expect(worker.catalog?.exactModels.some((model) => model.id === "future-family")).toBe(false);
      expect(worker.catalog?.exactModels.map((model) => model.id)).toEqual(EXACT_15);
    } finally { unlisten(); await worker.stop(true); }
  });

  test("an empty model picker clears while a selector-less update changes nothing", async () => {
    await chmod(fixture, 0o755);
    const events: Array<AcpModelCatalog | undefined> = [];
    const unlisten = onAcpCatalog((scope, catalog) => { if (scope === "model15c") events.push(catalog); });
    const worker = await createAcpWorker({
      cwd: process.cwd(), executable: fixture, executableArgs: [], model: "gemini-3.8-flash-low",
      environment: { FAKE_ACP_MODEL_1_5: "1" }, catalogScope: "model15c",
    });
    try {
      await drain(worker.runTurn("FAKE_MODEL15_NO_SELECTOR"));
      expect(worker.catalog?.exactModels.map((model) => model.id)).toEqual(EXACT_15);
      await drain(worker.runTurn("FAKE_MODEL15_CLEAR"));
      expect(worker.catalog?.exactModels).toEqual([]);
      // A later non-empty unknown grouped set still needs a full snapshot.
      await drain(worker.runTurn("FAKE_MODEL15_NEW_CHOICES"));
      expect(events.filter((catalog) => catalog === undefined)).toHaveLength(1);
    } finally { unlisten(); await worker.stop(true); }
  });

  test("pre-1.5 config-only catalogs still add, delete, and clear exact wire IDs", async () => {
    await chmod(fixture, 0o755);
    const worker = await createAcpWorker({ cwd: process.cwd(), executable: fixture, executableArgs: [], model: "fake-model-low", catalogScope: "model-legacy" });
    try {
      expect(worker.catalog?.exactModels.map((model) => model.id)).toEqual(EXACT_15);
      await drain(worker.runTurn("FAKE_CATALOG_UPDATE"));
      expect(worker.catalog?.exactModels.map((model) => model.id)).toEqual(["new-server-model"]);
      await drain(worker.runTurn("FAKE_CATALOG_CLEAR"));
      expect(worker.catalog?.exactModels).toEqual([]);
    } finally { await worker.stop(true); }
  });

  test("effort uses the picker introduced by the model switch and fails closed on real contradictions", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "agy-model15-effort-"));
    const rpcLog = join(root, "rpc.jsonl");
    // Startup has no thinking-level picker; only the model switch to the
    // grouped family introduces one, so using startup options cannot work.
    const worker = await createAcpWorker({
      cwd: process.cwd(), executable: fixture, executableArgs: [], model: "gemini-3.8-flash-high", effort: "low",
      environment: { FAKE_ACP_MODEL_1_5: "1", FAKE_ACP_MODEL_1_5_START_PLAIN: "1", FAKE_ACP_RPC_LOG: rpcLog },
      catalogScope: "model15-effort",
    });
    try {
      const setters = (await readFile(rpcLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
        .filter((rpc) => rpc.method === "session/set_config_option");
      expect(setters.map((rpc) => `${rpc.params.configId}:${rpc.params.value}`)).toEqual(["model:gemini-3.8-flash-high", "thinking_level:low"]);
    } finally { await worker.stop(true); await rm(root, { recursive: true, force: true }); }

    const encodedRoot = await mkdtemp(join(tmpdir(), "agy-model15-encoded-"));
    const encodedLog = join(encodedRoot, "rpc.jsonl");
    const encoded = await createAcpWorker({
      cwd: process.cwd(), executable: fixture, executableArgs: [], model: "gemini-3.8-flash-low", effort: "low",
      environment: { FAKE_ACP_MODEL_1_5: "1", FAKE_ACP_RPC_LOG: encodedLog }, catalogScope: "model15-encoded",
    });
    try {
      const setters = (await readFile(encodedLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
        .filter((rpc) => rpc.method === "session/set_config_option");
      expect(setters.map((rpc) => rpc.params.configId)).toEqual(["model"]);
    } finally { await encoded.stop(true); await rm(encodedRoot, { recursive: true, force: true }); }

    await expect(createAcpWorker({
      cwd: process.cwd(), executable: fixture, executableArgs: [], model: "gemini-3.8-flash-low",
      environment: { FAKE_ACP_MODEL_1_5: "1", FAKE_ACP_MODEL_1_5_MISMATCH: "1" },
    })).rejects.toMatchObject({ code: "agy_acp_model_mismatch" });

    await expect(createAcpWorker({
      cwd: process.cwd(), executable: fixture, executableArgs: [], model: "gemini-3.8-flash-high", effort: "low",
      environment: { FAKE_ACP_MODEL_1_5: "1", FAKE_ACP_MODEL_1_5_EFFORT_MISMATCH: "1" },
    })).rejects.toMatchObject({ code: "agy_acp_effort_mismatch" });

    // Encoded effort skips its setter but the model response's level still
    // contradicts the requested one.
    await expect(createAcpWorker({
      cwd: process.cwd(), executable: fixture, executableArgs: [], model: "gemini-3.8-flash-low", effort: "low",
      environment: { FAKE_ACP_MODEL_1_5: "1", FAKE_ACP_MODEL_1_5_LEVEL_HIGH: "1" },
    })).rejects.toMatchObject({ code: "agy_acp_effort_mismatch" });

    // An empty setter response is no evidence; the stale startup picker must
    // not be read back as a false mismatch.
    const emptyRoot = await mkdtemp(join(tmpdir(), "agy-model15-empty-"));
    const emptyLog = join(emptyRoot, "rpc.jsonl");
    const empty = await createAcpWorker({
      cwd: process.cwd(), executable: fixture, executableArgs: [], model: "gemini-3.8-flash-high", effort: "low",
      environment: { FAKE_ACP_MODEL_1_5: "1", FAKE_ACP_MODEL_1_5_EMPTY_SETTER: "1", FAKE_ACP_RPC_LOG: emptyLog },
      catalogScope: "model15-empty",
    });
    try {
      expect(empty.actualModel).toBeUndefined();
      const setters = (await readFile(emptyLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
        .filter((rpc) => rpc.method === "session/set_config_option");
      expect(setters.map((rpc) => rpc.params.configId)).toEqual(["model", "thinking_level"]);
    } finally { await empty.stop(true); await rm(emptyRoot, { recursive: true, force: true }); }

    // A fresh complete config without any effort picker cannot silently accept
    // an explicitly requested, non-encoded effort.
    await expect(createAcpWorker({
      cwd: process.cwd(), executable: fixture, executableArgs: [], model: "fake-model-low", effort: "high",
      environment: { FAKE_ACP_MODEL_1_5: "1" },
    })).rejects.toMatchObject({ code: "agy_acp_effort_unsupported" });
  });

  test("grouped choices A -> B -> A invalidate on each change and repeat emits nothing", async () => {
    await chmod(fixture, 0o755);
    const events: Array<AcpModelCatalog | undefined> = [];
    const unlisten = onAcpCatalog((scope, catalog) => { if (scope === "model15-aba") events.push(catalog); });
    const worker = await createAcpWorker({
      cwd: process.cwd(), executable: fixture, executableArgs: [], model: "gemini-3.8-flash-low",
      environment: { FAKE_ACP_MODEL_1_5: "1" }, catalogScope: "model15-aba",
    });
    try {
      await drain(worker.runTurn("FAKE_MODEL15_NEW_CHOICES"));
      await drain(worker.runTurn("FAKE_MODEL15_ECHO"));
      await drain(worker.runTurn("FAKE_MODEL15_ECHO"));
      expect(events.filter((catalog) => catalog === undefined)).toHaveLength(2);
      expect(events.filter(Boolean)).toHaveLength(1);
    } finally { unlisten(); await worker.stop(true); }
  });

  test("a startup notification cannot precede or replace the initial snapshot", async () => {
    await chmod(fixture, 0o755);
    const events: Array<AcpModelCatalog | undefined> = [];
    const unlisten = onAcpCatalog((scope, catalog) => { if (scope === "model15-start") events.push(catalog); });
    const worker = await createAcpWorker({
      cwd: process.cwd(), executable: fixture, executableArgs: [], model: "gemini-3.8-flash-low",
      environment: { FAKE_ACP_MODEL_1_5: "1", FAKE_ACP_MODEL_1_5_START_NOTIFICATION: "1" },
      catalogScope: "model15-start",
    });
    try {
      expect(events.filter((catalog) => catalog === undefined)).toHaveLength(0);
      expect(worker.catalog?.exactModels.map((model) => model.id)).toEqual(EXACT_15);
      expect(worker.catalog?.exactModels.some((model) => model.id === "future-family")).toBe(false);
    } finally { unlisten(); await worker.stop(true); }
  });

  test("opaque and xhigh wire IDs survive setters and selection notifications", async () => {
    await chmod(fixture, 0o755);
    const extras = ["opaque-wire-id", "gemini-3.8-flash-xhigh"];
    const worker = await createAcpWorker({
      cwd: process.cwd(), executable: fixture, executableArgs: [], model: "gemini-3.8-flash-low",
      environment: { FAKE_ACP_MODEL_1_5: "1", FAKE_ACP_MODEL_1_5_EXTRA: extras.join(",") },
      catalogScope: "model15-extra",
    });
    try {
      expect(worker.catalog?.exactModels.map((model) => model.id)).toEqual([...EXACT_15, ...extras]);
      await drain(worker.runTurn("FAKE_MODEL15_ECHO"));
      expect(worker.catalog?.exactModels.map((model) => model.id)).toEqual([...EXACT_15, ...extras]);
    } finally { await worker.stop(true); }
  });

  test("a config-only unknown ID never becomes exact; rediscovery gets the complete snapshot", async () => {
    await chmod(fixture, 0o755);
    const events: Array<AcpModelCatalog | undefined> = [];
    const unlisten = onAcpCatalog((scope, catalog) => { if (scope === "model15-exact") events.push(catalog); });
    const worker = await createAcpWorker({
      cwd: process.cwd(), executable: fixture, executableArgs: [], model: "gemini-3.8-flash-low",
      environment: { FAKE_ACP_MODEL_1_5: "1", FAKE_ACP_MODEL_1_5_EXACT_PICKER: "1" },
      catalogScope: "model15-exact",
    });
    try {
      expect(worker.catalog?.exactModels.map((model) => model.id)).toEqual(EXACT_15);
      await drain(worker.runTurn("FAKE_MODEL15_ADD_UNKNOWN"));
      expect(worker.catalog?.exactModels.map((model) => model.id)).toEqual(EXACT_15);
      expect(events.filter((catalog) => catalog === undefined)).toHaveLength(1);
    } finally { unlisten(); await worker.stop(true); }
  });

  test("an empty legacy snapshot drops an unknown currentModelId from actualModel", async () => {
    await chmod(fixture, 0o755);
    const worker = await createAcpWorker({
      cwd: process.cwd(), executable: fixture, executableArgs: [],
      environment: { FAKE_ACP_MODEL_1_5: "1", FAKE_ACP_MODEL_1_5_EMPTY_LEGACY: "1" },
      catalogScope: "model15-empty-legacy",
    });
    try {
      expect(worker.catalog?.exactModels).toEqual([]);
      expect(worker.actualModel).toBeUndefined();
    } finally { await worker.stop(true); }
  });

  test("the concrete descriptor's level is checked even without an effort request", async () => {
    await chmod(fixture, 0o755);
    await expect(createAcpWorker({
      cwd: process.cwd(), executable: fixture, executableArgs: [], model: "gemini-3.8-flash-low",
      environment: { FAKE_ACP_MODEL_1_5: "1", FAKE_ACP_MODEL_1_5_LEVEL_HIGH: "1" },
    })).rejects.toMatchObject({ code: "agy_acp_effort_mismatch" });
  });

  test("a same-level read-back of another advertised family is rejected", async () => {
    await chmod(fixture, 0o755);
    await expect(createAcpWorker({
      cwd: process.cwd(), executable: fixture, executableArgs: [], model: "gemini-3.8-flash-high",
      environment: { FAKE_ACP_MODEL_1_5: "1", FAKE_ACP_MODEL_1_5_OTHER_FAMILY: "1" },
    })).rejects.toMatchObject({ code: "agy_acp_model_mismatch" });
  });
});
