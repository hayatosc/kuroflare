# Cross-cutting design review

[← Design overview](../../spec.md)

This review compares the normative specifications with the current implementation as of 2026-07-10.
It does not redefine unresolved behavior silently.
Each item states the observed mismatch, the recommended contract, and the evidence required before the main specification may claim the property.

## 1. Priority and status

| ID     | Priority | Area                                       | Status                                                                                  |
| ------ | -------- | ------------------------------------------ | --------------------------------------------------------------------------------------- |
| DR-001 | P0       | Durable authority and failure model        | Closed: composite authority and disaster boundary tested                                |
| DR-002 | P0       | Atomic update append                       | Implemented and fault-injection tested                                                  |
| DR-003 | P0       | Large-update snapshot escape               | Closed narrowly: safe rejection + explicit repair; live escape remains unimplemented    |
| DR-004 | P0       | Checkpoint boundary and rollback retention | Implemented and concurrency tested                                                      |
| DR-005 | P1       | Meta entry merge granularity               | Closed: grouped schema v2, migration, and write admission implemented and tested        |
| DR-006 | P1       | Delete-versus-edit causality               | Closed: causal deletion witnesses and deferred reconciliation tested                    |
| DR-007 | P1       | Yjs actor identity                         | Closed: device/actor identity separated; provider-loss and real-process restart tested  |
| DR-008 | P1       | Snapshot health and rollback               | Implemented and recovery tested                                                         |
| DR-009 | P1       | Quarantine and public error evidence       | Closed: unified ApiError envelope (whole route surface), generalized WS reject evidence |
| DR-010 | P2       | Empty binary files                         | Closed: chunkless meta entries permitted and cross-checked against the manifest         |
| DR-011 | P2       | Portable path materialization              | Closed: deterministic shared sanitizer replaces OS-specific repair                      |
| DR-012 | P2       | Capability negotiation                     | Closed: opaque capability tokens with known-intersection negotiation                    |

P0 items can acknowledge or delete durable user data incorrectly.
P1 items can violate convergence, recovery, or interoperability under realistic concurrency.
P2 items are bounded compatibility gaps, but they should be resolved before distribution.

## 2. Durable state and checkpointing

### DR-001: Define the durable authority as a composite state — closed

The recoverable document is the latest `authoritative + verified + healthy` R2
snapshot plus later Durable Object SQLite `op_log` rows. SQLite is the authority for
acknowledged updates that have not reached a checkpoint; R2 stores immutable
checkpoint bytes and blob data. A normal execution-instance eviction is recoverable
because SQLite survives. Complete SQLite loss is a disaster outside the normal
guarantee and may lose acknowledged updates newer than the last checkpoint.

R2 bytes discovered by prefix listing without a SQLite pointer and snapshot-health
evidence are never auto-promoted. Hydration fails closed with
`snapshot-health:no-verified-generation`; an authenticated operator must explicitly
verify and recover the candidate.

Acceptance evidence:

- Existing normal eviction/restart tests restore checkpointed state and residual
  SQLite operations without duplicating that scenario here.
- `packages/worker/src/runtime/vault-room.test.ts` creates an authoritative seq 1
  checkpoint, acknowledges seq 2, then replaces SQLite with an empty store while
  retaining R2. Hydration rejects the unverified R2 candidate, leaves no document,
  op-log, dedup, or health mutation, and performs no R2 put/delete.
- `packages/obsidian-plugin/src/sync/obsidian/snapshot-health-ui.test.ts` checks the
  operator note for composite authority, normal eviction, complete SQLite loss, and
  best-effort checkpoint triggers.
- `spec.md`, `server.md`, `operations.md`, `deployment.md`, and this review use the
  same failure model. The nominal 128-operation / 30-second triggers are explicitly
  best effort rather than a hard recovery-point bound.

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

### DR-003: Safe rejection and explicit repair (live escape remains out of scope)

