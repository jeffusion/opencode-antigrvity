import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fixtureCompatibility } from "./fixtures/compatibility.js";
let compatibility: ReturnType<typeof fixtureCompatibility>;
beforeAll(() => { compatibility = fixtureCompatibility(); });
afterAll(() => { compatibility.mockRestore(); });
import { SessionPool, type SessionTurnRequest } from "../src/session-pool.js";
import type { AcpEvent } from "../src/protocol.js";
import { HOST_MCP_SERVER_NAME } from "../src/constants.js";
import { sessionStore, sessionStoreDirectory } from "../src/session-store.js";

const fixture = join(import.meta.dir, "fixtures", "fake-acp.mjs");
const contexts = new Map<string, Array<{ role: string; content: string }>>();

async function turn(pool: SessionPool, key: string, prompt: string): Promise<string> {
  let response = "";
  const messages = [...(contexts.get(key) ?? []), { role: "user", content: prompt }];
  for await (const event of pool.turn({
    key,
    messages,
    prompt: [{ type: "text", text: prompt }],
    settings: { cwd: process.cwd(), model: "fake-model-low", executable: fixture },
  })) {
    if (event.event === "update" && event.update.sessionUpdate === "agent_message_chunk" && event.update.content.type === "text") response += event.update.content.text;
  }
  contexts.set(key, [...messages, { role: "assistant", content: response }]);
  return response;
}

const missingExecutable = join(import.meta.dir, "fixtures", "missing-acp");

async function isolatedPool(): Promise<{ pool: SessionPool; key: string }> {
  await chmod(fixture, 0o755);
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = await mkdtemp(join(tmpdir(), "opencode-antigravity-slices-"));
  delete process.env.FAKE_ACP_STATE_FILE;
  return { pool: new SessionPool({ idleMs: 60_000 }), key: "slice-session" };
}

function execution(key: string, text: string, options: { requestId?: string; receipt?: { id: string; digest: string }; executable?: string } = {}): SessionTurnRequest {
  return {
    key,
    ...(options.requestId ? { requestId: options.requestId } : {}),
    ...(options.receipt ? { receipt: options.receipt } : {}),
    messages: [{ role: "user", content: text }],
    prompt: [{ type: "text", text }],
    settings: { cwd: process.cwd(), model: "fake-model-low", executable: options.executable ?? fixture },
  };
}

