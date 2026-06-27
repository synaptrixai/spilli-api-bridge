# SpiLLI API Bridge

Local HTTP bridge from Anthropic/OpenAI-style API clients to the SpiLLI SDK service.

## Why this exists

Tools such as Claude Code can route model requests through a local gateway by setting `ANTHROPIC_BASE_URL`. This bridge exposes the Anthropic Messages endpoint that Claude Code expects and forwards the prompt to `@synaptrix/spilli`.

It also exposes OpenAI-compatible chat completions for tools that use the `/v1/chat/completions` pattern.

Agent CLIs such as Codex and Claude Code require API-native tool-call objects before they execute tools. Use `SPILLI_BRIDGE_RESPONSE_MODE=compat` for those clients. `raw` mode is useful for plain text relay testing, but clients will treat model text that looks like a tool call as ordinary assistant text.

## Run

```sh
cd spilli-api-bridge
npm install
npm start
```


## Docker

Build and run with Docker Compose:

```sh
docker compose up --build
```

By default, Compose maps:

- Host port `8888` to container port `8888`.
- Host PEM directory `${HOME}/.spilli` to `/home/node/.spilli` read-only inside the container.

Override the PEM directory or host port when needed:

```sh
SPILLI_PEM_DIR=/path/to/.spilli SPILLI_BRIDGE_PORT=8889 docker compose up --build
```

Inside Docker, the bridge uses:

```env
SPILLI_BRIDGE_HOST=0.0.0.0
SPILLI_BRIDGE_PORT=8888
SPILLI_KEY_PATH=/home/node/.spilli
```

Host processes can then use:

```sh
export ANTHROPIC_BASE_URL="http://localhost:8888"
```

### Use The Published Image

The public image is published to GitHub Container Registry:

```text
ghcr.io/synaptrixai/spilli-api-bridge:latest
```

Use it from another project's Compose file:

```yaml
services:
  spilli-api-bridge:
    image: ghcr.io/synaptrixai/spilli-api-bridge:latest
    restart: unless-stopped
    ports:
      - "${SPILLI_BRIDGE_PORT:-8888}:8888"
    environment:
      SPILLI_BRIDGE_HOST: 0.0.0.0
      SPILLI_BRIDGE_PORT: 8888
      SPILLI_KEY_PATH: /home/node/.spilli
      SPILLI_BRIDGE_TEAM: ${SPILLI_BRIDGE_TEAM:-}
      SPILLI_BRIDGE_AUTH_TOKEN: ${SPILLI_BRIDGE_AUTH_TOKEN:-}
      SPILLI_BRIDGE_REQUEST_TIMEOUT_MS: ${SPILLI_BRIDGE_REQUEST_TIMEOUT_MS:-600000}
      SPILLI_BRIDGE_MODEL_CACHE_TTL_MS: ${SPILLI_BRIDGE_MODEL_CACHE_TTL_MS:-30000}
      SPILLI_BRIDGE_RESPONSE_MODE: ${SPILLI_BRIDGE_RESPONSE_MODE:-compat}
      SPILLI_BRIDGE_REUSE_SESSIONS: ${SPILLI_BRIDGE_REUSE_SESSIONS:-1}
    volumes:
      - ${SPILLI_PEM_DIR:-${HOME}/.spilli}:/home/node/.spilli:ro
```

For a pinned release, replace `latest` with a version tag such as `v0.1.0`.

### Publish A Release

Images are built for `linux/amd64` and `linux/arm64` by GitHub Actions. Pull requests build the image without publishing it. Pushes to `main`, version tags, and manual workflow runs publish to GHCR.

To publish a versioned image:

```sh
git tag v0.1.0
git push origin v0.1.0
```

After the first publish, make the GHCR package public in GitHub under the repository's Packages settings if it is not already public.

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
- `POST /v1/responses`

`/v1/messages` supports non-streaming responses and Anthropic SSE streaming.

`/v1/chat/completions` and `/v1/responses` support non-streaming and OpenAI-style SSE streaming.