The specification requires a large update to be applied, written as an R2 snapshot, and connected to a durable pointer before acknowledgement.
The former `snapshot-escape` branch advanced `docs.latest_seq`, wrote `message_dedup`, sent an acknowledgement, and sent `NeedFullSnapshot` without applying the update or writing an R2 snapshot.

That sequence permanently suppressed a retry because the dedup row proved a completion that never happened.
The runtime now sends one guarded `sync-update-rejected` frame for an oversized live update, then performs the stable `1011` close with reason `append-reject:large-update-requires-snapshot-import`, without acknowledgement or durable mutation.
The matching client item is paused with evidence and a released lease; snapshot import still requires manual use of the authenticated route. That manual repair is the intentional limit of DR-003's narrow safe-rejection scope, not a DR-009 gap (DR-009 is closed below).

Recommended contract:

1. Apply the update to a hydrated copy.
2. Encode and write that copy as an immutable R2 snapshot.
3. In one SQLite transaction, advance the snapshot pointer, `latest_snapshot_seq`, `latest_seq`, and dedup evidence to the same sequence.
4. Replace or update the active in-memory YDoc.
5. Only then send `Ack` and `NeedFullSnapshot(reason="large-update-snapshot")`.

The simpler safe alternative is active for protocol v1. Oversized live updates remain
unsupported and fail closed. The Obsidian settings panel now offers an explicit repair
action for one paused `sync-update-rejected` outbox row. It verifies the complete row
evidence and the actual update-bytes SHA-256, fetches the latest snapshot manifest
sequence (a 404 means a new document), imports the exact Yjs delta through the
authenticated snapshot route, and only then commits a guarded IndexedDB patch for that
same row with the imported `snapshotSeq`.

Authentication, conflict, network, malformed-response, hash, evidence, and local
commit failures leave the row paused. A retry after remote success and local interruption
is safe because Yjs update application is idempotent. Rows for the same document are
never completed as a group.

Acceptance evidence:

- An oversized live update sends one guarded rejection frame, then closes with `large-update-requires-snapshot-import` and leaves `op_log`, `docs`, and `message_dedup` unchanged.
- Retrying that message is not treated as a completed duplicate and receives no acknowledgement.
- Ordinary live updates continue through the existing append path.
- Explicit repair imports the exact paused update before completing only its evidence-matched local row; all failure classes leave the row paused.

Acceptance evidence for a future full escape (not part of this closure):

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

### DR-005: Avoid whole-entry last-writer-wins updates — closed

The metadata merge-granularity decision is now implemented as grouped schema version 2.
Each root `fileId` points to an integrated child `Y.Map` with independent `identity`,
`location`, `content`, and `deletion` groups. Path/canonical-path and binary
manifest/chunk invariants remain atomic plain objects inside their groups.

The normalized `MetaFile` view is read-only at the boundary. All production mutations
use grouped helpers, and identity fields are immutable after creation. Version-1 flat
entries are readable but read-only; after Hello admission, migration merges the
authoritative latest v1 snapshot with local v1 state and commits through a
latest-sequence snapshot-import CAS. If the latest snapshot is already v2, adoption is
allowed only when every local normalized entry is represented unchanged; otherwise
the local document is retained and downgraded to read-only. Mixed, detached,
unsupported, or invalid values fail closed rather than being silently overwritten.
Flat-v1 metadata outbox rows that cannot be losslessly converted are paused with an
actionable migration reason.

The wire admission rule is deliberately narrow: `metadata-schema-v2` is a metadata
write capability, not the general capability-intersection policy. A missing capability
gets `metadataAccess: "read-only"`; an old-server invalid-control close triggers one
legacy-capability retry, and file-YDoc synchronization remains available in either
read-only case.
Metadata updates from a read-only session are rejected before Yjs hydration, SQL/R2
mutation, acknowledgement, or broadcast. Snapshot imports require explicit
`metadataSchemaVersion: 2` evidence and preserve immutable identities.

Implemented schema:

