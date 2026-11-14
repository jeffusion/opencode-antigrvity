import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { HISTORY_OMISSION } from "../src/budget.js";
import type { ClientToolCall } from "../src/service-messages.js";
import { fixtureCompatibility } from "./fixtures/compatibility.js";

const testKey = "fixture-standalone-tool-api-key-at-least-32";
const model = "fake-model-low";
const prompt = "FAKE_MCP_PARALLEL FAKE_MCP_PERMISSION FAKE_MCP_PREAMBLE FAKE_MCP_SIGNED_ZERO";
const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP9sAAAAASUVORK5CYII=";
const schema = { type: "object", properties: { index: { type: "integer" }, signedZero: { type: "number" } }, required: ["index"] };
const messagesPath = "/v1/messages";
const chatPath = "/v1/chat/completions";
const isChat = (path: string) => path === chatPath;
const toolUse = (call: ClientToolCall) => ({ type: "tool_use", id: call.id, name: call.name, input: call.args });
const toolCall = (call: ClientToolCall) => ({
  type: "function", id: call.id, function: { name: call.name, arguments: JSON.stringify(call.args) },
});
const toolResult = (path: string, call: ClientToolCall) => {
  const content = `result ${call.args.index}`;
  return isChat(path)
    ? { role: "tool", tool_call_id: call.id, content }
    : { type: "tool_result", tool_use_id: call.id, content, is_error: call.args.index === 1 };
};

function continuation(path: string, calls: ClientToolCall[], results = calls) {
  const outputs = [...results].reverse().map(call => toolResult(path, call));
  return isChat(path) ? [
    { role: "user", content: prompt },
    { role: "assistant", content: "I will check.", tool_calls: calls.map(toolCall) },
    ...outputs,
  ] : [
    { role: "user", content: prompt },
    { role: "assistant", content: [{ type: "text", text: "I will check." }, ...calls.map(toolUse)] },
    { role: "user", content: outputs },
  ];
}

function sseFrames(body: string) {
  return body.trimEnd().split("\n\n").map(frame => frame.split("\n").find(line => line.startsWith("data: "))?.slice(6))
    .filter((line): line is string => line !== undefined);
}

