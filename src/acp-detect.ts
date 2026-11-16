import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { AgyProcessError } from "./errors.js";
import { CLI_VERSION, cliDistribution, installAcpServer, matchesCliPin } from "./acp-install.js";
import { cliSessionArgs } from "./cli-agent.js";

export type AcpServerDetection = {
  executable: string;
  args: string[];
  platform: string;
};

type AcpServerSearchOptions = {
  home?: string;
  path?: string;
};

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Legacy PAR distribution overrides are retired: they must fail loudly
 * instead of being reinterpreted as CLI arguments or a CLI executable. */
function rejectLegacyOverrides(): void {
  if (process.env.OPENCODE_ANTIGRAVITY_ACP_ARGS?.trim()) {
    throw new AgyProcessError(
      "OPENCODE_ANTIGRAVITY_ACP_ARGS is not supported by the official CLI migration. CLI session arguments are fixed; only the private home directory varies.",
    );
  }
  if (process.env.OPENCODE_ANTIGRAVITY_ACP_PATH?.trim()) {
    throw new AgyProcessError(
      "OPENCODE_ANTIGRAVITY_ACP_PATH is not used by the official CLI migration and is not interpreted as CLI arguments. Use OPENCODE_ANTIGRAVITY_CLI_PATH for an explicit executable override.",
    );
  }
}

export function acpServerArgs(home = process.env.GEMINI_HOME?.trim() || homedir()): string[] {
  return cliSessionArgs(home);
}

export async function resolveAcpExecutable(preferred?: string, options: AcpServerSearchOptions = {}): Promise<string> {
  rejectLegacyOverrides();
  const distribution = cliDistribution();
  const configured = preferred?.trim() || process.env.OPENCODE_ANTIGRAVITY_CLI_PATH?.trim();
  if (configured) {
    const path = isAbsolute(configured) ? configured : resolve(configured);
    if (!await isExecutable(path)) throw new AgyProcessError(`Configured Antigravity CLI was not found: ${path}`);
    // The explicit override stays pin-gated: it can only select the official
    // bytes, never an arbitrary ACP build.
    if (!await matchesCliPin(path, distribution)) {
      throw new AgyProcessError(`Configured Antigravity CLI does not match the pinned ${distribution.executable} SHA256 for ${process.platform}-${process.arch}`);
    }
    return path;
  }

  const home = options.home ?? homedir();
  const dataHome = process.env.XDG_DATA_HOME?.trim() || join(home, ".local", "share");
  const managed = join(dataHome, "opencode-antigravity", `antigravity-cli-${CLI_VERSION}`);
  const candidate = join(managed, distribution.executable);
  // Every normal discovery return is pin-gated, not only the host-tool path:
  // a cached foreign, truncated or unreadable executable fails closed here.
  // ensureAcpServer then reinstalls verified bytes over it.
  if (await isExecutable(candidate)) {
    if (!await matchesCliPin(candidate, distribution)) {
      throw new AgyProcessError(`The managed Antigravity CLI at ${candidate} does not match the pinned ${distribution.executable} SHA256 and will not be used. Remove it or let installation replace it.`);
    }
    return candidate;
  }

  throw new AgyProcessError(
    `The official Antigravity CLI ${CLI_VERSION} was not found. Remove legacy ACP overrides; installation is automatic or OPENCODE_ANTIGRAVITY_CLI_PATH may point at the pinned executable.`,
  );
}

export async function detectAcpServer(preferred?: string): Promise<AcpServerDetection> {
  const executable = await resolveAcpExecutable(preferred);
  return { executable, args: acpServerArgs(), platform: `${process.platform}-${process.arch}` };
}

export async function ensureAcpServer(preferred?: string, signal?: AbortSignal): Promise<AcpServerDetection> {
  signal?.throwIfAborted();
  rejectLegacyOverrides();
  try {
    return await detectAcpServer(preferred);
  } catch (error) {
    // Never silently ignore a user's explicit override.
    if (preferred?.trim() || process.env.OPENCODE_ANTIGRAVITY_CLI_PATH?.trim()) throw error;
    const executable = await installAcpServer(undefined, undefined, signal);
    return { executable, args: acpServerArgs(), platform: `${process.platform}-${process.arch}` };
  }
}