```
fileId -> Y.Map {
  identity: { schemaVersion, fileId, type, ydocId?, createdAt, createdBy }
  location: { path, canonicalPath, updatedAt, updatedBy, mtime }
  content:  { contentUpdatedAt, contentUpdatedBy, blobManifestHash?, blobChunks? }
  deletion: { deleted, deletedAt?, deletedBy? }
}
```

Acceptance evidence:

- [x] Concurrent rename plus binary update preserves both results.
- [x] Concurrent rename plus stale delete preserves the renamed location and tombstone.
- [x] Changing immutable identity fields is rejected before append/import.
- [x] Schema migration preserves location mtime and leaves grouped child maps.
- [x] Older clients remain metadata read-only without mutating legacy values.
- [x] File-YDoc updates from metadata read-only sessions remain accepted.

DR-006 is closed below. DR-012 (general capability negotiation) is closed below;
the metadata write gate is still intentionally narrow, but it now derives from the
generalized negotiated intersection.

### DR-006: Replace wall-clock delete detection with content-version evidence — closed

The current delete-versus-edit heuristic compares `deletedAt` and `contentUpdatedAt` from different devices.
Clock skew can invert that comparison.
Text content also lives in a separate file YDoc, so the meta YDoc does not provide a shared causal order across deletion and editing.

Implemented contract:

- A text deletion records `deletedContentVersion.kind = "text"`, the base64
  `Y.encodeStateVector` bytes, and the SHA-256 of canonical Y.Text content.
- A binary deletion records `deletedContentVersion.kind = "binary"` and the
  observed `blobManifestHash`.
- Reconciliation requires the current text YDoc state vector to dominate the base
  vector. Equal content keeps the tombstone; changed content restores it.
- Missing, incomplete, or invalid text evidence creates a defer repair and leaves
  the tombstone/content untouched until the required YDoc is available.
- A changed binary manifest restores only when the manifest and all chunks are
  verified present; otherwise the tombstone remains with actionable repair evidence.
- `deletedAt` and `deletedBy` are retained for audit/UI only and never decide data
  preservation. Legacy v1 deleted tombstones remain read-only for manual recovery
  regardless of any optional witness-shaped field.

The timestamp heuristic may remain as UI evidence, but it must not be the data-preservation boundary.

Acceptance evidence:

- [x] Tests use arbitrarily skewed device clocks and reach the same decision.
- [x] An edit made without observing the deletion is preserved.
- [x] An edit made before and observed by the deleter does not cause an unnecessary restore.
- [x] Missing/unloaded/incomplete YDocs defer without materializing deletion.
- [x] The decision converges on every client after required YDocs load.
- [x] Binary changed-manifest restoration covers complete and missing evidence.

### DR-007: Separate authenticated device identity from Yjs actor identity — closed

The previous design assigned one `yClientId` per device and carried it through setup and
hello. That value was not cryptographically bound to the Yjs actor IDs encoded in update
bytes, so it could not prove authorship.
The Obsidian plugin creates each meta and file document with `new Y.Doc()`, allowing Yjs
to generate the implementation-level actor ID independently for each document.

Recommended simpler contract:

- Use `deviceId` for authentication and audit identity.
- Let Yjs generate a fresh actor ID for each YDoc instance.
- Keep actor IDs out of setup, hello, session, and SQL audit contracts.
- Treat IndexedDB loss as a new document epoch. Probe provider databases without opening
  them, persist epoch evidence in the existing local-store `metadata` store, and recover
  under a global startup side-effect gate.

Acceptance evidence:

- [x] The specification identifies the exact component that sets each real `Y.Doc.clientID`:
      the Obsidian plugin creates each meta and file document with `new Y.Doc()`, so Yjs
      generates the actor ID independently per document.
- [x] Operation-log tests prove that a spoofed client actor field cannot change the
      authenticated `deviceId` audit attribution. `packages/worker/src/tests/room/sync.test.ts`
      sends a sync update carrying `actor: 'spoofed-audit-device'` and asserts the persisted
      `op_log` row records the authenticated `deviceId` from Hello, not the spoofed field.
