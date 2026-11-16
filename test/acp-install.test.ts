import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_VERSION, cliDistribution, installAcpServer, unpackCliArchive, type CliDistribution } from "../src/acp-install.js";
import { assertHostToolCompatibility } from "../src/acp-compatibility.js";

const encoder = new TextEncoder();

function sha(algorithm: "sha256" | "sha512", bytes: Uint8Array): string {
  return createHash(algorithm).update(bytes).digest("hex");
}

async function archiveOf(entries: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Bun.Archive(entries, { compress: "gzip" }).bytes();
}

async function fixture(entries: Record<string, Uint8Array>, member = "antigravity") {
  const payload = await archiveOf(entries);
  const executable = entries[member] ?? new Uint8Array();
  const distribution: CliDistribution = {
    url: "https://fixture.invalid/cli.tar.gz",
    executable: member,
    archive: true,
    archiveMember: member,
    archiveSha512: sha("sha512", payload),
    executableSha256: sha("sha256", executable),
    executableBytes: executable.length,
  };
  return { payload, distribution, executable };
}

function serve(payload: Uint8Array, counter: { calls: number }): typeof fetch {
  return (async (url: string) => {
    expect(url).toBe("https://fixture.invalid/cli.tar.gz");
    counter.calls++;
    return new Response(payload);
  }) as unknown as typeof fetch;
}

