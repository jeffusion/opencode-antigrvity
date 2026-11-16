import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { appendFile, chmod, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { startProxy, stopProxy, getProxyBaseUrl } from "../src/proxy.js";
import { closeHostBridges, hostBridge, hostResults, parseHostTools } from "../src/host-tools.js";
import { protocol as anthropicProtocol } from "@opencode/ai/protocols/anthropic-messages";
const Effect = await import(Bun.resolveSync("effect/Effect", dirname(import.meta.resolve("@opencode/ai"))));
import { SESSION_HEADER } from "../src/constants.js";
import { fixtureCompatibility } from "./fixtures/compatibility.js";
import { sessionStore } from "../src/session-store.js";
import { canonical } from "../src/coordinator.js";
import { createHash } from "node:crypto";
let compatibility: ReturnType<typeof fixtureCompatibility>;

const directory = await mkdtemp(join(tmpdir(), "agy-host-tools-"));
const env = { ...process.env };
const schema = [{ name: "shell", description: "OpenCode shell", input_schema: { type: "object", properties: { index: { type: "integer", description: "Exact schema" } }, required: ["index"] } }];
beforeAll(async () => {
  compatibility = fixtureCompatibility();
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = directory;
  process.env.GEMINI_HOME = join(directory, "gemini");
  process.env.FAKE_ACP_PROMPT_LOG = join(directory, "prompts.jsonl");
  await chmod(join(import.meta.dir, "fixtures/fake-acp.mjs"), 0o755);
  await startProxy(directory);
});
afterAll(async () => {
  await stopProxy();
  compatibility.mockRestore();
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  await rm(directory, { recursive: true, force: true });
});
const send = (session: string, messages: any[], extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => fetch(getProxyBaseUrl() + "/messages", {
  method: "POST", headers: { "content-type": "application/json", "x-api-key": "opencode-antigravity-local", [SESSION_HEADER]: session, ...headers },
  body: JSON.stringify({ model: "gemini-3.8-flash", tools: schema, system: "HOST_INSTRUCTIONS_UNTRUNCATED", messages, ...extra }),
});
const result = (id: string, text: string, is_error = false) => ({ type: "tool_result", tool_use_id: id, content: text, is_error });

test("harness failure after a real host tool handoff never repeats the host side effect", async () => {
  const host = "host-harness-fatal";
  const headers = { "x-opencode-antigravity-message": "host-harness-fatal-request" };
  const counter = join(directory, "host-harness-fatal.effects");
  const messages: any[] = [{ role: "user", content: "FAKE_MCP_HARNESS_FATAL" }];
  const first = await (await send(host, messages, {}, headers)).json();
  expect(first.stop_reason).toBe("tool_use");
  const call = first.content.find((p: any) => p.type === "tool_use");
  // Execute the exposed host operation once before returning its actual result.
  await appendFile(counter, "executed\n");
  messages.push({ role: "assistant", content: first.content }, { role: "user", content: [result(call.id, "HOST_SIDE_EFFECT_DONE")] });
  const failed = await send(host, messages, {}, headers);
  const failure = await failed.json();
  expect(failed.status).toBe(502);
  expect(failure.error.code).toBe("agy_process_error");
  expect(failure.content).toBeUndefined();
  const [key] = (await sessionStore.entries()).find(([, r]) => r.conversation?.hostSessionID === host)!;
  const saved = (await sessionStore.toolCall(key, call.id))!;
  expect(saved.delivery).toBe("locally-handed-off");
  expect(saved.result?.content).toEqual([{ type: "text", text: "HOST_SIDE_EFFECT_DONE" }]);
  expect(saved.resultDigest).toBeString();
  expect((await sessionStore.receipt(key, String(saved.requestId)))?.state).toBe("uncertain");
  const count = await promptLines();
  const retry = await send(host, messages, {}, headers);
  const retried = await retry.json();
  expect(retry.status).toBe(400);
  expect(retried.error.message).toContain("already started");
  expect(retried.content).toBeUndefined();
  expect(await promptLines()).toBe(count);
  messages.push({ role: "user", content: "Continue from the recorded result without repeating the operation." });
  const resumed = await (await send(host, messages)).json();
  expect(resumed.stop_reason).toBe("end_turn");
  expect(resumed.content.some((p: any) => p.type === "tool_use")).toBe(false);
  const after = (await sessionStore.toolCall(key, call.id))!;
  expect(after.result).toEqual(saved.result);
  expect(after.resultDigest).toBe(saved.resultDigest);
  expect(after.delivery).toBe(saved.delivery);
  expect(await readFile(counter, "utf8")).toBe("executed\n");
});

test("delivered history input and output are display views without ledger writes or payload restoration", async () => {
  const host = "history-display";
  const messages: any[] = [{ role: "user", content: "FAKE_MCP HISTORY_DISPLAY" }];
  const first = await (await send(host, messages)).json();
  const call = first.content.find((p: any) => p.type === "tool_use");
  messages.push({ role: "assistant", content: first.content }, { role: "user", content: [result(call.id, "ORIGINAL_LARGE_RESULT")] });
  const completed = await (await send(host, messages)).json();
  const [key] = (await sessionStore.entries()).find(([, r]) => r.conversation?.hostSessionID === host)!;
  const before = await sessionStore.toolCall(key, call.id);
  messages[1].content = [{ ...call, input: { summary: "trimmed arguments" } }];
  messages[2].content = [result(call.id, "trimmed output")];
  messages.push({ role: "assistant", content: "Completed summary." }, { role: "user", content: "Continue from the shortened history." });
  expect((await send(host, messages)).status).toBe(200);
  expect(await sessionStore.toolCall(key, call.id)).toEqual(before);
  const logged = (await readFile(join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").at(-1)!;
  expect(logged).toContain("trimmed output");
  expect(logged).not.toContain("ORIGINAL_LARGE_RESULT");
  // Expired delivered history still needs neither restoration nor execution.
  await sessionStore.saveToolCall(key, call.id, { ...before!, result: undefined, payloadExpired: true });
  await closeHostBridges(host);
  messages.push({ role: "assistant", content: "History retained." }, { role: "user", content: "Continue again." });
  expect((await send(host, messages)).status).toBe(200);
  expect((await sessionStore.toolCall(key, call.id))?.payloadExpired).toBe(true);
  for (const change of [{ name: "renamed" }, { type: "text" }]) {
    const invalid = structuredClone(messages);
    Object.assign(invalid[1].content[0], change);
    expect((await send(host, invalid)).status).toBe(400);
  }
});

test("active history rewrite waits for the full batch and leaves partial ACP history untouched", async () => {
  const host = "history-active-partial";
  const messages: any[] = [{ role: "user", content: "FAKE_MCP HISTORY_BASELINE" }];
  const first = await (await send(host, messages)).json();
  const oldCall = first.content.find((p: any) => p.type === "tool_use");
  messages.push({ role: "assistant", content: first.content }, { role: "user", content: [result(oldCall.id, "OLD_AUTHORITATIVE")] });
  const completed = await (await send(host, messages)).json();
  messages.push({ role: "assistant", content: completed.content }, { role: "user", content: "FAKE_MCP_PARALLEL HISTORY_NEW_BATCH" });
  const batch = await (await sendParallel(host, messages)).json();
  expect(batch.content).toHaveLength(2);
  const [key] = (await sessionStore.entries()).find(([, r]) => r.conversation?.hostSessionID === host)!;
  const bridge = hostBridge(key, host, directory);
  const baseline = structuredClone((bridge as any).turn.messages);
  messages[1].content = [{ ...oldCall, input: { shortened: true } }];
  messages[2].content = [result(oldCall.id, "OLD_DISPLAY_ONLY")];
  messages[3].content = "Completed summary.";
  messages.push({ role: "assistant", content: batch.content }, { role: "user", content: [result(batch.content[0].id, "NEW_A")] });
  const count = await promptLines();
  expect((await send(host, messages)).status).toBe(400);
  expect(hostBridge(key, host, directory)).toBe(bridge);
  expect((bridge as any).turn.messages).toEqual(baseline);
  expect(await promptLines()).toBe(count);
  messages.at(-1).content = [result(batch.content[1].id, "NEW_B")];
  const final = await (await send(host, messages)).json();
  expect(final.stop_reason).toBe("end_turn");
  expect(final.content.some((p: any) => p.type === "tool_use")).toBe(false);
  expect(hostBridge(key, host, directory)).not.toBe(bridge);
  expect(await promptLines()).toBe(count + 1);
  const logged = (await readFile(join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").at(-1)!;
  expect(logged).toContain("OLD_DISPLAY_ONLY");
  expect(logged).not.toContain("OLD_AUTHORITATIVE");
  expect(logged).toContain("NEW_A");
  expect(logged).toContain("NEW_B");
});

test("pending partial batches reject changed arguments and changed persisted results", async () => {
  for (const field of ["input", "output"]) {
    const host = `history-strict-${field}`;
    const messages: any[] = [{ role: "user", content: "FAKE_MCP_PARALLEL STRICT_PARTIAL" }];
    const first = await (await sendParallel(host, messages)).json();
    messages.push({ role: "assistant", content: first.content }, { role: "user", content: [result(first.content[0].id, "AUTHORITATIVE")] });
    expect((await send(host, messages)).status).toBe(400);
    if (field === "input") messages[1].content[0].input = { forged: true };
    else messages[2].content[0].content = "CHANGED";
    const rejected = await send(host, messages);
    expect(rejected.status).toBe(400);
    const body = await rejected.json();
    expect(body.error.message).toMatch(/conflict/i);
    expect(body.content).toBeUndefined();
  }
});

test("wire-equivalent text and rotating cache markers reuse the active bridge", async () => {
  const host = "history-wire-equivalent";
  const messages: any[] = [{ role: "user", content: [{ type: "text", text: "FAKE_MCP WIRE_EQUIVALENT", cache_control: { type: "ephemeral" } }] }];
  const first = await (await send(host, messages)).json();
  const call = first.content.find((p: any) => p.type === "tool_use");
  const [key] = (await sessionStore.entries()).find(([, r]) => r.conversation?.hostSessionID === host)!;
  const bridge = hostBridge(key, host, directory);
  const count = await promptLines();
  messages[0].content = "FAKE_MCP WIRE_EQUIVALENT";
  messages.push({ role: "assistant", content: first.content }, { role: "user", content: [result(call.id, "WIRE_RESULT"), { type: "text", text: "Continue", cache_control: { type: "ephemeral" } }] });
  const final = await (await send(host, messages)).json();
  expect(final.stop_reason).toBe("end_turn");
  expect(JSON.stringify(final.content)).toContain("WIRE_RESULT");
  expect(hostBridge(key, host, directory)).toBe(bridge);
  expect(await promptLines()).toBe(count);
});

test("latest handed-off call restores its original result and remains strict during recovery", async () => {
  for (const mode of ["restore", "input", "output", "expired"]) {
    const host = `latest-handoff-${mode}`;
    const initial = [{ role: "user", content: "FAKE_MCP LATEST_HANDOFF" }];
    const first = await (await send(host, initial)).json();
    const call = first.content.find((p: any) => p.type === "tool_use");
    const completed = await (await send(host, [...initial, { role: "assistant", content: first.content }, { role: "user", content: [result(call.id, "DURABLE_RESULT_ONCE")] }])).json();
    expect(completed.stop_reason).toBe("end_turn");
    const [key] = (await sessionStore.entries()).find(([, r]) => r.conversation?.hostSessionID === host)!;
    const before = (await sessionStore.toolCall(key, call.id))!;
    expect(before.delivery).toBe("locally-handed-off");
    await closeHostBridges(host);
    const messages: any[] = [...initial, { role: "assistant", content: structuredClone(first.content) }];
    if (mode === "input") messages[1].content.find((p: any) => p.id === call.id).input = { changed: true };
    if (mode === "output") messages.push({ role: "user", content: [result(call.id, "CONFLICTING_RESULT")] });
    if (mode === "expired") await sessionStore.saveToolCall(key, call.id, { ...before, result: undefined, payloadExpired: true });
    const count = await promptLines();
    const response = await send(host, messages);
    const body = await response.json();
    if (mode === "restore") {
      expect(response.status).toBe(200);
      expect(body.stop_reason).toBe("end_turn");
      expect(body.content.some((p: any) => p.type === "tool_use")).toBe(false);
      const logged = (await readFile(join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").at(-1)!;
      expect(logged).toContain("DURABLE_RESULT_ONCE");
      expect(await promptLines()).toBe(count + 1);
      expect(await sessionStore.toolCall(key, call.id)).toEqual(before);
    } else {
      expect(response.status).toBe(400);
      expect(body.content).toBeUndefined();
      expect(body.error.message).toMatch(mode === "expired" ? /payload expired/ : /conflict/i);
      expect(await promptLines()).toBe(count);
    }
  }
});

test("earlier delivered history with omitted output is not restored past an assistant boundary", async () => {
  const host = "earlier-handoff-omitted";
  const initial = [{ role: "user", content: "FAKE_MCP EARLIER_HANDOFF" }];
  const first = await (await send(host, initial)).json();
  const call = first.content.find((p: any) => p.type === "tool_use");
  await (await send(host, [...initial, { role: "assistant", content: first.content }, { role: "user", content: [result(call.id, "DO_NOT_RESTORE_HISTORY_PAYLOAD")] }])).json();
  const [key] = (await sessionStore.entries()).find(([, r]) => r.conversation?.hostSessionID === host)!;
  const before = await sessionStore.toolCall(key, call.id);
  await closeHostBridges(host);
  const messages = [...initial, { role: "assistant", content: [{ ...call, input: { summary: "shortened" } }] }, { role: "assistant", content: "Completed history boundary." }, { role: "user", content: "Continue without the old payload." }];
  const response = await send(host, messages);
  expect(response.status).toBe(200);
  await response.json();
  expect(await sessionStore.toolCall(key, call.id)).toEqual(before);
  const logged = (await readFile(join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").at(-1)!;
  expect(logged).toContain("shortened");
  expect(logged).not.toContain("DO_NOT_RESTORE_HISTORY_PAYLOAD");
});

test("plain proxy requests emit only configured instructions and user content", async () => {
  for (const system of ["Search only", ""]) {
    const response = await fetch(getProxyBaseUrl() + "/messages", {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": "opencode-antigravity-local" },
      body: JSON.stringify({ model: "gemini-3.8-flash", system, messages: [{ role: "user", content: "Plain task" }] }),
    });
    expect(response.status).toBe(200);
    await response.json();
    const logged = JSON.parse((await readFile(join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").at(-1)!);
    expect(logged.prompt).toEqual([
      ...(system ? [{ type: "text", text: "<instruction>\nSearch only\n</instruction>" }] : []),
      { type: "text", text: "Plain task" },
    ]);
  }
});

/** These scenarios require a two-call batch, not the bridge's best-effort
 * 25 ms arrival grouping. Finish both durable writes before either wakes it. */
async function sendParallel(session: string, messages: any[]): Promise<Response> {
  const saveReceipt = sessionStore.saveReceipt.bind(sessionStore);
  let arrivals = 0;
  let release!: () => void;
  let fail!: (error: Error) => void;
  const batch = new Promise<void>((resolve, reject) => { release = resolve; fail = reject; });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const persistence = spyOn(sessionStore, "saveReceipt").mockImplementation(async (...args) => {
    await saveReceipt(...args);
    if (args[2].state === "parked") {
      if (++arrivals === 1) deadline = setTimeout(() => fail(new Error("Both parallel calls must reach durable parking")), 5_000);
      if (arrivals === 2) { clearTimeout(deadline); release(); }
      await batch;
    }
  });
  try { return await send(session, messages); }
  finally { clearTimeout(deadline); persistence.mockRestore(); }
}

test("installed host encoder routes inline/promoted result and steering images into the rebuilt prompt", async () => {
  // Sanitized synthetic payloads, >90 KiB decoded each; no private screenshots.
  const resultImage = Buffer.alloc(96 * 1024, 17).toString("base64");
  const steeringImage = Buffer.alloc(100 * 1024, 23).toString("base64");
  const initial = [{ role: "user", content: "FAKE_MCP ENCODER_MEDIA" }];
  const first = await (await send("encoder-media", initial)).json();
  const call = first.content.find((part: any) => part.type === "tool_use");
  const body: any = await Effect.runPromise(anthropicProtocol.body.from({
    model: { id: "gemini-3.8-flash", provider: "antigravity", route: {} }, system: [], tools: [],
    messages: [
      { role: "user", content: [{ type: "text", text: initial[0].content }] },
      { role: "assistant", content: [{ type: "tool-call", id: call.id, name: call.name, input: call.input }] },
      { role: "tool", content: [{ type: "tool-result", id: call.id, name: call.name, result: { type: "content", value: [{ type: "text", text: "ENCODER_RESULT" }, { type: "file", uri: `data:image/png;base64,${resultImage}`, mime: "image/png" }] } }] },
      { role: "user", content: [{ type: "text", text: "IMAGE_STEERING" }, { type: "media", media: { mediaType: "image/png", source: { type: "base64" }, inline: () => ({ mime: "image/png", base64: steeringImage }) } }] },
    ],
  } as any));
  const encodedResult = body.messages.find((m: any) => m.content.some((p: any) => p.type === "tool_result"));
  const resultPart = encodedResult.content[0];
  expect(resultPart.content[1].type).toBe("image");
  // Exercise the host's promoted adjacent representation as well as its real
  // encoder's inline result representation, without inventing another codec.
  encodedResult.content.push(resultPart.content.pop());
  const final = await (await send("encoder-media", body.messages)).json();
  expect(final.stop_reason).toBe("end_turn");
  const content = JSON.stringify(final.content);
  expect(content).toContain("IMAGE_OK");
  expect(content).not.toContain(resultImage);
  const rebuilt = JSON.parse((await readFile(join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").at(-1)!);
  expect(rebuilt.prompt.filter((part: any) => part.type === "image").map((part: any) => part.data)).toEqual([resultImage, steeringImage]);
  expect(rebuilt.text).toContain("ENCODER_RESULT");
  expect(rebuilt.text).toContain("IMAGE_STEERING");

  const recoveredInitial = [{ role: "user", content: "FAKE_MCP IMAGE_RECOVERY" }];
  const lost = await (await send("encoder-image-recovery", recoveredInitial)).json();
  const lostCall = lost.content.find((part: any) => part.type === "tool_use");
  const recovery = structuredClone(body.messages);
  recovery[0] = recoveredInitial[0];
  recovery[1] = { role: "assistant", content: lost.content };
  recovery[2].content[0].tool_use_id = lostCall.id;
  await closeHostBridges("encoder-image-recovery");
  const recoveredResponse = await send("encoder-image-recovery", recovery);
  const recoveredBody = await recoveredResponse.json();
  expect(recoveredBody.error).toBeUndefined();
  expect(recoveredResponse.status).toBe(200);
  const recoveredPrompt = JSON.parse((await readFile(join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").at(-1)!);
  expect(recoveredPrompt.prompt.filter((part: any) => part.type === "image").map((part: any) => part.data)).toEqual([resultImage, steeringImage]);
});

test("MCP cancellation request IDs interrupt their bridge without a successful empty result", async () => {
  const first = await (await send("mcp-cancel-id", [{ role: "user", content: "FAKE_MCP" }])).json();
  expect(first.stop_reason).toBe("tool_use");
  const { sessionStore } = await import("../src/session-store.js");
  const { sessionPool } = await import("../src/session-pool.js");
  const [key] = (await sessionStore.entries()).find(([, record]) => record.conversation?.hostSessionID === "mcp-cancel-id")!;
  const bridge = hostBridge(key, "mcp-cancel-id", directory);
  const url = getProxyBaseUrl().replace(/\/v1$/, "") + `/mcp/${bridge.token}/${bridge.catalogID}`;
  const rpc = (body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const pending = rpc({ jsonrpc: "2.0", id: "cancel-me", method: "tools/call", params: { name: "shell", arguments: { index: 3 } } });
  await Bun.sleep(20);
  expect((await rpc({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "cancel-me" } })).status).toBe(202);
  const response = await (await pending).json();
  expect(response.error.message).toMatch(/cancel/i);
  expect(response.result).toBeUndefined();
  for (let i = 0; i < 100 && (await sessionPool.status(key)).active; i++) await Bun.sleep(10);
  expect((await sessionPool.status(key)).active).toBe(false);
});

test("MCP negotiates opted-in SSE progress and reports cancellation as a terminal error", async () => {
  const host = "mcp-negotiated-progress";
  const first = await (await send(host, [{ role: "user", content: "FAKE_MCP" }])).json();
  expect(first.stop_reason).toBe("tool_use");
  const { sessionStore } = await import("../src/session-store.js");
  const [key] = (await sessionStore.entries()).find(([, record]) => record.conversation?.hostSessionID === host)!;
  const bridge = hostBridge(key, host, directory);
  const url = getProxyBaseUrl().replace(/\/v1$/, "") + `/mcp/${bridge.token}/${bridge.catalogID}`;
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: "progress-request", method: "tools/call", params: { name: "shell", arguments: { index: 5 }, _meta: { progressToken: "token-progress" } } }) });
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("token-progress");
  expect((await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "progress-request" } }) })).status).toBe(202);
  let terminal = "";
  while (true) { const next = await reader.read(); if (next.done) break; terminal += new TextDecoder().decode(next.value); }
  expect(terminal).toContain('"error":');
  expect(terminal).toMatch(/cancel/i);
  expect(terminal).not.toContain('"result":');
});

test("parallel host calls park, partial results retain waiters without re-emission, then continue the same ACP prompt", async () => {
  const before = await promptLines();
  const messages: any[] = [{ role: "user", content: "FAKE_MCP_PARALLEL" }];
  const first = await (await sendParallel("parallel", messages)).json();
  expect(first.stop_reason).toBe("tool_use"); expect(first.content).toHaveLength(2);
  messages.push({ role: "assistant", content: first.content }, { role: "user", content: [result(first.content[0].id, "ONE")] });
  const partialResponse = await send("parallel", messages);
  expect(partialResponse.status).toBe(400);
  const partial = await partialResponse.json();
  expect(partial.content).toBeUndefined();
  expect(partial.error.message).toContain("pending results");
  messages.at(-1).content.push(result(first.content[1].id, "DENIED", true));
  const final = await (await send("parallel", messages)).json();
  expect(final.stop_reason).toBe("end_turn");
  expect(JSON.stringify(final.content)).toContain("ONE"); expect(JSON.stringify(final.content)).toContain("DENIED");
  expect(JSON.stringify(final.content)).toContain("isError");
  const prompts = (await readFile(join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").slice(before).filter((line) => line.includes("FAKE_MCP_PARALLEL"));
  expect(prompts).toHaveLength(1); expect(prompts[0]).toContain("HOST_INSTRUCTIONS_UNTRUNCATED");
});

test("sequential tool steps preserve error/media results and expose valid Anthropic SSE", async () => {
  const messages: any[] = [{ role: "user", content: "FAKE_MCP_SEQUENCE" }];
  const first = await (await send("sequence", messages)).json();
  messages.push({ role: "assistant", content: first.content }, { role: "user", content: [result(first.content[0].id, "FIRST")] });
  const second = await (await send("sequence", messages)).json();
  expect(second.stop_reason).toBe("tool_use");
  const call = second.content.find((part: any) => part.type === "tool_use");
  messages.push({ role: "assistant", content: second.content }, { role: "user", content: [result(call.id, "SECOND")] });
  const final = await send("sequence", messages, { stream: true });
  const text = await final.text(); expect(text).toContain("SECOND"); expect(text).toContain('"stop_reason":"end_turn"');
});

test("cross-session results cannot resolve tools; stopped calls rebuild with accepted late results", async () => {
  const messages = [{ role: "user", content: "FAKE_MCP" }];
  const a = await (await send("a", messages)).json();
  const b = await (await send("b", messages)).json();
  const wrong = await send("b", [...messages, { role: "assistant", content: b.content }, { role: "user", content: [result(a.content[0].id, "WRONG")] }]);
  expect(wrong.status).toBe(400);
  const good = await (await send("a", [...messages, { role: "assistant", content: a.content }, { role: "user", content: [result(a.content[0].id, "RIGHT")] }])).json();
  expect(JSON.stringify(good)).toContain("RIGHT");
  const stopped = await (await send("stop", messages)).json();
  await closeHostBridges("stop");
  const orphan = await send("stop", [...messages, { role: "assistant", content: stopped.content }, { role: "user", content: [result(stopped.content[0].id, "LATE")] }]);
  expect(orphan.status).toBe(200);
  const recovered = await orphan.json();
  expect(recovered.stop_reason).toBe("end_turn");
  expect(recovered.content.some((part: any) => part.type === "tool_use")).toBe(false);
});

test("host compaction leaves parked calls and their completed results intact", async () => {
  const { sessionStore } = await import("../src/session-store.js");
  const host = "parked-compaction";
  const original = [{ role: "user", content: "FAKE_MCP_PARALLEL" }];
  const first = await (await sendParallel(host, original)).json();
  const calls = first.content.filter((part: any) => part.type === "tool_use");
  expect(calls).toHaveLength(2);
  const partialMessages = [...original, { role: "assistant", content: first.content }, { role: "user", content: [result(calls[0].id, "COMPLETED_ONCE")] }];
  const partialResponse = await send(host, partialMessages);
  expect(partialResponse.status).toBe(400);
  expect((await partialResponse.json()).content).toBeUndefined();
  const oldBinding = (await sessionStore.entries()).find(([, r]) => r.conversation?.hostSessionID === host)!;
  expect((await sessionStore.toolCall(oldBinding[0], calls[0].id))!.delivery).toBe("result-persisted");
  const summary = await send(host, [...partialMessages, { role: "user", content: "Summarize the selected prefix." }], { system: "Keep exact identifiers", tools: undefined }, { "x-opencode-antigravity-request-kind": "compaction" });
  expect(summary.status).toBe(400);
  expect((await summary.json()).error.code).toBe("agy_internal_compaction");
  expect(await sessionStore.get(oldBinding[0])).toEqual(oldBinding[1]);
  const continued = await (await send(host, [...original, { role: "assistant", content: first.content }, { role: "user", content: [result(calls[0].id, "COMPLETED_ONCE"), result(calls[1].id, "COMPLETED_SECOND_ONCE")] }])).json();
  expect(continued.stop_reason).toBe("end_turn");
  expect(continued.content.some((part: any) => part.type === "tool_use")).toBe(false);
  const binding = (await sessionStore.entries()).find(([, r]) => r.conversation?.hostSessionID === host)!;
  expect(binding[1].sessionId).toBe(oldBinding[1].sessionId);
  expect(binding[1].conversation!.epoch).toBe(oldBinding[1].conversation!.epoch);
  for (const call of calls) expect((await sessionStore.toolCall(binding[0], call.id))!.delivery).toBe("locally-handed-off");
  expect(JSON.stringify(continued)).toContain("COMPLETED_ONCE");
  expect(JSON.stringify(continued)).toContain("COMPLETED_SECOND_ONCE");
});

test("tool schema and media conversion retain the native host contract", () => {
  expect(parseHostTools(schema)).toEqual(schema);
  expect(() => parseHostTools([...schema, ...schema])).toThrow();
  const results = hostResults([{ role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: [{ type: "image", source: { type: "base64", data: "AA==", media_type: "image/png" } }] }] }]);
  expect(results.get("a")?.content).toEqual([{ type: "image", data: "AA==", mimeType: "image/png" }]);
});

test("restart recovers independently persisted parallel results without reexecuting calls", async () => {
  const messages: any[] = [{ role: "user", content: "FAKE_MCP_PARALLEL" }];
  const first = await (await sendParallel("restart-parallel", messages)).json();
  expect(first.content).toHaveLength(2);
  messages.push({ role: "assistant", content: first.content }, { role: "user", content: [result(first.content[0].id, "DURABLE_FIRST")] });
  await send("restart-parallel", messages);
  await closeHostBridges("restart-parallel");
  // Simulate a restart continuation containing only the newly completed half.
  messages.at(-1).content = [result(first.content[1].id, "DURABLE_SECOND")];
  const final = await (await send("restart-parallel", messages)).json();
  expect(final.stop_reason).toBe("end_turn");
  expect(final.content.some((p: any) => p.type === "tool_use")).toBe(false);
  const prompts = (await readFile(join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line).text);
  const rebuilt = prompts.at(-1)!;
  expect(rebuilt).toContain("DURABLE_FIRST");
  expect(rebuilt).toContain("DURABLE_SECOND");
});

test("lost result after both calls executed cannot cause recovery to execute either again", async () => {
  const executions = new Map<string, number>();
  const execute = (calls: any[]) => calls.map(call => {
    executions.set(call.id, (executions.get(call.id) ?? 0) + 1);
    return result(call.id, `EXECUTED_${call.id}`);
  });
  const messages: any[] = [{ role: "user", content: "FAKE_MCP_PARALLEL SIDE_EFFECT_COUNTS" }];
  const first = await (await sendParallel("execution-counts", messages)).json();
  expect(first.content).toHaveLength(2);
  // Both host side effects happened, but only A's result reached the adapter.
  const completed = execute(first.content);
  messages.push({ role: "assistant", content: first.content }, { role: "user", content: [completed[0]] });
  const partialResponse = await send("execution-counts", messages);
  expect(partialResponse.status).toBe(400);
  const partial = await partialResponse.json();
  execute((partial.content ?? []).filter((p: any) => p.type === "tool_use"));
  expect(partial.content).toBeUndefined();
  await closeHostBridges("execution-counts");
  for (const stream of [false, true]) {
    const context = stream ? [...messages, { role: "assistant", content: "host interruption status" }, { role: "user", content: "recover pending work" }] : messages;
    const response = await send("execution-counts", context, { stream });
    expect(response.status).toBe(400);
    const recovered = await response.json();
    // Model a host executor: any executable calls would repeat the side effect.
    execute((recovered.content ?? []).filter((p: any) => p.type === "tool_use"));
    expect(recovered.error.message).toContain("execution is uncertain");
    expect(recovered.content).toBeUndefined();
  }
  for (const call of first.content) expect(executions.get(call.id)).toBe(1);
  // Reconcile B's original stored host result; never execute B to reconstruct it.
  messages.at(-1).content = [completed[1]];
  // The authoritative stored result need not be in the trailing result group.
  messages.push({ role: "assistant", content: "host stored completion status" }, { role: "user", content: "continue from stored results" });
  const final = await (await send("execution-counts", messages)).json();
  expect(final.stop_reason).toBe("end_turn");
  for (const call of first.content) expect(executions.get(call.id)).toBe(1);
});

test("catalog descriptions and schema ordering preserve the parked profile; changed schemas rebuild", async () => {
  for (const changed of [false, true]) {
    const session = `profile-${changed}`;
    const messages: any[] = [{ role: "user", content: "FAKE_MCP" }];
    const first = await (await send(session, messages)).json();
    messages.push({ role: "assistant", content: first.content }, { role: "user", content: [result(first.content[0].id, "ORIGIN_RESULT")] });
    const tools = structuredClone(schema);
    tools[0].description = "new description";
    if (changed) tools[0].input_schema.required = [];
    const final = await (await send(session, messages, { tools })).json();
    expect(final.stop_reason).toBe("end_turn");
    if (!changed) expect(JSON.stringify(final)).toContain("ORIGIN_RESULT");
    else expect((await readFile(join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").at(-1)!).toContain("ORIGIN_RESULT");
    expect(final.content.some((p: any) => p.type === "tool_use")).toBe(false);
  }
});

test("conflicting persisted results are terminal and private to their conversation", async () => {
  const { SessionStore } = await import("../src/session-store.js");
  const store = new SessionStore();
  await store.saveToolCall("durable-test", "call", { call: { id: "call", name: "shell", input: {} }, emitted: true });
  const secret = "PRIVATE_RESULT_私密🔒";
  const image = Buffer.from("PRIVATE_IMAGE_DATA").toString("base64");
  const completed = { content: [{ type: "text", text: secret }, { type: "image", data: image, mimeType: "image/png" }], isError: false };
  await Promise.all([store.saveToolResult("durable-test", "call", completed), store.saveToolResult("durable-test", "call", completed)]);
  const incoming = { content: [{ type: "text", text: "CHANGED_PRIVATE_机密" }], isError: false };
  let error: any;
  try { await store.saveToolResult("durable-test", "call", incoming, "history-reconciliation"); } catch (caught) { error = caught; }
  expect(error?.message).toStartWith("Conflicting result for completed tool call ");
  expect(error?.status).toBe(400);
  expect(error?.code).toBe("agy_invalid_request");
  expect(error?.retryable).toBe(false);
  const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
  expect(JSON.parse(error.message.slice(error.message.indexOf("{")))).toEqual({
    callID: "call", stage: "history-reconciliation", delivery: "result-persisted", payloadExpired: false,
    previousDigest: hash(completed), incomingDigest: hash(incoming),
    previousBytes: Buffer.byteLength(canonical(completed), "utf8"), incomingBytes: Buffer.byteLength(canonical(incoming), "utf8"),
  });
  expect(Buffer.byteLength(canonical(incoming), "utf8")).toBeGreaterThan(canonical(incoming).length);
  for (const value of [secret, image, incoming.content[0].text, "durable-test"]) expect(JSON.stringify(error)).not.toContain(value);
  for (const value of [secret, image, incoming.content[0].text, "durable-test"]) expect(error.message).not.toContain(value);
  expect((await store.toolCall("durable-test", "call"))?.result).toEqual(completed);
  expect((await store.toolCall("durable-test", "call"))?.resultDigest).toBe(hash(completed));
  await expect(store.saveToolResult("another-session", "call", completed)).rejects.toThrow("originating");

  const messages: any[] = [{ role: "user", content: "FAKE_MCP" }];
  const first = await (await send("http-result-conflict", messages)).json();
  const id = first.content[0].id;
  messages.push({ role: "assistant", content: first.content }, { role: "user", content: [result(id, secret)] });
  expect((await send("http-result-conflict", messages)).status).toBe(200);
  messages.at(-1).content = [result(id, incoming.content[0].text)];
  const response = await send("http-result-conflict", messages);
  expect(response.status).toBe(400);
  const payload = await response.json();
  expect(payload.error.code).toBe("agy_invalid_request");
  expect(payload.error.message).toContain(`"callID":"${id}"`);
  expect(payload.error.message).toContain('"stage":"inactive-trailing"');
  for (const value of [secret, incoming.content[0].text]) expect(JSON.stringify(payload)).not.toContain(value);
});

test("failed durable file sync cannot acknowledge a tool result", async () => {
  const { SessionStore } = await import("../src/session-store.js");
  const store = new SessionStore();
  await store.saveToolCall("sync-failure", "sync-call", { call: { id: "sync-call", name: "shell", input: {} } });
  const handle = await open(join(directory, "sync-probe"), "w", 0o600);
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  const sync = spyOn(prototype, "sync").mockImplementation(async () => { throw new Error("injected fsync failure"); });
  try {
    await expect(store.saveToolResult("sync-failure", "sync-call", { content: [{ type: "text", text: "NOT_ACKNOWLEDGED" }], isError: false })).rejects.toThrow("injected fsync failure");
  } finally { sync.mockRestore(); }
  expect((await store.toolCall("sync-failure", "sync-call"))?.result).toBeUndefined();
});

test("runtime retains proxy until the last same-workspace owner releases", async () => {
  const port = getProxyBaseUrl();
  await startProxy(directory);
  await stopProxy(directory);
  expect(getProxyBaseUrl()).toBe(port);
  expect((await fetch(port + "/health")).status).toBe(200);
});

test("compatible module reload shares proxy, pool and live bridge ownership", async () => {
  const proxyPath = "../src/proxy.ts?phase5-reload";
  const poolPath = "../src/session-pool.ts?phase5-reload";
  const bridgePath = "../src/host-tools.ts?phase5-reload";
  const reloadedProxy = await import(proxyPath);
  const reloadedPool = await import(poolPath);
  const reloadedBridge = await import(bridgePath);
  const { sessionPool } = await import("../src/session-pool.js");
  const { hostBridge } = await import("../src/host-tools.js");
  expect(reloadedPool.sessionPool).toBe(sessionPool);
  expect(reloadedBridge.hostBridge("reload-test", "reload-test", directory)).toBe(hostBridge("reload-test", "reload-test", directory));
  await reloadedProxy.startProxy(directory);
  expect(reloadedProxy.getProxyBaseUrl()).toBe(getProxyBaseUrl());
  await reloadedProxy.stopProxy(directory);
  expect((await fetch(getProxyBaseUrl() + "/health")).status).toBe(200);
  await closeHostBridges("reload-test");
});

test("model switch settles the old parked profile through a fresh binding", async () => {
  const messages: any[] = [{ role: "user", content: "FAKE_MCP" }];
  const first = await (await send("model-switch", messages)).json();
  const { sessionStore } = await import("../src/session-store.js");
  const [key, before] = (await sessionStore.entries()).find(([, r]) => r.conversation?.hostSessionID === "model-switch")!;
  messages.push({ role: "assistant", content: first.content }, { role: "user", content: [result(first.content[0].id, "MODEL_SWITCH_RESULT")] });
  const final = await (await send("model-switch", messages, { model: "gemini-3.8-flash-low" })).json();
  expect(final.stop_reason).toBe("end_turn");
  const after = await sessionStore.get(key);
  // Fake ACP numbers sessions per process, so epoch is the rebuild evidence.
  expect(after?.conversation?.epoch).toBeGreaterThan(before.conversation!.epoch);
  expect(after?.model).toBe("gemini-3.8-flash-low");
  expect((await sessionStore.toolCall(key, first.content[0].id))?.resultDigest).toBeString();
  expect((await readFile(join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").at(-1)!).toContain("MODEL_SWITCH_RESULT");
  expect((await readFile(join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").at(-1)!).toContain("have already executed in OpenCode");
});

test("generic host idle expiry retires a pending tool without fabricating success", async () => {
  process.env.OPENCODE_ANTIGRAVITY_HOST_IDLE_MS = "1000";
  try {
    const first = await (await send("terminal-output", [{ role: "user", content: "FAKE_MCP" }], { tools: [{ name: "StructuredOutput", input_schema: { type: "object" } }] })).json();
    expect(first.stop_reason).toBe("tool_use");
    const { sessionStore } = await import("../src/session-store.js");
    const [key] = (await sessionStore.entries()).find(([, r]) => r.conversation?.hostSessionID === "terminal-output")!;
    await new Promise(resolve => setTimeout(resolve, 1300));
    const saved = await sessionStore.toolCall(key, first.content[0].id);
    expect(saved?.result).toBeUndefined();
    const { sessionPool } = await import("../src/session-pool.js");
    expect((await sessionPool.status(key)).active).toBe(false);
  } finally { delete process.env.OPENCODE_ANTIGRAVITY_HOST_IDLE_MS; }
});

test("StructuredOutput uses ordinary result delivery across turns", async () => {
  const { sessionStore } = await import("../src/session-store.js");
  const session = "ordinary-structured-output";
  const tools = [{ name: "StructuredOutput", input_schema: { type: "object" } }];
  const messages: any[] = [{ role: "user", content: "FAKE_MCP" }];
  const first = await (await send(session, messages, { tools })).json();
  const call = first.content.find((part: any) => part.type === "tool_use");
  const [key] = (await sessionStore.entries()).find(([, record]) => record.conversation?.hostSessionID === session)!;
  expect((await sessionStore.toolCall(key, call.id))?.result).toBeUndefined();
  messages.push({ role: "assistant", content: first.content }, { role: "user", content: [result(call.id, "ORIGINAL_STRUCTURED_RESULT")] });
  const completed = await (await send(session, messages, { tools })).json();
  expect(completed.stop_reason).toBe("end_turn");
  expect(JSON.stringify(completed)).toContain("ORIGINAL_STRUCTURED_RESULT");
  expect((await sessionStore.toolCall(key, call.id))?.delivery).toBe("locally-handed-off");
  messages.push({ role: "assistant", content: completed.content }, { role: "user", content: "FAKE_MCP SECOND" });
  const second = await (await send(session, messages, { tools })).json();
  const next = second.content.find((part: any) => part.type === "tool_use");
  expect(next.id).not.toBe(call.id);
  messages.push({ role: "assistant", content: second.content }, { role: "user", content: [result(next.id, "SECOND_STRUCTURED_RESULT")] });
  const final = await (await send(session, messages, { tools })).json();
  expect(final.stop_reason).toBe("end_turn");
  expect(JSON.stringify(final)).toContain("SECOND_STRUCTURED_RESULT");
  expect((await sessionStore.toolCall(key, next.id))?.delivery).toBe("locally-handed-off");
});

test("MCP tools render only as host calls while thinking and compaction notices survive", async () => {
  for (const stream of [false, true]) {
    const session = `activity-${stream}`;
    const messages: any[] = [{ role: "user", content: "FAKE_MCP_ACTIVITY" }];
    const firstResponse = await send(session, messages, { stream });
    const firstText = await firstResponse.text();
    expect(firstText).toContain("GENUINE_THOUGHT_BEFORE");
    expect(firstText).not.toContain("Antigravity tool");
    expect(firstText).not.toContain("duplicate-command");
    let call: any;
    if (stream) {
      expect(firstText).toContain("GENUINE_THOUGHT_BEFORE");
      const events = firstText.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
      const starts = events.filter((event) => event.type === "content_block_start" && event.content_block.type === "tool_use");
      expect(starts).toHaveLength(1);
      call = starts[0].content_block;
      call.input = JSON.parse(events.find((event) => event.index === starts[0].index && event.delta?.type === "input_json_delta").delta.partial_json);
    } else {
      const first = JSON.parse(firstText);
      expect(first.stop_reason).toBe("tool_use");
      expect(first.content.filter((part: any) => part.type === "tool_use")).toHaveLength(1);
      call = first.content.find((part: any) => part.type === "tool_use");
    }
    messages.push({ role: "assistant", content: [call] }, { role: "user", content: [result(call.id, "HOST_TOOL_DENIED", true)] });
    const finalText = await (await send(session, messages, { stream })).text();
    expect(finalText).not.toContain("Antigravity tool");
    expect(finalText).toContain("GENUINE_THOUGHT_AFTER");
    expect(finalText).toContain("context compacted");
    expect(finalText).toContain("HOST_TOOL_DENIED");
    expect(finalText).toContain('"stop_reason":"end_turn"');
  }
});

test("quota rejection evidence cannot erase already emitted and completed host calls", async () => {
  const { sessionStore } = await import("../src/session-store.js");
  const messages: any[] = [{ role: "user", content: "FAKE_MCP_QUOTA" }];
  const first = await (await send("quota-after-tools", messages)).json();
  const call = first.content.find((part: any) => part.type === "tool_use");
  const [key] = (await sessionStore.entries()).find(([, record]) => record.conversation?.hostSessionID === "quota-after-tools")!;
  const saved = (await sessionStore.toolCall(key, call.id))!;
  expect((await sessionStore.receipt(key, String(saved.requestId)))?.state).toBe("parked");
  const response = await send("quota-after-tools", [...messages, { role: "assistant", content: first.content }, { role: "user", content: [result(call.id, "EXECUTED_ONCE")] }]);
  expect(response.status).toBe(429);
  expect((await sessionStore.receipt(key, String(saved.requestId)))?.state).toBe("uncertain");
  expect((await sessionStore.toolCall(key, call.id))?.resultDigest).toBeString();
  const repeated = await send("quota-after-tools", messages);
  expect(repeated.status).toBe(400);
  expect((await repeated.json()).error.message).toContain("already started");
  const logged = (await readFile(process.env.FAKE_ACP_PROMPT_LOG!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(logged.filter(entry => entry.text.includes("FAKE_MCP_QUOTA"))).toHaveLength(1);
});

test("waiting for host approval suspends the watchdog; changed instructions rebuild with results and steering", async () => {
  const previous = process.env.OPENCODE_ANTIGRAVITY_TURN_STALL_MS;
  process.env.OPENCODE_ANTIGRAVITY_TURN_STALL_MS = "1000";
  try {
    const messages: any[] = [{ role: "user", content: "FAKE_MCP" }];
    const first = await (await send("waiting", messages)).json();
    expect(first.stop_reason).toBe("tool_use");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    messages.push({ role: "assistant", content: first.content }, { role: "user", content: [result(first.content[0].id, "APPROVED"), { type: "text", text: "USER_STEERING" }] });
    const final = await (await send("waiting", messages, { system: "UPDATED_INSTRUCTIONS" })).json();
    expect(final.stop_reason).toBe("end_turn");
    const logged = JSON.parse((await readFile(join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").at(-1)!);
    expect(logged.prompt[0]).toEqual({ type: "text", text: "<instruction>\nUPDATED_INSTRUCTIONS\n</instruction>" });
    expect(logged.text).toContain("USER_STEERING");
    expect(logged.text).toContain("APPROVED");
    expect(logged.text).not.toContain("HOST_INSTRUCTIONS_UNTRUNCATED");
    expect(final.content.some((part: { type: string }) => part.type === "tool_use")).toBe(false);
  } finally { if (previous === undefined) delete process.env.OPENCODE_ANTIGRAVITY_TURN_STALL_MS; else process.env.OPENCODE_ANTIGRAVITY_TURN_STALL_MS = previous; }
});

const hostImage = (data: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });
const promptLines = async () => {
  try { return (await readFile(join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").filter(Boolean).length; }
  catch { return 0; }
};
/** Observe a real event barrier without polling; a hang fails loudly. */
async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not happen`)), 5_000); })]); }
  finally { clearTimeout(timer); }
}

test("image tool results rebuild a native prompt instead of an MCP delivery", async () => {
  const host = "image-native-delivery";
  const image = Buffer.alloc(96 * 1024, 47).toString("base64");
  const messages: any[] = [{ role: "user", content: "FAKE_MCP NATIVE_IMAGE" }];
  const first = await (await send(host, messages)).json();
  expect(first.stop_reason).toBe("tool_use");
  const call = first.content.find((part: any) => part.type === "tool_use");
  const [key] = (await sessionStore.entries()).find(([, record]) => record.conversation?.hostSessionID === host)!;
  const oldIdentity = String((await sessionStore.toolCall(key, call.id))!.requestId);
  messages.push({ role: "assistant", content: first.content }, {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: call.id, content: [{ type: "text", text: "RESULT_TEXT_BEFORE_IMAGE" }, hostImage(image)] }, { type: "text", text: "STEERING_AFTER_IMAGE" }],
  });
  const saveReceipt = sessionStore.saveReceipt.bind(sessionStore);
  let handoffIdentity: string | undefined;
  const receipts = spyOn(sessionStore, "saveReceipt").mockImplementation(async (...args) => {
    await saveReceipt(...args);
    if (args[0] === key && args[1] !== oldIdentity) handoffIdentity = args[1];
  });
  let final: any;
  try { final = await (await send(host, messages)).json(); }
  finally { receipts.mockRestore(); }
  expect(final.stop_reason).toBe("end_turn");
  const content = JSON.stringify(final.content);
  expect(content).toContain("IMAGE_OK");
  expect(content).not.toContain(image);
  const rebuilt = JSON.parse((await readFile(join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").at(-1)!);
  expect(rebuilt.prompt.filter((part: any) => part.type === "image").map((part: any) => part.data)).toEqual([image]);
  expect(rebuilt.text).toContain("RESULT_TEXT_BEFORE_IMAGE");
  expect(rebuilt.text).toContain("STEERING_AFTER_IMAGE");
  expect(rebuilt.text).toContain("[tool result");
  const saved = (await sessionStore.toolCall(key, call.id))!;
  expect(saved.delivery).toBe("result-persisted");
  expect((await sessionStore.receipt(key, oldIdentity))?.state).toBe("interrupted");
  expect(handoffIdentity).toBeString();
  expect((await sessionStore.receipt(key, handoffIdentity!))?.state).toBe("completed");

  // The same continuation replays the new completed receipt without a prompt.
  const beforeReplay = await promptLines();
  const revision = (await sessionStore.get(key))?.revision;
  const replay = await (await send(host, messages)).json();
  expect(replay.stop_reason).toBe("end_turn");
  expect(replay.content).toEqual(final.content);
  expect(await promptLines()).toBe(beforeReplay);
  expect((await sessionStore.get(key))?.revision).toBe(revision);

  // A later plain-text tool batch on the rebuilt session must not rebuild again.
  messages.push({ role: "assistant", content: final.content }, { role: "user", content: "FAKE_MCP SECOND_TEXT_TURN" });
  const beforeSecond = await promptLines();
  const second = await (await send(host, messages)).json();
  expect(second.stop_reason).toBe("tool_use");
  const next = second.content.find((part: any) => part.type === "tool_use");
  messages.push({ role: "assistant", content: second.content }, { role: "user", content: [result(next.id, "PLAIN_SECOND_RESULT")] });
  const beforeDelivery = await promptLines();
  const third = await (await send(host, messages)).json();
  expect(third.stop_reason).toBe("end_turn");
  expect(JSON.stringify(third.content)).toContain("PLAIN_SECOND_RESULT");
  expect(await promptLines()).toBe(beforeDelivery);
  expect(beforeDelivery).toBe(beforeSecond + 1);
});

test("image half-batch stays parked until every reported result arrives", async () => {
  const host = "image-half-batch";
  const image = Buffer.alloc(48 * 1024, 53).toString("base64");
  const messages: any[] = [{ role: "user", content: "FAKE_MCP_PARALLEL HALF_IMAGE" }];
  const first = await (await sendParallel(host, messages)).json();
  expect(first.content).toHaveLength(2);
  const [a, b] = first.content;
  const [key] = (await sessionStore.entries()).find(([, record]) => record.conversation?.hostSessionID === host)!;
  const bridge = hostBridge(key, host, directory);
  messages.push({ role: "assistant", content: first.content }, { role: "user", content: [
    { type: "tool_result", tool_use_id: a.id, content: [{ type: "text", text: "HALF_TEXT" }, hostImage(image)] },
  ] });
  const partial = await send(host, messages);
  expect(partial.status).toBe(400);
  expect((await partial.json()).error.message).toContain("pending results");
  // Incomplete reported batches must not retire the parked bridge.
  expect(hostBridge(key, host, directory)).toBe(bridge);
  // Only B is submitted again; A must be recovered from pending + durable state.
  messages.at(-1).content = [result(b.id, "SECOND_TEXT")];
  const final = await (await send(host, messages)).json();
  expect(final.stop_reason).toBe("end_turn");
  expect(JSON.stringify(final.content)).toContain("IMAGE_OK");
  expect(hostBridge(key, host, directory)).not.toBe(bridge);
  const rebuilt = JSON.parse((await readFile(join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").at(-1)!);
  expect(rebuilt.prompt.filter((part: any) => part.type === "image").map((part: any) => part.data)).toEqual([image]);
  expect(rebuilt.text).toContain("HALF_TEXT");
  expect(rebuilt.text).toContain("SECOND_TEXT");
});

test("invalid steering media rejects before the image switch and keeps the result", async () => {
  const host = "image-invalid-steering";
  const image = Buffer.alloc(20 * 1024, 59).toString("base64");
  const messages: any[] = [{ role: "user", content: "FAKE_MCP INVALID_STEERING" }];
  const first = await (await send(host, messages)).json();
  const call = first.content.find((part: any) => part.type === "tool_use");
  const [key] = (await sessionStore.entries()).find(([, record]) => record.conversation?.hostSessionID === host)!;
  const request = (steering: unknown) => [...messages, { role: "assistant", content: first.content }, { role: "user", content: [
    { type: "tool_result", tool_use_id: call.id, content: [hostImage(image)] }, steering,
  ] }];
  const rejected = await send(host, request({ type: "audio", data: "AA==" }));
  expect(rejected.status).toBe(400);
  const failure = await rejected.json();
  expect(failure.content).toBeUndefined();
  expect(failure.error.code).toBe("agy_unsupported_content");
  expect((await sessionStore.toolCall(key, call.id))?.resultDigest).toBeString();
  expect((await sessionStore.toolCall(key, call.id))?.delivery).toBe("result-persisted");
  // The persisted result survives; a corrected continuation rebuilds with it.
  const final = await (await send(host, request({ type: "text", text: "STEERING_OK" }))).json();
  expect(final.stop_reason).toBe("end_turn");
  const rebuilt = JSON.parse((await readFile(join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").at(-1)!);
  expect(rebuilt.prompt.filter((part: any) => part.type === "image").map((part: any) => part.data)).toEqual([image]);
  expect(rebuilt.text).toContain("STEERING_OK");
});

test("image continuation and its repeat replay without a new prompt", async () => {
  const host = "image-repeat-id";
  const image = Buffer.alloc(16 * 1024, 61).toString("base64");
  const headers = { "x-opencode-antigravity-message": "fixed-image-request" };
  const messages: any[] = [{ role: "user", content: "FAKE_MCP REPEAT_ID" }];
  const first = await (await send(host, messages, {}, headers)).json();
  const call = first.content.find((part: any) => part.type === "tool_use");
  messages.push({ role: "assistant", content: first.content }, { role: "user", content: [
    { type: "tool_result", tool_use_id: call.id, content: [hostImage(image)] },
  ] });
  const prompts = await promptLines();
  const response = await send(host, messages, {}, headers);
  expect(response.status).toBe(200);
  const answer = await response.json();
  // The complete image continuation and its repeat both replay without a new
  // prompt; the explicit header never overwrites the first step's slot.
  const repeated = await send(host, messages, {}, headers);
  expect(repeated.status).toBe(200);
  expect({ content: (await repeated.json()).content, stop_reason: "end_turn" }).toEqual({ content: answer.content, stop_reason: "end_turn" });
  expect(await promptLines()).toBe(prompts + 1);
  const [key] = (await sessionStore.entries()).find(([, record]) => record.conversation?.hostSessionID === host)!;
  expect((await sessionStore.toolCall(key, call.id))?.resultDigest).toBeString();
  expect((await sessionStore.receipt(key, "fixed-image-request"))?.state).not.toBe("completed");
});

test("image switch cancels calls that were never reported as a host batch", async () => {
  const host = "image-late-call";
  const image = Buffer.alloc(24 * 1024, 67).toString("base64");
  const messages: any[] = [{ role: "user", content: "FAKE_MCP LATE_CALL" }];
  const first = await (await send(host, messages)).json();
  const call = first.content.find((part: any) => part.type === "tool_use");
  const [key] = (await sessionStore.entries()).find(([, record]) => record.conversation?.hostSessionID === host)!;
  const bridge = hostBridge(key, host, directory);
  const url = getProxyBaseUrl().replace(/\/v1$/, "") + `/mcp/${bridge.token}/${bridge.catalogID}`;
  // The parked turn consumed its own park; the next queue push is the late call.
  const queue = (bridge as any).queue;
  const push = queue.push;
  let parked!: () => void;
  const park = new Promise<void>((resolve) => { parked = resolve; });
  queue.push = (value: any) => { push.call(queue, value); if (value?.event === "park") parked(); };
  const saveToolCall = sessionStore.saveToolCall.bind(sessionStore);
  let lateID: string | undefined;
  const calls = spyOn(sessionStore, "saveToolCall").mockImplementation(async (...args) => {
    await saveToolCall(...args);
    if (args[1] !== call.id) lateID = args[1];
  });
  let late: Promise<Response> | undefined;
  let continuation: Promise<Response> | undefined;
  try {
    late = fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "late-unreported", method: "tools/call", params: { name: "shell", arguments: { index: 9 } } }) });
    await within(park, "late MCP park");
    expect(lateID).toBeString();
    messages.push({ role: "assistant", content: first.content }, { role: "user", content: [
      { type: "tool_result", tool_use_id: call.id, content: [hostImage(image)] },
    ] });
    continuation = send(host, messages);
    const final = await (await continuation).json();
    expect(final.stop_reason).toBe("end_turn");
    expect(JSON.stringify(final.content)).toContain("IMAGE_OK");
    expect(final.content.some((part: any) => part.type === "tool_use")).toBe(false);
    const rebuilt = JSON.parse((await readFile(join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").at(-1)!);
    expect(rebuilt.text).not.toContain(lateID!);
    const stored = await sessionStore.toolCall(key, lateID!);
    expect(stored?.result).toBeUndefined();
    expect(stored?.delivery).toBeUndefined();
    const replacement = hostBridge(key, host, directory);
    expect(replacement).not.toBe(bridge);
    expect((replacement as any).pending.has(lateID!)).toBe(false);
    const lateResponse = await (await late).json();
    expect(lateResponse.result).toBeUndefined();
    expect(lateResponse.error.message).toMatch(/cancel|abort/i);
  } finally {
    queue.push = push;
    try { calls.mockRestore(); } catch { /* preserve the original failure */ }
    try { await closeHostBridges(host); } catch { /* preserve the original failure */ }
    try { await within(Promise.allSettled([late, continuation].filter((request): request is Promise<Response> => request !== undefined)), "late requests settle"); } catch { /* already closed */ }
  }
});

test("cancelling the continuation during the handoff submits no replacement prompt", async () => {
  const host = "image-handoff-cancel";
  const image = Buffer.alloc(18 * 1024, 71).toString("base64");
  const messages: any[] = [{ role: "user", content: "FAKE_MCP HANDOFF_CANCEL" }];
  const first = await (await send(host, messages)).json();
  const call = first.content.find((part: any) => part.type === "tool_use");
  const [key] = (await sessionStore.entries()).find(([, record]) => record.conversation?.hostSessionID === host)!;
  const bridge = hostBridge(key, host, directory);
  messages.push({ role: "assistant", content: first.content }, { role: "user", content: [
    { type: "tool_result", tool_use_id: call.id, content: [hostImage(image)] },
  ] });
  const { sessionPool } = await import("../src/session-pool.js");
  const turn = sessionPool.turn.bind(sessionPool);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reached!: () => void;
  const started = new Promise<void>((resolve) => { reached = resolve; });
  // Pause the replacement before its pooled turn can submit a prompt.
  const pause = spyOn(sessionPool, "turn").mockImplementation((request: any) => (async function* () {
    reached();
    await gate;
    yield* turn(request);
  })());
  let response: Promise<Response> | undefined;
  let closing: Promise<void> | undefined;
  try {
    const before = await promptLines();
    response = send(host, messages);
    await within(started, "replacement turn");
    expect(await promptLines()).toBe(before);
    expect((await sessionStore.toolCall(key, call.id))?.resultDigest).toBeString();
    closing = closeHostBridges(host);
    release();
    await closing;
    const http = await response;
    const outcome = await http.json();
    expect(http.status).toBeGreaterThanOrEqual(400);
    expect(outcome.error).toBeDefined();
    expect(outcome.content).toBeUndefined();
    expect(await promptLines()).toBe(before);
    const saved = (await sessionStore.toolCall(key, call.id))!;
    expect(saved.resultDigest).toBeString();
    expect(saved.delivery).toBe("result-persisted");
    expect(hostBridge(key, host, directory)).not.toBe(bridge);
  } finally {
    // Close first, then release the paused pump, then settle both requests.
    try { closing = closing ?? closeHostBridges(host); } catch { /* preserve the original failure */ }
    release();
    try { await closing; } catch { /* preserve the original failure */ }
    try { pause.mockRestore(); } catch { /* preserve the original failure */ }
    try { await closeHostBridges(host); } catch { /* preserve the original failure */ }
    try { if (response) await within(response, "response settle"); } catch { /* already settled */ }
  }
});

test("replacement prompt failure preserves the result and cannot resubmit", async () => {
  const host = "image-quota-failure";
  const image = Buffer.alloc(22 * 1024, 73).toString("base64");
  const messages: any[] = [{ role: "user", content: "FAKE_MCP QUOTA_HANDOFF" }];
  const first = await (await send(host, messages)).json();
  const call = first.content.find((part: any) => part.type === "tool_use");
  const [key] = (await sessionStore.entries()).find(([, record]) => record.conversation?.hostSessionID === host)!;
  const oldIdentity = String((await sessionStore.toolCall(key, call.id))!.requestId);
  messages.push({ role: "assistant", content: first.content }, { role: "user", content: [
    { type: "tool_result", tool_use_id: call.id, content: [hostImage(image)] },
    { type: "text", text: "FAKE_QUOTA_UNCERTAIN" },
  ] });
  const saveReceipt = sessionStore.saveReceipt.bind(sessionStore);
  let failedIdentity: string | undefined;
  const receipts = spyOn(sessionStore, "saveReceipt").mockImplementation(async (...args) => {
    await saveReceipt(...args);
    if (args[0] === key && args[1] !== oldIdentity) failedIdentity = args[1];
  });
  let http: Response;
  let failure: any;
  try { http = await send(host, messages); failure = await http.json(); }
  finally { receipts.mockRestore(); }
  expect(http.status).toBe(429);
  expect(failure.content).toBeUndefined();
  expect(failure.error).toBeDefined();
  const rebuilt = JSON.parse((await readFile(join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").at(-1)!);
  expect(rebuilt.prompt.filter((part: any) => part.type === "image").map((part: any) => part.data)).toEqual([image]);
  expect(rebuilt.text).toContain("FAKE_QUOTA_UNCERTAIN");
  expect(failedIdentity).toBeString();
  expect((await sessionStore.receipt(key, failedIdentity!))?.state).not.toBe("completed");
  const saved = (await sessionStore.toolCall(key, call.id))!;
  expect(saved.resultDigest).toBeString();
  expect(saved.delivery).toBe("result-persisted");
  // Content identity (not an explicit header) blocks resubmission and tool replay.
  const before = await promptLines();
  const retry = await send(host, messages);
  expect(retry.status).toBe(400);
  const retryBody = await retry.json();
  expect(retryBody.error.code).toBe("agy_request_already_started");
  expect(retryBody.content).toBeUndefined();
  expect(await promptLines()).toBe(before);
});

test("clearing instructions during a parked tool turn rebuilds without old instructions or reexecuting tools", async () => {
  const messages: any[] = [{ role: "user", content: "FAKE_MCP" }];
  const first = await (await send("clear-parked-system", messages)).json();
  expect(first.stop_reason).toBe("tool_use");
  const [key, before] = (await sessionStore.entries()).find(([, record]) => record.conversation?.hostSessionID === "clear-parked-system")!;
  const call = first.content.find((part: { type: string }) => part.type === "tool_use");
  messages.push({ role: "assistant", content: first.content }, { role: "user", content: [result(call.id, "ORIGINAL_RESULT")] });
  const final = await (await send("clear-parked-system", messages, { system: "" })).json();
  expect(final.stop_reason).toBe("end_turn");
  expect(final.content.some((part: { type: string }) => part.type === "tool_use")).toBe(false);
  const after = await sessionStore.get(key);
  expect(after?.sessionId).not.toBe(before.sessionId);
  expect(after?.conversation?.instructions).toBe("");
  const logged = JSON.parse((await readFile(join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").at(-1)!);
  expect(logged.text).toContain("ORIGINAL_RESULT");
  expect(logged.text).not.toContain("HOST_INSTRUCTIONS_UNTRUNCATED");
  expect(logged.text).not.toContain("<instruction>");
  expect((await sessionStore.toolCall(key, call.id))?.resultDigest).toBeString();
});

const promptCountFor = async (marker: string) => (await readFile(process.env.FAKE_ACP_PROMPT_LOG!, "utf8")).trim().split("\n").filter(line => line.includes(marker)).length;
const continuationMessages = (marker: string, first: any, texts: string[]) => {
  const messages: any[] = [{ role: "user", content: marker }];
  const call = first.content.find((part: any) => part.type === "tool_use");
  messages.push({ role: "assistant", content: first.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: texts.join(" "), is_error: false }] });
  return { messages, call };
};

test("content-identified continuation replays one frozen slice across headers and bridge restarts", async () => {
  const host = "continuation-slice";
  const marker = "FAKE_MCP SLICE_ONCE";
  const messages: any[] = [{ role: "user", content: marker }];
  const first = await (await send(host, messages)).json();
  expect(first.stop_reason).toBe("tool_use");
  const continuation = continuationMessages(marker, first, ["SLICE_RESULT"]).messages;
  const sent = await send(host, continuation);
  expect(sent.status).toBe(200);
  const answer = await sent.json();
  const shape = (value: any) => ({ content: value.content, stop_reason: value.stop_reason });
  const prompts = await promptCountFor(marker);
  // Same frozen identity+digest replays the same slice for any header shape:
  // none, the first request's header, or a different header.
  for (const headers of [{}, { "x-opencode-antigravity-message": "first-request" }, { "x-opencode-antigravity-message": "different-header" }]) {
    const replay = await send(host, continuation, {}, headers);
    expect(replay.status).toBe(200);
    expect(shape(await replay.json())).toEqual(shape(answer));
  }
  expect(await promptCountFor(marker)).toBe(prompts);
  // A rebuilt bridge (restart) reads the durable slice, not a new generation.
  await closeHostBridges(host);
  const restarted = await send(host, continuation);
  expect(restarted.status).toBe(200);
  expect(shape(await restarted.json())).toEqual(shape(answer));
  expect(await promptCountFor(marker)).toBe(prompts);
});

test("a parked initial response is never replaced by the later full answer", async () => {
  const host = "parked-isolation";
  const marker = "FAKE_MCP PARKED_ISOLATED";
  const messages: any[] = [{ role: "user", content: marker }];
  const first = await (await send(host, messages)).json();
  expect(first.stop_reason).toBe("tool_use");
  const continuation = continuationMessages(marker, first, ["ISOLATED_ANSWER"]).messages;
  const final = await (await send(host, continuation)).json();
  expect(JSON.stringify(final)).toContain("ISOLATED_ANSWER");
  const retry = await send(host, messages);
  expect(retry.status).toBe(400);
  const body = await retry.json();
  expect(body.error.code).toBe("agy_request_already_started");
  expect(JSON.stringify(body)).not.toContain("ISOLATED_ANSWER");
});

test("a partial result batch is not released and the full batch is delivered once", async () => {
  const host = "partial-batch";
  const marker = "FAKE_MCP_PARALLEL";
  const log = join(directory, "partial-batch.mcp.jsonl");
  await rm(log, { force: true });
  process.env.FAKE_ACP_MCP_RESULT_LOG = log;
  try {
    const before = await promptLines();
    const messages: any[] = [{ role: "user", content: `${marker} PARTIAL_BATCH` }];
    const first = await (await send(host, messages)).json();
    const calls = first.content.filter((part: any) => part.type === "tool_use");
    expect(calls.length).toBe(2);
    const [key] = (await sessionStore.entries()).find(([, record]) => record.conversation?.hostSessionID === host)!;
    // Both fixture RPCs are awaiting their host results.
    expect(await mcpDeliveries(log)).toHaveLength(0);
    const partial = [...messages, { role: "assistant", content: first.content }, { role: "user", content: [result(calls[0].id, "ONE")] }];
    const rejected = await send(host, partial);
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error.code).toBe("agy_tool_results_pending");
    expect((await sessionStore.toolCall(key, calls[0].id))?.resultDigest).toBeString();
    expect((await sessionStore.toolCall(key, calls[1].id))?.resultDigest).toBeUndefined();
    for (const call of calls) {
      const record = await sessionStore.toolCall(key, call.id);
      // A partial batch persists evidence but never claims a delivery attempt.
      expect(["delivery-attempted", "locally-handed-off"]).not.toContain(record?.delivery);
    }
    expect(await mcpDeliveries(log)).toHaveLength(0);
    const full = [...messages, { role: "assistant", content: first.content }, { role: "user", content: [result(calls[0].id, "ONE"), result(calls[1].id, "DENIED", true)] }];
    const saveReceipt = sessionStore.saveReceipt.bind(sessionStore);
    let childIdentity: string | undefined;
    const receipts = spyOn(sessionStore, "saveReceipt").mockImplementation(async (...args) => {
      await saveReceipt(...args);
      if (args[2].response?.state === "completed") childIdentity = args[1];
    });
    let released: any;
    try { released = await (await send(host, full)).json(); } finally { receipts.mockRestore(); }
    expect(released.stop_reason).toBe("end_turn");
    const batch = await mcpDeliveries(log);
    expect(batch).toHaveLength(1);
    expect(batch[0]).toHaveLength(2);
    expect(JSON.stringify(batch[0])).toContain("ONE");
    expect(JSON.stringify(batch[0])).toContain("DENIED");
    expect(batch[0].some((entry: any) => entry.result?.isError === true)).toBe(true);
    for (const call of calls) expect((await sessionStore.toolCall(key, call.id))?.delivery).toBe("locally-handed-off");
    expect(childIdentity).toBeString();
    const child = await sessionStore.receipt(key, childIdentity!);
    expect(child?.state).toBe("completed");
    const deliveredRecords = await Promise.all(calls.map((call: any) => sessionStore.toolCall(key, call.id)));
    const deliveredPrompts = await promptLines();
    const prompts = (await readFile(join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").slice(before).filter((line) => line.includes(marker));
    expect(prompts).toHaveLength(1);
    // A different result for an already-delivered batch cannot overwrite the
    // completed child receipt or release the same batch a second time.
    const conflicting = [...messages, { role: "assistant", content: first.content }, { role: "user", content: [result(calls[0].id, "DIFFERENT"), result(calls[1].id, "DENIED", true)] }];
    const refused = await send(host, conflicting);
    expect(refused.status).toBe(400);
    expect((await refused.json()).error.message).toMatch(/conflict/i);
    expect(await promptLines()).toBe(deliveredPrompts);
    expect(await sessionStore.receipt(key, childIdentity!)).toEqual(child);
    expect(await mcpDeliveries(log)).toHaveLength(1);
    expect(await Promise.all(calls.map((call: any) => sessionStore.toolCall(key, call.id)))).toEqual(deliveredRecords);
  } finally { delete process.env.FAKE_ACP_MCP_RESULT_LOG; }
});

test("a failed continuation without a completed slice stays fail-closed when repeated", async () => {
  const host = "failed-continuation";
  const marker = "FAKE_MCP_QUOTA";
  const messages: any[] = [{ role: "user", content: marker }];
  const first = await (await send(host, messages)).json();
  expect(first.stop_reason).toBe("tool_use");
  const before = await promptLines();
  const continuation = continuationMessages(marker, first, ["EXECUTED_ONCE"]).messages;
  const failed = await send(host, continuation);
  expect(failed.status).toBe(429);
  const repeated = await send(host, continuation);
  expect(repeated.status).toBe(400);
  expect((await repeated.json()).error.code).toBe("agy_request_already_started");
  // The failed attempt is not re-executed on repeat.
  expect(await promptLines()).toBe(before);
});

const childSliceMarker = "SLICE_SOURCE_RESULT";
let realSlice: any[] | undefined;

/** Capture one genuine completed child slice from the fake native turn. */
async function sharedCompletedSlice(): Promise<any[]> {
  if (realSlice) return realSlice;
  const host = "host-review-slice-source";
  const previousLog = process.env.FAKE_ACP_MCP_RESULT_LOG;
  process.env.FAKE_ACP_MCP_RESULT_LOG = join(directory, "host-review-slice-source.mcp.jsonl");
  try {
    const messages: any[] = [{ role: "user", content: "FAKE_MCP SLICE_SOURCE" }];
    const first = await (await send(host, messages)).json();
    expect(first.stop_reason).toBe("tool_use");
    const call = first.content.find((part: any) => part.type === "tool_use");
    const saveReceipt = sessionStore.saveReceipt.bind(sessionStore);
    let events: any[] | undefined;
    const spy = spyOn(sessionStore, "saveReceipt").mockImplementation(async (...args) => {
      await saveReceipt(...args);
      if (args[2].response?.state === "completed") events = args[2].response.events;
    });
    try {
      const completed = await send(host, [...messages, { role: "assistant", content: first.content }, { role: "user", content: [result(call.id, childSliceMarker)] }]);
      expect(completed.status).toBe(200);
      await completed.json();
    } finally { spy.mockRestore(); }
    expect(events).toBeArray();
    expect(events!.length).toBeGreaterThan(0);
    return realSlice = events!;
  } finally {
    await closeHostBridges(host);
    if (previousLog === undefined) delete process.env.FAKE_ACP_MCP_RESULT_LOG;
    else process.env.FAKE_ACP_MCP_RESULT_LOG = previousLog;
  }
}

/** Real fixture-side MCP batches: one JSON line per resolved tools/call group. */
async function mcpDeliveries(path: string): Promise<any[][]> {
  try { return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
  catch { return []; }
}

/** Closing a bridge rejects its MCP waiters, so the fixture then records error
 *  responses. A tool result can only ever appear if one was really released. */
async function noMcpToolResult(path: string): Promise<boolean> {
  return (await mcpDeliveries(path)).flat().every((entry: any) => entry.result === undefined);
}

/** Drive a real parallel FAKE_MCP batch through its parked partial continuation.
 *  The returned child identity/digest are the durable ones that continuation
 *  wrote while the bridge still owns both unresolved RPC waiters. */
async function parkedPartialChild(host: string) {
  const messages: any[] = [{ role: "user", content: "FAKE_MCP_PARALLEL CHILD_RECEIPT" }];
  const first = await (await send(host, messages)).json();
  expect(first.stop_reason).toBe("tool_use");
  const calls = first.content.filter((part: any) => part.type === "tool_use");
  expect(calls).toHaveLength(2);
  const [key] = (await sessionStore.entries()).find(([, record]) => record.conversation?.hostSessionID === host)!;
  const bridge = hostBridge(key, host, directory);
  const continuation = [...messages, { role: "assistant", content: first.content }, { role: "user", content: [result(calls[0].id, "PARTIAL_ONE")] }];
  const saveReceipt = sessionStore.saveReceipt.bind(sessionStore);
  const writes: Array<{ id: string; receipt: any }> = [];
  let partial: any;
  const spy = spyOn(sessionStore, "saveReceipt").mockImplementation(async (...args) => {
    await saveReceipt(...args);
    writes.push({ id: args[1], receipt: args[2] });
  });
  try {
    const response = await send(host, continuation);
    expect(response.status).toBe(400);
    partial = await response.json();
  } finally { spy.mockRestore(); }
  expect(partial.error.code).toBe("agy_tool_results_pending");
  const parked = writes.filter((write) => write.receipt.response?.state === "parked").at(-1);
  expect(parked).toBeDefined();
  const records = await Promise.all(calls.map((call: any) => sessionStore.toolCall(key, call.id)));
  // Holding the true owner: both RPC waiters are still unresolved.
  expect((bridge as any).waiting).toBe(true);
  expect((bridge as any).pending.size).toBe(2);
  for (const record of records) expect(["delivery-attempted", "locally-handed-off"]).not.toContain(record?.delivery);
  return { key, bridge, calls, continuation, messages, assistant: first.content, identity: parked!.id, digest: parked!.receipt.response.digest as string, records };
}

test("an exact completed child receipt replays its slice without releasing parked waiters", async () => {
  const host = "host-review-child-replay";
  const log = join(directory, "host-review-child-replay.mcp.jsonl");
  await rm(log, { force: true });
  process.env.FAKE_ACP_MCP_RESULT_LOG = log;
  try {
    const child = await parkedPartialChild(host);
    await sessionStore.saveReceipt(child.key, child.identity, { state: "completed", response: { digest: child.digest, state: "completed", events: await sharedCompletedSlice() } });
    const beforePrompt = await promptLines();
    const beforeRecords = await Promise.all(child.calls.map((call: any) => sessionStore.toolCall(child.key, call.id)));
    const reads: Array<[string, string]> = [];
    let deliveries = 0;
    let saves = 0;
    const readReceipt = sessionStore.receipt.bind(sessionStore);
    const readSpy = spyOn(sessionStore, "receipt").mockImplementation(async (...args) => { reads.push([args[0], args[1]]); return readReceipt(...args); });
    const deliveryStore = sessionStore.toolDelivery.bind(sessionStore);
    const deliverySpy = spyOn(sessionStore, "toolDelivery").mockImplementation(async (...args) => { deliveries++; return deliveryStore(...args); });
    const resultStore = sessionStore.saveToolResult.bind(sessionStore);
    const resultSpy = spyOn(sessionStore, "saveToolResult").mockImplementation(async (...args) => { saves++; return resultStore(...args); });
    let response: Response;
    try { response = await send(host, child.continuation); } finally { readSpy.mockRestore(); deliverySpy.mockRestore(); resultSpy.mockRestore(); }
    const body = await response.json();
    expect({ status: response.status, code: body.error?.code, message: body.error?.message }).toEqual({ status: 200, code: undefined, message: undefined });
    expect(body.stop_reason).toBe("end_turn");
    expect(JSON.stringify(body)).toContain(childSliceMarker);
    expect(await promptLines()).toBe(beforePrompt);
    expect(reads).toContainEqual([child.key, child.identity]);
    expect(deliveries).toBe(0);
    expect(saves).toBe(0);
    expect((child.bridge as any).waiting).toBe(true);
    expect((child.bridge as any).pending.size).toBe(2);
    expect(await mcpDeliveries(log)).toHaveLength(0);
    const receipt = await sessionStore.receipt(child.key, child.identity);
    expect(receipt?.state).toBe("completed");
    expect(receipt?.response?.events).toEqual(await sharedCompletedSlice());
    expect(await Promise.all(child.calls.map((call: any) => sessionStore.toolCall(child.key, call.id)))).toEqual(beforeRecords);
  } finally {
    delete process.env.FAKE_ACP_MCP_RESULT_LOG;
    await closeHostBridges(host);
  }
});

test("an active cached harness-failure slice is rejected before any success or answer replay", async () => {
  const host = "host-review-cached-harness-failure";
  const log = join(directory, "host-review-cached-harness-failure.mcp.jsonl");
  await rm(log, { force: true });
  process.env.FAKE_ACP_MCP_RESULT_LOG = log;
  try {
    const slice = await sharedCompletedSlice();
    const child = await parkedPartialChild(host);
    // A genuine completed slice whose first answer text is a harness failure:
    // well formed, matching digest, successful terminal, yet not replayable.
    const failure = "Agent execution error: Harness process exited unexpectedly (WS close code 1011).\nHarness stderr:\nSWEEP_FAILURE_TEXT";
    const poisoned = [
      { event: "update", sessionId: slice[0].sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: failure } } },
      ...slice,
    ];
    await sessionStore.saveReceipt(child.key, child.identity, { state: "completed", response: { digest: child.digest, state: "completed", events: poisoned } });
    const beforePrompt = await promptLines();
    const response = await send(host, child.continuation);
    const body = await response.json();
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(body.content).toBeUndefined();
    expect(body.stop_reason).toBeUndefined();
    expect(body.error).toBeDefined();
    expect(await promptLines()).toBe(beforePrompt);
    // The cached failure retires the original native turn; no success leaks and
    // no host result is released.
    expect(hostBridge(child.key, host, directory)).not.toBe(child.bridge);
    expect((child.bridge as any).closed).toBe(true);
    expect(await noMcpToolResult(log)).toBe(true);
    expect((await sessionStore.receipt(child.key, child.identity))?.response?.events).toEqual(poisoned);
    // Repeating the same continuation replays the same failure path, not a new
    // execution and not a resumed worker.
    const repeated = await send(host, child.continuation);
    const repeatedBody = await repeated.json();
    expect(repeated.status).toBeGreaterThanOrEqual(400);
    expect(repeatedBody.content).toBeUndefined();
    expect(repeatedBody.error).toBeDefined();
    expect(await promptLines()).toBe(beforePrompt);
    const { sessionPool } = await import("../src/session-pool.js");
    expect((await sessionPool.status(child.key)).active).toBe(false);
  } finally {
    delete process.env.FAKE_ACP_MCP_RESULT_LOG;
    await closeHostBridges(host);
  }
});

test("child receipt tombstones and stale slices fail closed before ledger or delivery changes", async () => {
  const slice = await sharedCompletedSlice();
  const cases: Array<{ name: string; preset: (digest: string) => any; code: string }> = [
    { name: "wrong-digest", preset: () => ({ state: "completed", response: { digest: "0".repeat(64), state: "completed", events: slice } }), code: "agy_completed_response_unavailable" },
    { name: "missing-events", preset: (digest) => ({ state: "completed", response: { digest, state: "completed" } }), code: "agy_completed_response_unavailable" },
    { name: "cancelled-events", preset: (digest) => ({ state: "completed", response: { digest, state: "completed", events: [...slice.slice(0, -1), { ...slice.at(-1), result: { stopReason: "cancelled" } }] } }), code: "agy_completed_response_unavailable" },
    { name: "submitted", preset: (digest) => ({ state: "submitted", response: { digest, state: "running" } }), code: "agy_request_already_started" },
    { name: "parked", preset: (digest) => ({ state: "parked", response: { digest, state: "parked" } }), code: "agy_request_already_started" },
    { name: "uncertain", preset: () => ({ state: "uncertain" }), code: "agy_request_already_started" },
  ];
  for (const entry of cases) {
    const host = `host-review-child-${entry.name}`;
    const log = join(directory, `host-review-child-${entry.name}.mcp.jsonl`);
    await rm(log, { force: true });
    process.env.FAKE_ACP_MCP_RESULT_LOG = log;
    try {
      const child = await parkedPartialChild(host);
      await sessionStore.saveReceipt(child.key, child.identity, entry.preset(child.digest));
      const beforeReceipt = await sessionStore.receipt(child.key, child.identity);
      const beforeRecords = await Promise.all(child.calls.map((call: any) => sessionStore.toolCall(child.key, call.id)));
      const beforePrompt = await promptLines();
      const reads: Array<[string, string]> = [];
      let deliveries = 0;
      const readReceipt = sessionStore.receipt.bind(sessionStore);
      const readSpy = spyOn(sessionStore, "receipt").mockImplementation(async (...args) => { reads.push([args[0], args[1]]); return readReceipt(...args); });
      const deliveryStore = sessionStore.toolDelivery.bind(sessionStore);
      const deliverySpy = spyOn(sessionStore, "toolDelivery").mockImplementation(async (...args) => { deliveries++; return deliveryStore(...args); });
      let response: Response;
      let body: any;
      try { response = await send(host, child.continuation); body = await response.json(); } finally { readSpy.mockRestore(); deliverySpy.mockRestore(); }
      expect(response.status).toBe(400);
      expect(body.content).toBeUndefined();
      expect(body.error.code).toBe(entry.code);
      expect(reads).toContainEqual([child.key, child.identity]);
      expect(deliveries).toBe(0);
      // The stored tombstone, tool evidence and fixture-side result are untouched.
      expect(await sessionStore.receipt(child.key, child.identity)).toEqual(beforeReceipt);
      expect(await Promise.all(child.calls.map((call: any) => sessionStore.toolCall(child.key, call.id)))).toEqual(beforeRecords);
      expect(await promptLines()).toBe(beforePrompt);
      expect(await noMcpToolResult(log)).toBe(true);
    } finally {
      delete process.env.FAKE_ACP_MCP_RESULT_LOG;
      await closeHostBridges(host);
    }
  }
});

test("operative calls without an originating request fail closed before delivery", async () => {
  {
    const host = "host-review-origin-missing";
    const log = join(directory, "host-review-origin-missing.mcp.jsonl");
    await rm(log, { force: true });
    process.env.FAKE_ACP_MCP_RESULT_LOG = log;
    try {
      const messages: any[] = [{ role: "user", content: "FAKE_MCP ORIGIN_MISSING" }];
      const first = await (await send(host, messages)).json();
      const call = first.content.find((part: any) => part.type === "tool_use");
      const [key] = (await sessionStore.entries()).find(([, record]) => record.conversation?.hostSessionID === host)!;
      const record = (await sessionStore.toolCall(key, call.id))!;
      // Preserve the operative call but remove its request origin.
      await sessionStore.saveToolCall(key, call.id, { ...record, requestId: "" });
      const before = await sessionStore.toolCall(key, call.id);
      const beforePrompt = await promptLines();
      const response = await send(host, [...messages, { role: "assistant", content: first.content }, { role: "user", content: [result(call.id, "MUST_NOT_DELIVER")] }]);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.content).toBeUndefined();
      expect(body.error.code).toBe("agy_request_origin_missing");
      expect(await sessionStore.toolCall(key, call.id)).toEqual(before);
      expect(await promptLines()).toBe(beforePrompt);
      expect(await noMcpToolResult(log)).toBe(true);
    } finally {
      delete process.env.FAKE_ACP_MCP_RESULT_LOG;
      await closeHostBridges(host);
    }
  }
  {
    const host = "host-review-origin-unrecorded";
    const log = join(directory, "host-review-origin-unrecorded.mcp.jsonl");
    await rm(log, { force: true });
    process.env.FAKE_ACP_MCP_RESULT_LOG = log;
    try {
      const messages: any[] = [{ role: "user", content: "FAKE_MCP ORIGIN_UNRECORDED" }];
      await (await send(host, messages)).json();
      const forged = { type: "tool_use", id: "toolu_unrecorded_origin", name: "shell", input: { index: 0 } };
      const beforePrompt = await promptLines();
      const response = await send(host, [...messages, { role: "assistant", content: [forged] }, { role: "user", content: [result(forged.id, "MUST_NOT_DELIVER")] }]);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.content).toBeUndefined();
      expect(body.error.message).toContain("no originating call");
      expect(await promptLines()).toBe(beforePrompt);
      expect(await noMcpToolResult(log)).toBe(true);
    } finally {
      delete process.env.FAKE_ACP_MCP_RESULT_LOG;
      await closeHostBridges(host);
    }
  }
});

test("a cancelled native terminal leaves a tombstone instead of a completed child response", async () => {
  const host = "host-review-cancelled-terminal";
  const marker = "FAKE_MCP CANCEL_TOMBSTONE";
  const messages: any[] = [{ role: "user", content: marker }];
  const first = await (await send(host, messages)).json();
  expect(first.stop_reason).toBe("tool_use");
  const call = first.content.find((part: any) => part.type === "tool_use");
  const [key] = (await sessionStore.entries()).find(([, record]) => record.conversation?.hostSessionID === host)!;
  const origin = String((await sessionStore.toolCall(key, call.id))!.requestId);
  await closeHostBridges(host);
  const continuation = [...messages, { role: "assistant", content: first.content }, { role: "user", content: [result(call.id, "EXECUTED_TOMBSTONE"), { type: "text", text: "FAKE_CANCELLED" }] }];
  const saveReceipt = sessionStore.saveReceipt.bind(sessionStore);
  const writes: Array<{ id: string; receipt: any }> = [];
  const spy = spyOn(sessionStore, "saveReceipt").mockImplementation(async (...args) => {
    await saveReceipt(...args);
    writes.push({ id: args[1], receipt: args[2] });
  });
  let response: Response;
  let body: any;
  try { response = await send(host, continuation); body = await response.json(); } finally { spy.mockRestore(); }
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(body.content).toBeUndefined();
  expect(body.error).toBeDefined();
  const child = writes.find((write) => write.id !== origin);
  expect(child).toBeDefined();
  const tombstone = await sessionStore.receipt(key, child!.id);
  expect(tombstone?.state).not.toBe("completed");
  expect(["submitted", "interrupted", "uncertain"]).toContain(tombstone?.state);
  expect(tombstone?.response?.state).not.toBe("completed");
  const prompts = await promptCountFor(marker);
  expect(prompts).toBe(2);
  const repeated = await send(host, continuation);
  expect(repeated.status).toBe(400);
  expect((await repeated.json()).error.code).toBe("agy_request_already_started");
  expect(await promptCountFor(marker)).toBe(prompts);
});

test("a failed completed-slice write exposes no success and preserves delivered ownership", async () => {
  const host = "host-review-completed-write-fail";
  const log = join(directory, "host-review-completed-write-fail.mcp.jsonl");
  await rm(log, { force: true });
  process.env.FAKE_ACP_MCP_RESULT_LOG = log;
  try {
    const messages: any[] = [{ role: "user", content: "FAKE_MCP WRITE_FAIL_KEEPS_OWNER" }];
    const first = await (await send(host, messages)).json();
    expect(first.stop_reason).toBe("tool_use");
    const call = first.content.find((part: any) => part.type === "tool_use");
    const [key] = (await sessionStore.entries()).find(([, record]) => record.conversation?.hostSessionID === host)!;
    const owned = (await sessionStore.toolCall(key, call.id))!;
    const origin = String(owned.requestId);
    const continuation = [...messages, { role: "assistant", content: first.content }, { role: "user", content: [result(call.id, "DELIVERED_ONCE")] }];
    const saveReceipt = sessionStore.saveReceipt.bind(sessionStore);
    const writes: Array<{ id: string; label: string }> = [];
    const spy = spyOn(sessionStore, "saveReceipt").mockImplementation(async (...args) => {
      writes.push({ id: args[1], label: `${args[2].state}:${args[2].response?.state ?? "none"}` });
      // Only the successful terminal response write fails; every other persist succeeds.
      if (args[2].response?.state === "completed") throw new Error("injected response.completed write failure");
      await saveReceipt(...args);
    });
    let response: Response;
    let body: any;
    try { response = await send(host, continuation); body = await response.json(); } finally { spy.mockRestore(); }
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(body.content).toBeUndefined();
    expect(body.error).toBeDefined();
    expect(writes.map((write) => write.label)).toContain("submitted:running");
    const attempted = writes.find((write) => write.label === "completed:completed");
    expect(attempted).toBeDefined();
    const promptAfterFailure = await promptLines();
    const record = (await sessionStore.toolCall(key, call.id))!;
    expect(record.result?.content).toEqual([{ type: "text", text: "DELIVERED_ONCE" }]);
    expect(record.delivery).toBe("locally-handed-off");
    expect(record.requestId).toBe(origin);
    expect(record.hostSessionID).toBe(host);
    const child = await sessionStore.receipt(key, attempted!.id);
    expect(child?.state).not.toBe("completed");
    expect(["submitted", "interrupted", "uncertain"]).toContain(child?.state);
    expect(child?.response?.state).not.toBe("completed");
    const originReceipt = await sessionStore.receipt(key, origin);
    expect(originReceipt?.state).toBe("completed");
    expect(originReceipt?.events?.length).toBeGreaterThan(0);
    const batch = await mcpDeliveries(log);
    expect(batch).toHaveLength(1);
    expect(JSON.stringify(batch[0])).toContain("DELIVERED_ONCE");
    const repeated = await send(host, continuation);
    expect(repeated.status).toBe(400);
    expect((await repeated.json()).error.code).toBe("agy_request_already_started");
    expect(await promptLines()).toBe(promptAfterFailure);
    expect(await mcpDeliveries(log)).toHaveLength(1);
    expect(await sessionStore.toolCall(key, call.id)).toMatchObject({ result: record.result, delivery: "locally-handed-off", requestId: origin });
  } finally {
    delete process.env.FAKE_ACP_MCP_RESULT_LOG;
    await closeHostBridges(host);
  }
});

test("a known tool result without the assistant call replays one slice across headers and bridge restarts", async () => {
  const host = "host-admission-known-result";
  const marker = "FAKE_MCP KNOWN_RESULT_NO_CALL";
  const messages: any[] = [{ role: "user", content: marker }];
  const first = await (await send(host, messages)).json();
  expect(first.stop_reason).toBe("tool_use");
  const call = first.content.find((part: any) => part.type === "tool_use");
  // Keep the initial user message (extendsBoundary) but omit the assistant
  // call: currentGroup is empty and only the known result identifies the turn.
  const continuation = [messages[0], { role: "user", content: [result(call.id, "KNOWN_RESULT_ONCE")] }];
  const answer = await (await send(host, continuation)).json();
  expect(answer.stop_reason).toBe("end_turn");
  expect(JSON.stringify(answer)).toContain("KNOWN_RESULT_ONCE");
  const prompts = await promptCountFor(marker);
  const shape = (value: any) => ({ content: value.content, stop_reason: value.stop_reason });
  // The same result replays the same slice for any header shape.
  for (const headers of [{}, { "x-opencode-antigravity-message": "first-request" }, { "x-opencode-antigravity-message": "different-header" }]) {
    const replay = await send(host, continuation, {}, headers);
    expect(replay.status).toBe(200);
    expect(shape(await replay.json())).toEqual(shape(answer));
  }
  expect(await promptCountFor(marker)).toBe(prompts);
  // A rebuilt bridge (restart) reads the same durable slice, not a new run.
  await closeHostBridges(host);
  const restarted = await send(host, continuation);
  expect(restarted.status).toBe(200);
  expect(shape(await restarted.json())).toEqual(shape(answer));
  expect(await promptCountFor(marker)).toBe(prompts);
});

test("a repeated partial stays conservatively parked and the full batch still delivers on the original turn", async () => {
  const host = "host-admission-double-partial";
  const log = join(directory, "host-admission-double-partial.mcp.jsonl");
  await rm(log, { force: true });
  process.env.FAKE_ACP_MCP_RESULT_LOG = log;
  try {
    const child = await parkedPartialChild(host);
    const before = await promptLines();
    const [key, record] = (await sessionStore.entries()).find(([, r]) => r.conversation?.hostSessionID === host)!;
    const epoch = record.conversation?.epoch;
    const sessionId = record.sessionId;
    // The identical second partial hits the parked child receipt: a
    // conservative rejection must not retire the original bridge or waiters,
    // nor rewrite any ledger evidence.
    const reads: Array<[string, string]> = [];
    let writes = 0;
    let saves = 0;
    const receiptStore = sessionStore.receipt.bind(sessionStore);
    const readSpy = spyOn(sessionStore, "receipt").mockImplementation(async (...args) => { reads.push([args[0], args[1]]); return receiptStore(...args); });
    const saveReceipt = sessionStore.saveReceipt.bind(sessionStore);
    const writeSpy = spyOn(sessionStore, "saveReceipt").mockImplementation(async (...args) => { writes++; return saveReceipt(...args); });
    const resultStore = sessionStore.saveToolResult.bind(sessionStore);
    const resultSpy = spyOn(sessionStore, "saveToolResult").mockImplementation(async (...args) => { saves++; return resultStore(...args); });
    let second: Response;
    let secondBody: any;
    try { second = await send(host, child.continuation); secondBody = await second.json(); } finally { readSpy.mockRestore(); writeSpy.mockRestore(); resultSpy.mockRestore(); }
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(secondBody.content).toBeUndefined();
    expect(secondBody.error.code).toBe("agy_request_already_started");
    expect(reads).toContainEqual([child.key, child.identity]);
    expect(writes).toBe(0);
    expect(saves).toBe(0);
    expect(hostBridge(child.key, host, directory)).toBe(child.bridge);
    expect((child.bridge as any).closed).toBe(false);
    expect((child.bridge as any).pending.size).toBe(2);
    const { sessionPool } = await import("../src/session-pool.js");
    expect((await sessionPool.status(child.key)).active).toBe(true);
    // Not even error deliveries: both waiters are still held by the owner.
    expect(await mcpDeliveries(log)).toHaveLength(0);
    expect(await promptLines()).toBe(before);
    // The completed batch delivers once on the original turn and generation.
    const full = [...child.messages, { role: "assistant", content: child.assistant }, { role: "user", content: [result(child.calls[0].id, "PARTIAL_ONE"), result(child.calls[1].id, "SECOND_TWO")] }];
    const completed = await send(host, full);
    expect(completed.status).toBe(200);
    const done = await completed.json();
    expect(done.stop_reason).toBe("end_turn");
    expect(JSON.stringify(done)).toContain("PARTIAL_ONE");
    expect(JSON.stringify(done)).toContain("SECOND_TWO");
    const batch = await mcpDeliveries(log);
    expect(batch).toHaveLength(1);
    expect(batch[0]).toHaveLength(2);
    expect(batch[0].every((entry: any) => entry.result)).toBe(true);
    for (const call of child.calls) expect((await sessionStore.toolCall(child.key, call.id))?.delivery).toBe("locally-handed-off");
    expect(await promptLines()).toBe(before);
    const after = await sessionStore.get(key);
    expect(after?.conversation?.epoch).toBe(epoch);
    expect(after?.sessionId).toBe(sessionId);
  } finally {
    delete process.env.FAKE_ACP_MCP_RESULT_LOG;
    await closeHostBridges(host);
  }
});

test("a completed-slice write that fails after persisting cannot be replayed as success", async () => {
  for (const variant of ["initial", "continuation"]) {
    const host = `host-admission-postsave-eio-${variant}`;
    const log = join(directory, `host-admission-postsave-eio-${variant}.mcp.jsonl`);
    const marker = variant === "initial" ? "PLAIN_INITIAL_POSTSAVE" : "FAKE_MCP WRITE_FAIL_POSTSAVE";
    await rm(log, { force: true });
    process.env.FAKE_ACP_MCP_RESULT_LOG = log;
    try {
      const initialMessages: any[] = [{ role: "user", content: marker }];
      let requestMessages = initialMessages;
      let key: string | undefined;
      let call: any;
      let origin: string | undefined;
      if (variant === "continuation") {
        const first = await (await send(host, initialMessages)).json();
        expect(first.stop_reason).toBe("tool_use");
        call = first.content.find((part: any) => part.type === "tool_use");
        [key] = (await sessionStore.entries()).find(([, record]) => record.conversation?.hostSessionID === host)!;
        origin = String((await sessionStore.toolCall(key, call.id))!.requestId);
        requestMessages = [...initialMessages, { role: "assistant", content: first.content }, { role: "user", content: [result(call.id, "DELIVERED_POSTSAVE")] }];
      }
      const saveReceipt = sessionStore.saveReceipt.bind(sessionStore);
      let injected = false;
      let attempted: string | undefined;
      const spy = spyOn(sessionStore, "saveReceipt").mockImplementation(async (...args) => {
        const completes = args[2].response?.state === "completed";
        if (!completes) return saveReceipt(...args);
        // Fault injected only after the real durable write has happened: the
        // post-rename window, not the pre-write one already covered elsewhere.
        await saveReceipt(...args);
        attempted = args[1];
        if (!injected) { injected = true; throw Object.assign(new Error("injected post-rename EIO"), { code: "EIO" }); }
      });
      let response: Response;
      let body: any;
      try { response = await send(host, requestMessages); body = await response.json(); } finally { spy.mockRestore(); }
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(body.content).toBeUndefined();
      expect(body.error).toBeDefined();
      expect(attempted).toBeString();
      if (!key) [key] = (await sessionStore.entries()).find(([, record]) => record.conversation?.hostSessionID === host)!;
      const promptAfterFailure = await promptCountFor(marker);
      if (variant === "continuation") {
        const record = (await sessionStore.toolCall(key!, call.id))!;
        expect(record.result?.content).toEqual([{ type: "text", text: "DELIVERED_POSTSAVE" }]);
        expect(record.delivery).toBe("locally-handed-off");
        expect(record.requestId).toBe(origin);
        const batch = await mcpDeliveries(log);
        expect(batch).toHaveLength(1);
        expect(JSON.stringify(batch[0])).toContain("DELIVERED_POSTSAVE");
      }
      // Both the initial snapshot and the continuation snapshot must demote a
      // post-rename failure; neither may keep a replayable completed response.
      const stored = await sessionStore.receipt(key!, attempted!);
      expect(stored?.state).not.toBe("completed");
      expect(stored?.response?.state).not.toBe("completed");
      const repeated = await send(host, requestMessages);
      const repeatedBody = await repeated.json();
      expect(repeated.status).toBeGreaterThanOrEqual(400);
      expect(repeatedBody.content).toBeUndefined();
      expect(await promptCountFor(marker)).toBe(promptAfterFailure);
      if (variant === "continuation") {
        expect(await mcpDeliveries(log)).toHaveLength(1);
        expect(await sessionStore.toolCall(key!, call.id)).toMatchObject({ result: { content: [{ type: "text", text: "DELIVERED_POSTSAVE" }] }, delivery: "locally-handed-off", requestId: origin });
      }
    } finally {
      delete process.env.FAKE_ACP_MCP_RESULT_LOG;
      await closeHostBridges(host);
    }
  }
});

test("an unknown operative call is rejected before any ledger write across parked, profile-change and inactive paths", async () => {
  for (const variant of ["parked", "profile-change", "inactive"]) {
    const host = `host-admission-unknown-group-${variant}`;
    const log = join(directory, `host-admission-unknown-group-${variant}.mcp.jsonl`);
    await rm(log, { force: true });
    process.env.FAKE_ACP_MCP_RESULT_LOG = log;
    try {
      const forged = { type: "tool_use", id: "toolu_unknown_group_call", name: "shell", input: { index: 7 } };
      let messages: any[];
      let child: Awaited<ReturnType<typeof parkedPartialChild>> | undefined;
      let beforeRecords: any[] = [];
      if (variant === "inactive") {
        // A completed plain turn, then a new request whose latest assistant
        // group has an unknown call but no result: operative coverage must not
        // silently ignore the group just because nothing produced a result.
        const plain = [{ role: "user", content: "PLAIN_INACTIVE_ORIGIN" }];
        expect((await send(host, plain)).status).toBe(200);
        messages = [...plain, { role: "assistant", content: [forged] }];
      } else {
        child = await parkedPartialChild(host);
        beforeRecords = await Promise.all(child.calls.map((call: any) => sessionStore.toolCall(child.key, call.id)));
        messages = [...child.messages, { role: "assistant", content: [...child.assistant, forged] }, { role: "user", content: [result(child.calls[0].id, "PARTIAL_ONE")] }];
      }
      const changedTools = structuredClone(schema);
      changedTools[0].description = "changed for admission";
      const before = await promptLines();
      const writeLog: Array<{ id: string; receipt: any }> = [];
      let writes = 0;
      let saves = 0;
      let reads = 0;
      const receiptStore = sessionStore.receipt.bind(sessionStore);
      const receiptSpy = spyOn(sessionStore, "receipt").mockImplementation(async (...args) => { reads++; return receiptStore(...args); });
      const saveReceipt = sessionStore.saveReceipt.bind(sessionStore);
      const receiptWriteSpy = spyOn(sessionStore, "saveReceipt").mockImplementation(async (...args) => { writes++; writeLog.push({ id: args[1], receipt: args[2] }); return saveReceipt(...args); });
      const resultStore = sessionStore.saveToolResult.bind(sessionStore);
      const resultSpy = spyOn(sessionStore, "saveToolResult").mockImplementation(async (...args) => { saves++; return resultStore(...args); });
      let response: Response;
      let body: any;
      try { response = await send(host, messages, variant === "profile-change" ? { tools: changedTools } : {}); body = await response.json(); } finally { receiptSpy.mockRestore(); receiptWriteSpy.mockRestore(); resultSpy.mockRestore(); }
      expect(response.status).toBe(400);
      expect(body.content).toBeUndefined();
      expect(body.error.code).toBe("agy_request_origin_missing");
      // Admission itself must not persist results or read the response cache.
      expect(saves).toBe(0);
      expect(reads).toBe(0);
      if (variant === "inactive") {
        expect(writes).toBe(0);
      } else {
        // At most the originating turn's own abort tombstone may follow the
        // decision; no parked/submitted/completed evidence may be written.
        expect(writeLog.length).toBeLessThanOrEqual(1);
        for (const write of writeLog) {
          expect(write.id).toBe(String(child!.records[0]?.requestId));
          expect(write.receipt).toMatchObject({ state: "interrupted" });
        }
      }
      expect(await promptLines()).toBe(before);
      if (child) expect(await Promise.all(child.calls.map((call: any) => sessionStore.toolCall(child.key, call.id)))).toEqual(beforeRecords);
      expect(await noMcpToolResult(log)).toBe(true);
    } finally {
      delete process.env.FAKE_ACP_MCP_RESULT_LOG;
      await closeHostBridges(host);
    }
  }
});

test("legacy no-header receipts are recognized after normalization and stay fail-closed", async () => {
  const { turnIdentity } = await import("../src/session-pool.js");
  const { normalizePrompt, hostInstructions } = await import("../src/prompt.js");
  const cases = [
    { name: "uncertain", receipt: { state: "uncertain" } },
    { name: "interrupted", receipt: { state: "interrupted" } },
    {
      name: "completed-legacy",
      receipt: {
        state: "completed",
        events: [
          { event: "update", sessionId: "legacy-native-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "STALE_NATIVE_HISTORY" } } },
          { event: "result", sessionId: "legacy-native-session", result: { stopReason: "end_turn" } },
        ],
      },
    },
  ];
  for (const entry of cases) {
    const host = `host-legacy-${entry.name}`;
    const warm = `LEGACY_WARM_${entry.name}`;
    const marker = `LEGACY_TEST_${entry.name}`;
    // A real completed plain turn establishes the exact session key and model
    // the proxy uses for this no-header request.
    expect((await send(host, [{ role: "user", content: warm }])).status).toBe(200);
    const [key, record] = (await sessionStore.entries()).find(([, r]) => r.conversation?.hostSessionID === host)!;
    // The old unchanged turn formula: same exported helpers, real normalized
    // turn shape; no identity/canonical/normalize algorithm is re-implemented.
    const normalized = await normalizePrompt([{ role: "user", content: marker }], { allowedRoots: [directory], hostTools: true });
    const identity = turnIdentity({
      key,
      prompt: normalized.blocks,
      messages: normalized.messages,
      priorMessages: normalized.priorMessages.filter((message: any) => message.role !== "system"),
      instructions: hostInstructions("HOST_INSTRUCTIONS_UNTRUNCATED"),
      settings: { model: record.model } as any,
    } as any);
    await sessionStore.saveReceipt(key, identity, entry.receipt as any);
    const tombstone = await sessionStore.receipt(key, identity);
    const promptsBefore = await promptLines();
    const response = await send(host, [{ role: "user", content: marker }]);
    const body = await response.json();
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(body.content).toBeUndefined();
    expect(body.error).toBeDefined();
    // The native turn must never start for this request ...
    expect(await promptCountFor(marker)).toBe(0);
    expect(await promptLines()).toBe(promptsBefore);
    // ... and a legacy completed receipt must not replay its native history.
    expect(JSON.stringify(body)).not.toContain("STALE_NATIVE_HISTORY");
    // The old tombstone survives byte-for-byte.
    expect(await sessionStore.receipt(key, identity)).toEqual(tombstone);
  }
});

test("a call joining during the park receipt write stays in one pending batch", async () => {
  const host = "host-parkrace-late-call";
  const marker = "FAKE_MCP_PARALLEL PARK_RACE";
  const log = join(directory, "host-parkrace-late-call.mcp.jsonl");
  await rm(log, { force: true });
  process.env.FAKE_ACP_MCP_RESULT_LOG = log;
  try {
    const messages: any[] = [{ role: "user", content: marker }];
    const saveReceipt = sessionStore.saveReceipt.bind(sessionStore);
    let callParkWrites = 0;
    let parkWrites = 0;
    // Open the real persisted-receipt window deterministically: the second
    // concurrent tools/call joins pending while the park receipt is written.
    const spy = spyOn(sessionStore, "saveReceipt").mockImplementation(async (...args) => {
      if (args[2].state === "parked" && !args[2].response) {
        callParkWrites++;
        if (callParkWrites === 2) await Bun.sleep(50);
      }
      if (args[2].state === "parked" && args[2].response?.state === "parked") { parkWrites++; await Bun.sleep(100); }
      return saveReceipt(...args);
    });
    let first: any;
    try { first = await (await send(host, messages)).json(); } finally { spy.mockRestore(); }
    expect(first.stop_reason).toBe("tool_use");
    const calls = first.content.filter((part: any) => part.type === "tool_use");
    // The response really exposed both calls, including the late arrival.
    expect(calls).toHaveLength(2);
    expect(callParkWrites).toBe(2);
    expect(parkWrites).toBe(1);
    const [key, record] = (await sessionStore.entries()).find(([, r]) => r.conversation?.hostSessionID === host)!;
    const epoch = record.conversation?.epoch;
    const sessionId = record.sessionId;
    // Only the first result arrives: both exposed calls must still belong to
    // the pending batch, so this stays fail-closed and delivers nothing.
    const partial = [...messages, { role: "assistant", content: first.content }, { role: "user", content: [result(calls[0].id, "RACE_FIRST")] }];
    let toolDeliveries = 0;
    const deliveryStore = sessionStore.toolDelivery.bind(sessionStore);
    const deliverySpy = spyOn(sessionStore, "toolDelivery").mockImplementation(async (...args) => { toolDeliveries++; return deliveryStore(...args); });
    let response: Response;
    let partialBody: any;
    try { response = await send(host, partial); partialBody = await response.json(); } finally { deliverySpy.mockRestore(); }
    expect(response.status).toBe(400);
    expect(partialBody.error.code).toBe("agy_tool_results_pending");
    expect(toolDeliveries).toBe(0);
    expect(await noMcpToolResult(log)).toBe(true);
    const firstRecord = await sessionStore.toolCall(key, calls[0].id);
    const secondRecord = await sessionStore.toolCall(key, calls[1].id);
    expect(firstRecord?.resultDigest).toBeString();
    expect(firstRecord?.delivery).toBe("result-persisted");
    expect(secondRecord?.resultDigest).toBeUndefined();
    // The full batch completes on the original turn and delivers both once.
    const promptsBefore = await promptLines();
    const full = [...messages, { role: "assistant", content: first.content }, { role: "user", content: [result(calls[0].id, "RACE_FIRST"), result(calls[1].id, "RACE_SECOND")] }];
    const completed = await send(host, full);
    const done = await completed.json();
    expect(completed.status).toBe(200);
    expect(done.stop_reason).toBe("end_turn");
    expect(JSON.stringify(done)).toContain("RACE_FIRST");
    expect(JSON.stringify(done)).toContain("RACE_SECOND");
    const batch = await mcpDeliveries(log);
    expect(batch).toHaveLength(1);
    expect(batch[0]).toHaveLength(2);
    expect(JSON.stringify(batch[0])).toContain("RACE_FIRST");
    expect(JSON.stringify(batch[0])).toContain("RACE_SECOND");
    expect(await promptLines()).toBe(promptsBefore);
    expect((await sessionStore.toolCall(key, calls[0].id))?.delivery).toBe("locally-handed-off");
    expect((await sessionStore.toolCall(key, calls[1].id))?.delivery).toBe("locally-handed-off");
    const after = await sessionStore.get(key);
    expect(after?.conversation?.epoch).toBe(epoch);
    expect(after?.sessionId).toBe(sessionId);
  } finally {
    delete process.env.FAKE_ACP_MCP_RESULT_LOG;
    await closeHostBridges(host);
  }
});
