# DR-003 Safe-Rejection Recovery Plan

## Decision

- Version 1 does not implement the transactional live snapshot escape for oversized updates.
- Oversized live updates remain unsupported on the WebSocket path and fail closed without acknowledgement or durable server mutation.
- The supported recovery action imports the exact paused local update through the authenticated snapshot route, then marks only that evidence-matched outbox item complete.
- The repair action preserves local content. Discard and fork workflows are outside this change because discard can lose data and fork requires a separate product contract.

## Recovery contract

1. Read the current paused `sync-update-rejected` outbox row from IndexedDB.
2. Require its item ID, document ID, message ID, update hash, rejection hash, and encoded update bytes to remain consistent.
3. Verify the encoded bytes against the recorded SHA-256 before sending them.
4. Fetch the latest server snapshot. For an existing document, pass its `manifestSeq` as `latestSeq`; for a missing document, import without `latestSeq`.
5. Import the rejected Yjs update through the authenticated snapshot route. A `409` conflict stops the attempt without changing the local row.
6. After a valid import response, commit one guarded IndexedDB patch that marks only the same paused row done and records the imported snapshot sequence.
7. If the process stops after the server import but before the local patch, retrying is safe: Yjs merge is idempotent, although it may create another immutable snapshot generation.

## Implementation steps

1. Add a pure completion decision and exact-evidence patch for one imported rejected update.
2. Carry that patch through the existing queue, local-store driver, and IndexedDB transaction pipeline.
3. Add an Obsidian repair adapter that lists paused rejected updates, verifies bytes, performs GET/PUT with optimistic sequence evidence, and commits the guarded local completion.
4. Add accessible settings controls to refresh and repair each rejected item, with explicit progress, success, conflict, and failure notices.
5. Cover pure decisions, store evidence guards, HTTP ordering/failure behavior, and settings presentation.
6. Update DR-003 and implementation-status documentation without claiming automatic large-update support or DR-009 closure.

## Acceptance evidence

- A successful repair imports the exact rejected update and completes only its matching outbox row.
- Hash mismatch, missing evidence, authentication failure, invalid response, and HTTP conflict leave the paused row unchanged.
- Two rejected updates for the same document are not completed together.
- Retrying after a server-success/local-commit interruption preserves content and can finish the local row.
- Existing ordinary updates and full-snapshot recovery behavior remain unchanged.

## Out of scope

- Transactional WebSocket acknowledgement for oversized updates.
- Automatic background recovery without an explicit user action.
- Discarding or forking rejected local content.
- Generalized DR-009 rejection evidence and capability negotiation.
