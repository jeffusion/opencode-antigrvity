import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeHostBridges, handleHostMcp, hostBridge } from "../src/host-tools.js";
import { ClientToolTurn } from "../src/tool-turn.js";
import { parseMessage, type ClientToolCall } from "../src/service-messages.js";
import type { HostCall, HostTool } from "../src/host-tools.js";
import type { AcpEvent } from "../src/protocol.js";
import { fixtureCompatibility } from "./fixtures/compatibility.js";

const fixture = join(import.meta.dir, "fixtures", "fake-acp.mjs");
const model = "fake-model-low";
const READ_TOOL: HostTool = { name: "read_file", description: "Read a host file", input_schema: { type: "object", properties: {} } };
const environment = { ...process.env };
let compatibility: ReturnType<typeof fixtureCompatibility>;
let directory: string;

beforeAll(async () => {
  compatibility = fixtureCompatibility();
  directory = await mkdtemp(join(tmpdir(), "agy-cli-runtime-bindings-"));
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = directory;
  await chmod(fixture, 0o755);
});

afterAll(async () => {
  await closeHostBridges();
  compatibility.mockRestore();
  for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
  Object.assign(process.env, environment);
  await rm(directory, { recursive: true, force: true });
});

function settings() {
  return { cwd: directory, model, executable: fixture };
}

function updateText(event: AcpEvent, text: string): string {
  return event.event === "update" && event.update.sessionUpdate === "agent_message_chunk" && event.update.content.type === "text"
    ? text + event.update.content.text : text;
}

test("the plugin bridge allows exactly the tool its own MCP tools/list serves", async () => {
  const session = "binding-plugin-allow";
  const baseURL = "http://127.0.0.1";
  const mcp = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handleHostMcp(request) });
  const rootURL = `${baseURL}:${mcp.port}`;
  const bridge = hostBridge(`host-v1:binding:${session}`, session, directory);
  const messages: any[] = [{ role: "user", content: "FAKE_MCP_PERMISSION" }];
  try {
    let calls: HostCall[] | undefined;
    for await (const event of bridge.request({ messages, tools: [READ_TOOL], settings: settings(), baseURL: rootURL })) {
      if (event.event === "host_tools") { calls = event.calls; break; }
    }
    expect(calls).toHaveLength(1);
    expect(calls![0].name).toBe("read_file");
    messages.push(
      { role: "assistant", content: [{ type: "tool_use", id: calls![0].id, name: calls![0].name, input: calls![0].input }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: calls![0].id, content: "READ_OK" }] },
    );
    let text = "";
    for await (const event of bridge.request({ messages, tools: [READ_TOOL], settings: settings(), baseURL: rootURL })) text = updateText(event, text);
    expect(text).toContain("READ_OK");
  } finally {
    await closeHostBridges(session);
    mcp.stop(true);
  }
});

test("the plugin bridge denies an unknown machine name even with a registered tool set", async () => {
  const session = "binding-plugin-unknown";
  const bridge = hostBridge(`host-v1:binding:${session}`, session, directory);
  process.env.FAKE_ACP_PERMISSION_CASE = "unknown-name";
  try {
    let text = "";
    for await (const event of bridge.request({
      messages: [{ role: "user", content: "FAKE_TOOL_PERMISSION" }],
      tools: [READ_TOOL], settings: settings(), baseURL: "http://127.0.0.1:9",
    })) text = updateText(event, text);
    expect(text).toContain("PERMISSION:deny");
  } finally {
    delete process.env.FAKE_ACP_PERMISSION_CASE;
    await closeHostBridges(session);
  }
});

function clientTurn(prompt: string): ClientToolTurn {
  const request = parseMessage({
    model, max_tokens: 128, messages: [{ role: "user", content: prompt }], tools: [READ_TOOL],
  } as any);
  return new ClientToolTurn({
    directory,
    detection: { executable: fixture, args: [], platform: `${process.platform}-${process.arch}` },
    selected: { requestedModel: model, acpModel: model },
    request,
  }, request.tools!, "anthropic");
}

async function segment(turn: ClientToolTurn): Promise<{ calls?: ClientToolCall[]; text: string }> {
  let calls: ClientToolCall[] | undefined;
  let text = "";
  for await (const event of turn.segment(AbortSignal.timeout(15_000))) {
    if (event.event === "function_calls") calls = event.calls;
    else text = updateText(event, text);
  }
  return { calls, text };
}

test("the service client turn allows exactly the tools its own MCP tools/list serves", async () => {
  const turn = clientTurn("FAKE_MCP_PERMISSION");
  try {
    const first = await segment(turn);
    expect(first.calls).toHaveLength(1);
    expect(first.calls![0].name).toBe("read_file");
    turn.resume(turn.protocol, turn.model, first.calls!.map((call) => ({
      id: call.id, content: [{ type: "text", text: "READ_OK" }], isError: false,
    })));
    const second = await segment(turn);
    expect(second.text).toContain("READ_OK");
  } finally { await turn.close(); }
});

test("the service client turn denies an unknown machine name even with a registered tool set", async () => {
  process.env.FAKE_ACP_PERMISSION_CASE = "unknown-name";
  const turn = clientTurn("FAKE_TOOL_PERMISSION");
  try {
    const result = await segment(turn);
    expect(result.calls).toBeUndefined();
    expect(result.text).toContain("PERMISSION:deny");
  } finally {
    delete process.env.FAKE_ACP_PERMISSION_CASE;
    await turn.close();
  }
});
