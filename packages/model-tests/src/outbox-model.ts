import assert from 'node:assert/strict'

export type OutboxItemId = string
export type FileId = string
export type Sha256 = string

export type OutboxKind =
  | 'y-update'
  | 'blob-put'
  | 'manifest-put'
  | 'blob-get'
  | 'meta-ref-update'
  | 'materialize'

export type OutboxStatus = 'pending' | 'retrying' | 'done' | 'failed' | 'blocked'

export interface OutboxItem {
  readonly id: OutboxItemId
  readonly kind: OutboxKind
  readonly dependsOn: readonly OutboxItemId[]
  status: OutboxStatus
  retryCount: number
  readonly fileId?: FileId
  readonly sha256?: Sha256
}

export interface OutboxState {
  readonly items: Map<OutboxItemId, OutboxItem>
  readonly publishedMetaRefs: Set<FileId>
  readonly materializedFiles: Set<FileId>
  nextItem: number
  nextFile: number
  nextHash: number
}

export interface BinaryUploadPlan {
  readonly fileId: FileId
  readonly chunkPuts: readonly OutboxItemId[]
  readonly manifestPut: OutboxItemId
  readonly metaRefUpdate: OutboxItemId
}

export interface BinaryDownloadPlan {
  readonly fileId: FileId
  readonly chunkGets: readonly OutboxItemId[]
  readonly materialize: OutboxItemId
}

/** Creates an empty outbox model. */
export function createOutboxState(): OutboxState {
  return {
    items: new Map<OutboxItemId, OutboxItem>(),
    publishedMetaRefs: new Set<FileId>(),
    materializedFiles: new Set<FileId>(),
    nextItem: 1,
    nextFile: 1,
    nextHash: 1,
  }
}

/** Enqueues blob PUTs, manifest PUT, and the dependent meta reference update. */
export function enqueueBinaryUpload(state: OutboxState, chunkCount: number): BinaryUploadPlan {
  assert(chunkCount >= 0)
  const fileId = fileIdOf(state.nextFile)
  state.nextFile += 1

  const chunkPuts: OutboxItemId[] = []
  for (let index = 0; index < chunkCount; index += 1) {
    chunkPuts.push(
      addItem(state, {
        kind: 'blob-put',
        dependsOn: [],
        fileId,
        sha256: nextSha256(state),
      }),
    )
  }

  const manifestPut = addItem(state, {
    kind: 'manifest-put',
    dependsOn: chunkPuts,
    fileId,
    sha256: nextSha256(state),
  })
  const metaRefUpdate = addItem(state, {
    kind: 'meta-ref-update',
    dependsOn: [...chunkPuts, manifestPut],
    fileId,
  })

  return { fileId, chunkPuts, manifestPut, metaRefUpdate }
}

/** Enqueues blob GETs and the dependent materialize step. */
export function enqueueBinaryDownload(state: OutboxState, chunkCount: number): BinaryDownloadPlan {
  assert(chunkCount >= 0)
  const fileId = fileIdOf(state.nextFile)
  state.nextFile += 1

  const chunkGets: OutboxItemId[] = []
  for (let index = 0; index < chunkCount; index += 1) {
    chunkGets.push(
      addItem(state, {
        kind: 'blob-get',
        dependsOn: [],
        fileId,
        sha256: nextSha256(state),
      }),
    )
  }

  const materialize = addItem(state, {
    kind: 'materialize',
    dependsOn: chunkGets,
    fileId,
  })

  return { fileId, chunkGets, materialize }
}

/** Returns true when all dependencies are done and the item may run. */
export function canRun(state: OutboxState, id: OutboxItemId): boolean {
  const item = requireItem(state, id)
  return (
    (item.status === 'pending' || item.status === 'retrying') &&
    item.dependsOn.every((dependencyId) => requireItem(state, dependencyId).status === 'done')
  )
}