- [x] Provider-loss recovery tests cover absent/present/unavailable probes, first epochs,
      meta/file loss, fresh Yjs actors, restart recovery, remote+local+pending convergence,
      duplicate idempotency, malformed/dependency-missing rows, 404 new documents, and 409
      rebuild. Recovery persists `recovering` before import and atomically commits candidate
      YDoc, cursor, exact outbox completions, and `ready` epoch after provider persistence.
      (`packages/obsidian-plugin/src/recovery/epoch*.test.ts`.)
- [x] Real Obsidian process-restart coverage. The `:app` E2E identifies the running
      Obsidian root process via Linux `/proc`, SIGTERMs and relaunches it mid-edit
      (`restartObsidianProcess` in the miniflare smoke harness), then drives epoch recovery
      through both the sync-request and need-full-snapshot paths. Green on 2026-07-16 across
      six consecutive runs (see [implementation-status.md](../implementation-status.md)).

DR-007 is closed. The checked-in unit crash tests use fake-indexeddb for the y-indexeddb
provider and local-store transactions; the real-process crash-boundary is covered by the
manually-run `:app` E2E above rather than automated CI, consistent with the other real
Obsidian acceptance gates. This section is scoped to DR-007; DR-009 and DR-012 are closed
under their own sections.

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

### DR-009: Unify completion, quarantine, and public errors — closed

The protocol specifies one `ApiError` shape, while runtime routes commonly return ad hoc `{ error: string }` bodies.
The WebSocket quarantine path intentionally sends no acknowledgement or quarantine evidence.
Oversized live updates are the explicit exception: they send one guarded rejection frame before the existing close, and the client matches that evidence locally. The client specification still polls the quarantine admin endpoint for quarantined updates.

Recommended contract:

- Every public HTTP failure uses the guarded `ApiError` envelope.
- WebSocket update rejection returns a guarded control message containing `messageId`, `docId`, `updateSha256`, a stable reason code, and whether retry can help.
- Quarantine evidence is not completion evidence and cannot mark an outbox item done.
- A matching quarantine message may pause the item immediately; polling remains a recovery fallback.
- Logs and UI never include update bytes, bearer tokens, refresh tokens, or setup tokens.

Acceptance evidence:

- [x] Contract tests cover every public route and WebSocket rejection. A mechanical test
      enumerates the composed Hono route table and asserts that every registered route returns
      the `ApiError` envelope on any 4xx/5xx (`packages/worker/src/tests/routes.test.ts`,
      "every registered public HTTP route emits the ApiError envelope"); it also guards against
      a future handler regressing to an ad hoc body. WebSocket rejection is covered for every
      reason code (`hash-mismatch`, `yjs-apply-failed`, `meta-schema-invalid`,
      `large-update-requires-snapshot-import`, `metadata-read-only`) in the room sync,
      quarantine, and auth tests. This enumeration surfaced and fixed a real gap: the public
      `POST /setup/exchange`, `POST /auth/refresh`, and `GET /ws/:vaultId` routes previously
      returned the raw validator issue list (not the envelope) on request-validation failure,
      because they reach the validator before any auth middleware; they now map validation
      failure to `request/invalid`.
- [x] Oversized live updates emit exactly one guarded rejection frame followed by the
      existing close, and matching client evidence is persisted atomically
      (`packages/worker/src/tests/room/sync.test.ts` asserts one `sync-update-rejected` frame
      then close 1011; the client persists the matching outbox pause atomically).
- [x] Unknown error codes fail closed and are not retried automatically: the client uses a
      retryable allowlist and defaults any unrecognized `ApiError.code`/HTTP status to a
      permanent, non-retried failure.
- [x] One malformed update causes one durable quarantine record and one stable client
      repair entry without an infinite retry loop (`packages/worker/src/tests/room/quarantine.test.ts`;
      the client pauses the item with `resumeOn: 'manual'` and dedupes the repair-log entry by
      stable id).