async function collect(events: AsyncIterable<AcpEvent>): Promise<AcpEvent[]> {
  const collected: AcpEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

const REGISTERED_MCP_NOWHERE = [{ type: "http" as const, name: HOST_MCP_SERVER_NAME, url: "http://127.0.0.1:9/mcp", headers: [] }];

function bindingTurn(key: string, prompt: string, toolNames: string[] | undefined): SessionTurnRequest {
  return {
    key,
    prompt: [{ type: "text", text: prompt }],
    settings: {
      cwd: process.cwd(), model: "fake-model-low", executable: fixture,
      mcpServers: REGISTERED_MCP_NOWHERE,
      ...(toolNames ? { mcpToolNames: toolNames } : {}),
    },
  };
}

function collectedText(events: AcpEvent[]): string {
  return events.flatMap((event) => event.event === "update" && event.update.sessionUpdate === "agent_message_chunk" && event.update.content.type === "text"
    ? [event.update.content.text] : []).join("");
}

async function attempt(pool: SessionPool, request: SessionTurnRequest): Promise<{ events: AcpEvent[]; error?: any }> {
  const events: AcpEvent[] = [];
  try { for await (const event of pool.turn(request)) events.push(event); }
  catch (error) { return { events, error }; }
  return { events };
}

/** Seed the on-disk receipt shape directly; saveReceipt validates and merges slices. */
async function putReceipt(key: string, request: string, value: unknown): Promise<void> {
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const directory = join(sessionStoreDirectory(), "requests", hash(key));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${hash(request)}.json`), JSON.stringify(value));
}

describe("HostBridge response slices", () => {
  test("a normal receipt replays native events and never records response metadata", async () => {
    const { pool, key } = await isolatedPool();
    try {
      const first = await collect(pool.turn(execution(key, "FAKE_STREAM", { requestId: "native-replay" })));
      const receipt = await sessionStore.receipt(key, "native-replay");
      expect(receipt?.state).toBe("completed");
      expect(receipt?.events).toEqual(first);
      expect(receipt?.response).toBeUndefined();
      const replay = await collect(pool.turn(execution(key, "ignored", { requestId: "native-replay", executable: missingExecutable })));
      expect(replay).toEqual(first);
    } finally { await pool.close(); }
  });

  test("a frozen receipt replays only the completed slice recorded for its digest", async () => {
    const { pool, key } = await isolatedPool();
    const frozen = { id: "response:match", digest: "digest-match" };
    try {
      const first = await collect(pool.turn(execution(key, "FAKE_STREAM", { receipt: frozen })));
      expect(first.at(-1)).toMatchObject({ event: "result", result: { stopReason: "end_turn" } });
      // A frozen turn seeds its running slice; a plain turn records none.
      expect((await sessionStore.receipt(key, frozen.id))?.response).toEqual({ digest: frozen.digest, state: "running" });
      await putReceipt(key, frozen.id, { version: 1, state: "completed", events: first, response: { digest: frozen.digest, state: "completed", events: first } });
      const replay = await collect(pool.turn(execution(key, "ignored", { receipt: frozen, executable: missingExecutable })));
      expect(replay).toEqual(first);
    } finally { await pool.close(); }
  });

  test("stale, running, parked, legacy, expired, open and cancelled slices fail closed", async () => {
    const { pool, key } = await isolatedPool();
    const digest = "digest-expected";
    try {
      const seed = await collect(pool.turn(execution(key, "FAKE_STREAM", { receipt: { id: "response:seed", digest: "seed" } })));
      const cancelled = seed.map((event) => structuredClone(event));
      (cancelled.at(-1) as Extract<AcpEvent, { event: "result" }>).result.stopReason = "cancelled";
      const cases = [
        // A slice recorded for a different response must never replay here.
        { name: "stale digest", id: "response:stale", receipt: { state: "completed", events: seed, response: { digest: "digest-other", state: "completed", events: seed } } },
        // A still-running or parked slice is not a completed answer.
        { name: "running slice", id: "response:running", receipt: { state: "completed", events: seed, response: { digest, state: "running" } } },
        { name: "parked slice", id: "response:parked", receipt: { state: "completed", events: seed, response: { digest, state: "parked" } } },
        // Old receipts and expired payloads have no verified slice to replay.
        { name: "legacy receipt", id: "response:legacy", receipt: { state: "completed", events: seed } },
        { name: "expired payload", id: "response:expired", receipt: { state: "completed", events: seed, updatedAt: 1, response: { digest, state: "completed", events: seed } } },
        // An incomplete slice must not replay as a finished response.
        { name: "no terminal", id: "response:open", receipt: { state: "completed", events: seed, response: { digest, state: "completed", events: seed.slice(0, -1) } } },
        { name: "cancelled terminal", id: "response:cancelled", receipt: { state: "completed", events: seed, response: { digest, state: "completed", events: cancelled } } },
        // A successful terminal does not bless malformed cached updates.
        { name: "malformed update", id: "response:update", receipt: { state: "completed", events: seed, response: { digest, state: "completed", events: [{ event: "update", sessionId: "test", update: {} }, seed.at(-1)] } } },
        // The terminal must be a real success, not a missing or fake result.
        { name: "result without payload", id: "response:nopayload", receipt: { state: "completed", events: seed, response: { digest, state: "completed", events: [{ event: "result", sessionId: "test" }] } } },
        { name: "empty stopReason", id: "response:empty", receipt: { state: "completed", events: seed, response: { digest, state: "completed", events: [{ event: "result", sessionId: "test", result: { stopReason: "" } }] } } },
        { name: "fake stopReason", id: "response:fake", receipt: { state: "completed", events: seed, response: { digest, state: "completed", events: [{ event: "result", sessionId: "test", result: { stopReason: "finished" } }] } } },
        { name: "non-success stopReason", id: "response:max", receipt: { state: "completed", events: seed, response: { digest, state: "completed", events: [{ event: "result", sessionId: "test", result: { stopReason: "max_tokens" } }] } } },
      ];
      for (const item of cases) {
        await putReceipt(key, item.id, { version: 1, ...item.receipt });
        const result = await attempt(pool, execution(key, "ignored", { receipt: { id: item.id, digest }, executable: missingExecutable }));
        expect({ case: item.name, events: result.events.length, kind: result.error?.kind, code: result.error?.code }).toEqual({
          case: item.name, events: 0, kind: "invalid_request",
          code: expect.stringMatching(/^agy_(request_already_started|completed_response_unavailable)$/),
        });
      }
      // An unverifiable slice structure is corruption, not replayable data.
      await putReceipt(key, "response:corrupt", { version: 1, state: "completed", events: seed, response: { digest, state: "completed", events: "truncated" } });
      const corrupt = await attempt(pool, execution(key, "ignored", { receipt: { id: "response:corrupt", digest }, executable: missingExecutable }));
      expect(corrupt.events).toEqual([]);
      expect(corrupt.error).toBeDefined();
    } finally { await pool.close(); }
  });

  test("a completed receipt still replays when the persisted execution profile is from an older agent", async () => {
    const { pool, key } = await isolatedPool();
    try {
      const first = await collect(pool.turn(execution(key, "FAKE_STREAM", { requestId: "agent-boundary-replay" })));
      const record = (await sessionStore.get(key))!;
      await sessionStore.set(key, { ...record, executionProfile: "0".repeat(64) });
      const replay = await collect(pool.turn(execution(key, "ignored", { requestId: "agent-boundary-replay", executable: missingExecutable })));
      expect(replay).toEqual(first);
    } finally { await pool.close(); }
  });

  test("an uncertain receipt is never replayed and never starts a worker", async () => {
    const { pool, key } = await isolatedPool();
    try {
      await putReceipt(key, "uncertain-request", { version: 1, state: "uncertain" });
      const result = await attempt(pool, execution(key, "ignored", { requestId: "uncertain-request", executable: missingExecutable }));
      expect(result.events).toEqual([]);
      expect(result.error).toMatchObject({ kind: "invalid_request", code: "agy_request_already_started" });
    } finally { await pool.close(); }
  });
});

describe("session pool isolation", () => {
  test("closed pools reject requests as non-retryable client errors", async () => {
    const pool = new SessionPool();
    await pool.close();
    await expect(turn(pool, "closed-pool", "never execute")).rejects.toMatchObject({
      code: "agy_pool_closed", kind: "invalid_request", status: 400, retryable: false,
    });
  });

  test("keeps independent workers separate", async () => {
    await chmod(fixture, 0o755);
    process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = await mkdtemp(join(tmpdir(), "opencode-antigravity-pool-"));
    delete process.env.FAKE_ACP_STATE_FILE;
    const pool = new SessionPool({ idleMs: 60_000 });
    try {
      await turn(pool, "session-a", "remember FAKE_MEMORY");
      const other = await turn(pool, "session-b", "what did you remember");
      const original = await turn(pool, "session-a", "what did you remember");
      expect(other).toContain("NOT_REMEMBERED");
      expect(original).toContain("FAKE_MEMORY");
    } finally {
      await pool.close();
    }
  });

  test("persists an ACP session id and resumes it in a new pool", async () => {
    await chmod(fixture, 0o755);
    process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = await mkdtemp(join(tmpdir(), "opencode-antigravity-resume-"));
    process.env.FAKE_ACP_STATE_FILE = join(process.env.OPENCODE_ANTIGRAVITY_DATA_DIR, "fake-state.json");
    const firstPool = new SessionPool({ idleMs: 60_000 });
    await turn(firstPool, "restart-session", "remember FAKE_MEMORY");
    await firstPool.close();
    const secondPool = new SessionPool({ idleMs: 60_000 });
    try {
      const resumed = await turn(secondPool, "restart-session", "what did you remember");
      expect(resumed).toContain("FAKE_MEMORY");
    } finally {
      await secondPool.close();
    }
  });
});

describe("CLI runtime bindings", () => {
  test("the MCP tool registry participates in the worker settings signature", async () => {
    await chmod(fixture, 0o755);
    const directory = await mkdtemp(join(tmpdir(), "opencode-antigravity-registry-"));
    process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = directory;
    delete process.env.FAKE_ACP_STATE_FILE;
    const pidLog = join(directory, "pids.log");
    process.env.FAKE_ACP_PID_LOG = pidLog;
    const pool = new SessionPool({ idleMs: 60_000 });
    try {
      const first = await collect(pool.turn(bindingTurn("registry-session", "FAKE_TOOL_PERMISSION one", ["read_file"])));
      expect(collectedText(first)).toContain("PERMISSION:allow");
      const firstProfile = (await sessionStore.get("registry-session"))!.executionProfile;
      // Identical registry: the same worker answers.
      const second = await collect(pool.turn(bindingTurn("registry-session", "FAKE_TOOL_PERMISSION two", ["read_file"])));
      expect(collectedText(second)).toContain("PERMISSION:allow");
      // A different registry is a different worker configuration and cannot
      // inherit the previous authorization table.
      const third = await collect(pool.turn(bindingTurn("registry-session", "FAKE_TOOL_PERMISSION three", ["write_file"])));
      expect(collectedText(third)).toContain("PERMISSION:deny");
      expect((await sessionStore.get("registry-session"))!.executionProfile).not.toBe(firstProfile);
      const pids = (await readFile(pidLog, "utf8")).trim().split("\n").filter(Boolean);
      expect(pids).toHaveLength(2);
    } finally {
      delete process.env.FAKE_ACP_PID_LOG;
      await pool.close();
    }
  });

  test("a stored session from an older execution profile is not loaded", async () => {
    await chmod(fixture, 0o755);
    const directory = await mkdtemp(join(tmpdir(), "opencode-antigravity-old-profile-"));
    process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = directory;
    delete process.env.FAKE_ACP_STATE_FILE;
    const rpcLog = join(directory, "rpc.jsonl");
    process.env.FAKE_ACP_RPC_LOG = rpcLog;
    const pool = new SessionPool({ idleMs: 60_000 });
    try {
      await turn(pool, "old-profile-session", "remember FAKE_MEMORY");
      const before = (await sessionStore.get("old-profile-session"))!;
      expect(before.sessionId).toBeString();
      await writeFile(rpcLog, "");
      // A session persisted by an older fixed-agent build has another profile.
      await sessionStore.set("old-profile-session", { ...before, executionProfile: "0".repeat(64) });
      await turn(pool, "old-profile-session", "what did you remember");
      const rpcs = (await readFile(rpcLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      expect(rpcs.some((rpc) => rpc.method === "session/load")).toBe(false);
      expect(rpcs.some((rpc) => rpc.method === "session/new")).toBe(true);
      expect((await sessionStore.get("old-profile-session"))!.sessionId).not.toBe(before.sessionId);
    } finally {
      delete process.env.FAKE_ACP_RPC_LOG;
      await pool.close();
    }
  });
});
