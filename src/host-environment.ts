import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { cliAuthenticationError } from "./auth-bridge.js";
import { CLI_AGENT_MARKDOWN, CLI_AGENT_NAME } from "./cli-agent.js";
import { resolveCliCredential } from "./cli-credentials.js";
import { effectiveAuth } from "./effective-auth.js";

/** Only the OS, networking and certificate variables the verified CLI run
 * needed. Authentication, cloud SDK, project, endpoint and ACP overrides stay
 * out of the native process environment. */
const WORKER_ENVIRONMENT_ALLOWLIST = [
  "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
] as const;

function workerEnvironment(environment: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const isolated: NodeJS.ProcessEnv = {};
  for (const name of WORKER_ENVIRONMENT_ALLOWLIST) {
    const value = environment[name];
    if (value !== undefined) isolated[name] = value;
  }
  return {
    ...isolated,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    GEMINI_HOME: home,
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(home, ".no-dbus-session")}`,
  };
}

async function privateRoot(home: string): Promise<void> {
  const existing = await lstat(home).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) throw new Error(`The private CLI home path is not a directory: ${home}`);
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
}

/** Verify every component from the controlled private home, not only a leaf. */
async function privateDirectory(home: string, ...parts: string[]): Promise<string> {
  await privateRoot(home);
  let current = home;
  for (const part of parts) {
    if (!part || part === "." || part === ".." || part.includes("/") || part.includes("\\")) throw new Error(`Invalid private CLI path component: ${part}`);
    current = join(current, part);
    const existing = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) throw new Error(`The private CLI home path is not a directory: ${current}`);
    if (!existing) {
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error: any) { if (error?.code !== "EEXIST") throw error; }
      const created = await lstat(current);
      if (created.isSymbolicLink() || !created.isDirectory()) throw new Error(`The private CLI home path is not a directory: ${current}`);
    }
    await chmod(current, 0o700);
  }
  return current;
}

async function privateFile(home: string, contents: string, ...parts: string[]): Promise<void> {
  if (!parts.length) throw new Error("A private CLI file needs a relative path");
  const parent = await privateDirectory(home, ...parts.slice(0, -1));
  const path = join(parent, parts[parts.length - 1]);
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new Error(`The private CLI home rejects non-regular files: ${path}`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/** Publish the initial token without replacing a private refresh state.
 * `link` is the atomic no-clobber operation; EEXIST keeps the first file. */
async function seedCliToken(home: string, raw: string): Promise<void> {
  const directory = await privateDirectory(home, "agy");
  const path = join(directory, "antigravity-oauth-token");
  const temporary = join(directory, `.token-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, raw, { mode: 0o600, flag: "wx" });
    try {
      await link(temporary, path);
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
    const existing = await lstat(path);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("The private CLI token path must be a regular file");
    await chmod(path, 0o600);
  } finally { await rm(temporary, { force: true }); }
}

/** Prepare the official CLI's isolated Linux home from the verified A1 seed:
 * fixed agent/plugin, completed onboarding, default project record, private
 * app data and an empty workspace. No host MCP/hooks/skills are imported. */
export async function hostEnvironment(environment: NodeJS.ProcessEnv, scope = "local", utilityDirectory?: string) {
  const credential = await resolveCliCredential(environment);
  if (!credential) throw cliAuthenticationError();
  // Bind the home identity to the same credential snapshot used for the token.
  const effective = await effectiveAuth(environment, credential.refreshToken);
  const data = environment.OPENCODE_ANTIGRAVITY_DATA_DIR?.trim() ||
    join(environment.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode-antigravity");
  const key = createHash("sha256").update(`${effective.scope}:${scope}`).digest("hex");
  const home = utilityDirectory ?? join(data, "host-acp", key);
  await privateDirectory(home);
  await privateDirectory(home, "agy", "cache");
  await privateDirectory(home, "antigravity-cli", "cache");
  await privateDirectory(home, "config", "plugins", CLI_AGENT_NAME, "agents");
  await privateDirectory(home, "config", "projects");
  const cwd = await privateDirectory(home, "workspace");
  await privateFile(home, `${JSON.stringify({ name: CLI_AGENT_NAME }, null, 2)}\n`, "config", "plugins", CLI_AGENT_NAME, "plugin.json");
  await privateFile(home, CLI_AGENT_MARKDOWN, "config", "plugins", CLI_AGENT_NAME, "agents", `${CLI_AGENT_NAME}.md`);
  const onboarding = JSON.stringify({ consumerOnboardingComplete: true, enterpriseOnboardingComplete: false, onboardingComplete: true });
  await privateFile(home, `${onboarding}\n`, "agy", "cache", "onboarding.json");
  await privateFile(home, onboarding, "antigravity-cli", "cache", "onboarding.json");
  await privateFile(home, `${JSON.stringify({ id: "default-cli-project", name: "CLI Project", projectResources: {} }, null, 2)}\n`, "config", "projects", "default-cli-project.json");
  await seedCliToken(home, credential.raw);
  return { cwd, environment: workerEnvironment(environment, home) };
}
