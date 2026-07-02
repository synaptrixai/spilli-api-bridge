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

Treat `SpilliSession` as an acquired network resource, not as chat memory. In this bridge, a live SpiLLI session must always be associated with a bridge-managed session key before inference runs.

Do:

- Resolve a bridge session key from client metadata when present.
  - Codex: `x-codex-turn-metadata` with `window_id`, `session_id`, and `thread_id`.
  - Claude Code: `x-claude-code-session-id`.
- Create or reuse sessions only through the bridge's tracked session maps before calling inference.
- Call `runInference(...)` only with an explicit live `session` argument and the matching resolved model.
- Send a complete prompt/query object on each `session.run({ prompt, query }, ...)` call.
- Keep API/chat history outside the SpiLLI resource session and include it in prompt/query when needed.
- Serialize `session.run()` calls per live resource session to avoid overlapping native stream callbacks.

Do not:

- Do not let `runInference(...)` create a fresh SpiLLI session internally.
- Do not use `service.getOrCreateSession({ model, scope, team }, ...)` as a resource-wide fallback for ordinary chat traffic.
- Do not share one SpiLLI session across different Claude/Codex chat sessions just because they target the same model.
- Do not use one SDK resource session as the source of chat memory.
- Use `clientId` in `session.run()` for chat ids or request ids. It is reserved for SDK/internal behavior.

Why this matters:

- Resource-wide SDK session reuse caused cross-chat context leakage between separate Claude Code sessions.
- Untracked `service.request(...)` calls from inside inference create orphan sessions that the bridge cannot map back to the correct chat/session key.
- The correct workflow is: derive bridge session key -> get or create tracked session -> pass that session into `runInference(...)` -> keep chat history in the HTTP payload.

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

Streaming in `raw` mode forwards SpiLLI SDK chunks as text deltas after `[EOG]` handling. Streaming in `compat` mode may wait for final post-processing when tool-call conversion is needed.

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
