# Developer Notes

This service is a local API compatibility bridge from Anthropic/OpenAI-style HTTP clients to the SpiLLI SDK.

## Runtime Shape

The bridge has three separate responsibilities:

1. Discover live SpiLLI host inventory and expose model display names through `/v1/models`.
2. Resolve API model names back to SpiLLI model UIDs.
3. Forward each inference request through an explicitly tracked SpiLLI session with a self-contained prompt/query payload.

Keep those concepts separate. Model inventory and resource allocation are not chat memory.

## PEM And mTLS

The bridge uses the same default PEM directory as the VS Code extension:

```text
~/.spilli
```

When `SPILLI_KEY_PATH` points to a directory, the highest-tier PEM wins in this order:

```text
SpiLLI_Enterprise.pem
SpiLLI_Team.pem
SpiLLI_Personal.pem
SpiLLI_Community.pem
```

Backend inventory requests must send the resolved PEM content as both `key` and `cert` in the HTTPS request options. This mirrors the extension's mTLS behavior.

## Model Inventory

Inventory comes from the hardcoded public SpiLLI backend endpoints in `src/server.mjs`. Do not expose these as public release environment variables unless there is a product requirement to support alternate deployments.

Model scope is set at runtime with `POST /v1/scope`, not with an environment variable. It is a model visibility scope, not a subscription tier. Valid values:

```text
public
private
team
team.<name>
enterprise
```

`community` is accepted as an alias for `public` because users often think in subscription tiers. Changing scope clears the model inventory cache; the next `/v1/models` or inference request discovers models for the active scope. When using `scope: "team"`, callers must also provide `team_name`; the bridge passes that value through to SpiLLI SDK resource requests as `team`.

`GET /v1/models` returns the API-facing friendly name as `id` and includes the underlying SpiLLI UID as `uid`.

Inference may receive either the friendly API name or the UID. The bridge should resolve friendly names to UIDs before calling the SDK.

## SpiLLI SDK Session Semantics

Treat `SpilliSession` as an acquired network resource, not as chat memory. The API request history is authoritative; `spilli_context` transfers that history into SpiLLIHost and identifies subsequent deltas.

Do:

- Resolve stable identity from Codex `x-codex-turn-metadata`, Claude Code `x-claude-code-session-id`, or the generic `x-spilli-session-id` header.
- Map Codex `thread_id` to `context_id`; derive a stable context id for clients that expose only one session id.
- Keep a committed revision and transcript-hash cursor per client conversation.
- Use `hydrate` for first use, reconnects, resource changes, and any history rewrite or compaction.
- Put prior structured messages in `recent_messages` during hydration and keep the current input in `query`.
- Use `delta` only for a strict append-only continuation, send only the new suffix in `query`, and include `delta_messages: []`.
- Retry `SPILLI_CONTEXT_MISS` once at the same revision with a hydration snapshot.
- Commit the revision and emitted assistant hashes only after inference succeeds.
- Serialize native runs by resource to avoid overlapping callbacks on the shared SDK client.

Do not:

- Do not use the SDK session allocation id as the logical conversation id.
- Do not send the full transcript in `query` on a delta turn.
- Do not include the current query again in hydration `recent_messages`.
- Do not advance revision state after errors, cancellation, or partial output.
- Do not expose `SPILLI_CONTEXT_MISS` or `[EOG]` as an API text delta.
- Do not use `clientId` for chat ids or tracing; it is reserved for SDK/native behavior.

Why this matters:

- SpiLLIHost keys logical context by authenticated client plus `context_id`, and validates a delta against `context_revision - 1`.
- The host keys model-specific cache state by authenticated client, `context_id`, and `resource_key`.
- Hydration replaces the host snapshot at the requested base revision; a successful turn commits the requested revision.
- Re-sending committed turns in `query` duplicates history, while omitting hydration after a lost host context produces a context miss.
- A live transport can be reused for a rewritten conversation because hydration replaces context state; a disconnected transport can be replaced while retaining the same logical `context_id`.

Requests with no supported session header receive an ephemeral identity and are not entered into the bridge reuse map. They hydrate independently on every request.

## Anthropic/OpenAI Compatibility

Anthropic clients primarily use:

```text
GET /v1/models
POST /v1/messages
POST /v1/messages/count_tokens
```

OpenAI-style clients primarily use:

```text
POST /v1/chat/completions
POST /v1/responses
```

The bridge has two response modes:

- `raw` is the default. It returns SpiLLI model text as assistant text and does not infer tool calls from model output.
- `compat` preserves the parser-based behavior that translates Harmony/JSON tool-call text into API-native tool-call blocks.

SDK `onChunk` values are deltas, not cumulative snapshots. Streaming in `raw` mode forwards each chunk once after internal marker filtering. Streaming in `compat` mode may wait for final post-processing when tool-call conversion is needed.

## Harmony Output

The SDK may return Harmony-formatted output containing analysis, commentary, final, and tool-call channels.

For API responses:

- In `raw` mode, return the raw SpiLLI model text as assistant text.
- In `compat` mode, return final assistant text and translate tool calls into Anthropic `tool_use`, OpenAI `tool_calls`, or OpenAI Responses `function_call` items.
- Do not expose analysis text in `compat` mode.

`renderHarmonyForDisplay()` is suitable for VS Code UI display, but API responses should use final text, not the display text that includes analysis sections.

## Troubleshooting

Useful commands:

```sh
curl "http://localhost:8888/v1/models?refresh=true"
```

```sh
curl -N http://localhost:8888/v1/messages \
  -H "content-type: application/json" \
  -H "x-api-key: sk-spilli-local" \
  -d '{"model":"Openai_Gpt Oss 20b","max_tokens":128,"messages":[{"role":"user","content":"Say hello in one sentence."}]}'
```

Production builds should avoid verbose request tracing or logs that expose local PEM paths, model UIDs, prompts, or responses. Prefer returning structured API errors to clients.
