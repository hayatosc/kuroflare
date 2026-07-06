import { assert } from 'vitest'

export type UpdateId = string
export type MessageId = string
export type SnapshotKey = string
export type RunId = string

type CheckpointStatus = 'writing' | 'r2-written' | 'pointer-updated' | 'compacted'
type OpStatus = 'active' | 'compacted'

interface OpLogEntry {
  readonly seq: number
  readonly updateId: UpdateId
  readonly messageId: MessageId
  status: OpStatus
}

interface CheckpointRun {
  readonly runId: RunId
  readonly upperSeq: number
  readonly content: ReadonlySet<UpdateId>
  status: CheckpointStatus
  snapshotKey: SnapshotKey | null
}

interface ModelSnapshot {
  readonly key: SnapshotKey
  readonly upperSeq: number
  readonly content: ReadonlySet<UpdateId>
  healthy: boolean
}

export interface ModelState {
  readonly ackedValid: Set<UpdateId>
  readonly seenMessages: Set<MessageId>
  readonly quarantined: Set<UpdateId>
  readonly opLog: OpLogEntry[]
  readonly checkpointRuns: CheckpointRun[]
  readonly r2Snapshots: Map<SnapshotKey, ModelSnapshot>
  pointer: SnapshotKey
  nextSeq: number
  nextUpdate: number
  nextMessage: number
  nextRun: number
  nextSnapshot: number
}

interface AppendValidResult {
  readonly updateId: UpdateId
  readonly messageId: MessageId
}

interface AppendInvalidResult {
  readonly updateId: UpdateId
  readonly messageId: MessageId
}

export interface DuplicateReplayResult {
  readonly replayed: boolean
}

export interface RestoredContent {
  readonly snapshotKey: SnapshotKey
  readonly updates: ReadonlySet<UpdateId>
}

const RETAIN_SNAPSHOT_COUNT = 3

/** Creates an empty model with an initial empty R2 snapshot pointer. */
export function createModelState(): ModelState {
  const initialKey = snapshotKey(0)
  const initialSnapshot: ModelSnapshot = {
    key: initialKey,
    upperSeq: 0,
    content: new Set<UpdateId>(),
    healthy: true,
  }

  return {
    ackedValid: new Set<UpdateId>(),
    seenMessages: new Set<MessageId>(),
    quarantined: new Set<UpdateId>(),
    opLog: [],
    checkpointRuns: [],
    r2Snapshots: new Map<SnapshotKey, ModelSnapshot>([[initialKey, initialSnapshot]]),
    pointer: initialKey,
    nextSeq: 1,
    nextUpdate: 1,
    nextMessage: 1,
    nextRun: 1,
    nextSnapshot: 1,
  }
}

/** Appends a valid update and records it as durably acknowledged. */
export function appendValidUpdate(state: ModelState): AppendValidResult {
  const updateId = updateIdOf(state.nextUpdate)
  const messageId = messageIdOf(state.nextMessage)
  state.nextUpdate += 1
  state.nextMessage += 1

  appendValidUpdateWithMessage(state, updateId, messageId)
  return { updateId, messageId }
}

/** Replays a message. Duplicate message IDs must not advance the model twice. */
export function appendValidUpdateWithMessage(
  state: ModelState,
  updateId: UpdateId,
  messageId: MessageId,
): void {
  if (state.seenMessages.has(messageId)) {
    return
  }

  state.seenMessages.add(messageId)
  state.ackedValid.add(updateId)
  state.opLog.push({
    seq: state.nextSeq,
    updateId,
    messageId,
    status: 'active',
  })
  state.nextSeq += 1
}

/** Replays a compacted duplicate after short-lived message dedup has expired. */
export function replayCompactedDuplicateWithoutDedup(
  state: ModelState,
  updateId: UpdateId,
  messageId: MessageId,
): DuplicateReplayResult {
  const originalEntry = state.opLog.find(
    (entry) => entry.updateId === updateId && entry.messageId === messageId,
  )
  if (!originalEntry || originalEntry.status !== 'compacted') {
    return { replayed: false }
  }

  state.seenMessages.delete(messageId)
  appendValidUpdateWithMessage(state, updateId, messageId)
  return { replayed: true }
}

/** Quarantines an invalid update without adding it to snapshots or op_log. */
export function appendInvalidUpdate(state: ModelState): AppendInvalidResult {
  const updateId = updateIdOf(state.nextUpdate)
  const messageId = messageIdOf(state.nextMessage)
  state.nextUpdate += 1
  state.nextMessage += 1

  if (!state.seenMessages.has(messageId)) {
    state.seenMessages.add(messageId)
    state.quarantined.add(updateId)
  }

  return { updateId, messageId }
}

