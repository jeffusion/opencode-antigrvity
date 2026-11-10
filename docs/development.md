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

This repository is a plugin/library, not a standalone development server.
The package entrypoint is `src/index.ts`; generated output lives in the ignored
`dist/` directory. The build type-checks `src/`, not the test files.
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
artifact. A push of a tag such as `agy-api-v1.0.0` to the fork creates a
GitHub Release after the Linux checks pass. The Release also includes
`install.sh`. An existing published release keeps its original assets.

### Install with systemd

On Linux x86_64 with glibc 2.27 or newer, download the installer from the
[fork releases](https://github.com/jeffusion/opencode-antigrvity/releases)
and run it as the account that will own the service:

```sh
sh install.sh --enable-linger
```

Use `--version agy-api-v1.0.0` to pin a published tag, or `--from-dir DIR`
to install from the binary and checksum downloaded from Actions or Releases.
The installer enables and starts `agy-api.service` and restarts it on upgrades.
With lingering enabled, systemd starts the user manager at boot even when
the account has no interactive session. If the account cannot enable lingering,
an administrator can run `sudo loginctl enable-linger <account>`.

The API key and port are configured in
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
systemctl --user restart agy-api.service
systemctl --user status agy-api.service
curl --fail http://127.0.0.1:8787/readyz
```

Use `journalctl --user -u agy-api.service` for logs. If ACP installation fails
at boot, the service exits and systemd retries after ten seconds.

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
`AGY_PORT` defaults to 8787 on 127.0.0.1. Put a TLS reverse proxy in front for
remote access and disable response buffering on the SSE route. Use a dedicated
OS account in a shared environment. `AGY_DATA_DIR` defaults to the XDG data
directory under `agy-api`, and the credential directory defaults to
`AGY_DATA_DIR/credentials`.

- `GET /healthz` reports process liveness. `GET /readyz` returns HTTP 503 until
  online ACP discovery reports at least one model.
- `GET /v1/models` returns a model list under `data`.
- `POST /v1/messages` accepts Anthropic-style `model`, `max_tokens`, `messages`,
  optional `system` and `stream`. Send `x-api-key` or a bearer token for both API
  routes. Messages contain strings or text blocks. For multiple turns, submit
  the conversation history ending with a user message. The service rebuilds
  bounded history in a fresh ACP session per request.
- `stream: true` returns SSE; otherwise the response is JSON. ACP owns its
  output token budget, so `max_tokens` is advisory. Zero usage counts can mean
  that ACP did not report usage.
- `POST /v1/chat/completions` supports the OpenAI SDK with
  `base_url="http://127.0.0.1:8787/v1"` and `api_key` set to `AGY_API_KEY`.
  Send a model ID from `client.models.list()` and text messages ending with a
  user message. Leading system and developer messages become instructions.
  The route supports one choice, JSON or SSE, and
  `stream_options={"include_usage": True}` with `stream=True` in Python.
  Either `max_completion_tokens` or `max_tokens` can supply an advisory budget.
  The route rejects tools, media, sampling controls and structured output.
- `GET /v1beta/models` lists the same ACP catalog in Gemini format.
  `POST /v1beta/models/{model}:generateContent` returns Gemini JSON, and
  `POST /v1beta/models/{model}:streamGenerateContent?alt=sse` streams Gemini
  response chunks. In the Google Gen AI SDK, set the base URL to
  `http://127.0.0.1:8787` and the API key to `AGY_API_KEY`.
  Both routes accept one text candidate, `systemInstruction`, and an
  advisory `generationConfig.maxOutputTokens`. Usage is included when ACP
  reports it.
