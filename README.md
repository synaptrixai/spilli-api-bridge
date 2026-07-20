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
      SPILLI_BRIDGE_ALLOCATION_TIMEOUT_MS: ${SPILLI_BRIDGE_ALLOCATION_TIMEOUT_MS:-60000}
      SPILLI_BRIDGE_RUN_TIMEOUT_MS: ${SPILLI_BRIDGE_RUN_TIMEOUT_MS:-300000}
      SPILLI_BRIDGE_MODEL_CACHE_TTL_MS: ${SPILLI_BRIDGE_MODEL_CACHE_TTL_MS:-30000}
      SPILLI_BRIDGE_COMPACT_TOOL_RESULTS: ${SPILLI_BRIDGE_COMPACT_TOOL_RESULTS:-0}
      SPILLI_BRIDGE_TOOL_RESULT_RAW_CHARS: ${SPILLI_BRIDGE_TOOL_RESULT_RAW_CHARS:-4000}
      SPILLI_BRIDGE_TOOL_RESULT_COMPACT_CHARS: ${SPILLI_BRIDGE_TOOL_RESULT_COMPACT_CHARS:-16000}
      SPILLI_BRIDGE_TOOL_RESULT_COMPACT_TARGET_CHARS: ${SPILLI_BRIDGE_TOOL_RESULT_COMPACT_TARGET_CHARS:-6000}
      SPILLI_BRIDGE_TOOL_RESULT_SUMMARY_TARGET_CHARS: ${SPILLI_BRIDGE_TOOL_RESULT_SUMMARY_TARGET_CHARS:-3000}
      SPILLI_BRIDGE_TOOL_RESULT_SUMMARIZER_ENABLED: ${SPILLI_BRIDGE_TOOL_RESULT_SUMMARIZER_ENABLED:-1}
      SPILLI_BRIDGE_TOOL_RESULT_SUMMARIZER_MODEL: ${SPILLI_BRIDGE_TOOL_RESULT_SUMMARIZER_MODEL:-}
      SPILLI_BRIDGE_TOOL_RESULT_SUMMARIZER_TIMEOUT_MS: ${SPILLI_BRIDGE_TOOL_RESULT_SUMMARIZER_TIMEOUT_MS:-60000}
      SPILLI_BRIDGE_TOOL_RESULT_SUMMARIZER_ENDPOINT: ${SPILLI_BRIDGE_TOOL_RESULT_SUMMARIZER_ENDPOINT:-}
      SPILLI_BRIDGE_MAX_HISTORY_CHARS: ${SPILLI_BRIDGE_MAX_HISTORY_CHARS:-}
      SPILLI_BRIDGE_CONTEXT_CHARS_PER_TOKEN: ${SPILLI_BRIDGE_CONTEXT_CHARS_PER_TOKEN:-3}
      SPILLI_BRIDGE_CONTEXT_INPUT_BUDGET_FRACTION: ${SPILLI_BRIDGE_CONTEXT_INPUT_BUDGET_FRACTION:-0.72}
      SPILLI_BRIDGE_CONTEXT_OUTPUT_RESERVE_TOKENS: ${SPILLI_BRIDGE_CONTEXT_OUTPUT_RESERVE_TOKENS:-1024}
      SPILLI_BRIDGE_RELEASE_EPHEMERAL_CONTEXTS: ${SPILLI_BRIDGE_RELEASE_EPHEMERAL_CONTEXTS:-1}
      SPILLI_BRIDGE_MAX_DURABLE_CONTEXTS_PER_RESOURCE: ${SPILLI_BRIDGE_MAX_DURABLE_CONTEXTS_PER_RESOURCE:-2}
      SPILLI_BRIDGE_RESPONSE_MODE: ${SPILLI_BRIDGE_RESPONSE_MODE:-compat}
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
- `SPILLI_BRIDGE_ALLOCATION_TIMEOUT_MS`: timeout for acquiring a SpiLLI model/session, default `60000`. The legacy `SPILLI_BRIDGE_REQUEST_TIMEOUT_MS` is still accepted as an allocation-timeout fallback.
- `SPILLI_BRIDGE_RUN_TIMEOUT_MS`: timeout for prompt hydration and generation after allocation, default `300000`.
- `SPILLI_BRIDGE_MODEL_CACHE_TTL_MS`: live model inventory cache TTL, default `30000`.
- `SPILLI_BRIDGE_TOOL_RESULT_RAW_CHARS`: maximum characters from a tool result forwarded raw into the local model context, default `4000`.
- `SPILLI_BRIDGE_TOOL_RESULT_COMPACT_CHARS`: maximum original result size handled by deterministic compaction before switching to summarizer-recommended pre-summary mode, default `16000`. The legacy `SPILLI_BRIDGE_MAX_TOOL_RESULT_CHARS` is still accepted as a fallback for this threshold.
- `SPILLI_BRIDGE_TOOL_RESULT_COMPACT_TARGET_CHARS`: target size for deterministic compacted tool results, default `6000`.
- `SPILLI_BRIDGE_TOOL_RESULT_SUMMARY_TARGET_CHARS`: target size for very large tool results when the bridge marks the result as summarizer-recommended, default `3000`.
- `SPILLI_BRIDGE_TOOL_RESULT_SUMMARIZER_ENABLED`: set to `0` to disable SpiLLI SDK summarization for oversized tool results, default `1`.
- `SPILLI_BRIDGE_TOOL_RESULT_SUMMARIZER_MODEL`: optional SpiLLI model name for tool-result summaries. If unset, the bridge uses the request model.
- `SPILLI_BRIDGE_TOOL_RESULT_SUMMARIZER_TIMEOUT_MS`: timeout for internal summarization runs, default `60000`.
- `SPILLI_BRIDGE_TOOL_RESULT_SUMMARIZER_ENDPOINT`: optional informational external summarizer endpoint retained for deployments that want to expose or track an out-of-process summarizer. The bridge's built-in oversized-tool-result path uses SpiLLI SDK directly.
- `SPILLI_BRIDGE_MAX_HISTORY_CHARS`: optional diagnostic override for maximum aggregate message-history characters forwarded during hydrate requests. Leave unset for normal use; the bridge derives this budget from SpiLLIHost's advertised safe context token limit for the resolved model.
- `SPILLI_BRIDGE_CONTEXT_CHARS_PER_TOKEN`: conservative text-to-token conversion used when deriving a bridge history budget from host-reported token limits, default `3`.
- `SPILLI_BRIDGE_CONTEXT_INPUT_BUDGET_FRACTION`: fraction of remaining host context assigned to input history after prompt/output reserve, default `0.72`.
- `SPILLI_BRIDGE_CONTEXT_OUTPUT_RESERVE_TOKENS`: minimum output-token reserve used when deriving bridge history budget from host limits, default `1024`.
- `SPILLI_BRIDGE_RELEASE_EPHEMERAL_CONTEXTS`: release short-lived Claude Code subagent KV contexts after success or failure, default `1`.
- `SPILLI_BRIDGE_MAX_DURABLE_CONTEXTS_PER_RESOURCE`: maximum idle durable main-session contexts to keep warm per SpiLLI resource before LRU release, default `2`.
- `SPILLI_BRIDGE_MODEL_ALIASES`: optional model aliases in `client_name=spilli_name` form, separated by commas or semicolons. No aliases are built in; model names pass through unchanged unless this variable is set.
- `SPILLI_BRIDGE_RESPONSE_MODE`: response conversion mode, default `compat`.
  - `raw`: return SpiLLI model text as assistant text and do not infer tool calls.
  - `compat`: parse Harmony/JSON tool-call text into Anthropic/OpenAI tool-call objects for clients that need API-native tool calls.