/** Starts a checkpoint run over the current pointer plus active residual ops. */
export function startCheckpoint(state: ModelState): RunId | null {
  const activeEntries = state.opLog.filter((entry) => entry.status === 'active')
  if (activeEntries.length === 0) {
    return null
  }

  const upperSeq = activeEntries[activeEntries.length - 1]?.seq
  if (upperSeq === undefined) {
    return null
  }

  const runId = runIdOf(state.nextRun)
  state.nextRun += 1
  state.checkpointRuns.push({
    runId,
    upperSeq,
    content: new Set(restoreCurrent(state).updates),
    status: 'writing',
    snapshotKey: null,
  })

  return runId
}

/** Writes a checkpoint snapshot to R2 without changing the active pointer yet. */
export function writeCheckpointSnapshot(state: ModelState, runId: RunId): void {
  const run = findRun(state, runId)
  if (!run || run.status !== 'writing') {
    return
  }

  const key = snapshotKey(state.nextSnapshot)
  state.nextSnapshot += 1
  state.r2Snapshots.set(key, {
    key,
    upperSeq: run.upperSeq,
    content: new Set(run.content),
    healthy: true,
  })
  run.snapshotKey = key
  run.status = 'r2-written'
}

/** Advances the snapshot pointer only after the checkpoint snapshot exists. */
export function updateCheckpointPointer(state: ModelState, runId: RunId): void {
  const run = findRun(state, runId)
  if (!run || run.status !== 'r2-written' || !run.snapshotKey) {
    return
  }

  const nextSnapshot = state.r2Snapshots.get(run.snapshotKey)
  assert(nextSnapshot)
  const currentSnapshot = state.r2Snapshots.get(state.pointer)
  assert(currentSnapshot)
  if (nextSnapshot.upperSeq < currentSnapshot.upperSeq) {
    return
  }

  state.pointer = run.snapshotKey
  run.status = 'pointer-updated'
}

/** Compacts op_log rows only after their checkpoint pointer is durable. */
export function compactCheckpoint(state: ModelState, runId: RunId): void {
  const run = findRun(state, runId)
  if (!run || run.status !== 'pointer-updated') {
    return
  }

  for (const entry of state.opLog) {
    if (entry.seq <= run.upperSeq) {
      entry.status = 'compacted'
    }
  }
  run.status = 'compacted'
  retainRecentSnapshots(state)
}

/** Models a large update path that writes a direct snapshot before pointer change. */
export function appendLargeUpdateViaDirectSnapshot(state: ModelState): AppendValidResult {
  const result = appendValidUpdate(state)
  const runId = startCheckpoint(state)
  if (runId) {
    writeCheckpointSnapshot(state, runId)
    updateCheckpointPointer(state, runId)
    compactCheckpoint(state, runId)
  }
  return result
}

/** Rebuilds volatile DO state from the current pointer and residual op_log. */
export function coldStart(state: ModelState): RestoredContent {
  return restoreFromPointerOrFallback(state, state.pointer)
}

/** Rebuilds after a stale pointer read by falling back to prefix-listed snapshots. */
export function coldStartWithStalePointerRead(state: ModelState): RestoredContent {
  const staleSnapshot = chooseOldestHealthySnapshot(state)
  return restoreFromPointerOrFallback(state, staleSnapshot.key)
}

/** Marks the current pointer snapshot corrupt to exercise retention fallback. */
export function corruptCurrentPointerSnapshot(state: ModelState): void {
  const snapshot = state.r2Snapshots.get(state.pointer)
  const healthySnapshotCount = [...state.r2Snapshots.values()].filter(
    (candidate) => candidate.healthy,
  ).length
  if (snapshot && snapshot.upperSeq > 0 && healthySnapshotCount > 1) {
    snapshot.healthy = false
  }
}

/** Restores from each retained snapshot and checks it remains internally valid. */
export function assertRetentionRollbackIsValid(state: ModelState): void {
  for (const snapshot of state.r2Snapshots.values()) {
    if (!snapshot.healthy) {
      continue
    }
    assertNoQuarantinedUpdates(snapshot.content, state.quarantined)
    assertSubset(snapshot.content, state.ackedValid)
  }
}

/** Verifies every model invariant that must hold after any crash boundary. */
export function assertModelInvariants(state: ModelState): void {
  const restored = coldStart(state)
  assertSetEquals(restored.updates, state.ackedValid, 'current restore lost acked update')
  assertNoQuarantinedUpdates(restored.updates, state.quarantined)
  assertRetentionRollbackIsValid(state)

  for (const run of state.checkpointRuns) {
    if (run.status === 'r2-written' || run.status === 'pointer-updated') {
      assert(run.snapshotKey, 'checkpoint run advanced without snapshot key')
      assert(state.r2Snapshots.has(run.snapshotKey), 'checkpoint run points at missing R2 snapshot')
    }
  }
}

