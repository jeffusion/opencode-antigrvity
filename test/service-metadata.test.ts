import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fixtureCompatibility } from "./fixtures/compatibility.js";

// Regression fixture, not production traffic: the 63 KB system reproduces the
// fixed-instruction cost of the 43977c49 failure, so the exact bytes are fake.
const testKey = "fixture-service-metadata-api-key-at-least-32";
const model = "gemini-4-hydrogen";
const user = "HYDROGEN_REGRESSION_USER";
const marker = "HYDROGEN_SYSTEM_FIXED";
const system = `${marker} ${"s".repeat(63_000)}`;
const budgetError = "Fixed instructions and current request exhaust the context budget";

/** Only the fields parseModelsDev reads, in the public https://models.dev/api.json shape. */
function cachedMetadata() {
  return {
    time: Date.now(),
    document: {
      google: { models: {
        "gemini-4-hydrogen": {
          id: model, name: "Gemini 4 Hydrogen", attachment: true, reasoning: true,
          tool_call: true, structured_output: true, temperature: false,
          modalities: { input: ["text", "image", "video", "audio", "pdf"], output: ["text"] },
          limit: { context: 1_048_576, output: 65_536 },
        },
      } },
    },
  };
}

async function startService(directory: string, promptLog: string, environment: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, "test", import.meta.path], {
    stdout: "pipe", stderr: "inherit",
    env: {
      PATH: [dirname(process.execPath), process.env.PATH].join(delimiter),
      AGY_TEST_SERVICE_METADATA_CHILD: "1", AGY_API_KEY: testKey, AGY_PORT: "0",
      AGY_DATA_DIR: directory, AGY_CREDENTIALS_DIR: join(directory, "credentials"),
      OPENCODE_ANTIGRAVITY_ACP_PATH: join(import.meta.dir, "fixtures", "fake-acp.mjs"),
      FAKE_ACP_EXTRA_MODEL: model, FAKE_ACP_PROMPT_LOG: promptLog,
      ...environment,
    },
  });
  const killer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  let logs = "";
  const decoder = new TextDecoder();
  for await (const chunk of child.stdout) {
    logs += decoder.decode(chunk, { stream: true });
    if (logs.includes("agy-api model catalog ready")) break;
  }
  clearTimeout(killer);
  return {
    logs,
    base: /agy-api listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(logs)?.[1],
    async stop() {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 6_000);
      force.unref?.();
      await child.exited;
      clearTimeout(force);
    },
  };
}

function generate(base: string, content: string) {
  return fetch(`${base}/v1beta/models/${model}:generateContent`, {
    method: "POST", headers: { "x-goog-api-key": testKey, "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: content }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: 8_192 },
    }),
    signal: AbortSignal.timeout(10_000),
  });
}

async function prompts(path: string) {
  const raw = await readFile(path, "utf8").catch(() => "");
  return raw.trim() ? raw.trim().split("\n").map(line => JSON.parse(line)) : [];
}

async function prepare(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const promptLog = join(directory, "prompts.jsonl");
  await writeFile(join(directory, "models-dev.json"), JSON.stringify(cachedMetadata()));
  return { directory, promptLog };
}

if (process.env.AGY_TEST_SERVICE_METADATA_CHILD === "1") {
  fixtureCompatibility();
  await import("../src/service.js");
} else {
  test("service startup loads cached models.dev limits before ready and admits a 63 KB fixed system", async () => {
    const { directory, promptLog } = await prepare("agy-service-metadata-");
    const service = await startService(directory, promptLog);
    try {
      expect(service.logs).toContain("agy-api model catalog ready");
      expect(service.base).toBeDefined();
      const response = await generate(service.base!, system);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.candidates[0].content.parts[0].text).toContain("FAKE_OK");

      const entries = await prompts(promptLog);
      expect(entries).toHaveLength(1);
      const blocks = entries[0].prompt;
      // The fixed system crosses once, first, and the operative user request stays last.
      expect(blocks[0]).toEqual({ type: "text", text: `<instruction>\n${system}\n</instruction>` });
      expect(blocks.at(-1)).toEqual({ type: "text", text: user });
      expect(blocks.map((block: { text?: string }) => block.text ?? "").join("\n").split(marker)).toHaveLength(2);

      // Past the known Hydrogen input window (878182 bytes) but below the 1 MB transport cap.
      const oversize = await generate(service.base!, "o".repeat(900_000));
      expect(oversize.status).toBe(400);
      const { error } = await oversize.json();
      expect(error.status).toBe("INVALID_ARGUMENT");
      expect(error.message).toBe(budgetError);
      expect(await prompts(promptLog)).toHaveLength(1);
    } finally {
      await service.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
  test("OPENCODE_ANTIGRAVITY_MODELS_DEV=0 keeps the unknown-model fallback without sending an ACP prompt", async () => {
    const { directory, promptLog } = await prepare("agy-service-metadata-off-");
    const service = await startService(directory, promptLog, { OPENCODE_ANTIGRAVITY_MODELS_DEV: "0" });
    try {
      expect(service.logs).toContain("agy-api model catalog ready");
      expect(service.base).toBeDefined();
      const response = await generate(service.base!, system);
      expect(response.status).toBe(400);
      const { error } = await response.json();
      expect(error.status).toBe("INVALID_ARGUMENT");
      expect(error.message).toBe(budgetError);
      expect(await prompts(promptLog)).toEqual([]);
    } finally {
      await service.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
}
