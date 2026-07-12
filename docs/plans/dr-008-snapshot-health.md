# DR-008 Snapshot Health and Rollback Plan

## Decisions

- Complete DR-008 across durable evidence, automatic restore fallback, logical quarantine, operator inspection, rollback APIs, and the operator UI.
- Treat snapshots without durable expected hashes as unverified. Do not select or retain them as rollback evidence until an operator explicitly verifies and approves them.
- Keep health evidence outside immutable R2 objects as versioned, append-only audit records.
- Treat the Durable Object snapshot pointer as a hint. Select the newest physically verified and logically healthy generation.
- Preserve quarantined or corrupt generations for inspection until an explicit retention decision removes them. Never use them for restore.

## Implementation Order

1. Add a contiguous schema migration and repository API for versioned snapshot health evidence.
2. Add a shared physical verifier for byte length, update SHA-256, Yjs decoding, state vector, state-vector SHA-256, and meta schema validity.
3. Record expected evidence during normal checkpoints and authenticated snapshot imports, then verify the R2 object before pointer advancement.
4. Replace key-derived health with evidence-backed descending candidate verification and automatic fallback during hydration.
5. Feed only verified, logically healthy generations into retention and rollback-floor decisions. Fail closed when no safe rollback generation exists.
6. Add authenticated inspection, verify/approve, quarantine, and rollback endpoints with guarded request and response contracts.
7. Add operator UI actions for inspection, explicit legacy verification, quarantine, and rollback confirmation.
8. Update specifications and implementation status only after runtime, API, UI, and recovery tests pass.

## Acceptance Evidence

- A corrupt newest snapshot falls back to the newest older verified generation and replays later operation-log rows without losing acknowledged updates.
- Hash, byte-length, Yjs, state-vector, and meta-schema mismatches are audited and never selected.
- A logically quarantined generation remains inspectable but cannot be restored automatically or selected for rollback.
- A legacy snapshot remains unverified until an authenticated operator explicitly verifies and approves its current bytes.
- Rollback changes the authoritative pointer monotonically through a new audited generation and preserves the previous generations.
- Retention keeps at least one verified rollback generation and every operation-log row required to replay from it.
- API guards, authorization, operator UI flows, cold-start recovery, pagination, concurrent append, and failure injection are covered by tests.

## Out of Scope

- Silently trusting or automatically backfilling legacy snapshot objects.
- Mutating immutable snapshot objects in place.
- Deleting quarantined evidence without an explicit retention action.
