import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorResponse } from "../src/anthropic-http.js";
import { geminiJson, geminiStream, parseGeminiContent } from "../src/gemini-content.js";
import { ClientToolTurn } from "../src/tool-turn.js";
import { openAIErrorResponse, openAIJson, openAIStream } from "../src/openai-chat.js";
import type { AcpEvent } from "../src/protocol.js";
import { anthropicStream, jsonMessage, parseMessage, publicFailure, streamTurn, textTurn, type ClientToolCall } from "../src/service-messages.js";
import { fixtureCompatibility } from "./fixtures/compatibility.js";

const request = { model: "test", max_tokens: 128, messages: [{ role: "user", content: "hello" }] };
const mimeType = "image/png";
const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP9sAAAAASUVORK5CYII=";
const image = (data: string, media_type = mimeType) => ({ type: "image", source: { type: "base64", media_type, data } });
const text: AcpEvent = { event: "update", sessionId: "test", update: {
  sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" },
} };

test("Anthropic accepts text history and rejects server tools and unsupported media", () => {
  expect(parseMessage({
    ...request, system: [{ type: "text", text: "be concise" }],
    messages: [{ role: "assistant", content: [{ type: "text", text: "prior answer" }] }, ...request.messages],
  }).history[0]?.content).toBe("prior answer");
  expect(() => parseMessage({ ...request, tools: [{ type: "web_search_20250305", name: "web_search" }] })).toThrow("server tools are unsupported");
  for (const tool_choice of [{ type: "any" }, { type: "tool", name: "lookup" }, { type: "auto", disable_parallel_tool_use: true }]) {
    expect(() => parseMessage({ ...request, tool_choice })).toThrow("tool_choice supports auto and none");
  }
  for (const part of [
    { type: "image", source: { type: "url", url: "file:///private.png" } },
    { type: "image", source: { type: "url", url: "https://example.com/image.png" } },
    { ...image(imageData), source: { ...image(imageData).source, url: "file:///private.png" } },
    image("data:image/png;base64,AAAA"),
    image("AA=A"),
    image("AB=="),
    image(imageData, "audio/wav"),
    image(imageData, "application/pdf"),
    image(imageData, "image/svg+xml"),
    { type: "document", source: { type: "base64", data: imageData, media_type: "application/pdf" } },
  ]) {
    expect(() => parseMessage({ ...request, messages: [
      { role: "user", content: [part] },
      ...request.messages,
    ] })).toThrow();
  }
  expect(() => parseMessage({ ...request, system: [image(imageData)] })).toThrow("Only text content blocks are supported");
});

