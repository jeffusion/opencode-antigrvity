import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, spyOn, test } from "bun:test";
import { SessionStore, validResponse } from "../src/session-store.js";

const DAY_MS = 24 * 60 * 60_000;

async function receiptFile(directory: string): Promise<string> {
  const [identity] = await readdir(join(directory, "requests"));
  const [file] = await readdir(join(directory, "requests", identity));
  return join(directory, "requests", identity, file);
}

describe("non-secret session persistence", () => {
  test("defaults to the opencode-antigravity directory under XDG_DATA_HOME", async () => {
    const dataHome = await mkdtemp(join(tmpdir(), "opencode-antigravity-xdg-store-"));
    const previousDataDir = process.env.OPENCODE_ANTIGRAVITY_DATA_DIR;
    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    try {
      delete process.env.OPENCODE_ANTIGRAVITY_DATA_DIR;
      process.env.XDG_DATA_HOME = dataHome;
      await new SessionStore().set("default-location", {
        sessionId: "session-id",
        model: "model",
        cwd: "/workspace",
        cliVersion: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastUsedAt: Date.now(),
      });
      const storePath = join(dataHome, "opencode-antigravity", "sessions.json");
      expect(JSON.parse(await readFile(storePath, "utf8"))["default-location"].sessionId).toBe("session-id");
    } finally {
      if (previousDataDir === undefined) delete process.env.OPENCODE_ANTIGRAVITY_DATA_DIR;
      else process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = previousDataDir;
      if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousXdgDataHome;
      await rm(dataHome, { recursive: true, force: true });
    }
  });

  test("writes restrictive metadata and no credential fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-antigravity-store-"));
    process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = directory;
    const store = new SessionStore();
    await store.set("hashed-session", {
      sessionId: "session-id",
      model: "model",
      effort: "low",
      cwd: "/workspace",
      cliVersion: "1.1.20",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastUsedAt: Date.now(),
    });
    const raw = JSON.parse(await readFile(join(directory, "sessions.json"), "utf8"));
    expect(raw["hashed-session"].sessionId).toBe("session-id");
    expect(JSON.stringify(raw)).not.toContain("refresh");
    expect(JSON.stringify(raw)).not.toContain("access");
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, "sessions.json"))).mode & 0o777).toBe(0o600);
  });
});

test("independent store instances preserve each other's writes", async () => {
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = await mkdtemp(join(tmpdir(), "antigravity-store-concurrent-"));
  const left = new SessionStore();
  const right = new SessionStore();
  await Promise.all([left.entries(), right.entries()]);
  const record = { sessionId: "s", model: "m", cwd: "/workspace", cliVersion: null, createdAt: Date.now(), updatedAt: Date.now(), lastUsedAt: Date.now() };
  await Promise.all([left.set("left", record), right.set("right", record)]);
  expect((await left.entries()).map(([key]) => key).sort()).toEqual(["left", "right"]);
  expect((await right.entries()).length).toBe(2);
});

test("turn lock excludes another process and recovers a dead owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agy-store-process-"));
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = directory;
  const storeModule = join(import.meta.dir, "..", "src", "session-store.ts");
  const child = Bun.spawn([process.execPath, "--eval", `
    const { SessionStore } = await import(${JSON.stringify(storeModule)});
    await new SessionStore().lockTurn("shared");
    console.log("locked");
    await Bun.stdin.text();
  `], { env: { ...process.env }, stdout: "pipe", stderr: "pipe", stdin: "pipe" });
  const reader = child.stdout.getReader();
  try {
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain("locked");
    await expect(new SessionStore().lockTurn("shared")).rejects.toThrow("busy");
    child.kill("SIGKILL");
    await child.exited;
    const unlock = await new SessionStore().lockTurn("shared");
    await unlock();
  } finally {
    reader.releaseLock();
    child.kill();
    await child.exited;
  }
});

test("concurrent processes preserve every session mapping", async () => {
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = await mkdtemp(join(tmpdir(), "antigravity-store-writers-"));
  const storeModule = join(import.meta.dir, "..", "src", "session-store.ts");
  const children = Array.from({ length: 3 }, (_, index) => Bun.spawn([process.execPath, "--eval", `
    const { SessionStore } = await import(${JSON.stringify(storeModule)});
    const store = new SessionStore();
    for (let i = 0; i < 5; i++) await store.set(${JSON.stringify(String(index))} + "-" + i, {
      sessionId: "s", model: "m", cwd: "/workspace", cliVersion: null,
      createdAt: Date.now(), updatedAt: Date.now(), lastUsedAt: Date.now()
    });
  `], { env: { ...process.env }, stdout: "ignore", stderr: "pipe" }));
  expect(await Promise.all(children.map(child => child.exited))).toEqual([0, 0, 0]);
  expect((await new SessionStore().entries()).length).toBe(15);
});

test("pruning preserves sessions locked by another owner", async () => {
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = await mkdtemp(join(tmpdir(), "antigravity-store-prune-"));
  const store = new SessionStore();
  await store.set("active", { sessionId: "s", model: "m", cwd: "/workspace", cliVersion: null,
    createdAt: 1, updatedAt: 1, lastUsedAt: 1 });
  const unlock = await store.lockTurn("active");
  try {
    await new SessionStore().prune(0);
    expect(await store.get("active")).toBeDefined();
  } finally { await unlock(); }
  await store.prune(0);
  expect(await store.get("active")).toBeUndefined();
});

