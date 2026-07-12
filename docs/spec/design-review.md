# Cross-cutting design review

[← Design overview](../../spec.md)

This review compares the normative specifications with the current implementation as of 2026-07-10.
It does not redefine unresolved behavior silently.
Each item states the observed mismatch, the recommended contract, and the evidence required before the main specification may claim the property.

## 1. Priority and status

| ID     | Priority | Area                                       | Status                                             |
| ------ | -------- | ------------------------------------------ | -------------------------------------------------- |
| DR-001 | P0       | Durable authority and failure model        | Specification correction required                  |
| DR-002 | P0       | Atomic update append                       | Implemented and fault-injection tested             |
| DR-003 | P0       | Large-update snapshot escape               | Safely disabled; full escape remains unimplemented |
| DR-004 | P0       | Checkpoint boundary and rollback retention | Implemented and concurrency tested                 |
| DR-005 | P1       | Meta entry merge granularity               | Schema decision required                           |
| DR-006 | P1       | Delete-versus-edit causality               | Schema decision required                           |
| DR-007 | P1       | Yjs actor identity                         | Current registry does not prove update authorship  |
| DR-008 | P1       | Snapshot health and rollback               | Implemented and recovery tested                    |
| DR-009 | P1       | Quarantine and public error evidence       | Wire contract and runtime differ                   |
| DR-010 | P2       | Empty binary files                         | Schema contradiction                               |
| DR-011 | P2       | Portable path materialization              | Deterministic policy missing                       |
| DR-012 | P2       | Capability negotiation                     | Forward-compatibility policy missing               |

P0 items can acknowledge or delete durable user data incorrectly.
P1 items can violate convergence, recovery, or interoperability under realistic concurrency.
P2 items are bounded compatibility gaps, but they should be resolved before distribution.

## 2. Durable state and checkpointing

### DR-001: Define the durable authority as a composite state

The overview and server specification call R2 the sole source of truth and state that the Durable Object may disappear safely.
The runtime acknowledges an ordinary update after writing it to `op_log`, `docs`, and `message_dedup` in Durable Object SQLite.
That update does not reach R2 until a later checkpoint.

The current recoverable state is therefore:

```
latest durable YDoc = latest valid R2 snapshot + later DO SQLite op_log rows
```

The phrase “the Durable Object may disappear” must distinguish an evicted execution instance from loss of Durable Object storage.
Eviction is recoverable today.
Complete SQLite loss can discard acknowledged updates newer than the last checkpoint.

Recommended contract:

- Treat DO SQLite as the authority for acknowledged, not-yet-checkpointed updates.
- Treat R2 as the authority for completed checkpoints and immutable blobs.
- Do not claim recovery from complete DO storage loss until an R2 manifest or pointer is advanced through the same durability boundary as acknowledgement.
- State the maximum acknowledged-data-loss window explicitly if complete DO storage loss remains an accepted failure mode.

Acceptance evidence:

- A crash test acknowledges update N, evicts the runtime before checkpoint, and restores N from SQLite plus R2.
- A separate disaster-recovery test documents what survives simulated SQLite loss.
- The overview, server specification, deployment guide, and operator UI use the same failure model.

### DR-002: Make the SQL append one transaction

The server specification defines `op_log`, `docs.latest_seq`, and `message_dedup` as one success unit.
`VaultRoom.persistAppend()` now writes all three records in one Durable Object storage transaction.
The runtime applies the committed update to derived in-memory state only after commit and rehydrates that state from the durable log if application unexpectedly fails.
Checkpoint scheduling failures no longer suppress the committed update acknowledgement or peer broadcast.

Recommended contract:

1. Validate the envelope and update against a hydrated copy.
2. In one SQLite transaction, insert `op_log`, advance `docs.latest_seq`, and insert `message_dedup`.
3. Apply the committed update to the in-memory YDoc.
4. Send the acknowledgement and peer broadcast.
5. If the in-memory apply unexpectedly fails after commit, discard that in-memory doc and hydrate it again from durable state.

The in-memory YDoc cannot be part of a SQLite transaction and should be described as derived state.

Acceptance evidence:

- Fault injection after each SQL statement leaves either all three records committed or none committed.
- Retrying the same `messageId` always returns the same `durableSeq`.
- No peer observes an update before its durable transaction commits.