DR-009 is closed. Every public HTTP failure uses the guarded `ApiError` envelope
(structurally, via the shared `apiErrorBody` helper used by every handler and validator
hook, and by test enumeration of the whole route surface). Quarantine/rejection evidence
pauses the exact outbox item but never marks it done; quarantine-admin polling remains a
recovery fallback. Secret redaction keeps update bytes and bearer/refresh/setup tokens out
of logs and UI.

### DR-010: Zero-byte binary files are representable — closed

The manifest schema already permitted `size = 0` with `chunks = []`. The `BinaryMetaFile`
schema required at least one chunk, so both contracts could not hold for an empty
attachment, and the Obsidian plugin silently skipped uploading empty binary files to
work around the contradiction.

Implemented contract:

- `blobChunks: []` is valid on both the flat v1 (`BinaryMetaFileSpecificSchema`) and
  grouped v2 (`BinaryMetaContentSchema`) binary schemas in `packages/core/src/sync/meta.ts`;
  `blobManifestHash` remains mandatory as content evidence.
- No zero-length chunk is manufactured to satisfy the schema; a chunkless meta entry is
  only valid when it matches a manifest with `size = 0` and `chunks = []`.
- The plugin no longer skips empty binary file uploads.

Acceptance evidence:

- [x] `packages/core/src/sync/messages.test.ts` ("validates binary meta files") asserts
      `isMetaFile({ ...entry, blobChunks: [] }, fileId)` is now valid.
