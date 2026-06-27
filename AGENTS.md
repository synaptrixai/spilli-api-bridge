# Agent Instructions

You are working in `spilli-api-bridge`, a local Anthropic/OpenAI-compatible bridge for the SpiLLI SDK.

## Non-Negotiable Semantics

- A SpiLLI SDK `SpilliSession` is an acquired network resource/session for a model/scope/team. It should be shared for the same resource so the bridge does not create duplicate network connections.
- It is not a chat conversation. Chat/client history belongs in the complete `{ prompt, query }` payload supplied to each `session.run()` call.
- Do not use `clientId` in `session.run()` for request ids, chat ids, or tracing. It is reserved for SDK/internal behavior.
- Claude Code can send overlapping requests for the same model, so serialize `session.run()` calls per shared resource session unless the SDK explicitly documents concurrent runs as safe.

## Correct SDK Pattern

Use this shape for inference:

```js
const resource = { model: resolvedUid, scope };
if (team) resource.team = team;

let session = service.getOrCreateSession(resource, timeoutMs);
if (!session.isLive()) {
  session = service.request(resource, timeoutMs);
}

const raw = await session.run(
  { prompt, query },
  { timeoutMs, onChunk }
);
```

Do not add `clientId` to `session.run()` options.

## Model Names

The API-facing model id should be the friendly display name returned by `/v1/models`. The bridge must map it back to the SpiLLI UID before requesting the SDK resource.

Accept both:

- Friendly model name from `/v1/models`.
- Raw SpiLLI UID.

Model matching intentionally normalizes spaces, underscores, and hyphens.

## PEM And Inventory

Use `SPILLI_KEY_PATH`, defaulting to `~/.spilli`, and resolve the highest-tier PEM in this order:

```text
SpiLLI_Enterprise.pem
SpiLLI_Team.pem
SpiLLI_Personal.pem
SpiLLI_Community.pem
```

Inventory calls must use mTLS with the PEM content as both `key` and `cert`.

## API Output Rules

- `SPILLI_BRIDGE_RESPONSE_MODE=raw` is the default. Return SpiLLI model text as assistant text and do not infer tool calls.
- `SPILLI_BRIDGE_RESPONSE_MODE=compat` preserves parser-based Harmony/JSON conversion into Anthropic/OpenAI tool-call objects.
- Never return Harmony analysis text to API clients in `compat` mode.
- Keep `/v1/models` dynamic; do not reintroduce static model-list environment variables.

## Logging

This bridge is intended for public release. Do not add verbose request tracing or logs that expose PEM paths, prompts, responses, model UIDs, or user data. Keep startup logs minimal and return structured errors through the API.

## Before Finishing Changes

Run:

```sh
npm run check
```

From the repository root, also run TypeScript when changing shared extension/agent code:

```sh
npx tsc -p tsconfig.json --noEmit
```

Do not inspect or copy secrets from `.env`.
