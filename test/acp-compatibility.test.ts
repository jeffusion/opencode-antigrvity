import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertHostToolCompatibility } from "../src/acp-compatibility.js";
import { cliDistribution } from "../src/acp-install.js";
import { CLI_AGENT_MARKDOWN, CLI_AGENT_NAME, CLI_AGENT_SHA256, cliAgentPath, cliSessionArgs } from "../src/cli-agent.js";

async function tempFile(bytes: Uint8Array): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "antigravity-cli-profile-"));
  const path = join(root, "antigravity");
  await writeFile(path, bytes);
  return { root, path };
}

test("host-tool gate pins one actual CLI executable hash per platform and fails closed", async () => {
  const fixture = await tempFile(new TextEncoder().encode("not the official CLI"));
  try {
    for (const [platform, arch] of [["linux", "x64"], ["win32", "x64"], ["darwin", "arm64"]]) {
      const pin = cliDistribution(platform, arch).executableSha256;
      expect(pin).toMatch(/^[0-9a-f]{64}$/);
      await expect(assertHostToolCompatibility(fixture.path, platform, arch)).rejects.toMatchObject({ code: "agy_acp_compatibility" });
    }
    // Unknown targets and version strings are not profiles.
    await expect(assertHostToolCompatibility(fixture.path, "linux", "arm64")).rejects.toMatchObject({ code: "agy_acp_compatibility" });
    await expect(assertHostToolCompatibility(join(fixture.root, "missing"), "linux", "x64")).rejects.toMatchObject({ code: "agy_acp_compatibility" });
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("fixed host agent document carries the required frontmatter and content digest", () => {
  expect(CLI_AGENT_SHA256).toMatch(/^[0-9a-f]{64}$/);
  expect(createHash("sha256").update(CLI_AGENT_MARKDOWN).digest("hex")).toBe(CLI_AGENT_SHA256);
  expect(CLI_AGENT_MARKDOWN).toContain(`name: ${CLI_AGENT_NAME}`);
  expect(CLI_AGENT_MARKDOWN).toContain('description: "OpenCode host agent"');
  expect(CLI_AGENT_MARKDOWN).toContain("tools: []");
  expect(CLI_AGENT_MARKDOWN).toContain("excludeDefaultComponents: true");
  expect(CLI_AGENT_MARKDOWN).toContain("mainAgent: true");
  expect(CLI_AGENT_MARKDOWN).toContain("Use only the tools exposed for this session. Follow the host instructions and the user request.");
  // No harness identity text, fingerprint removal or automatic patching.
  expect(CLI_AGENT_MARKDOWN).not.toMatch(/dsh|DeepMind|Antigravity identity|fingerprint|patch/i);
  expect(cliAgentPath("/tmp/gemini")).toBe(join("/tmp/gemini", "config", "plugins", CLI_AGENT_NAME, "agents", `${CLI_AGENT_NAME}.md`));
});

test("CLI session arguments match the proven A1 list and carry no PAR flags", () => {
  expect(cliSessionArgs("/private/home")).toEqual([
    "acp",
    "--gemini-dir",
    "/private/home",
    "--app-data-dir",
    "agy",
    "--agent",
    CLI_AGENT_NAME,
    "--process-per-session",
    "--disable-telemetry",
  ]);
  expect(cliSessionArgs("/private/home")).not.toContain("--uid");
  expect(cliSessionArgs("/private/home")).not.toContain("--notices");
});
