import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgyError } from "../src/errors.js";
import { geminiJson, geminiStream, parseGeminiContent } from "../src/gemini-content.js";
import { openAIJson, openAIStream } from "../src/openai-chat.js";
import {
  anthropicStream, jsonMessage, parseMessage, streamTurn, textTurn,
  type ClientToolCall, type ServiceTurnEvent,
} from "../src/service-messages.js";
import { buildBoundedHistory, extractTextContent, normalizePrompt } from "../src/prompt.js";
import { LOCAL_API_KEY, SESSION_HEADER } from "../src/constants.js";
import type { AcpServerDetection } from "../src/acp-detect.js";
import { fixtureCompatibility } from "./fixtures/compatibility.js";

/**
 * Independent parity regression tests for the plugin entrypoint (loopback
 * Anthropic proxy) and the standalone agy-api entrypoints. Both sides must run
 * the real fixture ACP (mock authentication/compatibility only) so assertions
 * land on the actual `FAKE_ACP_PROMPT_LOG` prompt; nothing here fabricates ACP
 * content. Event-stream cases use explicit AcpEvents and are marked simulated.
 */

const fixture = join(import.meta.dir, "fixtures", "fake-acp.mjs");
const environmentKeys = [
  "OPENCODE_ANTIGRAVITY_ACP_PATH", "OPENCODE_ANTIGRAVITY_DATA_DIR", "GEMINI_HOME",
  "OPENCODE_ANTIGRAVITY_MODELS_DEV", "FAKE_ACP_PROMPT_LOG",
  "OPENCODE_ANTIGRAVITY_ACP_AUTH_METHOD", "FAKE_ACP_STATE_FILE",
] as const;
const savedEnvironment = new Map<string, string | undefined>();
for (const key of environmentKeys) savedEnvironment.set(key, process.env[key]);

const root = await mkdtemp(join(tmpdir(), "agy-entrypoint-parity-"));
const promptLog = join(root, "prompts.jsonl");
process.env.OPENCODE_ANTIGRAVITY_ACP_PATH = fixture;
process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = join(root, "data");
process.env.GEMINI_HOME = join(root, "gemini-home");
process.env.OPENCODE_ANTIGRAVITY_MODELS_DEV = "0";
process.env.FAKE_ACP_PROMPT_LOG = promptLog;
delete process.env.OPENCODE_ANTIGRAVITY_ACP_AUTH_METHOD;
delete process.env.FAKE_ACP_STATE_FILE;

// Import after the environment is pinned, mirroring the proxy-smoke setup.
const { getProxyBaseUrl, startProxy, stopProxy } = await import("../src/proxy.js");