test("installs the pinned executable once across concurrent requests and reuses it offline", async () => {
  const root = await mkdtemp(join(tmpdir(), "antigravity-cli-install-"));
  const { payload, distribution } = await fixture({ antigravity: encoder.encode("#!/bin/sh\nexit 0\n") });
  const directory = join(root, `antigravity-cli-${CLI_VERSION}`);
  await mkdir(directory, { recursive: true });
  const dead = Bun.spawn([process.execPath, "--eval", ""], { stdout: "ignore", stderr: "ignore" });
  const deadPid = dead.pid;
  await dead.exited;
  if (deadPid === undefined) throw new Error("Could not create stale install-lock fixture");
  await writeFile(join(directory, ".install.lock"), `${deadPid}:${randomUUID()}`);
  const counter = { calls: 0 };
  try {
    const paths = await Promise.all([
      installAcpServer(directory, serve(payload, counter), undefined, distribution),
      installAcpServer(directory, serve(payload, counter), undefined, distribution),
    ]);
    expect(paths[0]).toBe(paths[1]);
    expect(counter.calls).toBe(1);
    expect(await readFile(paths[0], "utf8")).toBe("#!/bin/sh\nexit 0\n");
    if (process.platform !== "win32") expect((await stat(paths[0])).mode & 0o111).toBe(0o111);
    await installAcpServer(directory, serve(payload, counter), undefined, distribution);
    expect(counter.calls).toBe(1);
    expect(await readdir(directory)).toEqual([distribution.executable]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("authenticates the payload SHA512 before unpacking or publishing", async () => {
  const root = await mkdtemp(join(tmpdir(), "antigravity-cli-sha512-"));
  const { payload, distribution } = await fixture({ antigravity: encoder.encode("binary") });
  try {
    const tampered: CliDistribution = { ...distribution, archiveSha512: "0".repeat(128) };
    await expect(installAcpServer(root, serve(payload, { calls: 0 }), undefined, tampered)).rejects.toThrow(/SHA512/);
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects missing or unknown archive members without writing anything", async () => {
  const root = await mkdtemp(join(tmpdir(), "antigravity-cli-members-"));
  try {
    const missing = await fixture({ other: encoder.encode("not the cli") });
    await expect(installAcpServer(root, serve(missing.payload, { calls: 0 }), undefined, missing.distribution))
      .rejects.toThrow(/exactly antigravity/);
    expect(await readdir(root)).toEqual([]);

    const extra = await fixture({ antigravity: encoder.encode("binary"), "evil.sh": encoder.encode("x") });
    await expect(installAcpServer(root, serve(extra.payload, { calls: 0 }), undefined, extra.distribution))
      .rejects.toThrow(/exactly antigravity/);
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pins the actual executable SHA256 separately from the archive digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "antigravity-cli-exe-pin-"));
  const { payload, distribution } = await fixture({ antigravity: encoder.encode("binary") });
  try {
    const wrong: CliDistribution = { ...distribution, executableSha256: sha("sha256", encoder.encode("different")) };
    await expect(installAcpServer(root, serve(payload, { calls: 0 }), undefined, wrong)).rejects.toThrow(/executable does not match/);
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed download leaves no discoverable executable and can be retried", async () => {
  const root = await mkdtemp(join(tmpdir(), "antigravity-cli-retry-"));
  const { payload, distribution } = await fixture({ antigravity: encoder.encode("binary") });
  try {
    await expect(installAcpServer(root, (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch, undefined, distribution))
      .rejects.toThrow(/503/);
    expect(await readdir(root)).toEqual([]);
    const installed = await installAcpServer(root, serve(payload, { calls: 0 }), undefined, distribution);
    expect(sha("sha256", new Uint8Array(await readFile(installed)))).toBe(distribution.executableSha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Windows payload is a bare pinned executable, not an archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "antigravity-cli-windows-"));
  const executable = encoder.encode("MZ fixture");
  const distribution: CliDistribution = {
    url: "https://fixture.invalid/cli.exe",
    executable: "antigravity.exe",
    archive: false,
    archiveMember: null,
    archiveSha512: sha("sha512", executable),
    executableSha256: sha("sha256", executable),
    executableBytes: executable.length,
  };
  try {
    const download = (async () => new Response(executable)) as unknown as typeof fetch;
    const installed = await installAcpServer(root, download, undefined, distribution);
    expect(installed).toBe(join(root, "antigravity.exe"));
    expect(sha("sha256", new Uint8Array(await readFile(installed)))).toBe(distribution.executableSha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("official profile constants match the frozen pins", () => {
  const expected = {
    "linux-x64": ["https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.9-4515810895593472/linux-x64/cli_linux_x64.tar.gz", "d01eb13ba7750eed18907f1ae8860864371e0ad9064415e8d033d22b4bd7b9b4e4c7f962058520b452d67db1c33163d9a889d55a7dffa159596ec6cd91a87b79", "39816d49d5ab92229952987225c23ea3fed7580699dcb4a444e0388e0ac1ce43", 265700040],
    "win32-x64": ["https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.9-4515810895593472/windows-x64/cli_windows_x64.exe", "539a9415a686d9ec45f5c59fe7d32c485c6fa9abaea50208ae8ede4ed3622b9fb2bfd6680c87dc52344981172a96ddacb261ff4231276b5572fb5b62a9b0221e", "8803c289cac04d6e53f2211592d9981c2d5760bc0d9b4a7f222ef6ecc7abb38a", 231726744],
    "darwin-arm64": ["https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.9-4515810895593472/darwin-arm/cli_mac_arm64.tar.gz", "690cd6a5a5fdb23564fb1b14f7f6ae368fa3636b7630f56c574a6dfc0e2791a0e5b93d6515be1650c8a268cfb28440e1b9cbaa1c5b85aa762ab25b51c1fccda5", "fad3628ad91fe8613a72f074a1c5fde7cd816517788a5b9be96703f7d256741a", 223424816],
  } as const;
  for (const [platform, [url, archiveSha512, executableSha256, executableBytes]] of Object.entries(expected)) {
    const [os, arch] = platform.split("-");
    const distribution = cliDistribution(os, arch);
    expect(distribution.url).toBe(url);
    expect(distribution.archiveSha512).toBe(archiveSha512);
    expect(distribution.executableSha256).toBe(executableSha256);
    expect(distribution.executableBytes).toBe(executableBytes);
  }
  expect(() => cliDistribution("linux", "arm64")).toThrow(/No pinned/);
});

test("a corrupted cached executable is never returned and is safely reinstalled", async () => {
  const root = await mkdtemp(join(tmpdir(), "antigravity-cli-repair-"));
  const { payload, distribution } = await fixture({ antigravity: encoder.encode("official bytes") });
  const directory = join(root, `antigravity-cli-${CLI_VERSION}`);
  await mkdir(directory, { recursive: true });
  const cached = join(directory, distribution.executable);
  await writeFile(cached, "foreign executable");
  try {
    const installed = await installAcpServer(directory, serve(payload, { calls: 0 }), undefined, distribution);
    expect(await readFile(installed, "utf8")).toBe("official bytes");
    expect(sha("sha256", new Uint8Array(await readFile(installed)))).toBe(distribution.executableSha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Optional frozen-asset check: the frozen summary points at the real pinned
// payloads (the Linux tarball stays in cli-proof/download). Each payload runs
// through the real install and compatibility paths sequentially, without
// executing anything.
test.skipIf(!process.env.AGY_MIGRATION_ASSETS_DIR)("frozen official payloads install and pass the compatibility gate on all three platforms", async () => {
  const assets = process.env.AGY_MIGRATION_ASSETS_DIR!;
  const frozen = JSON.parse(readFileSync(join(assets, "frozen-platforms.json"), "utf8")) as {
    version: string;
    platforms: Record<string, {
      version: string;
      url: string;
      artifact: { path: string; size: number; sha512Official: string };
      exe: { path: string; size: number; sha256: string };
    }>;
  };
  const root = await mkdtemp(join(tmpdir(), "antigravity-cli-frozen-"));
  try {
    const cases = [
      ["linux_amd64", "linux", "x64"],
      ["windows_amd64", "win32", "x64"],
      ["darwin_arm64", "darwin", "arm64"],
    ] as const;
    for (const [key, platform, arch] of cases) {
      const entry = frozen.platforms[key];
      const distribution = cliDistribution(platform, arch);
      expect(entry.version).toBe(CLI_VERSION);
      expect(distribution.url).toBe(entry.url);
      expect(distribution.archiveSha512).toBe(entry.artifact.sha512Official);
      expect(distribution.executableSha256).toBe(entry.exe.sha256);
      expect(distribution.executableBytes).toBe(entry.exe.size);

      const payload = new Uint8Array(await readFile(entry.artifact.path));
      expect(payload.length).toBe(entry.artifact.size);
      expect(sha("sha512", payload)).toBe(entry.artifact.sha512Official);

      const directory = join(root, `${platform}-${arch}`);
      const download = (async () => new Response(payload)) as unknown as typeof fetch;
      const installed = await installAcpServer(directory, download, undefined, distribution);
      expect((await stat(installed)).size).toBe(entry.exe.size);
      expect(sha("sha256", new Uint8Array(await readFile(installed)))).toBe(entry.exe.sha256);
      await assertHostToolCompatibility(installed, platform, arch);
      if (distribution.archive) {
        const member = await unpackCliArchive(payload, distribution.archiveMember!);
        expect(sha("sha256", member)).toBe(distribution.executableSha256);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 240_000);

test("a declared payload above the 512 MiB bound is rejected before the body is read", async () => {
  const root = await mkdtemp(join(tmpdir(), "antigravity-cli-bound-"));
  const { distribution } = await fixture({ antigravity: encoder.encode("binary") });
  try {
    let cancelled = false;
    const download = (async () => ({
      ok: true,
      headers: new Headers({ "content-length": String(512 * 1024 * 1024 + 1) }),
      // Reading this body must surface its error instead of the bound error.
      body: new ReadableStream<Uint8Array>({
        pull() { throw new Error("body must not be read"); },
        cancel() { cancelled = true; },
      }),
    })) as unknown as typeof fetch;
    await expect(installAcpServer(root, download, undefined, distribution)).rejects.toThrow(/exceeds the 536870912 byte bound/);
    expect(cancelled).toBe(true);
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
