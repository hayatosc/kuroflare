# DR-001 Durability Contract Plan

## Goal

Close DR-001 by making the implemented durability boundary explicit and proving the disaster behavior without changing production acknowledgement or checkpoint semantics.

## Agreed contract

- The latest recoverable document is the latest valid authoritative R2 snapshot plus later Durable Object SQLite `op_log` rows.
- Durable Object runtime eviction is a normal recoverable event because SQLite storage survives the execution instance.
- Complete loss of Durable Object SQLite is a disaster event outside the normal recovery guarantee. Acknowledged updates newer than the last successful checkpoint may be lost.
- R2 bytes without the SQLite pointer and snapshot-health evidence are not promoted to authority automatically. Recovery fails closed and requires explicit verification or operator action.
- The 128-operation threshold and 30-second alarm delay are best-effort checkpoint triggers, not a maximum acknowledged-data-loss SLA. Alarm delay, alarm failure, per-alarm work limits, and concurrent appends prevent a truthful hard bound.

## Implementation steps

1. Add a deterministic Worker disaster-recovery test that creates an authoritative checkpoint, acknowledges a later residual update, replaces SQLite with an empty store while retaining R2, and proves hydration fails closed without acknowledgement, broadcast, SQL mutation, or R2 mutation.
2. Keep the existing real-workerd eviction and fake restart tests as the normal-eviction evidence. Do not duplicate those scenarios.
3. Add a concise operator-facing snapshot-health note that distinguishes normal runtime eviction from complete SQLite loss, with a focused UI test.
4. Align `spec.md`, server, operations, deployment, design-review, and implementation-status documentation with the composite-authority and disaster contracts.
5. Run formatting, lint, both TypeScript type checks, unit tests, build, and Worker E2E, then obtain an adversarial review.

## Acceptance criteria

- Documentation never calls R2 the sole authority for acknowledged updates that have not checkpointed.
- Documentation never claims that a Durable Object can disappear without distinguishing runtime eviction from storage loss.
- The disaster test proves that unverified R2 data is not silently admitted after complete SQLite loss.
- Normal eviction recovery evidence remains green.
- Operator text does not promise a hard time or operation-count recovery point objective.
- DR-001 is marked closed only after code, tests, UI, and documentation agree.

## Out of scope

- Writing R2 snapshot and pointer state in the acknowledgement durability boundary.
- A zero-loss guarantee for complete Durable Object storage loss.
- Backup replication, restore automation, or a numeric recovery point objective.
- Integrating the separate multi-document eviction policy into the production runtime.
