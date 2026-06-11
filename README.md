# SpiLLI API Bridge

Local HTTP bridge from Anthropic/OpenAI-style API clients to the SpiLLI SDK service.

## Why this exists

Tools such as Claude Code can route model requests through a local gateway by setting `ANTHROPIC_BASE_URL`. This bridge exposes the Anthropic Messages endpoint that Claude Code expects and forwards the prompt to `@synaptrix/spilli`.

It also exposes OpenAI-compatible chat completions for tools that use the `/v1/chat/completions` pattern.

## Run

```sh
cd spilli-api-bridge
npm install
npm start
```


## Claude Code

```sh
export ANTHROPIC_BASE_URL="http://localhost:8888"
export ANTHROPIC_AUTH_TOKEN="sk-spilli-local"
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1

curl http://localhost:8888/v1/models
claude --model "<model display name from /v1/models>"
```

Set `SPILLI_BRIDGE_AUTH_TOKEN=sk-spilli-local` before starting the bridge if you want token enforcement. If no bridge token is configured, local requests are accepted without auth.

## Endpoints

- `GET /health`
- `GET /v1/models`
- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `POST /v1/chat/completions`

`/v1/messages` supports non-streaming responses and Anthropic SSE streaming. Streaming is buffered until the SpiLLI run completes so Harmony/JSON tool calls can be returned as Anthropic `tool_use` blocks.

`/v1/chat/completions` supports non-streaming and OpenAI-style SSE streaming.

## Configuration

Copy `.env.example` into your process manager or shell environment.

- `SPILLI_BRIDGE_PORT`: HTTP port, default `8888`.
- `SPILLI_BRIDGE_HOST`: bind host, default `127.0.0.1`.
- `SPILLI_KEY_PATH`: PEM file or directory, default `~/.spilli`, matching the VS Code extension.
  When this points to a directory, the bridge uses the same highest-tier priority as the extension:
  `SpiLLI_Enterprise.pem`, `SpiLLI_Team.pem`, `SpiLLI_Personal.pem`, then `SpiLLI_Community.pem`.
- `SPILLI_BRIDGE_SCOPE`: SpiLLI model inventory scope, default `private`.
  Valid values are `public`, `private`, `team`, `team.<name>`, and `enterprise`.
  `community` is accepted as an alias for `public`; community is a PEM/subscription tier, not a host model visibility scope.
- `SPILLI_BRIDGE_TEAM`: optional team name for team-scoped requests.
- `SPILLI_BRIDGE_AUTH_TOKEN`: optional local bearer/API key.
- `SPILLI_BRIDGE_REQUEST_TIMEOUT_MS`: per-request SpiLLI timeout, default `600000`.
- `SPILLI_BRIDGE_MODEL_CACHE_TTL_MS`: live model inventory cache TTL, default `30000`.
- `SPILLI_BRIDGE_REUSE_SESSIONS`: set to `0` to force a fresh SpiLLI resource request for every inference request. Defaults to `1`, reusing acquired resource sessions by model/scope.
- `SPILLI_BRIDGE_NATIVE_CACHE_DIR`: optional native binary cache directory.

## Dynamic Models

`GET /v1/models` fetches the same host inventory used by the VS Code extension for the configured scope. It returns the friendly display name as the API model id and includes the underlying SpiLLI UID as `uid`.

You can force-refresh the model inventory cache on demand:

```sh
curl "http://localhost:8888/v1/models?refresh=true"
```

Inference requests may pass either the friendly model id returned from `/v1/models` or the raw UID. The bridge resolves the friendly name back to the UID before calling `SpilliService`.

## Smoke Test

To test the same Anthropic endpoint Claude Code uses:

```sh
curl -N http://localhost:8888/v1/messages \
  -H "content-type: application/json" \
  -H "x-api-key: sk-spilli-local" \
  -d '{"model":"Openai Gpt Oss 20b","max_tokens":128,"messages":[{"role":"user","content":"Say hello in one sentence."}]}'
```