### DR-003: Complete or remove the large-update escape before use

The specification requires a large update to be applied, written as an R2 snapshot, and connected to a durable pointer before acknowledgement.
The former `snapshot-escape` branch advanced `docs.latest_seq`, wrote `message_dedup`, sent an acknowledgement, and sent `NeedFullSnapshot` without applying the update or writing an R2 snapshot.

That sequence permanently suppressed a retry because the dedup row proved a completion that never happened.
The runtime now rejects oversized live updates without acknowledgement or durable mutation using the stable `append-reject:large-update-requires-snapshot-import` close reason.
Recovery currently requires manual use of the authenticated snapshot-import route; automatic client transition is future work.

Recommended contract:

1. Apply the update to a hydrated copy.
2. Encode and write that copy as an immutable R2 snapshot.
3. In one SQLite transaction, advance the snapshot pointer, `latest_snapshot_seq`, `latest_seq`, and dedup evidence to the same sequence.
4. Replace or update the active in-memory YDoc.
5. Only then send `Ack` and `NeedFullSnapshot(reason="large-update-snapshot")`.

The simpler safe alternative is now active until the full escape transaction exists.

Acceptance evidence:

- An oversized live update closes with `large-update-requires-snapshot-import` and leaves `op_log`, `docs`, and `message_dedup` unchanged.
- Retrying that message is not treated as a completed duplicate and receives no acknowledgement.
- Ordinary live updates continue through the existing append path.

Acceptance evidence for a future full escape:

- Fault injection at every step never leaves an acknowledgement without a restorable snapshot.
- A duplicate large update returns the original sequence and identical content.
- A cold start immediately after acknowledgement restores the large update.

### DR-004: Bind `upperSeq`, snapshot bytes, and state vector to one document boundary

The runtime now captures `latestSeq`, snapshot bytes, and the state vector in the same document queue turn before releasing the queue for R2 and SQL I/O.
Live appends, snapshot imports, checkpoint creation, and orphan pointer recovery share that document boundary.

An await-free encoder is insufficient if the sequence boundary and encoded YDoc are captured in different critical sections.
The snapshot can represent a state newer or older than its declared `upperSeq`.
Compaction can then remove an update that the snapshot does not contain.

Recommended contract:

- Acquire the document write queue.
- Capture `upperSeq`, snapshot bytes, and state vector in that one queue turn.
- Release the queue before R2 I/O.
- Permit later updates to append above `upperSeq` while the R2 write is in flight.
- Advance the pointer monotonically and compact only rows proven covered by the retained snapshot floor.

Normal compaction and orphan recovery now clamp deletion to the oldest retained snapshot floor and persist the state vector for that exact floor.
Retention candidates must match durable checkpoint state-vector evidence; missing or inconsistent evidence blocks compaction and cleanup.
R2 listing follows pagination before calculating the retention plan.

Acceptance evidence:

- A model test interleaves append at every checkpoint await and preserves every acknowledged update.
- Retaining snapshot S keeps every op required to replay from S to the latest state.
- Orphan recovery uses the same retained floor as normal compaction.
- Cleanup cannot retain an old snapshot while deleting the operations required to roll it forward.

## 3. Metadata convergence

### DR-005: Avoid whole-entry last-writer-wins updates

The data model describes path, content reference, and deletion as independently changing fields.
The plugin stores each `MetaFile` as one plain object under `Y.Map<fileId, value>` and replaces the entire value for rename, binary publication, deletion, and repair.

Concurrent writes to the same map key do not merge object fields.
A rename can therefore lose a concurrent binary update, and a deletion can erase metadata needed to detect a concurrent edit.

Recommended target schema:

```
fileId -> Y.Map {
  identity: { schemaVersion, fileId, type, ydocId?, createdAt, createdBy }
  location: { path, canonicalPath, updatedAt, updatedBy }
  content:  { blobManifestHash?, blobChunks, contentUpdatedAt, contentUpdatedBy }
  deletion: { deleted, deletedAt?, deletedBy?, deletedContentVersion? }
}
```