let compatibility: ReturnType<typeof fixtureCompatibility>;
beforeAll(async () => {
  compatibility = fixtureCompatibility();
  await chmod(fixture, 0o755);
  await startProxy(process.cwd());
});
afterAll(async () => {
  await stopProxy();
  compatibility.mockRestore();
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

const detection: AcpServerDetection = { executable: fixture, args: [], platform: process.platform };
const serviceModel = "fake-model-low";
const authHeaders = { "content-type": "application/json", "x-api-key": LOCAL_API_KEY };

async function pluginMessage(body: unknown, session?: string): Promise<Response> {
  return fetch(getProxyBaseUrl() + "/messages", {
    method: "POST",
    headers: { ...authHeaders, ...(session ? { [SESSION_HEADER]: session } : {}) },
    body: JSON.stringify(body),
  });
}

async function serviceJson(body: ReturnType<typeof parseMessage>): Promise<Record<string, any>> {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
  const events = textTurn({
    directory: root,
    detection,
    selected: { requestedModel: serviceModel, acpModel: serviceModel },
    request: body,
    signal,
  });
  const response = await jsonMessage(events, serviceModel);
  return response.json();
}

/** Prompt-log entries whose rendered text contains the marker (one per turn). */
async function promptEntries(marker: string) {
  const text = await readFile(promptLog, "utf8").catch(() => "");
  return text.trim().split("\n").filter(Boolean)
    .map(line => JSON.parse(line) as { text: string; prompt: Array<Record<string, any>> })
    .filter(entry => typeof entry.text === "string" && entry.text.includes(marker));
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Relative order of selected text/image markers inside the assembled ACP prompt. */
function orderedAtoms(blocks: any[], markers: ReadonlyArray<{ name: string; kind: "text" | "image"; value: string }>): string[] {
  const atoms: string[] = [];
  const textMarkers = markers.filter(marker => marker.kind === "text");
  for (const block of blocks) {
    if (block?.type === "image") {
      const marker = markers.find(entry => entry.kind === "image" && entry.value === block.data);
      if (marker) atoms.push(marker.name);
    } else if (block?.type === "text" && typeof block.text === "string") {
      const present = textMarkers
        .map(marker => ({ marker, at: block.text.indexOf(marker.value) }))
        .filter(entry => entry.at >= 0)
        .sort((a, b) => a.at - b.at);
      for (const { marker } of present) atoms.push(marker.name);
    }
  }
  return atoms;
}

async function pluginStatus(body: unknown, session?: string): Promise<number> {
  const response = await pluginMessage(body, session);
  await response.text();
  return response.status;
}

test("system reaches ACP exactly once, at the front, through both the plugin and the service entry", async () => {
  const system = "SYSTEM_PARITY_MARKER address the user as captain";
  const user = "USER_PARITY_MARKER hello";
  const body = { model: "gemini-3.8-flash", max_tokens: 64, system, messages: [{ role: "user", content: user }] };

  const plugin = await pluginMessage(body, "parity-system-plugin");
  expect(plugin.status).toBe(200);
  const pluginPayload = await plugin.json();
  expect(JSON.stringify(pluginPayload.content)).toContain("FAKE_OK");

  const servicePayload = await serviceJson(parseMessage({ ...body, model: serviceModel }));
  expect(JSON.stringify(servicePayload.content)).toContain("FAKE_OK");

  const entries = await promptEntries("USER_PARITY_MARKER");
  expect(entries).toHaveLength(2);
  for (const entry of entries) {
    expect(entry.prompt[0]?.type).toBe("text");
    expect(entry.prompt[0].text).toContain(system);
    // Exactly once, and only as the leading block.
    expect(occurrences(JSON.stringify(entry.prompt), system)).toBe(1);
    expect(entry.prompt.at(-1)).toEqual({ type: "text", text: user });
  }
  // Same wire body: the rebuilt ACP prompt must be identical across entries.
  expect(entries[0].prompt).toEqual(entries[1].prompt);
}, 30_000);

const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP9sAAAAASUVORK5CYII=";

test("assistant thinking history survives as ordered text on both entries; redacted thinking stays out; mixed images keep data and position", async () => {
  // Plugin public entrypoints: bounded history keeps readable reasoning text
  // in order, never the signature, and safely ignores redacted thinking.
  const thinking = { type: "thinking", thinking: "THINK_TEXT", signature: "sig-secret" };
  const pluginHistory = buildBoundedHistory([
    { role: "assistant", content: [thinking, { type: "text", text: "ANSWER_TEXT" }] },
  ]);
  expect(pluginHistory).toContain("THINK_TEXT");
  expect(pluginHistory.indexOf("THINK_TEXT")).toBeLessThan(pluginHistory.indexOf("ANSWER_TEXT"));
  expect(pluginHistory).not.toContain("sig-secret");

  const reasoningOnly = buildBoundedHistory([
    { role: "assistant", content: [{ type: "thinking", thinking: "ONLY_REASONING", signature: "sig-secret" }] },
  ]);
  expect(reasoningOnly).toContain("ONLY_REASONING");
  expect(reasoningOnly).not.toContain("sig-secret");

  const redacted = buildBoundedHistory([
    { role: "assistant", content: [{ type: "redacted_thinking", data: "OPAQUE_SECRET" }, { type: "text", text: "VISIBLE_TEXT" }] },
  ]);
  expect(redacted).toContain("VISIBLE_TEXT");
  expect(redacted).not.toContain("OPAQUE_SECRET");
  expect(extractTextContent([{ type: "redacted_thinking", data: "OPAQUE_SECRET" }])).toBe("");

  // Empty user messages stay rejected on the plugin entry.
  await expect(normalizePrompt([{ role: "user", content: "   " }])).rejects.toThrow("empty");

  // Service Anthropic entry: thinking blocks (with signature) fold into
  // readable history text; thinking + text + tool_use keeps tool causality.
  const request = { model: serviceModel, max_tokens: 128 };
  const parsed = parseMessage({ ...request, messages: [
    { role: "user", content: "GO_TOOL_MARKER" },
    { role: "assistant", content: [
      { type: "thinking", thinking: "THINK_TEXT", signature: "sig-secret" },
      { type: "text", text: "ANSWER_TEXT" },
      { type: "tool_use", id: "call_parity_1", name: "lookup", input: { q: "x" } },
    ] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "call_parity_1", content: "RESULT_TEXT" },
      { type: "text", text: "CONTINUE_TEXT" },
    ] },
  ] });
  const serialized = JSON.stringify(parsed.history);
  expect(serialized).toContain("THINK_TEXT");
  expect(serialized).toContain("ANSWER_TEXT");
  expect(serialized).toContain("call_parity_1");
  expect(serialized).not.toContain("sig-secret");
  expect(parsed.responses?.[0]?.id).toBe("call_parity_1");
  expect(JSON.stringify(parsed.responses?.[0]?.content)).toContain("RESULT_TEXT");

  const reasoningOnlyService = parseMessage({ ...request, messages: [
    { role: "user", content: "GO_REASONING_ONLY" },
    { role: "assistant", content: [{ type: "thinking", thinking: "ONLY_REASONING", signature: "sig-secret" }] },
    { role: "user", content: "next" },
  ] });
  expect(JSON.stringify(reasoningOnlyService.history)).toContain("ONLY_REASONING");
  expect(JSON.stringify(reasoningOnlyService.history)).not.toContain("sig-secret");

  const redactedService = parseMessage({ ...request, messages: [
    { role: "user", content: "GO_REDACTED" },
    { role: "assistant", content: [{ type: "redacted_thinking", data: "OPAQUE_SECRET" }, { type: "text", text: "VISIBLE_TEXT" }] },
    { role: "user", content: "next" },
  ] });
  expect(JSON.stringify(redactedService.history)).not.toContain("OPAQUE_SECRET");

  // Mixed images keep data and position on both entries.
  const mixed = [
    { type: "text", text: "BEFORE_IMG" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: imageData } },
    { type: "text", text: "AFTER_IMG" },
  ];
  expect(parseMessage({ ...request, messages: [{ role: "user", content: mixed }] }).history[0].content).toEqual([
    { type: "text", text: "BEFORE_IMG" },
    { type: "image", mimeType: "image/png", data: imageData },
    { type: "text", text: "AFTER_IMG" },
  ]);
  expect((await normalizePrompt([{ role: "user", content: mixed }])).blocks).toEqual([
    { type: "text", text: "BEFORE_IMG" },
    { type: "image", mimeType: "image/png", data: imageData },
    { type: "text", text: "AFTER_IMG" },
  ]);

  // Malformed thinking payloads and empty user messages stay rejected.
  for (const bad of [
    [{ role: "user", content: "go" }, { role: "assistant", content: [{ type: "thinking", thinking: 42 }] }, { role: "user", content: "next" }],
    [{ role: "user", content: "go" }, { role: "assistant", content: [{ type: "thinking" }] }, { role: "user", content: "next" }],
  ]) {
    expect(() => parseMessage({ ...request, messages: bad })).toThrow();
  }
  expect(() => parseMessage({ ...request, messages: [{ role: "user", content: "" }] })).toThrow("nonempty");
}, 20_000);

