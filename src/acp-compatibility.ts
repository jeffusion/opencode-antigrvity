import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { AgyError } from "./errors.js";
import { CLI_BUILD_ID, CLI_VERSION, cliDistribution } from "./acp-install.js";

// These pins are static asset verification only: each executable SHA256 is
// the frozen, parent-audited digest of the official CLI 1.5.9 payload
// (migration-assets-xAMwaBG2). Matching proves byte identity with those
// payloads, not any Windows/macOS runtime result and not credential or home
// isolation. On Linux the pinned build plus the fixed host agent strips the
// CLI's default system text; upstream manage_task remains as an accepted
// residual, so this is not a zero-tool guarantee. The gate is the actual
// executable hash, never a version string and never an archive digest.
async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function assertHostToolCompatibility(executable: string, platform = process.platform, arch = process.arch): Promise<void> {
  let pinned: string | undefined;
  try {
    pinned = cliDistribution(platform, arch).executableSha256;
  } catch { /* Unknown platform: fail closed below. */ }
  try {
    if (pinned && await sha256(executable) === pinned) return;
  } catch { /* Missing or unreadable executable fails closed. */ }
  throw new AgyError("unsupported", `This executable does not match the pinned official Antigravity CLI ${CLI_VERSION} (build ${CLI_BUILD_ID}) host-tool profile for ${platform}-${arch}. Use the official CLI executable for Linux x64, Windows x64 or macOS ARM64. Version text and executable overrides are not sufficient.`, { code: "agy_acp_compatibility" });
}
