import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

export function geminiHome(environment: NodeJS.ProcessEnv): string {
  return environment.GEMINI_HOME?.trim() || join(environment.HOME?.trim() || homedir(), ".gemini");
}

// CLI 1.3.5 uses zalando/go-keyring: generic target service:user, raw
// UTF-8 JSON bytes (not UTF-16). See docs/credential-review.md.
const credentialScript = String.raw`
$ErrorActionPreference = 'Stop'
try {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AgyCredential {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Credential {
    public uint Flags, Type;
    public string TargetName, Comment;
    public long LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist, AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool Read(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint="CredFree")]
  public static extern void Free(IntPtr credential);
  public static byte[] ReadBlob() {
    IntPtr pointer;
    if (!Read("gemini:antigravity", 1, 0, out pointer)) {
      if (Marshal.GetLastWin32Error() == 1168) return null;
      throw new Exception("Credential read failed");
    }
    try {
      var credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
      if (credential.CredentialBlobSize == 0 || credential.CredentialBlobSize > 2560) return null;
      var bytes = new byte[credential.CredentialBlobSize];
      Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
      return bytes;
    } finally { Free(pointer); }
  }
}
'@
$bytes = [AgyCredential]::ReadBlob()
if ($null -ne $bytes) { [Console]::Out.Write([Convert]::ToBase64String($bytes)) }
} catch { exit 2 }
`;

/** Reads only the official target. Never enumerate credentials or return raw errors. */
export async function readWindowsCliCredential(environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const systemRoot = environment.SystemRoot || process.env.SystemRoot;
    if (!systemRoot) return undefined;
    const { stdout } = await promisify(execFile)(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(credentialScript, "utf16le").toString("base64")],
      { env: environment, windowsHide: true, timeout: 10_000, maxBuffer: 16_384, encoding: "utf8" });
    if (!stdout.trim()) return undefined;
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(stdout.trim(), "base64"));
  } catch { return undefined; }
}

/** The complete consumer credential envelope plus its stable account revision. */
export type CliCredential = {
  raw: string;
  refreshToken: string;
};

function parseCredential(raw: string | undefined): CliCredential | undefined {
  try {
    const value: unknown = JSON.parse(raw || "");
    if (!value || typeof value !== "object" || !("token" in value)) return undefined;
    if ("auth_method" in value && value.auth_method && value.auth_method !== "consumer" && value.auth_method !== "oauth-personal") return undefined;
    const token = value.token;
    if (!token || typeof token !== "object" || !("refresh_token" in token)) return undefined;
    const refreshToken = typeof token.refresh_token === "string" && token.refresh_token.trim() ? token.refresh_token : undefined;
    return refreshToken && raw !== undefined ? { raw, refreshToken } : undefined;
  } catch { return undefined; }
}

/** Reads the full CLI consumer envelope. Custom HOME/GEMINI_HOME must never
 * borrow another home's OS login. Windows keyring remains first only for the
 * native default home; an existing keyring value never falls back to a file. */
export async function resolveCliCredential(environment: NodeJS.ProcessEnv = process.env,
  options: { platform?: NodeJS.Platform; nativeHome?: string; readKeyring?: typeof readWindowsCliCredential } = {}): Promise<CliCredential | undefined> {
  const nativeHome = options.nativeHome ?? homedir();
  const home = geminiHome(environment);
  const defaultHome = resolve(home) === resolve(join(nativeHome, ".gemini")) &&
    (!environment.HOME?.trim() || resolve(environment.HOME.trim()) === resolve(nativeHome));
  if ((options.platform ?? process.platform) === "win32" && defaultHome) {
    const raw = await (options.readKeyring ?? readWindowsCliCredential)(environment);
    // An existing malformed/non-consumer credential is not a file-fallback login.
    if (raw !== undefined) return parseCredential(raw);
  }
  try { return parseCredential(await readFile(join(home, "antigravity-cli", "antigravity-oauth-token"), "utf8")); }
  catch { return undefined; }
}

/** Existing callers only need the stable revision; keep this API unchanged. */
export async function resolveCliRefreshToken(environment: NodeJS.ProcessEnv = process.env,
  options: { platform?: NodeJS.Platform; nativeHome?: string; readKeyring?: typeof readWindowsCliCredential } = {}): Promise<string | undefined> {
  return (await resolveCliCredential(environment, options))?.refreshToken;
}
