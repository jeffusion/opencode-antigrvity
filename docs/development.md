# Development

## Prerequisites

- Bun >=1.4.4. The repository pins Bun 1.4.4 in `package.json` and CI; update
  both pins together.

Use Bun for installs, scripts, builds, tests, and CI. `bun.lock` is the sole
lockfile; do not create or update locks with another package manager. CI uses
`bun ci` (equivalent to `bun install --frozen-lockfile`): it verifies the lock
is current and installs its exact versions. For local development, the frozen
install is equally reproducible.

```sh
bun install --frozen-lockfile
mkdir -p /tmp/opencode
bun run check
```

## Daily workflow

Edit TypeScript in `src/` and add regression tests in `test/`.

```sh
bun run compile                   # Type-check and emit dist/ declarations and JS
bun test test                     # Run tests without rebuilding
bun test test/protocol.test.ts     # Run one test file
bun test --watch test              # Re-run tests as files change
bun run --bun tsc -p tsconfig.json --watch # Run TypeScript under Bun while watching
bun run check                     # Build and full tests before submitting changes
```

The OpenCode plugin entrypoint is `src/index.ts`. The standalone service
entrypoint is `src/service.ts`. Generated output lives in the ignored
`dist/` directory, and the build type-checks `src/`.
The OpenCode host must provide Bun at runtime. Imports from `node:` in source
and tests use Bun's Node.js API compatibility layer; they do not launch or
require the Node executable. TypeScript and the fake ACP test executable are
explicitly run with Bun. `@types/node` remains only to type-check those
compatible APIs; it does not add a Node runtime requirement.

This fork intentionally omits `build`, `prepack`, `prepare`, `preinstall`,
`install`, and `postinstall` scripts to avoid triggering pacote's embedded npm
Git preparation flow; runtime exports use `src/` and need no consumer-side build.
Before manually running `npm pack` or `bun pm pack`, run `bun run compile` to
generate `dist/`: packing no longer does this automatically. `npm publish` still
runs compilation and checks through `prepublishOnly` (`bun run check`).

Bun skips dependency lifecycle scripts unless a package is explicitly trusted.
Do not trust dependencies broadly: Koffi's optional platform package supplies
its prebuilt native binary, so its Node-based install script is intentionally
left untrusted. A clean Bun install and Koffi import were verified on Linux.

## Anthropic usage fallback

ACP prompt-response usage is authoritative when present, including explicit
zero values. If it is absent, the proxy may report a fresh measured context
occupancy as `input_tokens` with zero output tokens. This is an approximation
of the current context, not per-request token accounting or billing usage.
Fallback measurements stay bound to the response receipt and execution
generation. A turn without a new sample may reuse the latest measurement from
that same generation for up to five minutes, rechecked when each new terminal
or tool response is emitted. Completed receipt replays retain their original
response payload. A replacement execution cannot inherit the previous
generation's occupancy.

## Optional live tests

The default suite uses fixtures and skips opt-in live and platform-specific
checks when their prerequisites are unavailable. Normal development does not
require Google credentials or a running Antigravity server.

`bun run test:live` enables real inference checks. Only run it after configuring
the official Antigravity ACP executable and authentication; it may consume
account quota. See `test/acp-live.test.ts` and `src/acp-detect.ts` for the checks
and executable discovery behavior. Do not commit credentials or local `.env`
files.

## Verified baseline

Setup was verified with Bun 1.4.4: the build succeeded, with 205 tests passing,
10 skipped, and no failures.

A prior lockfile audit reported 4 dependency vulnerabilities (1 moderate,
3 high). Dependency upgrades were deliberately left out of this migration;
some remediation changes the pinned OpenCode plugin version and needs separate
compatibility testing.

## Bun references

