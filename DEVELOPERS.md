# Developer Notes

This service is a local API compatibility bridge from Anthropic/OpenAI-style HTTP clients to the SpiLLI SDK.

## Runtime Shape

The bridge has three separate responsibilities:

1. Discover live SpiLLI host inventory and expose model display names through `/v1/models`.
2. Resolve API model names back to SpiLLI model UIDs.
3. Forward each inference request to an acquired SpiLLI resource session with a self-contained prompt/query payload.

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

`SPILLI_BRIDGE_SCOPE` is a model visibility scope, not a subscription tier. Valid values:

```text
public
private
team
team.<name>
enterprise
```

`community` is accepted as an alias for `public` because users often think in subscription tiers.

`GET /v1/models` returns the API-facing friendly name as `id` and includes the underlying SpiLLI UID as `uid`.

Inference may receive either the friendly API name or the UID. The bridge should resolve friendly names to UIDs before calling the SDK.

## SpiLLI SDK Session Semantics

Treat `SpilliSession` as an acquired network resource for a model/scope/team, not as a chat conversation.

Do:

- Reuse `service.getOrCreateSession({ model: uid, scope, team })` for the same resource.
- Send a complete prompt/query object on each `session.run({ prompt, query }, ...)` call.
- Keep API/chat history outside the SpiLLI resource session and include it in prompt/query when needed.

Do not:

- Create a new resource request for every inference unless explicitly troubleshooting resource acquisition.
- Use one SDK resource session as the source of chat memory.
- Use `clientId` in `session.run()` for chat ids or request ids. It is reserved for SDK/internal behavior.

The bridge supports `SPILLI_BRIDGE_REUSE_SESSIONS=0` only as a troubleshooting escape hatch. Normal operation should reuse acquired resource sessions.

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
```

The bridge supports streaming, but SpiLLI output is currently buffered until `session.run()` completes so Harmony/JSON tool calls can be translated into API-native tool-call blocks.

## Harmony Output

The SDK may return Harmony-formatted output containing analysis, commentary, final, and tool-call channels.

For API responses:

- Return only final assistant text to the client.
- Do not expose analysis text.
- Parse tool calls from raw output and translate them into Anthropic `tool_use` or OpenAI `tool_calls`.

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
  -d '{"model":"Openai Gpt Oss 20b","max_tokens":128,"messages":[{"role":"user","content":"Say hello in one sentence."}]}'
```

Production builds should avoid verbose request tracing or logs that expose local PEM paths, model UIDs, prompts, or responses. Prefer returning structured API errors to clients.
