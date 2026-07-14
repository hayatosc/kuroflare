# Oversized Update Rejection Evidence Plan

## Goal

Stop a current Obsidian client from retrying the same oversized live Yjs update indefinitely while preserving the worker's no-acknowledgement and no-durable-mutation safety boundary.

## Agreed decisions

- Add a dedicated guarded `sync-update-rejected` control message instead of reusing `NeedFullSnapshot`.
- Keep protocol version 1 for this additive server-to-client message. Legacy clients retain the existing close-only behavior; capability and version negotiation remain separate work.
- Limit the first rejection reason to `large-update-requires-snapshot-import` with `retryable: false`.
- Require `vaultId`, `deviceId`, `messageId`, `docId`, and the server-computed `updateSha256` in the rejection evidence.
- Pause only the exact local outbox item whose message, document, and update hash match the guarded evidence.
- Persist the item as `paused` with `reason: sync-update-rejected` and `resumeOn: manual`, and release its running lease in the same IndexedDB transaction.
- Do not route the rejection through `NeedFullSnapshot` or full-snapshot release. The rejected local update must not become `done` merely because a remote snapshot was applied.

## Implementation steps

1. Define and test the guarded core control-message schema and stable rejection reason.
2. Emit exactly one rejection frame before the existing WebSocket close when the worker rejects an oversized live update. Preserve no Ack, no operation-log append, no document-pointer change, and no dedup evidence.
3. Route the guarded rejection to the plugin outbox completion boundary. Match the exact message, document, and hash, then atomically pause the item and release its lease.
4. Add focused core, worker, queue, store, and WebSocket tests for guarded parsing, durable-state invariants, exact correlation, hash mismatch fail-closed behavior, and non-retryable manual pause.
5. Update implementation status to describe this DR-009 subset accurately, then run formatting, lint, type checks, unit tests, and relevant Worker E2E coverage.

## Acceptance criteria

- An oversized live update receives one guarded `sync-update-rejected` frame followed by the existing stable close.
- The frame contains no raw update bytes or credentials.
- The worker sends no Ack and leaves `op_log`, `docs`, `message_dedup`, and the active YDoc unchanged.
- A current plugin pauses exactly one matching outbox item, clears its running lease atomically, and does not resend it automatically.
- Missing or mismatched message, document, or hash evidence cannot mutate local outbox state.
- Applying a remote full snapshot cannot complete an item paused for `sync-update-rejected`.

## Out of scope

- Automatic client-to-server snapshot import.
- Protocol-version or capability negotiation and legacy-client retry suppression.
- General quarantine rejection messages and repair-log creation.
- Public HTTP `ApiError` envelope migration.
- Closing DR-009 or DR-012 in full.
