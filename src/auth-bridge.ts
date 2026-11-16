import { AgyError } from "./errors.js";
import { resolveCliCredential } from "./cli-credentials.js";

export function cliAuthenticationError(): AgyError {
  return new AgyError("auth", "Antigravity requires an authenticated agy CLI. Sign in through agy, then retry. The plugin does not start interactive login.", { code: "agy_cli_auth_required" });
}

/**
 * Every worker still checks the current source consumer login, even when a
 * private CLI home already holds refreshed state. A signed-out source cannot
 * be bypassed with an old private token. This function never writes login
 * state and never starts an interactive login.
 */
export async function requireCliAuthentication(environment: NodeJS.ProcessEnv): Promise<void> {
  if (!await resolveCliCredential(environment)) throw cliAuthenticationError();
}
