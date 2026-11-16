import { expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertHostToolCompatibility } from "../src/acp-compatibility.js";
import { createAcpWorker } from "../src/acp-process.js";

test.skipIf(!process.env.AGY_TEST_MACOS_ACP_DIR)("frozen macOS ARM CLI passes the single-hash gate and altered bytes fail", async () => {
  // The macos job runs on an ARM64 runner; assert it where the artifact is real.
  if (process.platform === "darwin") expect(process.arch).toBe("arm64");
  const source = process.env.AGY_TEST_MACOS_ACP_DIR!;
  const executable = join(source, "antigravity");
  await expect(assertHostToolCompatibility(executable, "darwin", "arm64")).resolves.toBeUndefined();
  const root = await mkdtemp(join(tmpdir(), "agy-macos-profile-"));
  try {
    const candidate = join(root, "antigravity");
    const bytes = new Uint8Array(await readFile(executable));
    await writeFile(candidate, bytes);
    await expect(assertHostToolCompatibility(candidate, "darwin", "arm64")).resolves.toBeUndefined();
    await appendFile(candidate, "\0");
    await expect(assertHostToolCompatibility(candidate, "darwin", "arm64")).rejects.toMatchObject({ code: "agy_acp_compatibility" });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

// Platform boundary: only Linux x64 may start the production CLI. The
// production worker factory fails closed on unverified platforms before any
// credential read or spawn; this asserts the gate itself, with no fixture
// mocks, and never launches the official macOS CLI.
test.skipIf(process.platform === "linux")("production worker factory rejects this unverified platform before auth or spawn", async () => {
  const root = await mkdtemp(join(tmpdir(), "agy-macos-factory-gate-"));
  try {
    await expect(createAcpWorker({ cwd: root })).rejects.toMatchObject({
      kind: "unsupported",
      code: "agy_cli_platform_unverified",
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