Independent groups use separate Y.Map keys so rename and content publication can merge.
Values that must pass validation together remain one atomic plain object inside a group.
For example, `path` and `canonicalPath` stay together, as do `blobManifestHash` and `blobChunks`.
Identity becomes immutable after creation.

An append-only metadata operation log is a valid alternative, but it adds replay and compaction machinery without removing the need for deterministic reduction.
The grouped nested-map schema is the smaller change.

Acceptance evidence:

- Concurrent rename plus binary update preserves both results.
- Concurrent rename plus delete follows the documented deletion policy.
- Changing immutable identity fields is rejected or quarantined.
- Schema migration keeps older clients read-only instead of letting them overwrite unknown fields.

### DR-006: Replace wall-clock delete detection with content-version evidence

The current delete-versus-edit heuristic compares `deletedAt` and `contentUpdatedAt` from different devices.
Clock skew can invert that comparison.
Text content also lives in a separate file YDoc, so the meta YDoc does not provide a shared causal order across deletion and editing.

Recommended contract:

- A text deletion records the file YDoc state vector and content hash observed when deletion was chosen.
- A binary deletion records the observed `blobManifestHash`.
- Reconciliation compares the converged content version with the deletion base.
- If the required file YDoc is not loaded, deletion materialization waits instead of guessing.
- Ambiguous text cases preserve content.
- Binary restoration still requires manifest and chunk evidence.

The timestamp heuristic may remain as UI evidence, but it must not be the data-preservation boundary.

Acceptance evidence:

- Tests use arbitrarily skewed device clocks and reach the same decision.
- An edit made without observing the deletion is preserved.
- An edit made before and observed by the deleter does not cause an unnecessary restore.
- The decision is stable on every client after all required YDocs load.

### DR-007: Separate authenticated device identity from Yjs actor identity

Setup assigns one `yClientId` per device, and hello checks it against the device registry.
The plugin creates each meta and file document with `new Y.Doc()` and does not bind the assigned value to `Y.Doc.clientID`.
The server records the hello value beside an update but does not verify the client IDs encoded inside the update bytes.

The current registry therefore proves session metadata, not Yjs actor uniqueness or authorship.
It also models one actor per device while one device owns many independently created YDocs.

Recommended simpler contract:

- Use `deviceId` for authentication and audit identity.
- Let Yjs generate a fresh actor ID for each YDoc instance.
- Never reuse a Yjs actor ID after losing the corresponding persisted clock state.
- Treat IndexedDB loss as a new document epoch and use full-snapshot merge.
- Remove `yClientId` from security claims unless the server can decode and verify every actor ID in the update.

If deterministic allocation is retained, the registry key must include `(deviceId, docId, epoch)`, and admission must verify update-internal actor IDs.

Acceptance evidence:

- The specification identifies the exact component that sets each real `Y.Doc.clientID`.
- Restart and IndexedDB-loss tests prove that an actor ID is never reused with a reset clock.
- Spoofing the envelope `yClientId` cannot misattribute update authorship.

### DR-008: Define snapshot health as evidence, not a key shape — closed

The decision is to treat an immutable R2 object as usable only when its append-only
SQLite evidence proves both physical integrity and durable authority. A correctly
named object discovered by prefix listing is never sufficient authority by itself.

Implemented contract:

- Physical verification checks object readability, expected byte length and hashes,
  Yjs decoding, state-vector equality, and the meta schema where applicable.
- Logical health is an append-only, auditable SQLite event. Quarantine preserves the
  object but removes it from restore and retention eligibility.
- Hydration selects only authoritative, physically verified, healthy generations and
  validates every retained op-log sequence and the durable tail. A DO with no durable
  document clock and unapproved R2 candidates fails closed with
  `snapshot-health:no-verified-generation`; an operator must explicitly approve the
  generation through the authenticated health endpoint before recovery creates a
  pointer.
- Verification uses a pending event lease before the R2 read. The final approval
  rechecks the lease, document clock, pointer, and checkpoint-run authority in the
  document queue, so quarantine, retention, and concurrent first writes cannot be
  overwritten.
- Checkpoint pointer advancement, compaction, and retention deletion are serialized
  with quarantine. Retention may delete only the latest authoritative, verified,
  healthy evidence and never deletes the last healthy retained floor.
