# Windows CLI credential review

Reviewed the official CLI 1.3.5 Windows x64 artifact linked by the install
service's `manifests/windows_amd64.json` on 2026-10-14:
`https://storage.googleapis.com/antigravity-public/antigravity-cli/1.3.5-6164039479459840/windows-x64/cli_windows_x64.exe`.
SHA-512 (matches that manifest):
`4483cac360dcedcdba19c49d4e589559ce7fcba039daf1887ffa5bd68d1f4437660733295822c13283d4243e00813259ad839466f5b9bc6c20728077a392d38c`.

The Go function table identifies zalando/go-keyring's `windowsKeychain.Get`
and `.Set`, and `codeassistclient.KeyringTokenStorage.LoadStoredToken`.
The latter reads keyring service `gemini`, converts the returned string to
bytes (`runtime.stringtoslicebyte`), and calls `encoding/json/v2.Unmarshal`
into `codeassistclient.StoredToken`. Runtime struct metadata gives its
`token` and `auth_method,omitempty` JSON fields. It also includes unrelated
ID token, WIF, project, region and tier fields which this adapter ignores.
The upstream go-keyring v0.2.6 Windows implementation uses target
`service + ":" + username`, reads `string(cred.CredentialBlob)` and writes
`[]byte(password)`. The reporter independently identified the exact generic
target `gemini:antigravity`. Thus the supported envelope is UTF-8 JSON, not
Credential Manager's sometimes-used UTF-16 password representation.

The adapter reads only that target via CredReadW, frees its native buffer,
bounds blob/output size and execution time, and suppresses all native error
details. A custom HOME or GEMINI_HOME remains file-only. It never creates a
CLI token file, starts login, enumerates credentials, or writes the keyring.
Native CI uses synthetic credentials on a disposable GitHub runner only.

# macOS ARM64 isolation review (ACP 1.3.0)

This historical review covers 1.3.0. See the current
[ACP release pin and isolation review](development.md#acp-release-pin-and-isolation)
for the 1.5.0 upgrade.

Downloaded the official ACP 1.3.0 Darwin ARM64 archive and independently
verified both profile SHA-256 values. Extracted ZIP local entries from the
PAR executable (without executing it):
`google3/cloud/developer_experience/antigravity_extensions/acp_server/tool_filter.py`
and `server.py`. `ToolFilterConfig.from_request_kwargs` reads
`_meta.agy.enabledTools`; an empty list becomes an empty tuple, not None.
`resolve_disabled_builtins` disables everything outside that allowlist.
`_create_agent_config` applies that result, excludes the safe_view_file
substitute, and gates subagents and browser injection. Session creation,
restoration and agent rebuild all pass/persist the filter. This is a static
host-tool isolation review; native unauthenticated startup CI does not prove
authenticated inference.