function restoreCurrent(state: ModelState): RestoredContent {
  return restoreFromPointerOrFallback(state, state.pointer)
}

function restoreFromPointerOrFallback(
  state: ModelState,
  pointerSnapshotKey: SnapshotKey,
): RestoredContent {
  const snapshot = chooseLatestHealthySnapshot(state, pointerSnapshotKey)

  const updates = new Set(snapshot.content)
  for (const entry of state.opLog) {
    if (entry.seq > snapshot.upperSeq) {
      updates.add(entry.updateId)
    }
  }

  return { snapshotKey: snapshot.key, updates }
}

function chooseLatestHealthySnapshot(
  state: ModelState,
  pointerSnapshotKey: SnapshotKey,
): ModelSnapshot {
  const pointerSnapshot = state.r2Snapshots.get(pointerSnapshotKey)
  const healthySnapshots = [...state.r2Snapshots.values()].filter((snapshot) => snapshot.healthy)
  assert(healthySnapshots.length > 0, 'no healthy snapshot retained')

  const prefixListedSnapshot = maxByUpperSeq(healthySnapshots)
  if (!pointerSnapshot?.healthy) {
    return prefixListedSnapshot
  }

  return pointerSnapshot.upperSeq >= prefixListedSnapshot.upperSeq
    ? pointerSnapshot
    : prefixListedSnapshot
}

function chooseOldestHealthySnapshot(state: ModelState): ModelSnapshot {
  const healthySnapshots = [...state.r2Snapshots.values()].filter((snapshot) => snapshot.healthy)
  assert(healthySnapshots.length > 0, 'no healthy snapshot retained')
  return minByUpperSeq(healthySnapshots)
}

function maxByUpperSeq(snapshots: readonly ModelSnapshot[]): ModelSnapshot {
  const first = snapshots[0]
  assert(first)
  return snapshots.reduce(
    (best, snapshot) => (snapshot.upperSeq > best.upperSeq ? snapshot : best),
    first,
  )
}

function minByUpperSeq(snapshots: readonly ModelSnapshot[]): ModelSnapshot {
  const first = snapshots[0]
  assert(first)
  return snapshots.reduce(
    (best, snapshot) => (snapshot.upperSeq < best.upperSeq ? snapshot : best),
    first,
  )
}

function retainRecentSnapshots(state: ModelState): void {
  const snapshots = [...state.r2Snapshots.values()].sort(
    (left, right) => right.upperSeq - left.upperSeq,
  )
  const retainedKeys = new Set<SnapshotKey>()

  for (const snapshot of snapshots.slice(0, RETAIN_SNAPSHOT_COUNT)) {
    retainedKeys.add(snapshot.key)
  }
  retainedKeys.add(state.pointer)

  const newestHealthySnapshot = snapshots.find((snapshot) => snapshot.healthy)
  if (newestHealthySnapshot) {
    retainedKeys.add(newestHealthySnapshot.key)
  }

  for (const run of state.checkpointRuns) {
    if (run.status !== 'compacted' && run.snapshotKey) {
      retainedKeys.add(run.snapshotKey)
    }
  }

  for (const key of state.r2Snapshots.keys()) {
    if (!retainedKeys.has(key)) {
      state.r2Snapshots.delete(key)
    }
  }
}

function findRun(state: ModelState, runId: RunId): CheckpointRun | null {
  return state.checkpointRuns.find((run) => run.runId === runId) ?? null
}

function assertSetEquals(
  actual: ReadonlySet<UpdateId>,
  expected: ReadonlySet<UpdateId>,
  message: string,
): void {
  assert.equal(actual.size, expected.size, message)
  for (const value of expected) {
    assert(actual.has(value), `${message}: missing ${value}`)
  }
}

function assertSubset(actual: ReadonlySet<UpdateId>, expected: ReadonlySet<UpdateId>): void {
  for (const value of actual) {
    assert(expected.has(value), `snapshot contains unacknowledged update: ${value}`)
  }
}

function assertNoQuarantinedUpdates(
  content: ReadonlySet<UpdateId>,
  quarantined: ReadonlySet<UpdateId>,
): void {
  for (const updateId of quarantined) {
    assert(!content.has(updateId), `quarantined update leaked into restore: ${updateId}`)
  }
}

function updateIdOf(value: number): UpdateId {
  return `u${value}`
}

function messageIdOf(value: number): MessageId {
  return `m${value}`
}

function snapshotKey(value: number): SnapshotKey {
  return `snap-${value}`
}

function runIdOf(value: number): RunId {
  return `run-${value}`
}