// Explicit AcpEvents: protocol-layer simulation, not a real ACP stream.
const update = (sessionUpdate: string, text: string): ServiceTurnEvent => ({
  event: "update", sessionId: "parity", update: { sessionUpdate, content: { type: "text", text } } as never,
});
const interleaved: ServiceTurnEvent[] = [
  update("agent_thought_chunk", "THOUGHT_A"),
  update("agent_message_chunk", "BODY_A"),
  update("agent_thought_chunk", "THOUGHT_B"),
  update("agent_message_chunk", "BODY_B"),
];
const calls: ClientToolCall[] = [
  { id: "call_stream_1", name: "lookup", args: { n: 1 } },
  { id: "call_stream_2", name: "lookup", args: { n: 2 } },
];
async function* eventsOf(list: ServiceTurnEvent[]): AsyncGenerator<ServiceTurnEvent> {
  for (const item of list) yield item;
}

const sseFrames = (body: string) =>
  body.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));

function anthropicBlocks(frames: any[]) {
  const blocks: Array<{ index: number; type: string; text: string; id?: string }> = [];
  const byIndex = new Map<number, number>();
  for (const frame of frames) {
    if (frame.type === "content_block_start") {
      byIndex.set(frame.index, blocks.push({
        index: frame.index, type: frame.content_block.type, text: "",
        ...(frame.content_block.id ? { id: frame.content_block.id } : {}),
      }) - 1);
    } else if (frame.type === "content_block_delta") {
      const block = blocks[byIndex.get(frame.index)!];
      block.text += frame.delta.text ?? frame.delta.thinking ?? frame.delta.partial_json ?? "";
    }
  }
  return blocks;
}

