import { expect, test } from "bun:test";
import { AgyError } from "../src/errors.js";
import { openAIErrorResponse, openAIJson, openAIStream, parseChatCompletion } from "../src/openai-chat.js";
import type { AcpEvent } from "../src/protocol.js";
import { streamTurn } from "../src/service-messages.js";

const user = { role: "user", content: "question" };
const body = { model: "test", messages: [user] };

test("Chat Completions normalizes leading instructions and text history for the shared turn", () => {
  expect(parseChatCompletion({
    ...body, stream: true, stream_options: { include_usage: true }, max_completion_tokens: 123, n: 1, store: false,
    messages: [
      { role: "system", content: "be concise" },
      { role: "developer", content: [{ type: "text", text: "use plain language" }, { type: "text", text: "use English" }] },
      { role: "assistant", content: [{ type: "text", text: "previous answer" }] },
      user,
    ],
  })).toEqual({
    request: { model: "test", stream: true, maxTokens: 123, system: "be concise\nuse plain language\nuse English", history: [
      { role: "assistant", content: "previous answer" }, user,
    ] },
    includeUsage: true,
  });
  expect(parseChatCompletion(body).request.maxTokens).toBe(4096);
  expect(parseChatCompletion({ ...body, max_tokens: 22 }).request.maxTokens).toBe(22);
});

test("Chat Completions rejects unsupported controls and malformed nested input", () => {
  for (const overrides of [
    { tools: [] }, { temperature: 1 }, { n: 2 }, { store: true }, { max_tokens: 10, max_completion_tokens: 10 },
    { max_completion_tokens: null }, { max_tokens: 0 }, { stream: "true" }, { stream_options: { include_usage: true } },
    { stream: true, stream_options: null }, { stream: true, stream_options: [] },
    { stream: true, stream_options: { include_usage: "true" } }, { stream: true, stream_options: { include_obfuscation: false } },
    { messages: [null, user] }, { messages: [user, { role: "developer", content: "late" }, user] },
    { messages: [{ role: "tool", content: "answer" }, user] }, { messages: [{ ...user, name: "alias" }] },
    { messages: [{ ...user, content: [{ type: "image_url", image_url: { url: "example" } }] }] },
    { messages: [{ ...user, content: [{ type: "text", text: "question", extra: true }] }] },
    { messages: [{ ...user, content: [null] }] }, { messages: [{ ...user, content: ["question"] }] },
    { messages: [{ role: "assistant", content: "answer" }] },
  ]) {
    expect(() => parseChatCompletion({ ...body, ...overrides })).toThrow(AgyError);
  }
});

test("the JSON completion reports text and the inclusive ACP token totals", async () => {
  async function* turn(): AsyncGenerator<AcpEvent> {
    yield { event: "update", sessionId: "s", update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" },
    } };
    yield { event: "result", sessionId: "s", result: {
      stopReason: "max_tokens", usage: { inputTokens: 10, outputTokens: 2, cachedReadTokens: 3, cachedWriteTokens: 4 },
    } };
  }
  const response = await openAIJson(turn(), "test");
  expect(await response.json()).toEqual({
    id: expect.stringMatching(/^chatcmpl-/), created: expect.any(Number), object: "chat.completion", model: "test",
    choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "length" }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  });
});

function payload(frame: string) {
  expect(frame).toMatch(/^data: [^\n]+\n\n$/);
  return JSON.parse(frame.slice(6));
}

test("stream chunks retain their metadata and end with optional usage and DONE", () => {
  const stream = openAIStream("test", true);
  const [start, text, finish, usage, done] = [
    ...stream.start(), ...stream.text("answer\n\ntext"), ...stream.finish("refusal", { input_tokens: 4, output_tokens: 2 }),
  ];
  const header = { id: payload(start).id, created: payload(start).created, model: "test", object: "chat.completion.chunk" };
  expect(header.id).toMatch(/^chatcmpl-/);
  expect(Number.isInteger(header.created)).toBe(true);
  expect(payload(start)).toEqual({ ...header, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }], usage: null });
  expect(payload(text)).toEqual({ ...header, choices: [{ index: 0, delta: { content: "answer\n\ntext" }, finish_reason: null }], usage: null });
  expect(payload(finish)).toEqual({ ...header, choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }], usage: null });
  expect(payload(usage)).toEqual({ ...header, choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } });
  expect(done).toBe("data: [DONE]\n\n");
  const [withoutUsage, last] = openAIStream("test", false).finish("stop_sequence");
  expect(payload(withoutUsage)).not.toHaveProperty("usage");
  expect(payload(withoutUsage).choices[0].finish_reason).toBe("stop");
  expect(last).toBe("data: [DONE]\n\n");
  expect(payload(openAIStream("test", true).finish("end_turn")[1]).usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});

test("HTTP and stream failures use the same OpenAI error envelope", async () => {
  const error = new AgyError("rate_limit", "Rate limit reached", { details: { retryAfterMs: 1500 } });
  const response = openAIErrorResponse(error);
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBe("2");
  const envelope = await response.json();
  expect(envelope).toEqual({ error: { message: "Rate limit reached (retry after 2 seconds)", type: "rate_limit_error", code: "agy_rate_limit", param: null, retry_after: 2 } });
  expect(payload(openAIStream("test", false).error(error))).toEqual(envelope);
  const missing = openAIErrorResponse(new AgyError("unknown_model", "Unknown model"));
  expect(missing.status).toBe(404);
  expect((await missing.json()).error.code).toBe("model_not_found");
});

test("an ACP failure after the first chunk closes OpenAI SSE with an error and no DONE", async () => {
  async function* turn(): AsyncGenerator<AcpEvent> {
    yield { event: "update", sessionId: "s", update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" },
    } };
    throw new AgyError("rate_limit", "Rate limit reached", { details: { retryAfter: 2 } });
  }
  const controller = new AbortController();
  const response = await streamTurn(turn(), openAIStream("test", true), controller.signal, () => controller.abort(), () => {});
  const stream = await response.text();
  expect(stream).toContain('"content":"partial"');
  expect(stream).toContain('"type":"rate_limit_error"');
  expect(stream).not.toContain("[DONE]");
  expect(stream).not.toContain("event:");
});