- `SPILLI_BRIDGE_RENDER_TOOL_SCHEMAS`: set to `0` to disable rendering incoming Anthropic `tools` definitions into the local SpiLLI model prompt, default `1`. This emulates Anthropic's server-side tool-use prompt for local backends that only receive text.
- `SPILLI_BRIDGE_TOOL_SCHEMA_PROMPT_MAX_CHARS`: maximum characters used for the rendered tool-schema prompt, default `24000`.
- `SPILLI_BRIDGE_ASK_CONTINUE_ON_MAX_TOKENS`: in Anthropic compat mode, synthesize an `AskUserQuestion` continuation prompt when SpiLLIHost reports `max_tokens` and Claude Code advertised that tool, default `1`. Set to `0` to return plain `stop_reason: "max_tokens"` instead.
- `SPILLI_BRIDGE_NATIVE_CACHE_DIR`: optional native binary cache directory.
- `SPILLI_BRIDGE_WEB_SEARCH_ENDPOINT`: optional external search endpoint used to emulate Anthropic server-side `web_search` for Claude Code. If the URL contains `{query}`, the bridge sends a GET with the encoded query substituted. Otherwise it sends a POST body of `{"query":"...","max_results":5}`. Responses may use common shapes such as `results`, `items`, `organic_results`, or `webPages.value`, with `title`, `url`/`link`, and `snippet`/`description` fields.
- `SPILLI_BRIDGE_WEB_SEARCH_TIMEOUT_MS`: timeout for external/DuckDuckGo web search, default `10000`.
- `SPILLI_BRIDGE_WEB_SEARCH_MAX_RESULTS`: maximum web-search results returned to the agent, default `5`.
- `SPILLI_BRIDGE_TRACE_REQUEST_SHAPES`: set to `1` to write sanitized request-shape traces for local debugging. This logs headers and payload structure, including system-prompt length/hash/preview, but not model responses.
- `SPILLI_BRIDGE_LOG_SYSTEM_PROMPT`: set to `1` to include the full normalized Claude/Codex system prompt in bridge request logs. Leave unset for normal use; logs include only prompt length, SHA-256 hash, and a short preview by default.
- `SPILLI_BRIDGE_LOG_TOOL_SCHEMAS`: set to `1` to include full sanitized incoming tool definitions in bridge request logs. Leave unset for normal use; logs include only tool names, description previews, required fields, and input-schema property names.
- `SPILLI_BRIDGE_REQUEST_LOG_PATH`: optional path for the trace file. Defaults to `~/.spilli/spilli-api-bridge-requests.jsonl`.

