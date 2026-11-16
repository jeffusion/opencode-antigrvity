import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { ACP_VERSION } from "../src/acp-install.js";
import { resolveAcpExecutable } from "../src/acp-detect.js";

const companionName = process.platform === "win32" ? "localharness_external.exe" : "localharness_external";

async function makeExecutable(path: string): Promise<void> {
  await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(path, 0o755);
}

async function withTempInstall(run: (home: string, dataHome: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "opencode-antigravity-home-"));
  const dataHome = await mkdtemp(join(tmpdir(), "opencode-antigravity-xdg-"));
  const previousXdgDataHome = process.env.XDG_DATA_HOME;
  const previousAcpPath = process.env.OPENCODE_ANTIGRAVITY_ACP_PATH;
  process.env.XDG_DATA_HOME = dataHome;
  delete process.env.OPENCODE_ANTIGRAVITY_ACP_PATH;
  try {
    await run(home, dataHome);
  } finally {
    if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdgDataHome;
    if (previousAcpPath === undefined) delete process.env.OPENCODE_ANTIGRAVITY_ACP_PATH;
    else process.env.OPENCODE_ANTIGRAVITY_ACP_PATH = previousAcpPath;
    await Promise.all([
      rm(home, { recursive: true, force: true }),
      rm(dataHome, { recursive: true, force: true }),
    ]);
  }
}

test("discovers the installed ACP server under the XDG Antigravity data directory", async () => {
  await withTempInstall(async (home, dataHome) => {
    const directory = join(dataHome, "opencode-antigravity", `acp-server-${ACP_VERSION}`);
    const executable = join(directory, "agy_acp_server.par");
    await mkdir(directory, { recursive: true });
    await makeExecutable(executable);
    await makeExecutable(join(directory, companionName));

    await expect(resolveAcpExecutable(undefined, { home, path: "" })).resolves.toBe(executable);
  });
});

test("a managed executable without its companion is rejected instead of used", async () => {
  await withTempInstall(async (home, dataHome) => {
    const directory = join(dataHome, "opencode-antigravity", `acp-server-${ACP_VERSION}`);
    await mkdir(directory, { recursive: true });
    await makeExecutable(join(directory, "agy_acp_server.par"));

    await expect(resolveAcpExecutable(undefined, { home, path: "" }))
      .rejects.toMatchObject({ code: "agy_process_error" });
  });
});

test("an explicit OPENCODE_ANTIGRAVITY_ACP_PATH wins over the managed pair and is never swallowed", async () => {
  await withTempInstall(async (home, dataHome) => {
    const directory = join(dataHome, "opencode-antigravity", `acp-server-${ACP_VERSION}`);
    await mkdir(directory, { recursive: true });
    await makeExecutable(join(directory, "agy_acp_server.par"));
    await makeExecutable(join(directory, companionName));
    const override = join(dataHome, "external", "agy_acp_server");
    await mkdir(join(dataHome, "external"), { recursive: true });
    await makeExecutable(override);

    process.env.OPENCODE_ANTIGRAVITY_ACP_PATH = override;
    await expect(resolveAcpExecutable(undefined, { home, path: "" })).resolves.toBe(override);

    process.env.OPENCODE_ANTIGRAVITY_ACP_PATH = join(dataHome, "missing-server");
    await expect(resolveAcpExecutable(undefined, { home, path: "" })).rejects.toThrow(/not found/);
  });
});

test("uses options.home for the managed pair when XDG_DATA_HOME is unset", async () => {
  const home = await mkdtemp(join(tmpdir(), "opencode-antigravity-home-"));
  const previousXdgDataHome = process.env.XDG_DATA_HOME;
  const previousAcpPath = process.env.OPENCODE_ANTIGRAVITY_ACP_PATH;
  delete process.env.XDG_DATA_HOME;
  delete process.env.OPENCODE_ANTIGRAVITY_ACP_PATH;
  try {
    const directory = join(home, ".local", "share", "opencode-antigravity", `acp-server-${ACP_VERSION}`);
    const executable = join(directory, "agy_acp_server.par");
    await mkdir(directory, { recursive: true });
    await makeExecutable(executable);
    await makeExecutable(join(directory, companionName));

    await expect(resolveAcpExecutable(undefined, { home, path: "" })).resolves.toBe(executable);
  } finally {
    if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdgDataHome;
    if (previousAcpPath === undefined) delete process.env.OPENCODE_ANTIGRAVITY_ACP_PATH;
    else process.env.OPENCODE_ANTIGRAVITY_ACP_PATH = previousAcpPath;
    await rm(home, { recursive: true, force: true });
  }
});