test("the decoded image budget covers the whole conversation", () => {
  const maximum = image(Buffer.alloc(4 * 1024 * 1024).toString("base64"));
  const maximumMessage = { role: "user", content: [maximum] };
  expect(parseMessage({ ...request, messages: [maximumMessage, maximumMessage] }).history).toHaveLength(2);
  expect(() => parseMessage({ ...request, messages: [maximumMessage, maximumMessage, {
    role: "user", content: [image(imageData)],
  }] })).toThrow("The combined images are too large");
  expect(() => parseMessage({ ...request, messages: [{
    role: "user", content: [image(Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64"))],
  }] })).toThrow("The image is too large");
});

test("Gemini and Anthropic send current and historical images to ACP for JSON and SSE", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agy-service-images-"));
  const promptLog = join(directory, "prompts.jsonl");
  const environment = { FAKE_ACP_PROMPT_LOG: promptLog, GEMINI_HOME: join(directory, "profile") };
  const previous = Object.keys(environment).map(key => [key, process.env[key]] as const);
  const compatibility = fixtureCompatibility();
  const model = "fake-model-low";
  const prefix = { type: "text", text: "Earlier image" };
  const part = { inlineData: { mimeType, data: imageData } };
  const messages = [
    { role: "user", content: [prefix, image(imageData)] },
    { role: "assistant", content: "Earlier answer" },
    { role: "user", content: [image(imageData)] },
  ];
  const contents = [
    { role: "user", parts: [{ text: prefix.text }, part] },
    { role: "model", parts: [{ text: "Earlier answer" }] },
    { role: "user", parts: [part] },
  ];
  try {
    Object.assign(process.env, environment);
    for (const stream of [false, true]) {
      for (const gemini of [false, true]) {
        const controller = new AbortController();
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]);
        const events = textTurn({
          directory,
          detection: { executable: join(import.meta.dir, "fixtures", "fake-acp.mjs"), args: [], platform: process.platform },
          selected: { requestedModel: model, acpModel: model },
          request: gemini ? parseGeminiContent({ contents }, model, stream) : parseMessage({ ...request, model, messages, stream }),
          signal,
        });
        const response = stream
          ? await streamTurn(events, gemini ? geminiStream(model) : anthropicStream(model), signal, () => controller.abort(), () => {})
          : await (gemini ? geminiJson : jsonMessage)(events, model);
        expect(await response.text()).toContain("IMAGE_OK");
      }
    }
    const received = (await readFile(promptLog, "utf8")).trim().split("\n").map(line => JSON.parse(line).prompt);
    const acpImage = { type: "image", mimeType, data: imageData };
    expect(received).toEqual(Array.from({ length: 4 }, () => [
      { type: "text", text: "[user]" }, prefix, acpImage,
      { type: "text", text: "[assistant]\nEarlier answer" }, acpImage,
    ]));
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    compatibility.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Gemini advertises 29 tools over MCP, resumes parallel calls by ID, and returns the ACP answer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agy-service-tools-"));
  const listLog = join(directory, "mcp-list.jsonl");
  const environment = { FAKE_ACP_MCP_LIST_LOG: listLog, GEMINI_HOME: join(directory, "profile") };
  const previous = Object.keys(environment).map(key => [key, process.env[key]] as const);
  const compatibility = fixtureCompatibility();
  const model = "fake-model-low";
  const tools = [{ functionDeclarations: Array.from({ length: 29 }, (_, index) => ({
    name: `tool_${index}`,
    parametersJsonSchema: { type: "object", properties: { index: { type: "integer" } }, required: ["index"] },
  })) }];
  const contents = [{ role: "user", parts: [{ text: "FAKE_MCP_PARALLEL FAKE_MCP_PERMISSION FAKE_MCP_SEQUENCE" }] }];
  const turns: ClientToolTurn[] = [];
  async function reply(turn: ClientToolTurn, stream: boolean, readDelay = 0) {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]);
    const events = turn.segment(signal);
    if (!stream) return [await (await geminiJson(events, model)).json()];
    const response = await streamTurn(events, geminiStream(model), signal, () => controller.abort(), () => {});
    if (readDelay) await Bun.sleep(readDelay);
    return (await response.text()).trimEnd().split("\n\n").map(frame => JSON.parse(frame.slice(6)));
  }
  const parts = (frames: any[]) => frames.flatMap(frame => frame.candidates?.[0]?.content?.parts ?? []);
  const start = (stream: boolean, waitMs?: number, input = contents) => {
    const body = parseGeminiContent({ contents: input, tools }, model, stream);
    const turn = new ClientToolTurn({
      directory,
      detection: { executable: join(import.meta.dir, "fixtures", "fake-acp.mjs"), args: [], platform: process.platform },
      selected: { requestedModel: model, acpModel: model },
      request: body,
    }, body.tools!, "gemini", waitMs);
    turns.push(turn);
    return turn;
  };
  try {
    Object.assign(process.env, environment);
    for (const stream of [false, true]) {
      const turn = start(stream);
      const frames = await reply(turn, stream);
      const calls: ClientToolCall[] = parts(frames).map(part => part.functionCall);
      expect(frames.at(-1)?.candidates[0].finishReason).toBe("STOP");
      expect(calls).toHaveLength(2);
      expect(new Set(calls.map(call => call.id)).size).toBe(2);
      expect(calls.map(call => call.name)).toEqual(["tool_0", "tool_0"]);
      const callParts = calls.map(functionCall => ({ functionCall }));
      const displayNames = ["tool-image-1.png", "tool-image-2.png"];
      const imageResult = { output: [{ type: "text", text: "first" }, ...displayNames.map($ref => ({ $ref }))] };
      const resultParts = calls.map(({ id, name, args }) => ({ functionResponse: {
        id, name, ...(args.index === 0 ? {
          response: imageResult,
          parts: displayNames.map(displayName => ({ inlineData: { mimeType, data: imageData.replace(/=+$/, ""), displayName } })),
        } : { response: { error: "second" } }),
      } })).reverse();
      const input = [...contents, { role: "model", parts: callParts }, { role: "user", parts: [
        ...resultParts, { text: "Inspect the attached image next." }, { inlineData: { mimeType, data: imageData } }, { text: "Keep it brief." },
      ] }];
      expect(() => parseGeminiContent({
        contents: input, toolConfig: { functionCallingConfig: { mode: "NONE" } },
      }, model, stream)).toThrow("Cannot switch to tool mode NONE");
      const resumed = parseGeminiContent({ contents: input }, model, stream);
      const continuation = resumed.responses!;
      const withEcho = (echo: ClientToolCall) => parseGeminiContent({ contents: [
        ...contents, { role: "model", parts: [{ functionCall: echo }, callParts[1]] }, input.at(-1)!,
      ] }, model, stream);
      expect(() => withEcho({ ...calls[0], id: "wrong-call", args: { index: 999 } })).toThrow("ID must match");
      expect(() => withEcho({ ...calls[0], name: "wrong_tool" })).toThrow("name must match");
      const tampered = withEcho({ ...calls[0], args: { index: 999 } });
      expect(() => turn.resume("gemini", model, tampered.responses!, tampered.steering)).toThrow("matching tool result");
      expect(() => turn.resume("gemini", "other-model", continuation)).toThrow();
      expect(() => turn.resume("gemini", model, continuation.slice(0, 1))).toThrow();
      expect(() => turn.resume("gemini", model, [continuation[0], { ...continuation[1], id: "other-turn" }])).toThrow();
      expect(() => turn.resume("gemini", model, [continuation[0], { ...continuation[1], name: "tool_1" }])).toThrow();
      expect(() => turn.resume("gemini", model, [continuation[0], continuation[0]])).toThrow();
      expect(() => turn.resume("gemini", model, [continuation[0], { ...continuation[1], content: [{ type: "text", text: "x".repeat(30_000) }] }])).toThrow("context budget");
      expect(turn.owns(calls[0].id)).toBe(true);
      turn.resume("gemini", model, continuation, resumed.steering);
      expect(turn.owns(calls[0].id)).toBe(false);
      expect(() => turn.resume("gemini", model, continuation)).toThrow();

      const next = parts(await reply(turn, stream));
      const nextCall = next.at(-1).functionCall as ClientToolCall;
      expect(nextCall.args).toEqual({ index: 2 });
      const answer = JSON.parse(next.slice(0, -1).map(part => part.text).join(""));
      const expected = [
        { content: [{ type: "text", text: JSON.stringify(imageResult) }, ...displayNames.flatMap(displayName => [
          { type: "text", text: `[tool result image "${displayName}"]` }, { type: "image", mimeType, data: imageData },
        ])], isError: false },
        { content: [{ type: "text", text: '{"error":"second"}' }], isError: true },
      ];
      expected[Number(calls.at(-1)!.args.index)].content.push(
        { type: "text", text: "[subsequent user message]" },
        { type: "text", text: "Inspect the attached image next." },
        { type: "image", mimeType, data: imageData },
        { type: "text", text: "Keep it brief." },
      );
      expect(answer).toEqual(expected);
      const last = parseGeminiContent({ contents: [{ parts: [{ functionResponse: {
        id: nextCall.id, name: nextCall.name, response: { output: "last" },
      } }] }] }, model, stream);
      turn.resume("gemini", model, last.responses!);
      const final = await reply(turn, stream);
      expect(final.at(-1)?.candidates[0].finishReason).toBe("STOP");
      expect(parts(final).map(part => part.text).join("")).toContain("last");
      await turn.done;
    }

    const expired = start(false, 20);
    const expiredCall = parts(await reply(expired, false))[0].functionCall as ClientToolCall;
    expect(expired.owns(expiredCall.id)).toBe(true);
    await expired.done;
    expect(expired.owns(expiredCall.id)).toBe(false);

    const cancelled = start(true);
    const client = new AbortController();
    const segment = cancelled.segment(client.signal);
    expect((await segment.next()).value?.event).toBe("function_calls");
    client.abort();
    await segment.return(undefined);
    await cancelled.done;

    const queued = start(true, undefined, [{ role: "user", parts: [{ text: "FAKE_MCP_QUEUED_TEXT" }] }]);
    const delayed = parts(await reply(queued, true, 100));
    expect(delayed.at(-1).functionCall).toBeDefined();
    expect(delayed.slice(0, -1).map(part => part.text).join("")).toBe(["a", "b", "c"].map(ch => ch.repeat(80_000)).join(""));
    await queued.close();

    const lists = (await readFile(listLog, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(lists).toEqual(Array.from({ length: 5 }, () => tools[0].functionDeclarations.map(({ name, parametersJsonSchema }) =>
      ({ name, inputSchema: parametersJsonSchema }))));
    expect((await readdir(directory)).filter(name => name.startsWith("request-"))).toEqual([]);
  } finally {
    await Promise.all(turns.map(turn => turn.close()));
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    compatibility.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
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