async function readReply(response: Response, path: string, stream: boolean): Promise<{ calls: ClientToolCall[]; reason: string; text: string }> {
  expect(response.status).toBe(200);
  if (!stream) {
    const body = await response.json();
    if (isChat(path)) {
      const { message, finish_reason: reason } = body.choices[0];
      const calls = (message.tool_calls ?? []).map((call: ReturnType<typeof toolCall>) =>
        ({ id: call.id, name: call.function.name, args: JSON.parse(call.function.arguments) }));
      return { calls, reason, text: message.content ?? "" };
    }
    return {
      calls: body.content.filter((part: { type: string }) => part.type === "tool_use")
        .map((part: ReturnType<typeof toolUse>) => ({ id: part.id, name: part.name, args: part.input })),
      reason: body.stop_reason,
      text: body.content.filter((part: { type: string }) => part.type === "text").map((part: { text: string }) => part.text).join(""),
    };
  }

  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const data = sseFrames(await response.text());
  const partials: { id: string; name: string; args: string }[] = [];
  let reason = "";
  let text = "";
  if (isChat(path)) {
    expect(data.pop()).toBe("[DONE]");
    for (const frame of data.map(line => JSON.parse(line))) {
      const choice = frame.choices[0];
      if (!choice) {
        expect(frame.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
        continue;
      }
      text += choice.delta.content ?? "";
      reason = choice.finish_reason ?? reason;
      for (const call of choice.delta.tool_calls ?? []) {
        if (call.id) {
          expect(call.type).toBe("function");
          expect(call.index).toBe(partials.length);
          partials.push({ id: call.id, name: call.function.name, args: "" });
        }
        partials[call.index].args += call.function.arguments;
      }
    }
  } else {
    const frames = data.map(line => JSON.parse(line));
    expect(frames[0].type).toBe("message_start");
    expect(frames.at(-1).type).toBe("message_stop");
    let blockIndex: number | undefined;
    for (const frame of frames) {
      if (frame.type === "content_block_start") {
        expect(blockIndex).toBeUndefined();
        blockIndex = frame.index;
        if (frame.content_block.type === "tool_use") {
          expect(frame.index).toBe(partials.length + 1);
          expect(frame.content_block.input).toEqual({});
          partials.push({ id: frame.content_block.id, name: frame.content_block.name, args: "" });
        }
      } else if (frame.type === "content_block_delta") {
        expect(frame.index).toBe(blockIndex);
        if (frame.delta.type === "text_delta") text += frame.delta.text;
        else {
          expect(frame.delta.type).toBe("input_json_delta");
          partials.at(-1)!.args += frame.delta.partial_json;
        }
      } else if (frame.type === "content_block_stop") {
        expect(frame.index).toBe(blockIndex);
        blockIndex = undefined;
      } else if (frame.type === "message_delta") {
        expect(blockIndex).toBeUndefined();
        reason = frame.delta.stop_reason;
      }
    }
  }
  return { calls: partials.map(({ id, name, args }) => ({ id, name, args: JSON.parse(args) })), reason, text };
}

if (process.env.AGY_TEST_STANDALONE_CHILD === "1") {
  fixtureCompatibility();
  await import("../src/service.js");
} else test("standalone Messages and Chat Completions resume only their own tool calls and send images to ACP", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agy-standalone-tools-"));
  const promptLog = join(directory, "prompt.jsonl");
  const toolLog = join(directory, "tools.jsonl");
  const child = Bun.spawn([process.execPath, "test", import.meta.path], {
    stdout: "pipe", stderr: "inherit",
    env: {
      PATH: [dirname(process.execPath), process.env.PATH].join(delimiter),
      AGY_TEST_STANDALONE_CHILD: "1", AGY_API_KEY: testKey, AGY_PORT: "0", AGY_DATA_DIR: directory,
      OPENCODE_ANTIGRAVITY_ACP_PATH: join(import.meta.dir, "fixtures", "fake-acp.mjs"),
      FAKE_ACP_PROMPT_LOG: promptLog, FAKE_ACP_MCP_LIST_LOG: toolLog,
      OPENCODE_ANTIGRAVITY_HISTORY_MAX_CHARS: "512",
      OPENCODE_ANTIGRAVITY_MODELS_DEV: "0",
    },
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 12_000);
  try {
    let logs = "";
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      logs += decoder.decode(chunk, { stream: true });
      if (logs.includes("agy-api model catalog ready")) break;
    }
    const base = /agy-api listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(logs)?.[1];
    expect(logs).toContain("agy-api model catalog ready");
    expect(base).toBeDefined();
    const post = (path: string, body: object, key = testKey) => fetch(base + path, {
      method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5_000),
    });
    const invalid = async (path: string, body: object, status = 400, key = testKey) => {
      const response = await post(path, body, key);
      expect(response.status).toBe(status);
      const { error } = await response.json();
      if (path.startsWith("/v1beta/")) expect(error.status).toBe("INVALID_ARGUMENT");
      else expect(error.type).toBe(status === 401 ? "authentication_error" : "invalid_request_error");
    };

    for (const path of [messagesPath, chatPath]) {
      const chat = isChat(path);
      for (const stream of [false, true]) {
        const body = { model, max_tokens: 128, stream, ...(chat && stream ? { stream_options: { include_usage: true } } : {}) };
        const first = await readReply(await post(path, {
          ...body,
          messages: [{ role: "user", content: chat ? [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:image/png;base64,${imageData}` } },
          ] : prompt }],
          tools: chat ? [{ type: "function", function: { name: "lookup", parameters: schema } }]
            : [{ name: "lookup", input_schema: schema }],
        }), path, stream);
        expect(first.reason).toBe(chat ? "tool_calls" : "tool_use");
        expect(first.text).toBe("I will check.");
        expect(first.calls).toHaveLength(2);
        expect(first.calls.map(call => call.name)).toEqual(["lookup", "lookup"]);
        expect(first.calls.map(call => call.args.index).sort()).toEqual([0, 1]);
        expect(first.calls.every(call => Object.is(call.args.signedZero, 0))).toBe(true);
        expect(new Set(first.calls.map(call => call.id)).size).toBe(2);

        const follow = { ...body, messages: continuation(path, first.calls) };
        await invalid(path, follow, 401, "wrong-key");
        await invalid(path, { ...follow, model: "gemini-3.8-flash-high" });
        const other = chat ? messagesPath : chatPath;
        await invalid(other, { model, max_tokens: 128, messages: continuation(other, first.calls) });
        await invalid(`/v1beta/models/${model}:generateContent`, { contents: [{ parts: first.calls.map(({ id, name }) => ({
          functionResponse: { id, name, response: { output: "wrong protocol" } },
        })) }] });
        await invalid(path, { ...follow, messages: continuation(path, first.calls, first.calls.slice(0, 1)) });
        await invalid(path, { ...follow, messages: continuation(path, first.calls, [first.calls[0], first.calls[0]]) });
        for (const change of [{ name: "wrong_tool" }, { args: { ...first.calls[0].args, signedZero: 1 } }]) {
          const tampered = [{ ...first.calls[0], ...change }, first.calls[1]];
          await invalid(path, { ...follow, messages: continuation(path, tampered) });
        }

        const final = await readReply(await post(path, follow), path, stream);
        expect(final.reason).toBe(chat ? "stop" : "end_turn");
        expect(final.calls).toEqual([]);
        expect(JSON.parse(final.text)).toEqual([0, 1].map(index => ({
          content: [{ type: "text", text: `result ${index}` }],
          isError: !chat && index === 1,
        })));
        await invalid(path, follow);
      }
    }

    // The large call alone exceeds the optional budget. Its much smaller result
    // would fit if reconstruction failed to treat the pair as one unit.
    const history = [
      { call: { id: "omitted", name: "lookup", args: { data: "x".repeat(1024) } }, result: "ORPHAN_RESULT" },
      { call: { id: "retained", name: "lookup", args: { data: "RETAINED_CALL" } }, result: "RETAINED_RESULT" },
    ];
    const anthropicHistory = history.flatMap(({ call, result }) => [
      { role: "assistant", content: [toolUse(call)] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: result }] },
    ]);
    const chatHistory = history.flatMap(({ call, result }) => [
      { role: "assistant", content: null, tool_calls: [toolCall(call)] },
      { role: "tool", tool_call_id: call.id, content: result },
    ]);
    const geminiHistory = history.flatMap(({ call, result }) => [
      { role: "model", parts: [{ functionCall: call }] },
      { role: "user", parts: [{ functionResponse: { id: call.id, name: call.name, response: { result } } }] },
    ]);
    for (const [path, messages] of [[messagesPath, anthropicHistory], [chatPath, chatHistory]] as const) {
      const response = await post(path, { model, max_tokens: 128, messages: [
        ...messages, { role: "assistant", content: "Done." }, { role: "user", content: "New question." },
      ] });
      expect(response.status).toBe(200);
      await response.text();
    }
    const response = await post(`/v1beta/models/${model}:generateContent`, { contents: [
      ...geminiHistory, { role: "model", parts: [{ text: "Done." }] }, { role: "user", parts: [{ text: "New question." }] },
    ] });
    expect(response.status).toBe(200);
    await response.text();

    const prompts = (await readFile(promptLog, "utf8")).trim().split("\n").map(line => JSON.parse(line).prompt);
    expect(prompts).toHaveLength(7);
    expect(prompts.slice(2, 4)).toEqual(Array.from({ length: 2 }, () => [
      { type: "text", text: prompt }, { type: "image", mimeType: "image/png", data: imageData },
    ]));
    for (const blocks of prompts.slice(4)) {
      const text = blocks.map((block: { text: string }) => block.text).join("\n");
      expect(text).toContain(HISTORY_OMISSION);
      expect(text).not.toContain("ORPHAN_RESULT");
      expect(text).toContain("RETAINED_CALL");
      expect(text).toContain("RETAINED_RESULT");
      expect(text).toContain("New question.");
    }
    const toolLists = (await readFile(toolLog, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(toolLists).toEqual(Array.from({ length: 4 }, () => [{ name: "lookup", inputSchema: schema }]));
    expect(await readdir(join(directory, "work"))).toEqual([]);
  } finally {
    child.kill("SIGTERM");
    await child.exited;
    clearTimeout(timeout);
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
