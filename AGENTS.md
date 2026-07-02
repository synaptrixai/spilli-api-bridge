# Agent Instructions

## Session Workflow

- Do not let `runInference(...)` create SpiLLI sessions internally.
- Always derive a bridge-managed session key before inference when the client exposes one.
  - Codex: `x-codex-turn-metadata` with `window_id`, `session_id`, `thread_id`
  - Claude Code: `x-claude-code-session-id`
- Always create or reuse the SpiLLI session before calling `runInference(...)`, then pass that live session in explicitly.

## Chat Isolation

- Do not use `service.getOrCreateSession({ model, scope, team }, ...)` as a resource-wide fallback for chat requests.
- Do not share one SpiLLI session across distinct Claude or Codex chat sessions targeting the same model.
- Keep conversation history in the HTTP payload, not in the SpiLLI session itself.

## SDK Constraints

- `clientId` must not be used for chat ids, request ids, or tracing.
- Serialize `session.run()` calls per live SpiLLI session unless the SDK documents concurrency as safe.
