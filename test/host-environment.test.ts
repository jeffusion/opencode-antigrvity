import { expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hostEnvironment } from "../src/host-environment.js";
import { effectiveAuth } from "../src/effective-auth.js";
import * as credentials from "../src/cli-credentials.js";
import { CLI_AGENT_MARKDOWN, CLI_AGENT_NAME, cliAgentPath } from "../src/cli-agent.js";

const rawCredential = JSON.stringify({
  auth_method: "consumer",
  token: { access_token: "fixture-access", refresh_token: "fixture-refresh", expiry: "2099-01-01T00:00:00Z" },
  extra: { preserve: true },
});

test("host CLI isolates global MCP, hooks and workspaces with the verified private home seed", async () => {
  const root = await mkdtemp(join(tmpdir(), "agy-host-env-"));
  const source = join(root, "gemini");
  await mkdir(join(source, "antigravity-acp"), { recursive: true });
  await mkdir(join(source, "antigravity-cli"), { recursive: true });
  await mkdir(join(source, "config"));
  await writeFile(join(source, "config/mcp_config.json"), JSON.stringify({ mcpServers: { unwanted: { command: "bad" } } }));
  await writeFile(join(source, "config/hooks.json"), "{}");
  await writeFile(join(source, "antigravity-cli/antigravity-oauth-token"), rawCredential);
  await writeFile(join(source, "antigravity-acp/settings.json"), JSON.stringify({ auth: { type: "oauth-personal" }, gcp: { project: "fixture" }, tools: { unsafe: true } }));
  try {
    const options = {
      GEMINI_HOME: source,
      OPENCODE_ANTIGRAVITY_DATA_DIR: join(root, "data"),
      GEMINI_API_KEY: "host-key-must-not-leak",
      GOOGLE_API_KEY: "host-google-key-must-not-leak",
      GOOGLE_APPLICATION_CREDENTIALS: join(root, "adc.json"),
      GOOGLE_CLOUD_PROJECT: "host-project",
      OPENCODE_ANTIGRAVITY_ACP_PATH: "/legacy/par",
    };
    const a = await hostEnvironment(options, "account-a");
    const b = await hostEnvironment(options, "account-b");
    const home = a.environment.GEMINI_HOME!;
    expect(home).not.toBe(b.environment.GEMINI_HOME);
    expect(await readdir(a.cwd)).toEqual([]);
    expect(await readdir(home)).toEqual(expect.arrayContaining(["agy", "config", "workspace"]));
    expect(await readdir(home)).not.toContain("antigravity-acp");
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    expect((await stat(a.cwd)).mode & 0o777).toBe(0o700);
    expect(a.environment.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("true");
    expect(a.environment.DBUS_SESSION_BUS_ADDRESS).toBe(`unix:path=${join(home, ".no-dbus-session")}`);
    for (const name of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "OPENCODE_ANTIGRAVITY_ACP_PATH", "BROWSER"]) {
      expect(a.environment).not.toHaveProperty(name);
    }
    const token = join(home, "agy", "antigravity-oauth-token");
    expect(await readFile(token, "utf8")).toBe(rawCredential);
    expect((await stat(token)).mode & 0o777).toBe(0o600);
    const agent = cliAgentPath(home);
    expect(await readFile(agent, "utf8")).toBe(CLI_AGENT_MARKDOWN);
    expect(await readFile(join(home, "config", "plugins", CLI_AGENT_NAME, "plugin.json"), "utf8")).toContain(CLI_AGENT_NAME);
    expect(await readFile(join(home, "config", "projects", "default-cli-project.json"), "utf8")).toContain("default-cli-project");
    expect(await readFile(join(home, "agy", "cache", "onboarding.json"), "utf8")).toContain("onboardingComplete");
    expect(await readFile(join(home, "antigravity-cli", "cache", "onboarding.json"), "utf8")).toContain("onboardingComplete");
    expect(await readFile(join(source, "antigravity-cli/antigravity-oauth-token"), "utf8")).toBe(rawCredential);

    // A private refresh state is preserved; only the source logout invalidates it.
    await writeFile(token, "private-refreshed", { mode: 0o600 });
    await chmod(token, 0o600);
    const same = await hostEnvironment(options, "account-a");
    expect(await readFile(join(same.environment.GEMINI_HOME!, "agy", "antigravity-oauth-token"), "utf8")).toBe("private-refreshed");
    const [concurrentA, concurrentB] = await Promise.all([
      hostEnvironment(options, "account-concurrent"),
      hostEnvironment(options, "account-concurrent"),
    ]);
    expect(concurrentA.environment.GEMINI_HOME).toBe(concurrentB.environment.GEMINI_HOME);
    const concurrentHome = concurrentA.environment.GEMINI_HOME!;
    expect(await readFile(join(concurrentHome, "agy", "antigravity-oauth-token"), "utf8")).toBe(rawCredential);
    expect(await readFile(cliAgentPath(concurrentHome), "utf8")).toBe(CLI_AGENT_MARKDOWN);
    expect((await readdir(concurrentHome, { recursive: true })).some(name => String(name).endsWith(".tmp"))).toBe(false);
    await rm(join(source, "antigravity-cli/antigravity-oauth-token"));
    await expect(hostEnvironment(options, "account-a")).rejects.toMatchObject({ code: "agy_cli_auth_required" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("host home identity uses the same credential snapshot as the seeded token", async () => {
  const root = await mkdtemp(join(tmpdir(), "agy-host-snapshot-"));
  const source = join(root, "source");
  const data = join(root, "data");
  await mkdir(join(source, "antigravity-acp"), { recursive: true });
  const credential = { raw: JSON.stringify({ auth_method: "consumer", token: { refresh_token: "snapshot-a" } }), refreshToken: "snapshot-a" };
  const full = spyOn(credentials, "resolveCliCredential").mockResolvedValue(credential);
  let refreshReads = 0;
  const refresh = spyOn(credentials, "resolveCliRefreshToken").mockImplementation(async () => { refreshReads += 1; return "later-b"; });
  try {
    const environment = { GEMINI_HOME: source, OPENCODE_ANTIGRAVITY_DATA_DIR: data };
    const expected = await effectiveAuth(environment, credential.refreshToken);
    const isolated = await hostEnvironment(environment, "snapshot");
    const expectedHome = join(data, "host-acp", createHash("sha256").update(`${expected.scope}:snapshot`).digest("hex"));
    expect(isolated.environment.GEMINI_HOME).toBe(expectedHome);
    expect(refreshReads).toBe(0);
    expect(full).toHaveBeenCalledTimes(1);
    expect(await readFile(join(expectedHome, "agy", "antigravity-oauth-token"), "utf8")).toBe(credential.raw);
  } finally {
    refresh.mockRestore();
    full.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("an intermediate private-home symlink is rejected before any outside write", async () => {
  const root = await mkdtemp(join(tmpdir(), "agy-host-symlink-"));
  const source = join(root, "source");
  const outside = join(root, "outside");
  const home = join(root, "private");
  await mkdir(join(source, "antigravity-cli"), { recursive: true });
  await writeFile(join(source, "antigravity-cli/antigravity-oauth-token"), rawCredential);
  await mkdir(outside);
  await mkdir(home);
  await (await import("node:fs/promises")).symlink(outside, join(home, "config"));
  try {
    await expect(hostEnvironment({ GEMINI_HOME: source, OPENCODE_ANTIGRAVITY_DATA_DIR: join(root, "data") }, "symlink", home)).rejects.toThrow(/not a directory/i);
    expect(await readdir(outside)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent private-home publication cannot clobber the seeded private refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "agy-host-publish-"));
  const home = join(root, "private");
  const source = join(root, "source");
  await mkdir(join(source, "antigravity-acp"), { recursive: true });
  const first = { raw: JSON.stringify({ auth_method: "consumer", token: { refresh_token: "publisher-a" } }), refreshToken: "publisher-a" };
  const second = { raw: JSON.stringify({ auth_method: "consumer", token: { refresh_token: "publisher-b" } }), refreshToken: "publisher-b" };
  let calls = 0;
  const bothResolved = Promise.withResolvers<void>();
  const full = spyOn(credentials, "resolveCliCredential").mockImplementation(async () => {
    const value = calls++ === 0 ? first : second;
    if (calls === 2) bothResolved.resolve();
    await bothResolved.promise;
    return value;
  });
  try {
    const environment = { GEMINI_HOME: source, OPENCODE_ANTIGRAVITY_DATA_DIR: join(root, "data") };
    await Promise.all([hostEnvironment(environment, "publisher-a", home), hostEnvironment(environment, "publisher-b", home)]);
    const token = join(home, "agy", "antigravity-oauth-token");
    expect([first.raw, second.raw]).toContain(await readFile(token, "utf8"));
    expect((await readdir(join(home, "agy"))).some(name => name.includes(".tmp"))).toBe(false);
    expect((await stat(token)).mode & 0o777).toBe(0o600);
  } finally {
    full.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