When Claude Code sends its internal “web search tool use” request to `/v1/messages`, the bridge resolves that request server-side. It tries `SPILLI_BRIDGE_WEB_SEARCH_ENDPOINT` first when configured, then falls back to DuckDuckGo Instant Answer plus DuckDuckGo HTML search. The returned assistant text is passed by Claude Code back into the main conversation as the WebSearch tool result, including result titles, URLs, snippets, and a reminder to cite the URLs.

### Summarization Endpoint

The bridge exposes `POST /v1/spilli/summarize` and `POST /summarize` for direct local summarization through the configured SpiLLI SDK connection:

```json
{
  "model": "Openai_Gpt_Oss_20b",
  "text": "large tool output...",
  "target_chars": 3000,
  "instruction": "Preserve file paths and line numbers."
}
```

The response is:

```json
{
  "summary": "...",
  "original_chars": 12345,
  "summary_chars": 2345,
  "model": "Openai_Gpt_Oss_20b"
}
```

Oversized Anthropic/Claude `tool_result` blocks are summarized through the same internal SpiLLI path before they are added to model context. If summarization fails, the bridge falls back to deterministic compaction and logs `tool_result.summarize.error`.

## Dynamic Models

`GET /v1/models` uses the same public-model discovery approach as the VS Code extension for the active model scope. Public scope merges the backend public catalog with host inventory, while non-public scopes use host inventory. It returns the friendly display name as the API model id and includes the underlying SpiLLI UID as `uid`.

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

When the selected model carries SpiLLI allocation metadata, the bridge also forwards the same protocol details the VS Code extension uses:

- Full-model allocations use the plain V1 resource shape.
- Fragmented or graph-backed allocations use V2 metadata by setting `allocation_protocol: 2`.
- If the catalog or host inventory includes `graph_v2` metadata such as `compatibility_id` and `total_layers`, the bridge forwards that as `resource.graph_v2` and treats the model as V2 even when `allocation_protocol` is omitted.
- This protocol metadata is part of the bridge's resource identity, so a full-model session is not reused for a fragmented-graph session of the same model UID.

Anthropic-compatible `/v1/messages`, OpenAI-compatible `/v1/chat/completions`, and OpenAI-compatible `/v1/responses` support `stream: true`. In `raw` mode, streaming forwards SpiLLI SDK chunks as SSE text deltas and treats `[EOG]` as the end-of-generation marker instead of returning it to clients. In `compat` mode, the bridge keeps the parser-based tool-call conversion behavior for clients that require native tool-call blocks.

## Chat Sessions

The bridge maps client conversation metadata to SpiLLIHost's versioned `spilli_context` protocol:

- Codex uses `window_id`, `session_id`, and `thread_id` from `x-codex-turn-metadata`.
- Claude Code uses `x-claude-code-session-id`.
- Other clients may send `x-spilli-session-id` to opt into stateful reuse.
- Requests without a supported session identifier are isolated and hydrated as one-off conversations.

The first turn, rewritten history, model changes, and reconnects use `hydrate`. Strict append-only follow-ups use `delta` and send only the uncommitted suffix as the current query. If SpiLLIHost reports `SPILLI_CONTEXT_MISS`, the bridge suppresses that internal marker and retries the same revision once with hydration.

Model selection follows the extension's current allocation rule:

- A host-advertised full model uses the default V1 resource request.
- A host-advertised fragment set or public-catalog model with `graph_v2` metadata uses V2 allocation metadata on the SDK resource request.
- If both host inventory and public catalog describe the same logical model, host metadata wins and catalog metadata fills gaps.

SDK chunks are incremental text deltas. The bridge converts each chunk once into the selected Anthropic or OpenAI SSE event format, then commits the revision and assistant history only after the SpiLLI run succeeds.

The bridge logs inbound inference requests and converted SpiLLI prompt/query payloads as JSONL at `~/.spilli/spilli-api-bridge-requests.jsonl`. Override with `SPILLI_BRIDGE_REQUEST_LOG_PATH` when needed. Auth tokens are not logged, and very large strings are truncated.

## Smoke Test

To test the same Anthropic endpoint Claude Code uses:

```sh
curl -N http://localhost:8888/v1/messages \
  -H "content-type: application/json" \
  -H "x-api-key: sk-spilli-local" \
  -d '{"model":"Openai_Gpt Oss 20b","max_tokens":128,"messages":[{"role":"user","content":"Say hello in one sentence."}]}'
```
