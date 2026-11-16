import { afterAll, beforeAll, spyOn } from "bun:test";
import { resolve } from "node:path";
import * as compatibility from "../../src/acp-compatibility.js";
import * as detect from "../../src/acp-detect.js";
import * as auth from "../../src/auth-bridge.js";
import * as credentials from "../../src/cli-credentials.js";
import * as hostEnvironment from "../../src/host-environment.js";

const fixtureExecutable = resolve(import.meta.dir, "fake-acp.mjs");
const fixtureCredential = {
  raw: JSON.stringify({ auth_method: "consumer", token: { refresh_token: "fixture-refresh" } }),
  refreshToken: "fixture-refresh",
};

/** Stub only the install/discovery boundary onto the fake executable: synthetic
 * protocol tests over the real worker/pool/bridge, not an official CLI E2E. */
function stubAcpDetection() {
  const detection = { executable: fixtureExecutable, args: [] as string[], platform: `${process.platform}-${process.arch}` };
  const originalEnsure = detect.ensureAcpServer;
  const originalDetect = detect.detectAcpServer;
  // An explicit non-fake path still faces the real pinned detection gates; an
  // unknown executable is never silently accepted as the fixture.
  const ensure = spyOn(detect, "ensureAcpServer").mockImplementation(async (preferred?: string, signal?: AbortSignal) => {
    if (preferred?.trim() && resolve(preferred) !== fixtureExecutable) return originalEnsure(preferred, signal);
    signal?.throwIfAborted();
    return detection;
  });
  const detectServer = spyOn(detect, "detectAcpServer").mockImplementation(async (preferred?: string) => {
    if (preferred?.trim() && resolve(preferred) !== fixtureExecutable) return originalDetect(preferred);
    return detection;
  });
  return () => { ensure.mockRestore(); detectServer.mockRestore(); };
}

function stubCredential() {
  const credential = spyOn(credentials, "resolveCliCredential").mockResolvedValue(fixtureCredential);
  const refresh = spyOn(credentials, "resolveCliRefreshToken").mockResolvedValue(fixtureCredential.refreshToken);
  return () => { refresh.mockRestore(); credential.mockRestore(); };
}

/** Keep the production allowlist and private-home seed; only re-add the
 * fixture-only protocol switches after the real hostEnvironment returns. */
function stubHostEnvironment() {
  const original = hostEnvironment.hostEnvironment;
  const spy = spyOn(hostEnvironment, "hostEnvironment").mockImplementation(async (environment, scope, utilityDirectory) => {
    const isolated = await original({ ...environment, GEMINI_HOME: environment.GEMINI_HOME }, scope, utilityDirectory);
    const fixtureEnvironment: Record<string, string> = {};
    for (const [name, value] of Object.entries(environment)) {
      if (name.startsWith("FAKE_") && typeof value === "string") fixtureEnvironment[name] = value;
    }
    return { ...isolated, environment: { ...isolated.environment, ...fixtureEnvironment } };
  });
  return () => spy.mockRestore();
}

/** Fake ACP does not talk to Google; keep process/pool tests credential-free. */
export function useFixtureAuthentication() {
  let authentication: ReturnType<typeof spyOn<typeof auth, "requireCliAuthentication">>;
  let restoreDetection: () => void;
  let restoreCredential: () => void;
  let restoreHost: () => void;
  beforeAll(() => {
    authentication = spyOn(auth, "requireCliAuthentication").mockResolvedValue(undefined);
    restoreDetection = stubAcpDetection();
    restoreCredential = stubCredential();
    restoreHost = stubHostEnvironment();
  });
  afterAll(() => { restoreHost(); restoreCredential(); restoreDetection(); authentication.mockRestore(); });
}

/** Test-only dependency replacement, never an environment bypass shipped to
 * users. The production validator still rejects this executable. */
export function fixtureCompatibility() {
  const original = compatibility.assertHostToolCompatibility;
  const authentication = spyOn(auth, "requireCliAuthentication").mockResolvedValue(undefined);
  const validation = spyOn(compatibility, "assertHostToolCompatibility").mockImplementation(async path => {
    if (resolve(path) !== fixtureExecutable) return original(path);
  });
  const restoreDetection = stubAcpDetection();
  const restoreCredential = stubCredential();
  const restoreHost = stubHostEnvironment();
  return { mockRestore() { restoreHost(); restoreCredential(); restoreDetection(); validation.mockRestore(); authentication.mockRestore(); } };
}