- [CI installs and frozen lockfiles](https://bun.com/docs/pm/cli/install#ci-cd)
- [Bun script execution and `--bun`](https://bun.com/docs/runtime#bun)
- [Dependency lifecycle scripts and `trustedDependencies`](https://bun.com/docs/pm/lifecycle#trusteddependencies)
- [Portable environment-variable prefixes](https://bun.com/docs/runtime/environment-variables#setting-environment-variables)

## Standalone Linux service

The fork's Linux CI job builds the executable and uploads
`agy-api-linux-x86_64` and `agy-api-linux-x86_64.sha256` as an Actions
artifact. A push of a tag such as `v0.1.0` to the fork creates a
GitHub Release with the binary and checksum after the Linux checks pass.

### Install with systemd

On Linux x86_64 with glibc 2.27 or newer, download the
[installer from main](https://raw.githubusercontent.com/jeffusion/opencode-antigrvity/main/scripts/install.sh)
and run it as the account that will own the service. To install as root, run
the installer from a root login shell (`sudo -i`):

```sh
sh install.sh
```

The installer uses the latest GitHub Release by default. Use
`--version v0.1.0` to pin a published binary and checksum, or
`--from-dir DIR` to install from local copies of those two files.
The installer starts `agy-api.service`, enables boot startup even without an
interactive login, and restarts the service on upgrades. Root installs create
`/etc/systemd/system/agy-api.service` and require root's login home and the
default XDG config and data paths. If the previous installer created a root
user service at `$HOME/.config/systemd/user/agy-api.service`, the installer
stops and disables it before starting the system service. It saves the old
unit as `agy-api.service.migrated` once the system service is registered and
started.

Unprivileged installs use a systemd user service with lingering enabled. If
systemd requires administrator permission for lingering, ask an administrator
to run `sudo loginctl enable-linger <account>`, then retry the installer as the
service account.

| Action | Root install | Unprivileged install |
| --- | --- | --- |
| Check status | `systemctl status agy-api.service` | `systemctl --user status agy-api.service` |
| Restart | `systemctl restart agy-api.service` | `systemctl --user restart agy-api.service` |
| Stop and disable at boot | `systemctl disable --now agy-api.service` | `systemctl --user disable --now agy-api.service` |
| View logs | `journalctl -u agy-api.service` | `journalctl --user -u agy-api.service` |

The API key, listen address (`AGY_HOST`) and port (`AGY_PORT`) are configured in
`${XDG_CONFIG_HOME:-$HOME/.config}/agy-api/agy-api.env`. If the account uses a
custom XDG config directory, the systemd user manager must use the same path.
The installer preserves the existing environment file during upgrades.

The service needs a consumer `agy` login. For an account that is already
signed in, provision a private copy of its CLI credential file in the service
profile. The path below assumes the default `AGY_CREDENTIALS_DIR`.

```sh
profile="${XDG_DATA_HOME:-$HOME/.local/share}/agy-api/credentials"
install -d -m 700 "$profile/antigravity-cli"
install -m 600 "${GEMINI_HOME:-$HOME/.gemini}/antigravity-cli/antigravity-oauth-token" \
  "$profile/antigravity-cli/antigravity-oauth-token"
```

Restart the service using the command for your installation above, then run
`curl --fail http://127.0.0.1:8787/readyz`. If ACP installation fails at boot,
the service exits and systemd retries after ten seconds.

### Build and run directly

Build with Bun on Linux x86_64 with glibc:

```sh
bun run build:service
./dist/agy-api --help
```

Copy `dist/agy-api` to the target machine. It includes Bun and the native
file-lock addon. Provision a dedicated agy CLI login directory and set
`AGY_CREDENTIALS_DIR` to it. The service uses its consumer login, and discovers
or downloads the official ACP executable and its companion. Set
`OPENCODE_ANTIGRAVITY_ACP_PATH` to use an existing compatible installation.

Set `AGY_API_KEY` to a random secret of at least 32 bytes before starting.
`AGY_HOST` defaults to `127.0.0.1` and `AGY_PORT` defaults to `8787`.
Set `AGY_HOST` to a specific interface address to serve clients on that network.
For TLS access, use a reverse proxy with response buffering disabled for SSE.
Use a dedicated OS account in a shared environment. `AGY_DATA_DIR` defaults to the XDG data
directory under `agy-api`, and the credential directory defaults to
`AGY_DATA_DIR/credentials`.

- `GET /healthz` reports process liveness. `GET /readyz` returns HTTP 503 until
  online ACP discovery reports at least one model.
- `GET /v1/models` returns a model list under `data`.
- `POST /v1/messages` accepts Anthropic-style `model`, `max_tokens`, `messages`,
  optional `system` and `stream`. Send `x-api-key` or a bearer token for
  Messages and Chat Completions. An image block uses `type: "image"` and a
  `source` with `type: "base64"`, `media_type` and `data`. For a new turn,
  send the conversation history ending with a user message. The service
  rebuilds bounded history in a fresh ACP session.
- Messages accepts client `tools` with `name`, `input_schema` and optional
  `description`. A call returns a `tool_use` content block with `id`,
  `name` and `input`, and `stop_reason: "tool_use"`. Append the assistant
  content, then send a single user message containing one `tool_result` per
  call before any user text or images. Match each `tool_use_id` to the
  corresponding call. Results support text, inline images and `is_error`.
  `tool_choice` supports `{"type":"auto"}` and `{"type":"none"}`.
  [Claude tool call reference](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)
- `stream: true` returns SSE; otherwise the response is JSON. ACP owns its
  output token budget, so `max_tokens` is advisory. Zero usage counts can mean
  that ACP did not report usage.
- `POST /v1/chat/completions` supports the OpenAI SDK with
  `base_url="http://127.0.0.1:8787/v1"` and `api_key` set to `AGY_API_KEY`.
  Send a model ID from `client.models.list()` and messages ending with a
  user message when starting a turn. Leading system and developer messages
  become instructions. User messages can mix text with `image_url` parts
  whose `url` is a `data:image/<format>;base64,...` string. Omit `detail`
  or use `"auto"`. The route supports one choice, JSON or SSE, and
  `stream_options={"include_usage": True}` with `stream=True` in Python.
  Either `max_completion_tokens` or `max_tokens` can supply an advisory
   budget. A finite numeric `temperature` is accepted but ignored; other
   sampling controls and structured output are unsupported.
- Chat Completions accepts `tools` with `type: "function"` and a
  `function` definition. A call returns in `message.tool_calls` for JSON
  or `delta.tool_calls` for SSE with JSON-encoded `function.arguments` and
  `finish_reason: "tool_calls"`. Append the assistant message, then send
  one `role: "tool"` message per call with the matching `tool_call_id` and
  text content. `tool_choice` supports `"auto"` and `"none"`.
  [Chat Completions reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- For both Messages and Chat Completions, the client runs the tools. Return
  the entire result batch in one request, in any order, to the same
  authenticated service instance, protocol and model within three minutes.
  The original conversation can be omitted when the request begins with the
  result batch. The live ACP turn keeps the tools declared at its start.
  Each batch can be resumed once. Forced calls, strict schemas and
  serial-only tool calling are unsupported.
- `GET /v1beta/models` lists the same ACP catalog in Gemini format.
  `POST /v1beta/models/{model}:generateContent` returns Gemini JSON, and
  `POST /v1beta/models/{model}:streamGenerateContent?alt=sse` streams Gemini
  response chunks. In the Google Gen AI SDK, set the base URL to
  `http://127.0.0.1:8787` and the API key to `AGY_API_KEY`.
  Both routes accept text and `inlineData` image parts with `mimeType` and
  base64 `data`. They return one candidate, accept `systemInstruction`
  and an advisory `generationConfig.maxOutputTokens`, and include usage
  when ACP reports it.
- Both Gemini routes accept `tools: [{functionDeclarations: [...]}]`. A
  declaration takes a name, optional description, and either `parameters`
  (Gemini's OpenAPI schema) or `parametersJsonSchema` (JSON Schema). The
  service exposes declarations to the isolated ACP worker and returns
  `candidates[0].content.parts[].functionCall` with an ID, name and arguments.
  The client executes each function and sends a follow-up to the same model
  with one `functionResponse: {id, name, response}` part per call in the batch.
  Use the returned IDs for parallel calls, and send results in any order.
  A response is a JSON object. Include an `error` key for a failed tool.
  Add nested `parts[].inlineData` for tool result images. A named image can be
  referenced once in the response JSON with `{"$ref":"<displayName>"}`. ACP
  receives the response JSON and the images in order as MCP content blocks,
  with each display name beside its image.
  The response parts can follow the original conversation or appear alone.
  New user text and inline images can follow the entire result batch, including
  in the same user message. The live ACP prompt receives that content in order
  as a labeled subsequent user message at the end of the last MCP result.
  They resume the live ACP turn on the same service instance for up to three
  minutes. Each batch can be resumed once. The service clears pending calls
  on expiry or shutdown. Function calling supports automatic selection and
  `toolConfig.functionCallingConfig.mode: "NONE"` to disable calls when
  starting a turn. A continuation cannot change to that mode.
  [Gemini function calling reference](https://ai.google.dev/gemini-api/docs/generate-content/function-calling)
- All three protocols accept inline PNG, JPEG, WebP and GIF in message
  content. Each image can be up to 4 MiB decoded, with up to 8 MiB decoded
  across the request and a 12 MiB JSON body limit. System instructions use
   text. The service rejects URL and file references, audio, video and documents.
- All three protocols accept a finite numeric `temperature` (inside
  `generationConfig` for Gemini), but it does not change ACP sampling.
  Unsupported controls such as `top_p`, `top_k` and forced tool calls remain
  rejected. Anthropic and Gemini return ACP thinking separately from answer
  text in both JSON and SSE; historical readable thinking is accepted without
  treating its signature as upstream authentication. See the
  [shared prompt contract](prompt-contract.md#shared-plugin-and-service-rules).
