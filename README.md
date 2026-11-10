# Antigravity API

`agy-api` is a standalone Linux service backed by Google Antigravity ACP. It
provides OpenAI Chat Completions, Anthropic Messages and Gemini GenerateContent
endpoints. The fork also provides an OpenCode V2 plugin.

## Install the Linux service

On Linux x86_64 with glibc 2.27+ and a systemd user session, run this as the service
account:

```sh
curl --fail --show-error --location \
  https://github.com/jeffusion/opencode-antigrvity/releases/latest/download/install.sh \
  -o install-agy-api.sh
sh install-agy-api.sh --enable-linger
```

The installer verifies the release binary, creates a private API key file, and
enables and starts the user service. Provision an `agy` login in the dedicated
credential directory before sending inference requests.

See the [deployment and API guide](docs/development.md#standalone-linux-service)
for credential setup, health checks, offline installs and release tags.
