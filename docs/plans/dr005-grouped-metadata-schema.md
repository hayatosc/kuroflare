# DR-005 Grouped Metadata Schema Plan

## Decision

- Metadata schema version 2 stores each root `fileId` value as one nested `Y.Map`.
- The nested map contains four independently mergeable keys: `identity`, `location`, `content`, and `deletion`.
- Each group value is an atomic plain object so fields with joint invariants cannot merge independently.
- Legacy version 1 flat entries are readable only for one-way migration. They are never writable after the rollout.
- Clients that do not advertise metadata schema version 2 remain connected and may read and sync file YDocs, but metadata writes are rejected before mutation.
- Capability negotiation is narrowly scoped to metadata write admission. General capability negotiation remains DR-012.

## Version 2 groups

- `identity`: schema version 2, file ID, file type, optional text YDoc ID, creation timestamp, and creator. This group is immutable after creation.
- `location`: path, canonical path, update timestamp, updater, and legacy `mtime`. Keeping `mtime` makes migration lossless; removing it is a later cleanup.
- `content`: content update timestamp and updater, plus the binary manifest hash and chunk hashes for binary files.
- `deletion`: deleted flag and optional deletion timestamp and actor.

`deletedContentVersion` is intentionally absent until DR-006 defines causal deletion evidence.

## Admission and compatibility

1. Add a `metadata-schema-v2` client capability and a `read-only | read-write` metadata access result to hello acceptance.
2. Persist metadata access in the WebSocket session. Missing capability means read-only.
3. Reject metadata WebSocket updates from read-only sessions before hydration, Yjs apply, acknowledgement, broadcast, SQL, or R2 mutation. Return stable evidence when the client understands it; the close reason remains stable for older clients.
4. Require explicit schema version 2 evidence on authenticated metadata snapshot imports. File snapshot imports are unchanged.
5. If an older server rejects the new capability as an invalid control message, retry once without the capability and remain metadata read-only when the accepted response omits metadata access.
6. Unsupported grouped values are read-only evidence, not corrupt values, and cannot be offered to invalid-metadata discard actions.

## Schema and migration

1. Add strict group schemas and a decoder that returns `supported-v2`, `legacy-v1`, `unsupported`, or `invalid` disposition.
2. Keep a normalized `MetaFile` view for downstream planning while all mutations go through grouped-map helpers.
3. Build the grouped migration in one Yjs transaction, then publish it only through a latest-sequence snapshot-import CAS. Rebuild every stale retry from the newly fetched authoritative snapshot.
4. Reject mixed, unsupported, or invalid documents for writing. Empty and fully version 2 documents are writable.
5. Validate identity immutability by comparing the current and candidate metadata documents before accepting live updates or snapshot imports.
6. Reject version 1 to version 2 root replacement on the live WebSocket path. Only the snapshot-import CAS may perform the one-way root migration.
7. If a non-empty remote v2 snapshot cannot represent every local entry, preserve the local IndexedDB/Yjs state, downgrade metadata to read-only, and surface an explicit manual-repair notice. Invalid values are logged for inspection; they are discardable only with negotiated write access and the exact confirmation phrase. Once every invalid value is resolved and the document becomes writable, synchronize the repaired metadata state in full.

## Production cutover

1. Replace create, rename, delete, binary publication, reconciliation, and manual repair root replacements with group-specific mutations.
2. Replace production readers in startup, path lookup, materialization, binary restore, repair, and snapshot paths with the normalized decoder.
3. Gate local metadata side effects and metadata outbox sends on negotiated read-write access and a fully grouped local document.
4. Update Worker live-update, import, rollback, and snapshot-health validation for grouped version 2 documents.
5. Update smoke fixtures and E2E helpers so no production or test writer silently emits flat version 1 entries.
6. Pause persisted flat-version 1 metadata outbox rows with an actionable migration reason while leaving file-YDoc and blob-transfer work available.

## Acceptance evidence

- Concurrent rename and binary publication preserve both the new location and new content.
- Concurrent rename and delete preserve the location group and converge on the documented tombstone state.
- Identity mutation, mixed representation, invalid group invariants, and detached nested maps fail closed.
- Version 1 migration preserves every existing field and produces a fully version 2 document in one transaction.
- Two imports using the same sequence cannot both commit; the stale client refetches before rebuilding its migration candidate.
- A legacy client cannot mutate metadata, acknowledge a metadata write, or cause SQL/R2/broadcast changes, while read and file-YDoc sync remain available.
- A new client can fall back to an older server once without enabling metadata writes.
- Bootstrap, reconnect, join adoption, remote text/binary materialization, repair, snapshot import, rollback, and health verification use grouped entries.

## Rollout constraint

The admission gate, client migration, grouped writers, and server validators must ship in the same release. Shipping only one side creates either a metadata outage or a dual-writer window where a legacy root replacement can erase grouped state.

## Out of scope

- DR-006 causal delete-versus-edit evidence.
- General required/optional capability intersection from DR-012.
- Removal of the legacy `mtime` field.
- Physical tombstone deletion and retention policy changes.
