import { createHash } from "node:crypto";
import { join } from "node:path";

/**
 * The single fixed host agent for official Antigravity CLI sessions. Verified
 * on the Linux 1.5.9 payload: selecting this agent strips the CLI's default
 * system text and default components. The upstream CLI still exposes its
 * manage_task tool, so this agent is not a zero-tool guarantee.
 */
export const CLI_AGENT_NAME = "opencode-antigravity";

/** Where the CLI reads the agent from, relative to its --gemini-dir
 * (verified against the official 1.5.9 CLI in cli-proof run-IuSo4u). */
export function cliAgentRelativePath(): string {
  return join("config", "plugins", CLI_AGENT_NAME, "agents", `${CLI_AGENT_NAME}.md`);
}

export function cliAgentPath(geminiDir: string): string {
  return join(geminiDir, cliAgentRelativePath());
}

export const CLI_AGENT_DESCRIPTION = "OpenCode host agent";

/** Digest covers the complete Markdown document, frontmatter included. */
export const CLI_AGENT_MARKDOWN = [
  "---",
  `name: ${CLI_AGENT_NAME}`,
  `description: "${CLI_AGENT_DESCRIPTION}"`,
  "tools: []",
  "excludeDefaultComponents: true",
  "mainAgent: true",
  "---",
  "Use only the tools exposed for this session. Follow the host instructions and the user request.",
  "",
].join("\n");

export const CLI_AGENT_SHA256 = createHash("sha256").update(CLI_AGENT_MARKDOWN).digest("hex");

/**
 * Fixed session arguments for the official CLI, matching the successful A1
 * proof run (run-IuSo4u): flag and value stay separate argv entries. The agent
 * is fixed; only the private home directory varies. There is no generic
 * argument-override bypass.
 */
export function cliSessionArgs(home: string): string[] {
  return ["acp", "--gemini-dir", home, "--app-data-dir", "agy", "--agent", CLI_AGENT_NAME, "--process-per-session", "--disable-telemetry"];
}