test("interleaved thought/text/tool-terminal streams preserve reasoning order without leaking thought into the final body (simulated events)", async () => {
  // Anthropic JSON: reasoning and body keep their original interleaved order;
  // tool calls terminate without colliding with content blocks.
  const message = (await jsonMessage(eventsOf([...interleaved, { event: "function_calls", calls }]), serviceModel)
    .then(response => response.json())) as Record<string, any>;
  expect(message.content.map((block: any) => block.type)).toEqual([
    "thinking", "text", "thinking", "text", "tool_use", "tool_use",
  ]);
  expect(message.content.filter((block: any) => block.type === "thinking").map((block: any) => block.thinking).join("")).toBe("THOUGHT_ATHOUGHT_B");
  expect(message.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("")).toBe("BODY_ABODY_B");
  expect(message.stop_reason).toBe("tool_use");

  // Anthropic SSE: block indices are unique and increasing; thought deltas stay
  // out of text deltas; the tool-terminal stop reason is delivered.
  const anthropicSse = await streamTurn(
    eventsOf([...interleaved, { event: "function_calls", calls }]),
    anthropicStream(serviceModel), AbortSignal.timeout(10_000), () => {}, () => {},
  ).then(response => response.text());
  const frames = sseFrames(anthropicSse);
  const blocks = anthropicBlocks(frames);
  expect(blocks.map(block => block.type)).toEqual(["thinking", "text", "thinking", "text", "tool_use", "tool_use"]);
  expect(new Set(blocks.map(block => block.index)).size).toBe(blocks.length);
  expect(blocks.map(block => block.index)).toEqual([...blocks.map(block => block.index)].sort((a, b) => a - b));
  expect(blocks.filter(block => block.type === "thinking").map(block => block.text).join("")).toBe("THOUGHT_ATHOUGHT_B");
  expect(blocks.filter(block => block.type === "text").map(block => block.text).join("")).toBe("BODY_ABODY_B");
  expect(frames.at(-2)?.type).toBe("message_delta");
  expect(frames.at(-2)?.delta.stop_reason).toBe("tool_use");
  expect(frames.at(-1)?.type).toBe("message_stop");

  // Gemini carries reasoning as native `thought: true` parts: JSON and SSE keep
  // the interleaved order, and the non-thought body contains only BODY_*.
  const geminiParts = (frames: any[]) =>
    frames.flatMap((frame: any) => frame.candidates?.[0]?.content?.parts ?? []);
  const expectedParts = [
    { text: "THOUGHT_A", thought: true }, { text: "BODY_A" },
    { text: "THOUGHT_B", thought: true }, { text: "BODY_B" },
  ];
  const geminiBody = (await geminiJson(eventsOf([...interleaved, { event: "function_calls", calls }]), serviceModel)
    .then(response => response.json())) as Record<string, any>;
  expect(geminiBody.candidates[0].content.parts.slice(0, 4)).toEqual(expectedParts);
  expect(geminiBody.candidates[0].content.parts.filter((part: any) => !part.thought).map((part: any) => part.text).join("")).toBe("BODY_ABODY_B");
  expect(geminiBody.candidates[0].content.parts.filter((part: any) => part.thought).map((part: any) => part.text).join("")).toBe("THOUGHT_ATHOUGHT_B");
  expect(geminiBody.candidates[0].content.parts.map((part: any) => part.functionCall?.id).filter(Boolean)).toEqual(["call_stream_1", "call_stream_2"]);
  expect(geminiBody.candidates[0].finishReason).toBe("STOP");
  expect(JSON.stringify(geminiBody)).not.toContain("reasoning_content");

  const geminiSse = await streamTurn(
    eventsOf([...interleaved, { event: "function_calls", calls }]),
    geminiStream(serviceModel), AbortSignal.timeout(10_000), () => {}, () => {},
  ).then(response => response.text());
  const streamedParts = geminiParts(sseFrames(geminiSse));
  expect(streamedParts.slice(0, 4)).toEqual(expectedParts);
  expect(streamedParts.filter((part: any) => !part.thought).map((part: any) => part.text).join("")).toBe("BODY_ABODY_B");
  expect(streamedParts.filter((part: any) => part.thought).map((part: any) => part.text).join("")).toBe("THOUGHT_ATHOUGHT_B");
  expect(streamedParts.map((part: any) => part.functionCall?.id).filter(Boolean)).toEqual(["call_stream_1", "call_stream_2"]);

  // OpenAI carries no reasoning field and must not invent one: only body text
  // and the existing tool_calls payload survive JSON and SSE.
  const openAi = (await openAIJson(eventsOf([...interleaved, { event: "function_calls", calls }]), serviceModel)
    .then(response => response.json())) as Record<string, any>;
  const choice = openAi.choices[0];
  expect(choice.message.content).toBe("BODY_ABODY_B");
  expect(choice.message.tool_calls.map((call: any) => call.id)).toEqual(["call_stream_1", "call_stream_2"]);
  expect(choice.message.tool_calls.map((call: any) => call.function.name)).toEqual(["lookup", "lookup"]);
  expect(choice.message.tool_calls.map((call: any) => JSON.parse(call.function.arguments))).toEqual([{ n: 1 }, { n: 2 }]);
  expect(choice.finish_reason).toBe("tool_calls");
  expect(JSON.stringify(openAi)).not.toContain("THOUGHT_");
  expect(JSON.stringify(openAi)).not.toContain("reasoning_content");

  const openAiSse = await streamTurn(
    eventsOf([...interleaved, { event: "function_calls", calls }]),
    openAIStream(serviceModel, false), AbortSignal.timeout(10_000), () => {}, () => {},
  ).then(response => response.text());
  const openAiFrames = openAiSse.split("\n")
    .filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
    .map(line => JSON.parse(line.slice(6)));
  expect(openAiFrames.flatMap((frame: any) => frame.choices?.flatMap((entry: any) => entry.delta?.content ?? []) ?? []).join("")).toBe("BODY_ABODY_B");
  const streamedCalls = openAiFrames.flatMap((frame: any) => frame.choices?.flatMap((entry: any) => entry.delta?.tool_calls ?? []) ?? []);
  expect(streamedCalls.map((call: any) => call.id).filter(Boolean)).toEqual(["call_stream_1", "call_stream_2"]);
  expect(streamedCalls.map((call: any) => call.function?.name).filter(Boolean)).toEqual(["lookup", "lookup"]);
  expect(streamedCalls.map((call: any) => call.function?.arguments ?? "").join("")).toBe('{"n":1}{"n":2}');
  expect(openAiSse.trimEnd().endsWith("data: [DONE]")).toBe(true);
  expect(openAiSse).not.toContain("THOUGHT_");
  expect(openAiSse).not.toContain("reasoning_content");

  // Reasoning followed by a failure must not surface as a success response.
  async function* failing(): AsyncGenerator<ServiceTurnEvent> {
    yield update("agent_thought_chunk", "REASON_BEFORE_FAILURE");
    yield update("agent_message_chunk", "PARTIAL_BODY");
    throw new AgyError("process", "simulated upstream failure");
  }
  await expect(jsonMessage(failing(), serviceModel)).rejects.toThrow();
  const failedSse = await streamTurn(failing(), anthropicStream(serviceModel), AbortSignal.timeout(10_000), () => {}, () => {})
    .then(response => response.text());
  expect(failedSse).toContain("PARTIAL_BODY");
  expect(sseFrames(failedSse).at(-1)?.type).toBe("error");
  expect(failedSse).not.toContain("message_stop");
}, 20_000);

