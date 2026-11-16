import { expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fixtureCompatibility } from "./fixtures/compatibility.js";
import { getProxyBaseUrl, getProxyRuntime, startProxy, stopProxy } from "../src/proxy.js";
import { LOCAL_API_KEY, SESSION_HEADER } from "../src/constants.js";

test("proxy replacement waits for old cleanup and keeps the reopened pool usable", async () => {
  const root = await mkdtemp(join(process.env.TMPDIR || "/tmp/opencode", "agy-proxy-lifecycle-"));
  const keys = ["OPENCODE_ANTIGRAVITY_DATA_DIR", "GEMINI_HOME", "FAKE_ACP_PROMPT_LOG", "FAKE_ACP_STATE_FILE"];
  const saved = keys.map(key => process.env[key]);
  const fixture = join(import.meta.dir, "fixtures/fake-acp.mjs");
  const compatibility = fixtureCompatibility();
  let finishCleanup!: () => void;
  const cleanupGate = new Promise<void>(resolve => { finishCleanup = resolve; });
  let enteredCleanup!: () => void;
  const cleanupStarted = new Promise<void>(resolve => { enteredCleanup = resolve; });
  let restoreClose: (() => void) | undefined;
  let stopping: Promise<void> | undefined;
  let restarting: Promise<number> | undefined;
  try {
    process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = join(root, "data");
    process.env.GEMINI_HOME = join(root, "gemini");
    delete process.env.FAKE_ACP_PROMPT_LOG;
    delete process.env.FAKE_ACP_STATE_FILE;
    await chmod(fixture, 0o755);
    await startProxy(root);
    const manager = getProxyRuntime()!.manager;
    const originalClose = manager.close.bind(manager);
    const close = spyOn(manager, "close").mockImplementation(async () => {
      await originalClose();
      enteredCleanup();
      await cleanupGate;
    });
    restoreClose = () => close.mockRestore();

    stopping = stopProxy(root);
    await cleanupStarted;
    restarting = startProxy(root);
    // Let a competing start run while shutdown is paused before pool.close().
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(getProxyRuntime()).toBeNull();
    finishCleanup();
    await Promise.all([stopping, restarting]);

    const response = await fetch(`${getProxyBaseUrl()}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": LOCAL_API_KEY, [SESSION_HEADER]: "reopened-pool" },
      body: JSON.stringify({ model: "gemini-3.8-flash", max_tokens: 1024, messages: [{ role: "user", content: "hello" }] }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).content).not.toHaveLength(0);
  } finally {
    finishCleanup();
    await Promise.allSettled([stopping, restarting]);
    restoreClose?.();
    await stopProxy(root);
    compatibility.mockRestore();
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
    await rm(root, { recursive: true, force: true });
  }
});
