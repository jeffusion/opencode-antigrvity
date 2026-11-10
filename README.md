# OpenCode Antigravity

An OpenCode V2 provider plugin for Google's Antigravity ACP. This fork also
offers `agy-api`, a standalone Linux service for OpenAI Chat Completions,
Anthropic Messages and Gemini GenerateContent clients.

## Use as an OpenCode plugin

Sign in with Google's `agy` CLI on the machine running OpenCode V2, then install
the plugin from this fork:

```sh
opencode plugin add 'github:jeffusion/opencode-antigrvity#main'
```

Select a model from the **Antigravity** provider in OpenCode. The plugin reuses
the `agy` login and runs its own local adapter inside OpenCode.

## Run as a standalone API service

On Linux x86_64 with glibc 2.27+ and systemd, run this as the service account.
To run the service as root, use a root login shell (`sudo -i`).

```sh
curl -fsSL https://raw.githubusercontent.com/jeffusion/opencode-antigrvity/main/scripts/install.sh | sh
```

The installer verifies the binary from GitHub Releases, starts the service, and
enables it at boot. To stop it and disable automatic startup, run
`systemctl --user disable --now agy-api.service`. In a root shell without a
systemd user session, prefix that command with `XDG_RUNTIME_DIR=/run/user/0`.

The service listens on `127.0.0.1:8787` by default. Provision an `agy` login in
its dedicated credential directory before sending inference requests.

See the [deployment and API guide](docs/development.md#standalone-linux-service)
for credential setup, health checks, offline installs and release tags.