test("numeric temperature is accepted without changing the ACP turn; invalid temperature and forced tool_choice stay rejected", async () => {
  const request = { model: serviceModel, max_tokens: 64, messages: [{ role: "user", content: "hi" }] };
  expect(parseMessage({ ...request, temperature: 0.7 })).toEqual(parseMessage({ ...request }));
  expect(parseMessage({ ...request, temperature: 1 })).toEqual(parseMessage({ ...request }));
  for (const temperature of ["hot", {}, Number.NaN]) {
    expect(() => parseMessage({ ...request, temperature })).toThrow();
  }
  // Legacy rejections stay in force.
  expect(() => parseMessage({ ...request, top_p: 0.5 })).toThrow();
  expect(() => parseMessage({ ...request, tool_choice: { type: "tool", name: "lookup" } })).toThrow("tool_choice supports");

  const contents = [{ role: "user", parts: [{ text: "TEMPERATURE_PARITY_MARKER" }] }];
  expect(parseGeminiContent({ contents, generationConfig: { temperature: 0.5 } }, serviceModel, false))
    .toEqual(parseGeminiContent({ contents }, serviceModel, false));
  expect(() => parseGeminiContent({ contents, generationConfig: { temperature: "hot" } }, serviceModel, false)).toThrow();
  expect(() => parseGeminiContent({ contents, generationConfig: { topP: 0.9 } }, serviceModel, false)).toThrow();

  // Plugin entry: the same numeric temperature changes nothing in the ACP
  // prompt, while non-numeric temperatures are rejected instead of warned.
  const pluginBody = (temperature?: unknown) => ({
    model: "gemini-3.8-flash", max_tokens: 64,
    messages: [{ role: "user", content: "TEMPERATURE_PARITY_MARKER" }],
    ...(temperature === undefined ? {} : { temperature }),
  });
  const warm = await pluginMessage(pluginBody(0.7), "parity-temperature-warm");
  expect(warm.status).toBe(200);
  await warm.json();
  const plain = await pluginMessage(pluginBody(), "parity-temperature-plain");
  expect(plain.status).toBe(200);
  await plain.json();
  const entries = await promptEntries("TEMPERATURE_PARITY_MARKER");
  expect(entries).toHaveLength(2);
  for (const entry of entries) expect(entry.prompt).toEqual([{ type: "text", text: "TEMPERATURE_PARITY_MARKER" }]);

  for (const temperature of [{ mode: "hot" }, "hot"]) {
    const response = await pluginMessage(pluginBody(temperature), "parity-temperature-invalid");
    expect(response.status).toBe(400);
    await response.text();
  }
}, 30_000);