- Rollback replays the exact op-log range, writes a new immutable generation, and
  commits the pointer only after source and target health are revalidated.
- The admin API returns server-computed `allowedActions` and an optional
  `actionBlockReason`; clients do not infer authority from status fields alone.

Acceptance evidence:

- Worker integration suite: 225 tests passed, including corrupt-newest fallback,
  op-log gap/tail rejection, pending verification races, queue-linearized
  quarantine/retention, immutable target conflicts, and rollback replay.
- Worker SQLite e2e suite: 7 tests passed, including latest-per-generation reads
  over 9,000 audit events.
- Snapshot health evidence is versioned, latest-per-key selected without an audit
  history cap, and repeated verification/quarantine requests are idempotent.

## 4. Protocol and compatibility

### DR-009: Unify completion, quarantine, and public errors

The protocol specifies one `ApiError` shape, while runtime routes commonly return ad hoc `{ error: string }` bodies.
The WebSocket quarantine path intentionally sends no acknowledgement or rejection evidence.
The client specification compensates by polling the quarantine admin endpoint and matching records after retries.

Recommended contract:

- Every public HTTP failure uses the guarded `ApiError` envelope.
- WebSocket update rejection returns a guarded control message containing `messageId`, `docId`, `updateSha256`, a stable reason code, and whether retry can help.
- Quarantine evidence is not completion evidence and cannot mark an outbox item done.
- A matching quarantine message may pause the item immediately; polling remains a recovery fallback.
- Logs and UI never include update bytes, bearer tokens, refresh tokens, or setup tokens.

Acceptance evidence:

- Contract tests cover every public route and WebSocket rejection.
- Unknown error codes fail closed and are not retried automatically.
- One malformed update causes one durable quarantine record and one stable client repair entry without an infinite retry loop.

### DR-010: Decide how zero-byte binary files are represented

The manifest schema permits `size = 0` with `chunks = []`.
The `BinaryMetaFile` schema requires at least one chunk.
Both contracts cannot hold for an empty attachment.

Recommended contract:

- Permit `blobChunks = []` only when the referenced manifest has `size = 0` and `chunks = []`.
- Keep `blobManifestHash` mandatory so the empty file still has content evidence.
- Do not manufacture a zero-length chunk solely to satisfy the metadata schema.

Acceptance evidence:

- Upload, download, materialize, delete, and restore tests cover an empty binary file.

### DR-011: Make invalid-path repair portable and deterministic

The data model defers Windows reserved names, trailing spaces or periods, and path-length limits to OS-specific materialization.
If each device chooses a different repair name, watcher feedback can make the shared path oscillate.

Recommended contract:

- Define a deterministic `portablePath` sanitizer shared by every client.
- Cover Windows reserved names, control characters, trailing spaces and periods, and segment limits with common vectors.
- Store the original path and repair reason in the repair log.
- Keep an OS-only local conflict copy for restrictions that cannot be expressed portably; do not write that local alias back to meta state.

Acceptance evidence:

- Linux, macOS, and Windows adapters produce the same portable alias for the shared vectors.
- Materializing and rescanning the alias is a no-op.

### DR-012: Specify capability negotiation independently of protocol version

`ClientCapabilitySchema` is a closed union.
Adding a capability makes older guards reject the entire hello if the new value is sent, even when the capability is optional.

Recommended contract:

- A peer ignores unknown optional capabilities and negotiates the known intersection.
- Required capabilities use an explicit required list or a protocol-version boundary.
- Capability order and duplicates have no semantic effect.

Acceptance evidence:

- An older client accepts hello with an unknown optional capability.
- Missing required capability produces a stable upgrade error rather than a generic malformed-message close.

## 5. Documentation and release gate

The main specifications should adopt a review item only after its decision and acceptance evidence are complete.
Until then, implementation status must link to the corresponding DR identifier instead of describing the property as implemented.

Before the first distributed release:

1. Close DR-001 through DR-004 and rerun crash-injection models.
2. Decide DR-005 through DR-007 before freezing metadata schema version 1 and setup credentials.
3. DR-008 is closed with the evidence above. Close DR-009 before advertising
   protocol-level self-healing guarantees.
4. Close DR-010 through DR-012 before cross-platform compatibility testing.
