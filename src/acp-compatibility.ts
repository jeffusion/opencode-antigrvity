import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { dirname, join } from "node:path";
import { AgyError } from "./errors.js";
import { acpDistribution } from "./acp-install.js";

// Official Google distribution inspected for tool-filter implementation and
// verified against the official 1.5.0 archives. An empty enabledTools list
// still removes every built-in including native view_file from
// CapabilitiesConfig.enabled_tools, and disables START_SUBAGENT so no
// subagent/browser is injected; 1.5 removed the safe_view_file substitute, so
// that host tool no longer exists. The filter survives new/load/resume and the
// next-turn rebuild. Linux, Windows and macOS ARM64 share the same reviewed
// ACP Python layer; the Windows PyInstaller's 57 PYZ modules match its bundled
// source bytecode. Version strings alone are not a compatibility profile;
// runtime coverage is tracked separately from this static review.
const profiles: Record<string, [string, string]> = {
  "linux-x64": ["8a35f63dd2284e3790a1d97dd0cb2236057c55a0c598b26f3bde022b843d5c04", "13dca92307524722a3434cd50baba3f33502d71a24f804f03ee2efbd18b6017d"],
  "win32-x64": ["209a30dee3f67fbb62710263d38323dc0d66b71b5121eb37ea80b63383dd178a", "4e3644c05a601fd8da1cc9e72639e857d3a7c78f3d2cdf48ea7805ce4a3263ab"],
  "darwin-arm64": ["bbb138a7ff32982e231af325e3176b252174f4c59e4fee7159c0e364ad5f9613", "4eddc5c77a0bb275372fb548a9011a1acc70828a4a72412f2da0733c90db30fe"],
};
async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function assertHostToolCompatibility(executable: string, platform = process.platform, arch = process.arch): Promise<void> {
  const profile = profiles[`${platform}-${arch}`];
  try {
    if (profile && await sha256(executable) === profile[0] && await sha256(join(dirname(executable), acpDistribution(platform, arch).companion)) === profile[1]) return;
  } catch { /* Missing companion or unknown executable fails closed. */ }
  throw new AgyError("unsupported", `This ACP executable pair does not match a reviewed host-tool isolation profile for ${platform}-${arch}. Use the official Antigravity 1.5.0 Linux x64, Windows x64 or macOS ARM64 distribution, including its platform-specific companion. Other platforms/builds require a reviewed profile; version text and executable overrides are not sufficient.`, { code: "agy_acp_compatibility" });
}
