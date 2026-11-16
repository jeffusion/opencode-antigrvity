import { chmod, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { acquireFileLock } from "./file-lock.js";

/** Official Antigravity CLI replacement for the retired PAR distribution. */
export const CLI_VERSION = "1.5.9";
export const CLI_BUILD_ID = "4515810895593472";

// Pins come from migration-assets-xAMwaBG2/frozen-platforms.json (sha256
// f9537201a7bca43bc3c801af7a068afe46395038195485ac6ba8068352af1f95), re-verified
// by parent-asset-audit-QIEZ4m. archiveSha512 authenticates the whole payload;
// executableSha256 pins the actual executable that is published and spawned.
export type CliDistribution = {
  url: string;
  executable: string;
  archive: boolean;
  archiveMember: string | null;
  archiveSha512: string;
  executableSha256: string;
  executableBytes: number;
};

const DISTRIBUTIONS: Record<string, CliDistribution> = {
  "linux-x64": {
    url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.9-4515810895593472/linux-x64/cli_linux_x64.tar.gz",
    executable: "antigravity",
    archive: true,
    archiveMember: "antigravity",
    archiveSha512: "d01eb13ba7750eed18907f1ae8860864371e0ad9064415e8d033d22b4bd7b9b4e4c7f962058520b452d67db1c33163d9a889d55a7dffa159596ec6cd91a87b79",
    executableSha256: "39816d49d5ab92229952987225c23ea3fed7580699dcb4a444e0388e0ac1ce43",
    executableBytes: 265_700_040,
  },
  "win32-x64": {
    url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.9-4515810895593472/windows-x64/cli_windows_x64.exe",
    executable: "antigravity.exe",
    archive: false,
    archiveMember: null,
    archiveSha512: "539a9415a686d9ec45f5c59fe7d32c485c6fa9abaea50208ae8ede4ed3622b9fb2bfd6680c87dc52344981172a96ddacb261ff4231276b5572fb5b62a9b0221e",
    executableSha256: "8803c289cac04d6e53f2211592d9981c2d5760bc0d9b4a7f222ef6ecc7abb38a",
    executableBytes: 231_726_744,
  },
  "darwin-arm64": {
    url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.9-4515810895593472/darwin-arm/cli_mac_arm64.tar.gz",
    executable: "antigravity",
    archive: true,
    archiveMember: "antigravity",
    archiveSha512: "690cd6a5a5fdb23564fb1b14f7f6ae368fa3636b7630f56c574a6dfc0e2791a0e5b93d6515be1650c8a268cfb28440e1b9cbaa1c5b85aa762ab25b51c1fccda5",
    executableSha256: "fad3628ad91fe8613a72f074a1c5fde7cd816517788a5b9be96703f7d256741a",
    executableBytes: 223_424_816,
  },
};

const MAX_PAYLOAD_BYTES = 512 * 1024 * 1024;

export function cliDistribution(platform = process.platform, arch = process.arch): CliDistribution {
  const distribution = DISTRIBUTIONS[`${platform}-${arch}`];
  if (!distribution) throw new Error(`No pinned official Antigravity CLI ${CLI_VERSION} for ${platform}-${arch}`);
  return distribution;
}

export function acpInstallDirectory(): string {
  return join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"), "opencode-antigravity", `antigravity-cli-${CLI_VERSION}`);
}

function digest(algorithm: "sha256" | "sha512", bytes: Uint8Array): string {
  return createHash(algorithm).update(bytes).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** A discoverable executable is only usable when its actual bytes match the
 * pinned size and SHA256; anything else must fail closed or be reinstalled. */
export async function matchesCliPin(path: string, distribution: CliDistribution): Promise<boolean> {
  try {
    const stats = await stat(path);
    if (stats.size !== distribution.executableBytes) return false;
    return await sha256File(path) === distribution.executableSha256;
  } catch {
    return false;
  }
}

/**
 * Read the pinned executable out of the authenticated Unix archive in memory.
 * Bun's File map exposes no entry types or duplicate metadata, so the member
 * set is required to be exactly the expected one: a missing or unknown entry
 * fails closed instead of writing anything from the archive to disk.
 */
export async function unpackCliArchive(bytes: Uint8Array, member: string): Promise<Uint8Array> {
  const files = await new Bun.Archive(bytes).files();
  const names = [...files.keys()];
  if (names.length !== 1 || names[0] !== member) {
    throw new Error(`Official CLI archive must contain exactly ${member}; found ${JSON.stringify(names.sort())}`);
  }
  const file = files.get(member);
  if (!file || file.size === 0) throw new Error(`Official CLI archive is missing a non-empty ${member}`);
  return new Uint8Array(await file.arrayBuffer());
}

/**
 * Read a bounded response body. Content-Length is rejected early when it is
 * already over the bound, but the streamed byte count is authoritative: the
 * body is cancelled and the install fails as soon as the limit is crossed.
 */
async function boundedBody(response: Response): Promise<Uint8Array> {
  const body = response.body;
  if (!body) throw new Error("Official Antigravity CLI response has no body");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PAYLOAD_BYTES) {
    await body.cancel().catch(() => {});
    throw new Error(`Official Antigravity CLI payload exceeds the ${MAX_PAYLOAD_BYTES} byte bound`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PAYLOAD_BYTES) {
        throw new Error(`Official Antigravity CLI payload exceeds the ${MAX_PAYLOAD_BYTES} byte bound`);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks);
}

/** Lazy first-request installation; shared across sessions and server processes. */
export async function installAcpServer(
  directory = acpInstallDirectory(),
  download: typeof fetch = fetch,
  signal?: AbortSignal,
  distribution: CliDistribution = cliDistribution(),
): Promise<string> {
  signal?.throwIfAborted();
  const executable = join(directory, distribution.executable);
  // Only a file matching the pinned size and SHA256 counts as ready; missing,
  // truncated or foreign bytes force a fresh, verified install instead of
  // being handed out unverified.
  const ready = async () => await matchesCliPin(executable, distribution);
  if (await ready()) return executable;
  await mkdir(directory, { recursive: true });
  const release = await acquireFileLock(join(directory, ".install.lock"), 180_000, signal);
  let staging: string | undefined;
  try {
    if (await ready()) return executable;
    const timeout = AbortSignal.timeout(120_000);
    const response = await download(distribution.url, { signal: signal ? AbortSignal.any([timeout, signal]) : timeout, redirect: "error" });
    if (!response.ok) throw new Error(`Official Antigravity CLI download failed: HTTP ${response.status}`);
    const payload = await boundedBody(response);
    if (!payload.length) throw new Error("Official Antigravity CLI payload is empty");
    // Authenticate the whole official payload before unpacking or publishing.
    if (digest("sha512", payload) !== distribution.archiveSha512) {
      throw new Error(`Official Antigravity CLI payload does not match the pinned ${CLI_VERSION} SHA512 for this platform`);
    }
    const bytes = distribution.archive
      ? await unpackCliArchive(payload, distribution.archiveMember!)
      : payload;
    // Pin the actual executable bytes, never the archive digest.
    if (bytes.length !== distribution.executableBytes || digest("sha256", bytes) !== distribution.executableSha256) {
      throw new Error(`Official Antigravity CLI executable does not match the pinned ${CLI_VERSION} SHA256`);
    }
    staging = await mkdtemp(join(directory, ".install-"));
    const staged = join(staging, distribution.executable);
    await writeFile(staged, bytes, { mode: 0o755 });
    await chmod(staged, 0o755);
    // Atomic publish: the pinned executable is the only discoverable artifact.
    await rename(staged, executable);
    return executable;
  } finally {
    try { if (staging) await rm(staging, { recursive: true, force: true }); }
    finally { await release(); }
  }
}
