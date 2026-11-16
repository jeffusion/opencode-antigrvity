import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireCliAuthentication } from "../src/auth-bridge.js";

const fixture = (revision: string) => JSON.stringify({ auth_method: "consumer", token: { refresh_token: revision } });

test("requireCliAuthentication consumes the current CLI source and never writes an ACP token", async () => {
  const home = await mkdtemp(join(tmpdir(), "agy-cli-auth-"));
  const environment = { GEMINI_HOME: home };
  const token = join(home, "antigravity-cli", "antigravity-oauth-token");
  try {
    await expect(requireCliAuthentication(environment)).rejects.toMatchObject({ code: "agy_cli_auth_required" });
    await mkdir(join(home, "antigravity-cli"));
    await writeFile(token, "{broken");
    await expect(requireCliAuthentication(environment)).rejects.toMatchObject({ code: "agy_cli_auth_required" });
    await writeFile(token, fixture("cli-fixture"));
    await expect(requireCliAuthentication(environment)).resolves.toBeUndefined();
    expect(await readFile(token, "utf8")).toBe(fixture("cli-fixture"));
    // Authentication is checked again on every call; a stale private ACP file
    // cannot keep a signed-out source alive.
    await rm(token);
    await expect(requireCliAuthentication(environment)).rejects.toMatchObject({ code: "agy_cli_auth_required" });
  } finally { await rm(home, { recursive: true, force: true }); }
});
