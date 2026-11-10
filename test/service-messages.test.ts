import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorResponse } from "../src/anthropic-http.js";
import { openAIErrorResponse, openAIJson, openAIStream } from "../src/openai-chat.js";
import type { AcpEvent } from "../src/protocol.js";
import { anthropicStream, jsonMessage, parseMessage, publicFailure, streamTurn, textTurn } from "../src/service-messages.js";
import { fixtureCompatibility } from "./fixtures/compatibility.js";

const request = { model: "test", max_tokens: 128, messages: [{ role: "user", content: "hello" }] };
const text: AcpEvent = { event: "update", sessionId: "test", update: {
  sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" },
} };

test("the standalone input accepts text history and rejects host tools and attachments", () => {
  expect(parseMessage({
    ...request, system: [{ type: "text", text: "be concise" }],
    messages: [{ role: "assistant", content: [{ type: "text", text: "prior answer" }] }, ...request.messages],
  }).history[0]?.content).toBe("prior answer");
  expect(() => parseMessage({ ...request, tools: [] })).toThrow("Unsupported request field");
  expect(() => parseMessage({ ...request, messages: [
    { role: "user", content: [{ type: "image", source: { type: "url", url: "file:///private.png" } }] },
    ...request.messages,
  ] })).toThrow("Only text content blocks are supported");
});

test("cancelling an SSE response aborts a blocked turn before releasing its slot", async () => {
  const controller = new AbortController();
  const settled = Promise.withResolvers<void>();
  let cleaned = false;
  async function* turn(): AsyncGenerator<AcpEvent> {
    try {
      yield text;
      if (!controller.signal.aborted) {
        await new Promise<void>(resolve => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
      }
    } finally { cleaned = true; }
  }
  const response = await streamTurn(turn(), anthropicStream("test"), controller.signal, () => controller.abort(), settled.resolve);
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: message_start");
  await reader.cancel();
  await settled.promise;
  expect(controller.signal.aborted).toBe(true);
  expect(cleaned).toBe(true);
});

test("a large ACP chunk streams losslessly through the bounded SSE buffer", async () => {
  const content = "x".repeat(8191) + "😀" + "\x00".repeat(140_000);
  const controller = new AbortController();
  async function* turn(): AsyncGenerator<AcpEvent> {
    yield { event: "update", sessionId: "test", update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: content },
    } };
    yield { event: "result", sessionId: "test", result: { stopReason: "end_turn" } };
  }
  const response = await streamTurn(turn(), anthropicStream("test"), controller.signal, () => controller.abort(), () => {});
  const events = (await response.text()).split("\n")
    .filter(line => line.startsWith("data: "))
    .map(line => JSON.parse(line.slice(6)));
  expect(events.filter(event => event.type === "content_block_delta").map(event => event.delta.text).join("")).toBe(content);
  expect(events.at(-1)?.type).toBe("message_stop");
});

test("both service protocols surface the captured ACP model-format failure without a success response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agy-service-failure-"));
  const replay = join(directory, "replay.json");
  const environment = {
    FAKE_ACP_REPLAY_FILE: replay,
    FAKE_ACP_PROMPT_LOG: join(directory, "prompts.jsonl"),
    GEMINI_HOME: join(directory, "profile"),
  };
  const previous = Object.keys(environment).map(key => [key, process.env[key]] as const);
  const compatibility = fixtureCompatibility();
  const failure = "Agent execution error: model output error: encountered an improper format stop reason.\nPlease retry with a properly formatted function call.";
  const event = (value: string): AcpEvent => ({
    event: "update", sessionId: "test", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } },
  });
  const end: AcpEvent = { event: "result", sessionId: "test", result: { stopReason: "end_turn" } };
  const failureEvents: AcpEvent[] = [
    event(failure.slice(0, 36)),
    { event: "update", sessionId: "test", update: { sessionUpdate: "usage_update", used: 1, size: 100 } },
    event(failure.slice(36)),
    end,
  ];
  const model = "fake-model-low";
  const turn = (signal?: AbortSignal) => textTurn({
    directory,
    detection: { executable: join(import.meta.dir, "fixtures", "fake-acp.mjs"), args: [], platform: process.platform },
    selected: { requestedModel: model, acpModel: model },
    request: parseMessage({ ...request, model }),
    signal: signal ?? AbortSignal.timeout(5_000),
  });
  const setReplay = (events: AcpEvent[]) => writeFile(replay, JSON.stringify({ events }));
  const stream = (frames: Parameters<typeof streamTurn>[1]) => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]);
    return streamTurn(turn(signal), frames, signal, () => controller.abort(), () => {});
  };

  try {
    Object.assign(process.env, environment);
    await setReplay(failureEvents);
    const formats = [
      { json: jsonMessage, failure: errorResponse, frames: () => anthropicStream(model), end: "message_stop" },
      { json: openAIJson, failure: openAIErrorResponse, frames: () => openAIStream(model, false), end: "[DONE]" },
    ];
    for (const format of formats) {
      const json = await format.json(turn(), model).catch(error => format.failure(publicFailure(error)));
      const sse = await stream(format.frames()).catch(error => format.failure(publicFailure(error)));
      for (const response of [json, sse]) {
        expect(response.status).toBe(502);
        const body = await response.json();
        expect(body.error.code).toBe("agy_model_output_format");
        expect(body.error.message).toBe("Antigravity could not complete the request");
      }
    }

    await setReplay([event("partial answer"), { event: "update", sessionId: "test", update: {
      sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "next segment" },
    } }, ...failureEvents]);
    for (const format of formats) {
      const response = await stream(format.frames());
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("partial answer");
      expect(body).toContain("agy_model_output_format");
      expect(body).not.toContain("improper format stop reason");
      expect(body).not.toContain(format.end);
    }

    for (const chunks of [[`Quoted error: ${failure}`], [failure, "\nHere is what it means."]]) {
      await setReplay([...chunks.map(event), end]);
      const response = await jsonMessage(turn(), model);
      expect((await response.json()).content[0].text).toBe(chunks.join(""));
    }
    await setReplay([event(failure), { ...end, result: { stopReason: "refusal" } }]);
    const refused = await jsonMessage(turn(), model);
    expect((await refused.json()).stop_reason).toBe("refusal");
    expect((await readdir(directory)).sort()).toEqual(["prompts.jsonl", "replay.json"]);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    compatibility.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
