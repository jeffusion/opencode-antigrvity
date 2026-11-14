import { describe, expect, test } from "bun:test";
import { UnsupportedMediaError } from "../src/errors.js";
import { buildBoundedHistory, historyReferenceBlocks, normalizePrompt, stableConversationKey } from "../src/prompt.js";

test("bounded history keeps reasoning text without its signature", async () => {
  const prompt = await normalizePrompt([
    { role: "assistant", content: [{ type: "thinking", thinking: "REASONING", signature: "sig-secret" }, { type: "text", text: "ANSWER" }] },
    { role: "user", content: "NEXT" },
  ]);
  const history = buildBoundedHistory(prompt.priorMessages, 500);
  expect(history).toContain("REASONING");
  expect(history).toContain("ANSWER");
  expect(history).not.toContain("sig-secret");
});

describe("prompt normalization", () => {
  test("extracts only the latest user text and bounded prior context", async () => {
    const prompt = await normalizePrompt([
      { role: "system", content: "Be concise" },
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: [{ type: "text", text: "second" }] },
    ]);
    expect(prompt.text).toBe("second");
    expect(buildBoundedHistory(prompt.priorMessages, 500)).toContain("first");
    expect(stableConversationKey([{ role: "user", content: "first" }])).toHaveLength(48);
  });

  test("converts ACP-supported media and rejects remote URLs", async () => {
    const prompt = await normalizePrompt([{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }]);
    expect(prompt.blocks[0]).toMatchObject({ type: "image", mimeType: "image/png", data: "AA==" });
    await expect(normalizePrompt([{ role: "user", content: [{ type: "input_audio", data: "AA==", media_type: "audio/wav" }] }])).rejects.toThrow(UnsupportedMediaError);
    await expect(normalizePrompt([{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }])).rejects.toThrow(UnsupportedMediaError);
  });

  test("rejects host tool calls", async () => {
    await expect(normalizePrompt([{ role: "assistant", content: "x", tool_calls: [] }, { role: "user", content: "next" }])).rejects.toThrow(/tool calls/i);
  });

  test("historical assistant references keep media order and render tools as inert text", async () => {
    const blocks = await historyReferenceBlocks({ role: "assistant", content: [
      { type: "thinking", thinking: "WHY", signature: "sig" },
      { type: "text", text: "SEE" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
      { type: "tool_use", id: "call-1", name: "lookup", input: { q: "x" } },
    ] }, []);
    expect(blocks).toEqual([
      { type: "text", text: "[assistant]" },
      { type: "text", text: "WHY" },
      { type: "text", text: "SEE" },
      { type: "image", mimeType: "image/png", data: "AA==" },
      { type: "text", text: '[tool lookup call-1] {"q":"x"}' },
    ]);
  });

  test("plugin still accepts BMP images", async () => {
    const prompt = await normalizePrompt([{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/bmp", data: "AA==" } },
    ] }]);
    expect(prompt.blocks).toEqual([{ type: "image", mimeType: "image/bmp", data: "AA==" }]);
  });

  test("rejects malformed known reasoning blocks instead of silently dropping them", async () => {
    for (const part of [
      { type: "thinking", thinking: 42 },
      { type: "thinking" },
      { type: "thinking", thinking: "x", signature: 7 },
      { type: "redacted_thinking", data: 42 },
      { type: "redacted_thinking" },
    ]) {
      await expect(normalizePrompt([
        { role: "assistant", content: [part] },
        { role: "user", content: "next" },
      ])).rejects.toThrow();
    }
    expect(buildBoundedHistory([{ role: "assistant", content: [{ type: "redacted_thinking", data: "opaque" }, { type: "text", text: "VISIBLE" }] }]))
      .toContain("VISIBLE");
  });

  test("tiny bounded history cannot replay an oversized entry through slice(-0)", () => {
    for (const limit of [1, 10, 24, 40]) {
      const history = buildBoundedHistory([{ role: "user", content: "X".repeat(10_000) }], limit);
      const body = history.split("\n").slice(2, -1).join("\n");
      expect(body.length).toBeLessThanOrEqual(limit);
      expect(history).not.toContain("X".repeat(100));
    }
    const history = buildBoundedHistory([{ role: "user", content: "X".repeat(10_000) }, { role: "assistant", content: "recent" }], 240);
    expect(history.length).toBeLessThanOrEqual(240);
    expect(history).toContain("recent");
  });

  test("parses explicit Anthropic base64 image sources instead of treating the data as a path", async () => {
    const jpeg = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
    const prompt = await normalizePrompt([{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg } }] }]);
    expect(prompt.blocks).toEqual([{ type: "image", data: jpeg, mimeType: "image/jpeg" }]);
  });

  test("rebuilt host tool continuation identifies completed calls without losing steering or images", async () => {
    const prompt = await normalizePrompt([
      { role: "assistant", content: [{ type: "tool_use", id: "original", name: "shell", input: { command: "echo completed" } }] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "original", content: [{ type: "text", text: "ORIGINAL_RESULT" }] },
        { type: "text", text: "NEW_STEERING" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
      ] },
    ], { hostTools: true });
    expect(prompt.text).toContain("have already executed in OpenCode");
    expect(prompt.text).toContain("not a new request to execute those calls");
    expect(prompt.text).toContain("[tool result original]");
    expect(prompt.text.indexOf("ORIGINAL_RESULT")).toBeLessThan(prompt.text.indexOf("NEW_STEERING"));
    expect(prompt.blocks.at(-1)).toMatchObject({ type: "image", data: "AA==" });
  });
});
