import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureCompatibility } from "./fixtures/compatibility.js";
import { getProxyBaseUrl, startProxy, stopProxy } from "../src/proxy.js";
import { LOCAL_API_KEY, SESSION_HEADER } from "../src/constants.js";

const directory = await mkdtemp(join(tmpdir(), "agy-proxy-cancel-"));
const rpcLog = join(directory, "rpc.jsonl");
const replayFile = join(directory, "replay.json");
const fixture = join(import.meta.dir, "fixtures/fake-acp.mjs");
const env = { ...process.env };
let compatibility: ReturnType<typeof fixtureCompatibility>;

beforeAll(async () => {
  compatibility = fixtureCompatibility();
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = directory;
  process.env.GEMINI_HOME = join(directory, "gemini");
  process.env.FAKE_ACP_PROMPT_LOG = join(directory, "prompts.jsonl");
  process.env.FAKE_ACP_RPC_LOG = rpcLog;
  delete process.env.FAKE_ACP_STATE_FILE;
  // One text update, then FAKE_HANG silences the fixture turn: the proxy's
  // pending next() cannot settle on its own any more.
  await writeFile(replayFile, JSON.stringify({ events: [{ event: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } } }] }));
  await chmod(fixture, 0o755);
  await startProxy(directory);
});
afterAll(async () => {
  await stopProxy();
  compatibility.mockRestore();
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  await rm(directory, { recursive: true, force: true });
});

const headers = { "content-type": "application/json", "x-api-key": LOCAL_API_KEY };
const request = (session: string, body: Record<string, unknown>) => fetch(getProxyBaseUrl() + "/messages", {
  method: "POST", headers: { ...headers, [SESSION_HEADER]: session }, body: JSON.stringify({ model: "gemini-3.8-flash", max_tokens: 1024, ...body }),
});
async function rpcCount(method: string): Promise<number> {
  try { return (await readFile(rpcLog, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(message => message.method === method).length; }
  catch { return 0; }
}

test("client disconnect while the next event is pending aborts and releases the ACP turn", async () => {
  const cancels = await rpcCount("session/cancel");
  process.env.FAKE_ACP_REPLAY_FILE = replayFile;
  let response: Response;
  try {
    response = await request("cancel-pending", { stream: true, messages: [{ role: "user", content: "FAKE_HANG" }] });
  } finally {
    // Later turns on this fixture must start from a plain prompt.
    delete process.env.FAKE_ACP_REPLAY_FILE;
  }
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  let received = "";
  while (!received.includes("partial")) {
    const next = await reader.read();
    expect(next.done).toBe(false);
    received += new TextDecoder().decode(next.value);
  }
  expect(received).toContain("message_start");
  // The producer is silent from here on: cancel cannot preempt that pending
  // next() unless the request-level signal reaches ACP.
  await reader.cancel();

  let cancelsAfter = cancels;
  for (let i = 0; i < 300 && cancelsAfter === cancels; i++) { await Bun.sleep(10); cancelsAfter = await rpcCount("session/cancel"); }
  expect(cancelsAfter).toBeGreaterThan(cancels);

  // The aborted turn must release its session slot: the next turn completes.
  const follow = await request("cancel-pending", { stream: true, messages: [{ role: "user", content: "FAKE_STREAM" }] });
  expect(follow.status).toBe(200);
  expect(await follow.text()).toContain("FAKE_STREAM_OK");
}, 20_000);

const hostTools = [{ name: "shell", description: "OpenCode shell", input_schema: { type: "object", properties: { index: { type: "integer" } }, required: ["index"] } }];

test("a natural SSE park keeps its host bridge usable and does not cancel the turn", async () => {
  const cancels = await rpcCount("session/cancel");
  const messages: any[] = [{ role: "user", content: "FAKE_MCP PARK_SURVIVES" }];
  const first = await request("cancel-park", { stream: true, tools: hostTools, messages });
  expect(first.status).toBe(200);
  const sse = await first.text();
  expect(sse).toContain("message_stop");
  expect(sse).toContain('"stop_reason":"tool_use"');
  const blocks = new Map<number, { id?: string; name?: string; input?: unknown; partial: string }>();
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = JSON.parse(line.slice(6));
    if (payload.type === "content_block_start" && payload.content_block?.type === "tool_use") {
      blocks.set(payload.index, { id: payload.content_block.id, name: payload.content_block.name, partial: "" });
    } else if (payload.type === "content_block_delta" && payload.delta?.type === "input_json_delta") {
      const block = blocks.get(payload.index);
      if (block) block.partial += payload.delta.partial_json;
    }
  }
  const [block] = [...blocks.values()];
  expect(block?.id).toBeString();
  const call = { type: "tool_use", id: block!.id, name: block!.name, input: JSON.parse(block!.partial || "{}") };
  messages.push({ role: "assistant", content: [call] }, { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "PARK_RESULT" }] });
  const follow = await request("cancel-park", { tools: hostTools, messages });
  expect(follow.status).toBe(200);
  const body = await follow.json();
  expect(body.stop_reason).toBe("end_turn");
  expect(JSON.stringify(body.content)).toContain("PARK_RESULT");
  expect(await rpcCount("session/cancel")).toBe(cancels);
});