- [x] `packages/core/src/sync/manifest.test.ts` ("empty-file manifests match binary meta
      entries with no chunks") proves `blobManifestMatchesMetaFile` accepts a chunkless meta
      entry against the chunkless manifest that `buildBlobManifest` produces for zero bytes
      ("buildBlobManifest handles empty files").
- [x] That same match function gates both the upload dedup check
      (`packages/obsidian-plugin/src/main/file-tree.ts`, `enqueueBinaryUploadFromVaultFile`)
      and the delete-vs-edit binary-restore evidence check
      (`packages/obsidian-plugin/src/main/plugin.ts`), so upload and restore share one
      invariant check.
- [x] The pre-existing `packages/core/src/outbox.test.ts` test "binary plan builders
      support zero chunk manifests without hidden dependencies" shows the upload and
      download/materialize outbox plan builders were already chunk-count-agnostic; only the
      meta schema and the plugin's manual skip blocked an empty file from reaching that
      machinery.
- [x] The plugin's silent skip of empty binary uploads is removed
      (`packages/obsidian-plugin/src/main/file-tree.ts`).

This evidence is at the schema/invariant/plan-builder unit level plus removal of the
workaround; no dedicated end-to-end test drives an actual empty-file
upload-download-materialize-delete-restore round trip through the worker or the Obsidian
e2e harness. Every exercised code path is chunk-count-agnostic, so a zero-chunk manifest
runs the same logic as any other chunk count.

### DR-011: Make invalid-path repair portable and deterministic — closed

The data model deferred Windows reserved names, trailing spaces or periods, and
path-length limits to OS-specific materialization. If each device chose a different
repair name, watcher feedback could make the shared path oscillate.

Implemented contract:

- `portablePath()` (`packages/core/src/sync/meta.ts`) is a pure function with no OS
  branch, covering Windows reserved device names, control/forbidden characters, trailing
  spaces or periods, and a 255-byte segment ceiling shared by ext4/NTFS/APFS component
  name limits. Every client evaluates the identical rule set.
- `planPortablePathRepairs()` (`packages/core/src/sync/reconcile.ts`) plans repairs the
  same way `planPathConflictRepairs` does. The Obsidian reconcile pass
  (`packages/obsidian-plugin/src/sync/meta/reconcile.ts`) applies portable-path repairs
  first, then re-runs path-conflict planning over the sanitized paths, so any collision
  the sanitizer introduces converges through the existing conflict-suffix mechanism.
  Repair-log entries reuse the existing path-conflict retry/resolve actions
  (`packages/obsidian-plugin/src/sync/obsidian/repair-actions.ts`,
  `packages/obsidian-plugin/src/editor/settings-tab.ts`) instead of a new independent one.

Acceptance evidence:

- [x] `packages/core/src/sync/meta.test.ts` covers reserved names, control/forbidden
      characters, trailing space/dot, and 255-byte truncation, and proves
      `portablePath(portablePath(path).path).path === portablePath(path).path` for every
      vector ("portablePath is idempotent: re-sanitizing an already-sanitized path is a
      no-op").
- [x] `packages/core/src/sync/reconcile.test.ts` ("planPortablePathRepairs renames a
      Windows reserved device name", "planPortablePathRepairs ignores deleted entries and
      already-portable paths") and `packages/obsidian-plugin/src/sync/meta/reconcile.test.ts`
      ("reconcileMetaDoc sanitizes a Windows reserved device name and is a no-op on rescan",
      "reconcileMetaDoc resolves a portable-path collision through the existing path-conflict
      repair") prove a sanitized alias is stable on rescan and that a collision introduced by
      sanitization converges through the existing conflict-suffix mechanism.
- [x] Because `portablePath` is one deterministic function with no OS-specific branch
      that every client evaluates identically, "Linux, macOS, and Windows adapters produce
      the same portable alias for the shared vectors" holds by construction rather than by
      separately exercising three OS adapters.

The recommended contract's OS-only local conflict copy for restrictions that still
cannot be expressed portably (kept out of shared meta state) is not implemented; the
common vectors above are handled entirely by the shared sanitizer, and no residual
OS-only fallback exists. This gap is outside the stated acceptance evidence and does not
block this closure, but it remains future work if a restriction is found that
`portablePath` cannot express deterministically.

### DR-012: Specify capability negotiation independently of protocol version — closed

`ClientCapabilitySchema` was a closed union.
Adding a capability made older guards reject the entire hello if the new value was sent, even when the capability was optional.

Implemented contract:

- `ClientHello.capabilities` is validated as opaque, format-guarded tokens rather than a closed union, so an unrecognized optional capability no longer fails hello admission.
- `decideClientCapabilityNegotiation` (`packages/core/src/sync/messages.ts`) computes the known intersection; capability order and duplicates have no semantic effect.
- A hello is rejected only when it is missing a capability from the explicit required list (`REQUIRED_CLIENT_CAPABILITIES`, currently empty), closing with a stable `capability-required:<name>` reason distinct from the generic malformed-message close.
- The Worker's `metadata-schema-v2` write gate derives `metadataAccess` from the negotiated intersection instead of a raw advertised-list check.

Acceptance evidence:

- [x] A peer accepts a hello advertising an unrecognized optional capability (`packages/core/src/sync/messages.test.ts`; `packages/worker/src/runtime/vault-room.test.ts` "VaultRoom admits a hello advertising an unrecognized optional capability (DR-012)").
- [x] A hello missing a required capability is rejected with a stable `capability-required:<name>` close reason rather than a generic malformed-message close (`decideClientCapabilityNegotiation` unit tests in `packages/core/src/sync/messages.test.ts`; wired at the sole call site in `packages/worker/src/runtime/auth.ts`). No capability is currently mandatory, so this path is exercised by unit tests rather than live traffic.

## 5. Documentation and release gate

The main specifications should adopt a review item only after its decision and acceptance evidence are complete.
Until then, implementation status must link to the corresponding DR identifier instead of describing the property as implemented.

DR-001 through DR-012 are closed with the acceptance evidence recorded above. The
design-review gate is therefore complete, but it is not by itself a distribution
approval.

Before the first distributed release, repository automation must pass for the exact
release commit, including crash-injection models, package tests, type checking,
lint/format checks, builds, distribution contracts, and release artifact checks.
This is automated evidence only. The separate human-owned gates are public GitHub
and npm configuration, production Cloudflare/canary setup, and Windows plus real
multi-device validation. The authoritative checklist is
[distribution-pipeline.md](../plans/distribution-pipeline.md#human-owned-release-gates).
