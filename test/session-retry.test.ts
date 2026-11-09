import { afterEach, expect, test } from "bun:test";
import { useFixtureAuthentication } from "./fixtures/compatibility.js";
useFixtureAuthentication();
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { SessionPool, type SessionTurnRequest } from "../src/session-pool.js";
import { SessionStore } from "../src/session-store.js";
import { HarnessFailureGuard, type AcpEvent } from "../src/protocol.js";

const fixture = join(import.meta.dir, "fixtures", "fake-acp.mjs");
const pools: SessionPool[] = [];
const directories: string[] = [];
const savedEnvironment = { ...process.env };
afterEach(async () => {
  await Promise.all(pools.splice(0).map(pool => pool.close()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
  for (const key of ["OPENCODE_ANTIGRAVITY_DATA_DIR", "FAKE_ACP_PROMPT_LOG", "FAKE_ACP_STATE_FILE"]) {
    if (savedEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnvironment[key];
  }
});
async function setup() {
  await chmod(fixture, 0o755);
  const directory = await mkdtemp(join(tmpdir(), "agy-retry-"));
  directories.push(directory);
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = directory;
  process.env.FAKE_ACP_PROMPT_LOG = join(directory, "prompts.jsonl");
  delete process.env.FAKE_ACP_STATE_FILE;
  return directory;
}
function pool() { const value = new SessionPool({ maxQueue: 3 }); pools.push(value); return value; }
function request(requestId: string, text = "hello"): SessionTurnRequest {
  return { key: "session", requestId, prompt: [{ type: "text", text }],
    settings: { cwd: process.cwd(), model: "fake-model-low", executable: fixture } };
}
async function collect(events: AsyncIterable<unknown>) {
  const result = [];
  for await (const event of events) result.push(event);
  return result;
}
async function promptCount(directory: string) {
  return (await readFile(join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").length;
}

test("replays completed requests across pools, even after a newer message", async () => {
  const directory = await setup();
  const first = pool();
  const original = await collect(first.turn(request("one")));
  await first.close();
  const second = pool();
  expect(await collect(second.turn(request("one")))).toEqual(original);
  await collect(second.turn(request("two")));
  expect(await collect(second.turn(request("one")))).toEqual(original);
  expect(await promptCount(directory)).toBe(2);
});

const failureHeader = "Agent execution error: Harness process exited unexpectedly (WS close code 1011).\nHarness stderr:\n";
const textEvent = (text: string): AcpEvent => ({ event: "update", sessionId: "test", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });

test("harness envelope guard is bounded, ordered and only matches segment starts", () => {
  for (const text of ["Explanation: " + failureHeader, "Quoted: \"" + failureHeader, "Agent execution error: a normal tool failed", failureHeader.slice(0, -2)]) {
    const guard = new HarnessFailureGuard();
    const events = [...text].map(textEvent);
    const output = events.flatMap(event => guard.push(event));
    output.push(...guard.flush());
    expect(output).toEqual(events);
  }
  const guard = new HarnessFailureGuard();
  const partial = textEvent("Agent execution error:");
  const usage = { event: "update", sessionId: "test", update: { sessionUpdate: "usage_update", used: 1, size: 10 } } as AcpEvent;
  expect(guard.push(partial)).toEqual([]);
  expect(guard.push(usage)).toEqual([partial, usage]);
  expect(() => guard.push(textEvent(failureHeader))).toThrow("Harness process exited unexpectedly");
});

test("live harness envelopes fail as process errors without output, success or repeated side effects", async () => {
  for (const mode of ["WHOLE", "SPLIT", "RPC"]) {
    const directory = await setup();
    const sessions = pool();
    const req = request("harness", `FAKE_HARNESS_FAILURE ${mode}`);
    const seen: unknown[] = [];
    let caught: any;
    try { for await (const event of sessions.turn(req)) seen.push(event); } catch (error) { caught = error; }
    expect(caught?.kind).toBe("process");
    expect(caught?.message).toBe(failureHeader + (mode === "SPLIT" ? "" : "context canceled"));
    expect(seen).toEqual([]);
    expect((await sessions.status("session")).workerState).toBe("closed");
    expect((await new SessionStore().receipt("session", "harness"))?.state).toBe("uncertain");
    await expect(collect(sessions.turn(req))).rejects.toThrow("already started");
    expect(await readFile(join(directory, "prompts.jsonl.effects"), "utf8")).toBe("effect\n");
    expect(await promptCount(directory)).toBe(1);
  }
});

test("legacy harness receipt is rejected before yield without mutating receipt or permitting resume", async () => {
  const directory = await setup();
  const sessions = pool();
  await collect(sessions.turn(request("normal")));
  const store = new SessionStore();
  const events: AcpEvent[] = [textEvent("Earlier normal content"), { event: "update", sessionId: "test", update: { sessionUpdate: "tool_call", toolCallId: "tool", title: "boundary", status: "completed" } }, textEvent(failureHeader + "context canceled"), { event: "result", sessionId: "test", result: { stopReason: "end_turn" } }];
  await store.saveReceipt("session", "legacy", { state: "completed", events });
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const receiptPath = join(directory, "requests", hash("session"), hash("legacy") + ".json");
  const originalBytes = await readFile(receiptPath);
  const before = await store.receipt("session", "legacy");
  const seen: unknown[] = [];
  await expect((async () => { for await (const event of sessions.turn(request("legacy"))) seen.push(event); })()).rejects.toThrow("Harness process exited unexpectedly");
  expect(seen).toEqual([]);
  expect(await store.receipt("session", "legacy")).toEqual(before);
  expect(await readFile(receiptPath)).toEqual(originalBytes);
  expect((await sessions.status("session")).workerState).toBe("none");
  expect((await store.get("session"))?.conversation?.resumable).toBe(false);
  expect(await promptCount(directory)).toBe(1);
});

test("rejects uncertain retries after failure without sending another prompt", async () => {
  const directory = await setup();
  const first = pool();
  await expect(collect(first.turn(request("failed", "FAKE_EXIT")))).rejects.toThrow();
  await first.close();
  const second = pool();
  await expect(collect(second.turn(request("failed", "FAKE_EXIT")))).rejects.toThrow("already started");
  expect(await promptCount(directory)).toBe(1);
  await collect(second.turn(request("new")));
  expect(await promptCount(directory)).toBe(2);
});

test("does not send a prompt if the started receipt cannot be saved", async () => {
  const directory = await setup();
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(directory, "requests"), "not a directory");
  await expect(collect(pool().turn(request("one")))).rejects.toThrow();
  await expect(readFile(join(directory, "prompts.jsonl"))).rejects.toThrow();
});

test("cancelling a queued request leaves later turns behind the active turn", async () => {
  const directory = await setup();
  const sessions = pool();
  const active = sessions.turn(request("active", "FAKE_PAUSE_STREAM"));
  await active.next();
  const abort = new AbortController();
  const queued = collect(sessions.turn({ ...request("queued"), signal: abort.signal }));
  const rejected = queued.catch(error => error);
  abort.abort();
  expect((await rejected).message).toContain("cancelled");
  const later = collect(sessions.turn(request("later")));
  await collect(active);
  await later;
  expect(await promptCount(directory)).toBe(2);
  // A request cancelled before submission remains safe to submit later.
  await collect(sessions.turn(request("queued")));
  expect(await promptCount(directory)).toBe(3);
  await expect(collect(sessions.turn(request("message-only", "FAKE_QUOTA_MESSAGE_ONLY")))).rejects.toThrow("quota");
  expect((await new SessionStore().receipt("session", "message-only"))?.state).toBe("uncertain");
  await expect(collect(sessions.turn(request("message-only", "FAKE_QUOTA_MESSAGE_ONLY")))).rejects.toThrow("already started");
});

test("cancelled and abandoned turns retain non-replayable receipt evidence", async () => {
  await setup();
  const sessions = pool();
  await collect(sessions.turn(request("cancelled", "FAKE_CANCELLED")));
  expect((await new SessionStore().receipt("session", "cancelled"))?.state).toBe("interrupted");
  await expect(collect(sessions.turn(request("cancelled", "FAKE_CANCELLED")))).rejects.toThrow("already started");
  const events = sessions.turn(request("abandoned", "FAKE_PAUSE_STREAM"));
  await events.next();
  await events.return();
  expect((await new SessionStore().receipt("session", "abandoned"))?.state).toBe("uncertain");
});

test("identical intentional text at a later host boundary is a new request", async () => {
  const directory = await setup();
  const sessions = pool();
  const initial = { ...request(""), hostSessionID: "host", messages: [{ role: "user", content: "hello" }] };
  await collect(sessions.turn(initial));
  await collect(sessions.turn({ ...initial, messages: [...initial.messages, { role: "assistant", content: "FAKE_OK\n" }, { role: "user", content: "hello" }] }));
  expect(await promptCount(directory)).toBe(2);
});

test("another pool cannot mutate a session while its turn is active", async () => {
  await setup();
  const active = pool().turn(request("one", "FAKE_PAUSE_STREAM"));
  await active.next();
  const second = pool();
  await expect(collect(second.turn(request("two")))).rejects.toThrow("busy");
  await collect(active);
  await collect(second.turn(request("two")));
});

test("request receipts survive idle metadata pruning", async () => {
  const directory = await setup();
  await collect(pool().turn(request("one")));
  await new SessionStore().prune(-1);
  await collect(pool().turn(request("one")));
  expect(await promptCount(directory)).toBe(1);
});

test("definite quota rejection may resubmit but accepted activity cannot", async () => {
  const directory = await setup();
  const sessions = pool();
  for (let attempt = 0; attempt < 2; attempt++) await expect(collect(sessions.turn(request("rejected", "FAKE_QUOTA_REJECTED")))).rejects.toThrow("quota");
  expect((await new SessionStore().receipt("session", "rejected"))?.state).toBe("rejected-before-execution");
  await expect(collect(sessions.turn(request("uncertain", "FAKE_QUOTA_UNCERTAIN")))).rejects.toThrow("quota");
  expect((await new SessionStore().receipt("session", "uncertain"))?.state).toBe("uncertain");
  await expect(collect(sessions.turn(request("uncertain", "FAKE_QUOTA_UNCERTAIN")))).rejects.toThrow("already started");
  expect(await promptCount(directory)).toBe(3);
});

test("completed tombstones never execute again without a payload", async () => {
  const directory = await setup();
  await new SessionStore().saveReceipt("session", "large", { state: "completed" });
  await expect(collect(pool().turn(request("large")))).rejects.toThrow("response payload is unavailable");
  await expect(readFile(join(directory, "prompts.jsonl"))).rejects.toThrow();
});
