# Agent Instructions

## Session Workflow

- Derive stable `window_id`, `session_id`, and `context_id` from supported client metadata.
- Send a versioned `spilli_context` on every stateful run.
- Hydrate first, after reconnect/rewrite/resource changes, and after `SPILLI_CONTEXT_MISS`.
- Delta only strict append-only history, and commit revision state only after success.

## Chat Isolation

- Do not use `service.getOrCreateSession({ model, scope, team }, ...)` as a resource-wide fallback for chat requests.
- Do not share one SpiLLI session across distinct Claude or Codex chat sessions targeting the same model.
- Do not treat a V1 full-model allocation and a V2 fragmented allocation for the same model UID as the same resource.
- Treat API request history as authoritative and SpiLLIHost history as a hydrated cache.

## SDK Constraints

- `clientId` must not be used for chat ids, request ids, or tracing.
- Forward `allocation_protocol` and `graph_v2` when the selected model advertises fragmented-placement metadata.
- Infer V2 when `graph_v2.compatibility_id` and `graph_v2.total_layers` are present even if `allocation_protocol` is omitted.
- Serialize `session.run()` calls per live SpiLLI session unless the SDK documents concurrency as safe.
- Treat SDK `onChunk` values as incremental deltas; never emit them as cumulative snapshots.