## Configuration

Copy `.env.example` into your process manager or shell environment.

- `SPILLI_BRIDGE_PORT`: HTTP port, default `8888`.
- `SPILLI_BRIDGE_HOST`: bind host, default `127.0.0.1`.
- `SPILLI_KEY_PATH`: PEM file or directory, default `~/.spilli`, matching the VS Code extension.
  When this points to a directory, the bridge uses the same highest-tier priority as the extension:
  `SpiLLI_Enterprise.pem`, `SpiLLI_Team.pem`, `SpiLLI_Personal.pem`, then `SpiLLI_Community.pem`.
- `SPILLI_BRIDGE_TEAM`: optional fallback team name for team-scoped requests. Runtime `POST /v1/scope` with `team_name` is preferred.
- `SPILLI_BRIDGE_AUTH_TOKEN`: optional local bearer/API key.
- `SPILLI_BRIDGE_REQUEST_TIMEOUT_MS`: per-request SpiLLI timeout, default `600000`.
- `SPILLI_BRIDGE_MODEL_CACHE_TTL_MS`: live model inventory cache TTL, default `30000`.
- `SPILLI_BRIDGE_RESPONSE_MODE`: response conversion mode, default `raw`.
  - `raw`: return SpiLLI model text as assistant text and do not infer tool calls.
  - `compat`: parse Harmony/JSON tool-call text into Anthropic/OpenAI tool-call objects for clients that need API-native tool calls.
- `SPILLI_BRIDGE_REUSE_SESSIONS`: set to `0` to force a fresh SpiLLI resource request for troubleshooting. Defaults to `1`, reusing the acquired network resource/session by model/scope while keeping chat history in each request payload.
- `SPILLI_BRIDGE_NATIVE_CACHE_DIR`: optional native binary cache directory.

## Dynamic Models

`GET /v1/models` fetches the same host inventory used by the VS Code extension for the active model scope. It returns the friendly display name as the API model id and includes the underlying SpiLLI UID as `uid`.

The bridge starts with `public` model scope. Change it at runtime with:

```sh
curl -X POST http://localhost:8888/v1/scope \
  -H 'content-type: application/json' \
  -d '{"scope":"public"}'
```

For team-scoped models, include `team_name`:

```sh
curl -X POST http://localhost:8888/v1/scope \
  -H 'content-type: application/json' \
  -d '{"scope":"team","team_name":"my-team"}'
```

Valid scope values are `public`, `private`, `team`, `team.<name>`, and `enterprise`. `community` is accepted as an alias for `public`.

You can force-refresh the model inventory cache on demand:

```sh
curl "http://localhost:8888/v1/models?refresh=true"
```

Inference requests may pass either the friendly model id returned from `/v1/models` or the raw UID. The bridge resolves the friendly name back to the UID before calling `SpilliService`.

Anthropic-compatible `/v1/messages`, OpenAI-compatible `/v1/chat/completions`, and OpenAI-compatible `/v1/responses` support `stream: true`. In `raw` mode, streaming forwards SpiLLI SDK chunks as SSE text deltas and treats `[EOG]` as the end-of-generation marker instead of returning it to clients. In `compat` mode, the bridge keeps the parser-based tool-call conversion behavior for clients that require native tool-call blocks.

The bridge logs inbound inference requests and converted SpiLLI prompt/query payloads as JSONL at `~/.spilli/spilli-api-bridge-requests.jsonl`. Override with `SPILLI_BRIDGE_REQUEST_LOG_PATH` when needed. Auth tokens are not logged, and very large strings are truncated.

## Smoke Test

To test the same Anthropic endpoint Claude Code uses:

```sh
curl -N http://localhost:8888/v1/messages \
  -H "content-type: application/json" \
  -H "x-api-key: sk-spilli-local" \
  -d '{"model":"Openai_Gpt Oss 20b","max_tokens":128,"messages":[{"role":"user","content":"Say hello in one sentence."}]}'
```
