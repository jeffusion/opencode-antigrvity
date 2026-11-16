import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { CLI_VERSION } from "../src/acp-install.js";
import { detectAcpServer, resolveAcpExecutable } from "../src/acp-detect.js";
import { CLI_AGENT_NAME } from "../src/cli-agent.js";

const ENV = [
  "XDG_DATA_HOME",
  "OPENCODE_ANTIGRAVITY_ACP_PATH",
  "OPENCODE_ANTIGRAVITY_ACP_ARGS",
  "OPENCODE_ANTIGRAVITY_CLI_PATH",
  "GEMINI_HOME",
] as const;

// The frozen summary points at the real pinned payloads; tests never execute them.
const frozenSummary = process.env.AGY_MIGRATION_ASSETS_DIR
  ? JSON.parse(readFileSync(join(process.env.AGY_MIGRATION_ASSETS_DIR, "frozen-platforms.json"), "utf8")) as {
      platforms: Record<string, { exe: { path: string; sha256: string } }>;
    }
  : undefined;
const pinnedLinuxExe = frozenSummary?.platforms?.linux_amd64?.exe?.path;
const pinnedLinuxSha256 = frozenSummary?.platforms?.linux_amd64?.exe?.sha256;

async function makeExecutable(path: string): Promise<void> {
  await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(path, 0o755);
}

async function withTempInstall(run: (home: string, dataHome: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "opencode-antigravity-home-"));
  const dataHome = await mkdtemp(join(tmpdir(), "opencode-antigravity-xdg-"));
  const previous = new Map(ENV.map((name) => [name, process.env[name]]));
  process.env.XDG_DATA_HOME = dataHome;
  for (const name of ENV) {
    if (name !== "XDG_DATA_HOME") delete process.env[name];
  }
  try {
    await run(home, dataHome);
  } finally {
    for (const name of ENV) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await Promise.all([
      rm(home, { recursive: true, force: true }),
      rm(dataHome, { recursive: true, force: true }),
    ]);
  }
}

const managedDirectory = (dataHome: string) => join(dataHome, "opencode-antigravity", `antigravity-cli-${CLI_VERSION}`);

test("a cached foreign managed executable is rejected on every discovery path, not just host-tool use", async () => {
  await withTempInstall(async (home, dataHome) => {
    const directory = managedDirectory(dataHome);
    const executable = join(directory, "antigravity");
    await mkdir(directory, { recursive: true });
    await makeExecutable(executable);
    await expect(resolveAcpExecutable(undefined, { home, path: "" })).rejects.toThrow(/does not match the pinned/);
    // detectAcpServer is the service/catalog discovery path with no host-tool gate.
    await expect(detectAcpServer()).rejects.toMatchObject({ code: "agy_process_error" });
  });
});

test("missing installation is reported instead of falling back to PAR names", async () => {
  await withTempInstall(async (home) => {
    await expect(resolveAcpExecutable(undefined, { home, path: "" }))
      .rejects.toMatchObject({ code: "agy_process_error" });
  });
});

test("uses options.home for the managed executable when XDG_DATA_HOME is unset", async () => {
  const home = await mkdtemp(join(tmpdir(), "opencode-antigravity-home-"));
  const previous = new Map(ENV.map((name) => [name, process.env[name]]));
  for (const name of ENV) delete process.env[name];
  try {
    const directory = join(home, ".local", "share", "opencode-antigravity", `antigravity-cli-${CLI_VERSION}`);
    // The foreign executable is found at the home-derived location and refused there.
    await mkdir(directory, { recursive: true });
    await makeExecutable(join(directory, "antigravity"));
    await expect(resolveAcpExecutable(undefined, { home, path: "" }))
      .rejects.toThrow(`antigravity-cli-${CLI_VERSION}`);
  } finally {
    for (const name of ENV) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("an explicit CLI_PATH override is still pin-gated and never silently accepted", async () => {
  await withTempInstall(async (home, dataHome) => {
    const override = join(dataHome, "external", "antigravity");
    await mkdir(join(dataHome, "external"), { recursive: true });
    await makeExecutable(override);
    process.env.OPENCODE_ANTIGRAVITY_CLI_PATH = override;
    await expect(resolveAcpExecutable(undefined, { home, path: "" }))
      .rejects.toThrow(/does not match the pinned/);

    process.env.OPENCODE_ANTIGRAVITY_CLI_PATH = join(dataHome, "missing-cli");
    await expect(resolveAcpExecutable(undefined, { home, path: "" })).rejects.toThrow(/not found/);
  });
});

test("legacy ACP_PATH and ACP_ARGS fail loudly instead of becoming CLI arguments", async () => {
  await withTempInstall(async (home) => {
    process.env.OPENCODE_ANTIGRAVITY_ACP_PATH = join(home, "agy_acp_server.par");
    await expect(resolveAcpExecutable(undefined, { home, path: "" }))
      .rejects.toThrow(/OPENCODE_ANTIGRAVITY_CLI_PATH/);
    delete process.env.OPENCODE_ANTIGRAVITY_ACP_PATH;

    process.env.OPENCODE_ANTIGRAVITY_ACP_ARGS = '["--uid="]';
    await expect(resolveAcpExecutable(undefined, { home, path: "" }))
      .rejects.toThrow(/fixed/);
    await expect(detectAcpServer()).rejects.toThrow(/OPENCODE_ANTIGRAVITY_ACP_ARGS/);
  });
});

test.skipIf(!pinnedLinuxExe || !existsSync(pinnedLinuxExe))("the pinned official executable is accepted as managed and as an explicit override", async () => {
  await withTempInstall(async (home, dataHome) => {
    const directory = managedDirectory(dataHome);
    await mkdir(directory, { recursive: true });
    await symlink(pinnedLinuxExe!, join(directory, "antigravity"));
    const managed = join(directory, "antigravity");
    await expect(resolveAcpExecutable(undefined, { home, path: "" })).resolves.toBe(managed);

    process.env.OPENCODE_ANTIGRAVITY_CLI_PATH = pinnedLinuxExe!;
    await expect(resolveAcpExecutable(undefined, { home, path: "" })).resolves.toBe(pinnedLinuxExe!);
    expect(pinnedLinuxSha256).toMatch(/^[0-9a-f]{64}$/);
    delete process.env.OPENCODE_ANTIGRAVITY_CLI_PATH;

    process.env.GEMINI_HOME = home;
    const detection = await detectAcpServer();
    expect(detection.executable).toBe(managed);
    expect(detection.args).toEqual([
      "acp",
      "--gemini-dir",
      home,
      "--app-data-dir",
      "agy",
      "--agent",
      CLI_AGENT_NAME,
      "--process-per-session",
      "--disable-telemetry",
    ]);
    expect(detection.args).not.toContain("--uid");
    expect(detection.args).not.toContain("--notices");
  });
});

test("argument home default follows GEMINI_HOME then the OS home", async () => {
  await withTempInstall(async () => {
    const { acpServerArgs } = await import("../src/acp-detect.js");
    expect(acpServerArgs("/explicit/home")[2]).toBe("/explicit/home");
    process.env.GEMINI_HOME = "/private/gemini";
    expect(acpServerArgs()[2]).toBe("/private/gemini");
    delete process.env.GEMINI_HOME;
    expect(acpServerArgs()[2]).toBe(homedir());
  });
});
