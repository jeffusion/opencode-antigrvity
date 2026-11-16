import { expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertHostToolCompatibility } from "../src/acp-compatibility.js";
import { cliDistribution } from "../src/acp-install.js";
import { SessionStore } from "../src/session-store.js";
import { createAcpWorker } from "../src/acp-process.js";

test("Windows distribution targets the pinned official CLI exe and rejects unknown builds", async () => {
  const root = await mkdtemp(join(tmpdir(), "agy-windows-profile-"));
  try {
    const distribution = cliDistribution("win32", "x64");
    expect(distribution.executable).toBe("antigravity.exe");
    expect(distribution.archive).toBe(false);
    expect(distribution.url).toBe("https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.9-4515810895593472/windows-x64/cli_windows_x64.exe");
    const executable = join(root, distribution.executable);
    await writeFile(executable, "unreviewed CLI");
    await expect(assertHostToolCompatibility(executable, "win32", "x64")).rejects.toMatchObject({ code: "agy_acp_compatibility" });
    await expect(assertHostToolCompatibility(executable, "win32", "arm64")).rejects.toMatchObject({ code: "agy_acp_compatibility" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Optional official-artifact check, also run on Linux after reviewing the
// Windows archive. Nothing here executes the downloaded Windows binary.
test.skipIf(!process.env.AGY_TEST_WINDOWS_ACP_DIR)("frozen Windows CLI passes the single-hash gate and altered bytes fail", async () => {
  const source = process.env.AGY_TEST_WINDOWS_ACP_DIR!;
  const executable = join(source, "antigravity.exe");
  await expect(assertHostToolCompatibility(executable, "win32", "x64")).resolves.toBeUndefined();
  const root = await mkdtemp(join(source, "profile-check-"));
  try {
    const candidate = join(root, "antigravity.exe");
    const bytes = new Uint8Array(await readFile(executable));
    await writeFile(candidate, bytes);
    await expect(assertHostToolCompatibility(candidate, "win32", "x64")).resolves.toBeUndefined();
    await appendFile(candidate, "\0");
    await expect(assertHostToolCompatibility(candidate, "win32", "x64")).rejects.toMatchObject({ code: "agy_acp_compatibility" });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("session records can be persisted and atomically replaced on the native filesystem", async () => {
  const root = await mkdtemp(join(tmpdir(), "agy-platform-store-"));
  const previous = process.env.OPENCODE_ANTIGRAVITY_DATA_DIR;
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = root;
  try {
    await mkdir(join(root, "workspace with spaces"));
    const store = new SessionStore();
    const record = { sessionId: "first", model: "model", cwd: join(root, "workspace with spaces"), cliVersion: "1.3.0", createdAt: 1, updatedAt: 1, lastUsedAt: 1 };
    await store.set("windows-session", record);
    await store.set("windows-session", { ...record, sessionId: "replacement" });
    expect((await new SessionStore().get("windows-session"))?.sessionId).toBe("replacement");
    await store.saveReceipt("windows-session", "request", { state: "prepared" });
    expect((await new SessionStore().receipt("windows-session", "request"))?.state).toBe("prepared");
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_ANTIGRAVITY_DATA_DIR;
    else process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

// Platform boundary: only Linux x64 may start the production CLI. The
// production worker factory fails closed on unverified platforms before any
// credential read or spawn; this asserts the gate itself, with no fixture
// mocks, and never launches the official Windows CLI.
test.skipIf(process.platform === "linux")("production worker factory rejects this unverified platform before auth or spawn", async () => {
  const root = await mkdtemp(join(tmpdir(), "agy-windows-factory-gate-"));
  try {
    await expect(createAcpWorker({ cwd: root })).rejects.toMatchObject({
      kind: "unsupported",
      code: "agy_cli_platform_unverified",
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
