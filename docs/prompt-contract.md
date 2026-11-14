# Host prompt contract

For primary Antigravity requests, the plugin replaces OpenCode's assembled
system text at the HTTP request hook with the active agent's `system` field.
This excludes generated skills, AGENTS.md instructions, model identity and
environment metadata. A missing, empty or whitespace-only field means no
instructions; agent lookup failures propagate instead of falling back.

The adapter sends a nonempty agent prompt as one text block:

```xml
<instruction>
Configured agent system prompt, unchanged.
</instruction>
```

User content follows without a `[user]` marker or adapter boilerplate. The
plugin preserves OpenCode's new-child subagent introduction. It never adds
that introduction itself, so continuation messages are not prefixed again.
Conversation history, attachments and original tool results remain available
when continuing or rebuilding a trajectory. Changed/cleared instructions
retire the previous ACP context, including a parked tool turn once its results
are available, so old instructions are not silently retained.

ACP initialization omits optional `clientInfo` and advertises empty
`clientCapabilities`. Tool configuration uses the protocol's `mcpServers`
field with a server named `external_tool`; model selection is unchanged.

These rules govern the host input to ACP, not Antigravity's own internal
system prompt/metadata. Auxiliary title/generate requests keep their dedicated
utility behavior. This does not promise to resolve Google location restrictions.

## Shared plugin and service rules

The plugin and standalone service share prompt construction, not execution
ownership. Protocol adapters validate their own wire format before passing
content to the shared layer.

- Nonempty system instructions use the same `<instruction>` wrapper. The
  shared reconstruction function budgets the wrapped text and emits it exactly
  once, before history and current user content. Callers must not prepend it
  again.
- Readable assistant thinking from conversation history is retained as text;
  signatures are not forwarded as instructions or authentication. Opaque `redacted_thinking`
  payloads are ignored without deleting their history position. Malformed
  known blocks still fail validation. This does not allow thinking blocks in
  service user messages, system instructions or tool results.
- Historical tool calls and results retain their IDs, order and images.
  Reconstruction budgets related calls and results together. Shared history
  formatting must not claim that API-client tools were executed by OpenCode.
- ACP thought output remains separate from answer text. Anthropic and Gemini
  JSON and SSE responses preserve its position relative to text and tool
  calls. Anthropic compatibility signatures are not upstream signatures;
  Gemini responses do not invent `thoughtSignature`. OpenAI responses retain
  their standard answer/tool fields without a `reasoning_content` extension.
- A finite numeric `temperature` is accepted but ignored, with a shared
  once-per-process warning. It does not control ACP sampling. This does not
  enable other unsupported generation controls.

Necessary entrypoint policies remain separate: the plugin can read permitted
workspace attachments and accepts `image/*`; the public service accepts only
inline PNG/JPEG/WebP/GIF and never reads a caller-specified server file. Their
transport and decoded-media limits also remain distinct.

The plugin owns its persistent receipts, tool ledger and session recovery.
The service owns its in-memory pending client-tool turns and their expiry.
Sharing content rules does not make these lifecycles interchangeable.

Changes to these shared rules must exercise both entrypoints, including mixed
thinking/image/tool history reaching the ACP prompt. The regression cases in
`test/entrypoint-parity.test.ts` check the prompt log and JSON/SSE output;
parser-only assertions are not a substitute for that boundary check.