/** Marks an item successful if its dependencies are complete. */
export function completeItem(state: OutboxState, id: OutboxItemId): void {
  const item = requireItem(state, id)
  if (!canRun(state, id)) {
    return
  }

  item.status = 'done'
  if (item.kind === 'meta-ref-update') {
    assert(item.fileId)
    state.publishedMetaRefs.add(item.fileId)
  }
  if (item.kind === 'materialize') {
    assert(item.fileId)
    state.materializedFiles.add(item.fileId)
  }
}

/** Marks an item retrying without unblocking dependents. */
export function retryItem(state: OutboxState, id: OutboxItemId): void {
  const item = requireItem(state, id)
  if (item.status === 'pending' || item.status === 'retrying') {
    item.retryCount += 1
    item.status = 'retrying'
  }
}

/** Permanently fails an item and blocks all transitive dependents. */
export function failItem(state: OutboxState, id: OutboxItemId): void {
  const item = requireItem(state, id)
  if (item.status === 'done') {
    return
  }

  item.status = 'failed'
  blockDependents(state, id)
}

/** Asserts semantic ordering invariants for all currently visible side effects. */
export function assertOutboxInvariants(state: OutboxState): void {
  for (const item of state.items.values()) {
    for (const dependencyId of item.dependsOn) {
      assert(state.items.has(dependencyId), `missing dependency ${dependencyId}`)
    }

    if (item.status === 'done') {
      for (const dependencyId of item.dependsOn) {
        assert.equal(
          requireItem(state, dependencyId).status,
          'done',
          `${item.kind} completed before dependency ${dependencyId}`,
        )
      }
    }

    if (item.status === 'blocked') {
      assert(
        item.dependsOn.some((dependencyId) =>
          hasFailedAncestor(state, dependencyId, new Set<OutboxItemId>()),
        ),
        `${item.kind} blocked without failed dependency`,
      )
    }
  }

  for (const fileId of state.publishedMetaRefs) {
    const metaRef = [...state.items.values()].find(
      (item) => item.kind === 'meta-ref-update' && item.fileId === fileId && item.status === 'done',
    )
    assert(metaRef)
    assert(
      metaRef.dependsOn.every((dependencyId) => requireItem(state, dependencyId).status === 'done'),
      `published meta ref before blob dependencies for ${fileId}`,
    )
  }

  for (const fileId of state.materializedFiles) {
    const materialize = [...state.items.values()].find(
      (item) => item.kind === 'materialize' && item.fileId === fileId && item.status === 'done',
    )
    assert(materialize)
    assert(
      materialize.dependsOn.every(
        (dependencyId) => requireItem(state, dependencyId).status === 'done',
      ),
      `materialized before blob downloads for ${fileId}`,
    )
  }
}

function addItem(
  state: OutboxState,
  item: Omit<OutboxItem, 'id' | 'status' | 'retryCount'>,
): OutboxItemId {
  const id = itemIdOf(state.nextItem)
  state.nextItem += 1
  state.items.set(id, {
    ...item,
    id,
    status: 'pending',
    retryCount: 0,
  })
  return id
}

function blockDependents(state: OutboxState, failedId: OutboxItemId): void {
  for (const item of state.items.values()) {
    if (item.status !== 'done' && item.status !== 'failed' && item.dependsOn.includes(failedId)) {
      item.status = 'blocked'
      blockDependents(state, item.id)
    }
  }
}

function hasFailedAncestor(state: OutboxState, id: OutboxItemId, seen: Set<OutboxItemId>): boolean {
  if (seen.has(id)) {
    return false
  }
  seen.add(id)

  const item = requireItem(state, id)
  return (
    item.status === 'failed' ||
    item.dependsOn.some((dependencyId) => hasFailedAncestor(state, dependencyId, seen))
  )
}

function requireItem(state: OutboxState, id: OutboxItemId): OutboxItem {
  const item = state.items.get(id)
  assert(item, `missing item: ${id}`)
  return item
}

function nextSha256(state: OutboxState): Sha256 {
  const value = sha256Of(state.nextHash)
  state.nextHash += 1
  return value
}

function itemIdOf(value: number): OutboxItemId {
  return `item-${value}`
}

function fileIdOf(value: number): FileId {
  return `file-${value}`
}

function sha256Of(value: number): Sha256 {
  return value.toString(16).padStart(64, '0')
}