test("assistant thinking + inline image + tool call/result survive the plugin SessionPool rebuild and the service turn with the same readable order", async () => {
  const imagePart = { type: "image", source: { type: "base64", media_type: "image/png", data: imageData } };
  const messages = [
    { role: "user", content: "HISTORY_USER_MARKER" },
    { role: "assistant", content: [
      { type: "thinking", thinking: "HISTORY_THINKING_MARKER", signature: "sig-history-secret" },
      { type: "text", text: "HISTORY_TEXT_BEFORE" },
      imagePart,
      { type: "text", text: "HISTORY_TEXT_AFTER" },
      { type: "tool_use", id: "toolu_history_1", name: "lookup", input: { query: "alpha" } },
    ] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_history_1", content: "HISTORY_RESULT_MARKER", is_error: true }] },
    { role: "user", content: "HISTORY_FINAL_USER_MARKER" },
  ];
  const body = { model: "gemini-3.8-flash", max_tokens: 64, messages };

  // Real plugin loopback request -> SessionPool rebuild -> ACP prompt log.
  const plugin = await pluginMessage(body);
  expect(plugin.status).toBe(200);
  const pluginPayload = await plugin.json();
  expect(JSON.stringify(pluginPayload.content)).toMatch(/IMAGE_OK|FAKE_OK/);
  // Same wire body through the service parser/turn -> ACP prompt log.
  const servicePayload = await serviceJson(parseMessage({ ...body, model: serviceModel }));
  expect(JSON.stringify(servicePayload.content)).toMatch(/IMAGE_OK|FAKE_OK/);

  const entries = await promptEntries("HISTORY_USER_MARKER");
  expect(entries).toHaveLength(2);
  const markers = [
    { name: "THINK", kind: "text", value: "HISTORY_THINKING_MARKER" },
    { name: "BEFORE", kind: "text", value: "HISTORY_TEXT_BEFORE" },
    { name: "IMAGE", kind: "image", value: imageData },
    { name: "AFTER", kind: "text", value: "HISTORY_TEXT_AFTER" },
  ] as const;
  for (const entry of entries) {
    const joined = entry.prompt.filter(block => block.type === "text").map(block => String(block.text)).join("\n");
    // Thinking body and image data keep their original text/image relative order.
    expect(orderedAtoms(entry.prompt, markers)).toEqual(["THINK", "BEFORE", "IMAGE", "AFTER"]);
    expect(entry.prompt.filter(block => block.type === "image").map(block => block.data)).toEqual([imageData]);
    // Tool identity, original arguments, result and the error flag are not lost.
    expect(joined).toContain("toolu_history_1");
    expect(joined).toContain('"query":"alpha"');
    expect(joined).toContain("HISTORY_RESULT_MARKER");
    expect(joined).toContain("toolu_history_1 error");
    expect(joined.indexOf("HISTORY_RESULT_MARKER")).toBeLessThan(joined.indexOf("HISTORY_FINAL_USER_MARKER"));
    // Signatures are never replayed into ACP history.
    expect(joined).not.toContain("sig-history-secret");
  }
}, 30_000);

test("malformed thinking/redacted/signature and misplaced thinking are rejected on both entries; redacted-only assistant keeps its history slot", async () => {
  const malformed = [
    ["thinking_text_number", { type: "thinking", thinking: 42 }],
    ["thinking_missing", { type: "thinking" }],
    ["thinking_signature_number", { type: "thinking", thinking: "visible", signature: 42 }],
    ["redacted_data_number", { type: "redacted_thinking", data: 42 }],
    ["redacted_missing", { type: "redacted_thinking" }],
  ] as const;
  const pluginBody = (content: unknown) => ({
    model: "gemini-3.8-flash", max_tokens: 64,
    messages: [
      { role: "user", content: "PLUGIN_REJECT_USER_MARKER" },
      { role: "assistant", content },
      { role: "user", content: "PLUGIN_REJECT_FINAL_MARKER" },
    ],
  });
  const serviceBody = (content: unknown) => ({
    model: serviceModel, max_tokens: 64,
    messages: [
      { role: "user", content: "SERVICE_REJECT_USER_MARKER" },
      { role: "assistant", content },
      { role: "user", content: "SERVICE_REJECT_FINAL_MARKER" },
    ],
  });
  const pluginStatuses: Record<string, number> = {};
  for (const [name, malformedPart] of malformed) {
    expect(() => parseMessage(serviceBody([malformedPart]))).toThrow();
    pluginStatuses[name] = await pluginStatus(pluginBody([malformedPart]));
  }
  expect(pluginStatuses).toEqual(Object.fromEntries(malformed.map(([name]) => [name, 400])));

  // thinking is only readable in assistant history: user, system and tool_result
  // placements stay rejected, and so do OpenAI-style input_text blocks.
  expect(() => parseMessage({ model: serviceModel, max_tokens: 64,
    messages: [{ role: "user", content: [{ type: "thinking", thinking: "x" }] }] })).toThrow();
  expect(() => parseMessage({ model: serviceModel, max_tokens: 64,
    system: [{ type: "thinking", thinking: "x" }],
    messages: [{ role: "user", content: "go" }] })).toThrow();
  expect(() => parseMessage({ model: serviceModel, max_tokens: 64, messages: [
    { role: "user", content: "go" },
    { role: "assistant", content: [{ type: "text", text: "a" }, { type: "tool_use", id: "toolu_misplaced", name: "lookup", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_misplaced", content: [{ type: "thinking", thinking: "x" }] }] },
  ] })).toThrow();
  expect(() => parseMessage({ model: serviceModel, max_tokens: 64,
    messages: [{ role: "user", content: [{ type: "input_text", text: "x" }] }] })).toThrow();
  expect(() => parseMessage({ model: serviceModel, max_tokens: 64,
    messages: [{ role: "user", content: [{ type: "input_text", text: "x" }, { type: "image", source: { type: "base64", media_type: "image/png", data: imageData } }] }] })).toThrow();

  // Empty ordinary assistant turns still have no readable content.
  for (const content of ["", "   ", [], [{ type: "text", text: " \t " }]]) {
    expect(() => parseMessage(serviceBody(content))).toThrow();
  }

  // A valid redacted-only assistant message is opaque but keeps its slot.
  const redactedOnly = parseMessage({ model: serviceModel, max_tokens: 64, messages: [
    { role: "user", content: "go" },
    { role: "assistant", content: [{ type: "redacted_thinking", data: "OPAQUE_REDACTED_SERVICE" }] },
    { role: "user", content: "next" },
  ] });
  expect(redactedOnly.history).toHaveLength(3);
  expect(redactedOnly.history[1].role).toBe("assistant");
  expect(JSON.stringify(redactedOnly)).not.toContain("OPAQUE_REDACTED_SERVICE");

  // The plugin accepts the same valid redacted-only assistant and never emits
  // the opaque payload; the request still completes through the real entry.
  const pluginRedacted = await pluginMessage({ model: "gemini-3.8-flash", max_tokens: 64, messages: [
    { role: "user", content: "PLUGIN_REDACTED_USER" },
    { role: "assistant", content: [{ type: "redacted_thinking", data: "OPAQUE_REDACTED_PLUGIN" }] },
    { role: "user", content: "PLUGIN_REDACTED_FINAL_MARKER" },
  ] });
  expect(pluginRedacted.status).toBe(200);
  await pluginRedacted.json();
  const entries = await promptEntries("PLUGIN_REDACTED_FINAL_MARKER");
  expect(entries).toHaveLength(1);
  expect(JSON.stringify(entries[0].prompt)).not.toContain("OPAQUE_REDACTED_PLUGIN");
}, 40_000);
