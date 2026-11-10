import { expect, test } from "bun:test";
import { AgyError } from "../src/errors.js";
import { geminiErrorResponse, geminiJson, geminiStream, parseGeminiContent } from "../src/gemini-content.js";
import type { AcpEvent } from "../src/protocol.js";
import { streamTurn } from "../src/service-messages.js";

const model = "gemini-test";
const contents = [{ parts: [{ text: "Question" }] }];

test("Gemini requests map text, roles, system instructions and output budget", () => {
  expect(parseGeminiContent({
    contents: [
      { role: "user", parts: [{ text: "A" }, { text: "B" }] },
      { role: "model", parts: [{ text: "Answer" }] },
      ...contents,
    ],
    systemInstruction: { role: "user", parts: [{ text: "System" }, { text: "Rules" }] },
    generationConfig: { maxOutputTokens: 512, candidateCount: 1, responseMimeType: "text/plain" },
  }, model, true)).toEqual({
    model, stream: true, maxTokens: 512, system: "System\nRules",
    history: [
      { role: "user", content: "A\nB" },
      { role: "assistant", content: "Answer" },
      { role: "user", content: "Question" },
    ],
  });
  expect(parseGeminiContent({ contents }, model, false).maxTokens).toBe(4096);
});

test("Gemini requests reject unsupported and malformed input", () => {
  for (const fields of [
    { tools: [] },
    { generationConfig: { temperature: 0 } },
    { generationConfig: { responseMimeType: "application/json" } },
    { generationConfig: { candidateCount: 2 } },
    { generationConfig: { maxOutputTokens: 0 } },
    { contents: [{ role: "assistant", parts: [{ text: "Question" }] }] },
    { contents: [{ role: "model", parts: [{ text: "Question" }] }] },
    { contents: [{ parts: [{ text: "Question", thought: true }] }] },
    { contents: [{ parts: [] }] },
    { systemInstruction: { parts: [{ inlineData: { data: "AAAA", mimeType: "image/png" } }] } },
  ]) {
    expect(() => parseGeminiContent({ contents, ...fields }, model, false)).toThrow(AgyError);
  }
});

function text(value: string): AcpEvent {
  return { event: "update", sessionId: "s", update: {
    sessionUpdate: "agent_message_chunk", content: { type: "text", text: value },
  } };
}

test("Gemini JSON contains one text candidate and actual inclusive ACP usage", async () => {
  async function* turn(): AsyncGenerator<AcpEvent> {
    yield text("Hello");
    yield text(" world");
    yield { event: "result", sessionId: "s", result: { stopReason: "max_tokens",
      usage: { inputTokens: 10, outputTokens: 2, cachedReadTokens: 3, cachedWriteTokens: 4, totalTokens: 12, thoughtTokens: 0 },
    } };
  }
  expect(await (await geminiJson(turn(), model)).json()).toEqual({
    candidates: [{ index: 0, content: { role: "model", parts: [{ text: "Hello world" }] }, finishReason: "MAX_TOKENS" }],
    modelVersion: model,
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, cachedContentTokenCount: 3, totalTokenCount: 12, thoughtsTokenCount: 0 },
  });
});

async function readFrames(turn: AsyncGenerator<AcpEvent>) {
  const controller = new AbortController();
  const response = await streamTurn(turn, geminiStream(model), controller.signal, () => controller.abort(), () => {});
  const body = await response.text();
  expect(body.endsWith("\n\n")).toBe(true);
  return body.trimEnd().split("\n\n").map(frame => {
    expect(frame.startsWith("data: ")).toBe(true);
    return JSON.parse(frame.slice("data: ".length));
  });
}

test("Gemini SSE sends text deltas, maps finish reasons, and omits unreported counts", async () => {
  async function* turn(): AsyncGenerator<AcpEvent> {
    yield text("Hel");
    yield text("lo");
    yield { event: "result", sessionId: "s", result: { stopReason: "end_turn" } };
  }
  expect(await readFrames(turn())).toEqual([
    { candidates: [{ index: 0, content: { role: "model", parts: [{ text: "Hel" }] } }], modelVersion: model },
    { candidates: [{ index: 0, content: { role: "model", parts: [{ text: "lo" }] } }], modelVersion: model },
    { candidates: [{ index: 0, finishReason: "STOP" }], modelVersion: model },
  ]);
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 3 };
  expect(geminiStream(model).finish("refusal", usage, { cachedReadTokens: 3 })).toEqual([
    `data: ${JSON.stringify({ candidates: [{ index: 0, finishReason: "OTHER" }], modelVersion: model,
      usageMetadata: { cachedContentTokenCount: 3 } })}\n\n`,
  ]);
});

test("Gemini HTTP and mid-stream errors preserve status and retry information", async () => {
  const failure = new AgyError("rate_limit", "Rate limit reached", { details: { retryAfter: 2 } });
  const response = geminiErrorResponse(failure);
  const details = [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "2s" }];
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBe("2");
  expect(await response.json()).toEqual({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Rate limit reached", details } });
  const missing = geminiErrorResponse(new AgyError("unknown_model", "Unknown model"));
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: { code: 404, status: "NOT_FOUND", message: "Unknown model" } });

  async function* turn(): AsyncGenerator<AcpEvent> {
    yield text("Partial");
    throw failure;
  }
  expect(await readFrames(turn())).toEqual([
    { candidates: [{ index: 0, content: { role: "model", parts: [{ text: "Partial" }] } }], modelVersion: model },
    { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Antigravity could not complete the request", details } },
  ]);
});