describe("receipt read-modify-write locking", () => {
  test("receipt reads, expiry pruning and saves share one receipt lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "antigravity-receipt-shared-lock-"));
    process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = directory;
    const store = new SessionStore();
    await store.saveReceipt("session", "request", { state: "completed", events: [] });
    const keys: string[] = [];
    const lockTurn = store.lockTurn.bind(store);
    spyOn(store, "lockTurn").mockImplementation(async (key: string, waitMs?: number) => {
      keys.push(key);
      return lockTurn(key, waitMs);
    });
    await store.receipt("session", "request");
    await store.pruneCompletedPayloads(Date.now() + 8 * DAY_MS);
    await store.saveReceipt("session", "request", { state: "running" });
    const locks = keys.filter(key => key.startsWith("receipt:"));
    expect(locks.length).toBe(3);
    expect(new Set(locks).size).toBe(1);
  });

  test("expiry takes the owner lock first and releases the receipt lock first", async () => {
    const directory = await mkdtemp(join(tmpdir(), "antigravity-receipt-lock-order-"));
    process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = directory;
    const store = new SessionStore();
    await store.saveReceipt("session", "request", { state: "completed", events: [] });
    const order: string[] = [];
    const lockTurn = store.lockTurn.bind(store);
    spyOn(store, "lockTurn").mockImplementation(async (key: string, waitMs?: number) => {
      const release = await lockTurn(key, waitMs);
      const name = key.startsWith("receipt:") ? "receipt" : "owner";
      order.push(`+${name}`);
      return async () => { order.push(`-${name}`); await release(); };
    });
    await store.pruneCompletedPayloads(Date.now() + 8 * DAY_MS);
    expect(order).toEqual(["+owner", "+receipt", "-receipt", "-owner"]);
  });

  test("expiry running concurrently with a save cannot erase the newer slice", async () => {
    const directory = await mkdtemp(join(tmpdir(), "antigravity-receipt-race-"));
    process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = directory;
    const store = new SessionStore();
    // Discover the receipt lock through the real method, then hold it as a
    // barrier so expiry and the new save genuinely overlap on disk.
    const keys: string[] = [];
    const lockTurn = store.lockTurn.bind(store);
    spyOn(store, "lockTurn").mockImplementation(async (key: string, waitMs?: number) => {
      const release = await lockTurn(key, waitMs);
      keys.push(key);
      return release;
    });
    await store.saveReceipt("session", "request", { state: "completed", events: [{ type: "agent_message_chunk" } as never], response: { digest: "old", state: "running" } });
    const receiptLock = keys.find(key => key.startsWith("receipt:"))!;
    const unlock = await new SessionStore().lockTurn(receiptLock, 5000);
    const events = [{ type: "agent_message_chunk", text: "new" }] as never[];
    let settled = 0;
    const pruning = store.pruneCompletedPayloads(Date.now() + 8 * DAY_MS).then(() => { settled += 1; });
    const saving = store.saveReceipt("session", "request", { state: "running", response: { digest: "new", state: "running", events } }).then(() => { settled += 1; });
    await Bun.sleep(30);
    // Both queue behind the same lock; an unlocked expiry would have finished.
    expect(settled).toBe(0);
    await unlock();
    await Promise.all([pruning, saving]);
    expect(await store.receipt("session", "request")).toMatchObject({ state: "running", response: { digest: "new", state: "running" } });
    expect((await store.receipt("session", "request"))?.response?.events).toEqual(events);
  });

  test("a receipt with an invalid response slice fails closed and leaves a tombstone", async () => {
    const directory = await mkdtemp(join(tmpdir(), "antigravity-receipt-bad-response-"));
    process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = directory;
    const store = new SessionStore();
    await store.saveReceipt("session", "request", { state: "running" });
    const path = await receiptFile(directory);
    const raw = JSON.parse(await readFile(path, "utf8"));
    raw.response = { digest: "d", state: "nonsense" };
    await writeFile(path, JSON.stringify(raw));
    expect(validResponse(raw.response)).toBe(false);
    expect(validResponse({ digest: "d", state: "running", events: [] })).toBe(true);
    await expect(store.receipt("session", "request")).rejects.toThrow("Invalid request receipt");
    const stored = await store.receipt("session", "request");
    expect(stored).toMatchObject({ state: "uncertain" });
    expect(stored?.response).toBeUndefined();
  });

  test("saveReceipt refuses to overwrite a receipt it could not read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "antigravity-receipt-unreadable-"));
    process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = directory;
    const store = new SessionStore();
    await store.saveReceipt("session", "request", { state: "running" });
    const path = await receiptFile(directory);
    await writeFile(path, "{not json");
    await expect(store.saveReceipt("session", "request", { state: "completed" })).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("{not json");
    // A non-ENOENT read failure (here: a directory sits at the receipt path)
    // must fail closed the same way instead of replacing the evidence.
    await rm(path);
    await mkdir(path);
    await expect(store.saveReceipt("session", "request", { state: "completed" })).rejects.toThrow();
    expect((await stat(path)).isDirectory()).toBe(true);
  });

  test("saving merges the stored slice and never persists an invalid response", async () => {
    const directory = await mkdtemp(join(tmpdir(), "antigravity-receipt-merge-"));
    process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = directory;
    const store = new SessionStore();
    await store.saveReceipt("session", "request", { state: "completed", response: { digest: "d", state: "running", events: [] } });
    await store.saveReceipt("session", "request", { state: "parked" });
    expect(await store.receipt("session", "request")).toMatchObject({ state: "parked", response: { digest: "d", state: "parked", events: [] } });
    await store.saveReceipt("session", "request", { state: "running", response: { digest: "", state: "bogus" } as never });
    expect(await store.receipt("session", "request")).toMatchObject({ state: "running", response: { digest: "d", state: "parked", events: [] } });
    // Without a stored slice there is nothing to merge: the invalid one must
    // not reach disk at all.
    await store.saveReceipt("session", "fresh", { state: "running", response: { digest: "", state: "bogus" } as never });
    expect((await store.receipt("session", "fresh"))?.response).toBeUndefined();
  });
});
