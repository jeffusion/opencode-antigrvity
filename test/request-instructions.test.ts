import { expect, test } from "bun:test";
import { withAgentSystem } from "../src/request-instructions.js";
import { hostInstructions } from "../src/prompt.js";

test("configured system replaces generated context without changing user/history/tools", async () => {
  const body = {
    system: [{ type: "text", text: "GENERATED_SKILLS_AGENTS_ENV" }],
    messages: [{ role: "user", content: "You are a subagent spawned by another session.\nTask" }],
    tools: [{ name: "shell", input_schema: { type: "object" } }],
    model: "gemini-3.8-flash", stream: true,
  };
  const request = new Request("http://localhost/messages", {
    method: "POST", headers: { "content-type": "application/json", "content-length": "999", "x-test": "preserved" },
    body: JSON.stringify(body),
  });
  const rewritten = await withAgentSystem(request, "Search carefully.\nDo not write files.");
  expect(await rewritten.json()).toEqual({ ...body, system: "Search carefully.\nDo not write files." });
  expect(rewritten.headers.get("x-test")).toBe("preserved");
  expect(rewritten.headers.has("content-length")).toBe(false);
  expect(await request.json()).toEqual(body);
  expect(hostInstructions("Search carefully.\nDo not write files.")).toBe("<instruction>\nSearch carefully.\nDo not write files.\n</instruction>");
});

test("missing, empty and whitespace-only agent system never fall back to generated text", async () => {
  for (const system of [undefined, "", " \n\t"]) {
    const request = new Request("http://localhost/messages", {
      method: "POST", body: JSON.stringify({ system: "GENERATED_DEFAULT", messages: [{ role: "user", content: "Task" }] }),
    });
    const rewritten = await withAgentSystem(request, system);
    const body = await rewritten.json();
    expect(body.system).toBe("");
    expect(hostInstructions(body.system)).toBe("");
    expect(body.messages).toEqual([{ role: "user", content: "Task" }]);
  }
});
