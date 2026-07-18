import type { OutboxRunningLease } from '@kuroflare/core'
import * as v from 'valibot'
import { assert, describe, test } from 'vitest'
import * as Y from 'yjs'

import { isLocalStoreOutboxRecord } from '../main/guards'
import type { LocalStoreOutboxRecord } from '../sync/store/store'
import { createReadyDocumentEpoch, documentEpochMetadataKey } from './epoch'
import { commitDocumentRecoveryTransaction, type DocumentRecoveryCommitInput } from './epoch-repair'

type StoredValue = unknown

const fakeIdbRequest = v.custom<IDBRequest<unknown>>((v) => typeof v === 'object' && v !== null)
const fakeIdbRequestArray = v.custom<IDBRequest<unknown[]>>(
  (v) => typeof v === 'object' && v !== null,
)
const fakeIdbRequestUndef = v.custom<IDBRequest<undefined>>(
  (v) => typeof v === 'object' && v !== null,
)
const fakeIdbTransaction = v.custom<IDBTransaction>((v) => typeof v === 'object' && v !== null)
const fakeIdbDatabase = v.custom<IDBDatabase>((v) => typeof v === 'object' && v !== null)
const fakeRecord = v.custom<Record<string, unknown>>((v) => typeof v === 'object' && v !== null)

class FakeRequest<Result> {
  result: Result
  onsuccess: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(result: Result) {
    this.result = result
    queueMicrotask(() => this.onsuccess?.())
  }
}

class FakeTransaction {
  readonly writes: Array<() => void> = []
  oncomplete: (() => void) | null = null
  onabort: (() => void) | null = null
  onerror: (() => void) | null = null
  aborted = false

  constructor(private readonly database: FakeDatabase) {
    setTimeout(() => {
      if (this.aborted) return
      if (database.crashNextTransaction) {
        database.crashNextTransaction = false
        this.aborted = true
        this.onabort?.()
        return
      }
      for (const write of this.writes) write()
      this.oncomplete?.()
    }, 0)
  }

  objectStore(name: string): FakeObjectStore {
    return new FakeObjectStore(this.database, this, name)
  }

  abort(): void {
    this.aborted = true
    this.onabort?.()
  }
}

class FakeObjectStore {
  constructor(
    private readonly database: FakeDatabase,
    private readonly transaction: FakeTransaction,
    private readonly name: string,
  ) {}

  get(key: string): IDBRequest<unknown> {
    if (this.database.shouldMutateOnRead(this.name, key)) {
      this.database.mutateOnRead(this.name, key)
    }
    const value = cloneValue(this.database.read(this.name, key))
    const request = new FakeRequest(value)
    return v.parse(fakeIdbRequest, request)
  }

  getAll(): IDBRequest<unknown[]> {
    return v.parse(
      fakeIdbRequestArray,
      new FakeRequest(this.database.readAll(this.name).map(cloneValue)),
    )
  }

  put(value: unknown, key: string): IDBRequest<unknown> {
    this.transaction.writes.push(() => this.database.write(this.name, key, cloneValue(value)))
    return v.parse(fakeIdbRequest, new FakeRequest(key))
  }

  delete(key: string): IDBRequest<undefined> {
    this.transaction.writes.push(() => this.database.delete(this.name, key))
    return v.parse(fakeIdbRequestUndef, new FakeRequest(undefined))
  }
}

class FakeDatabase {
  crashNextTransaction = false
  mutateReadKey: { readonly store: string; readonly key: string } | null = null
  private readonly stores = new Map<string, Map<string, StoredValue>>()

  constructor() {
    for (const name of [
      'metadata',
      'meta-ydoc',
      'file-ydocs',
      'remote-cursors',
      'outbox',
      'running-leases',
    ]) {
      this.stores.set(name, new Map())
    }
  }

  transaction(): IDBTransaction {
    return v.parse(fakeIdbTransaction, new FakeTransaction(this))
  }

  read(store: string, key: string): StoredValue {
    return this.stores.get(store)?.get(key)
  }

  readAll(store: string): StoredValue[] {
    return [...(this.stores.get(store)?.values() ?? [])]
  }

  write(store: string, key: string, value: StoredValue): void {
    this.stores.get(store)?.set(key, value)
  }

  delete(store: string, key: string): void {
    this.stores.get(store)?.delete(key)
  }

  mutateOnRead(store: string, key: string): void {
    if (this.mutateReadKey?.store !== store || this.mutateReadKey.key !== key) return
    this.mutateReadKey = null
    const current = this.stores.get(store)?.get(key)
    if (typeof current !== 'object' || current === null) return
    this.stores.get(store)?.set(key, {
      ...v.parse(fakeRecord, current),
      status: 'paused',
    })
  }

  shouldMutateOnRead(store: string, key: string): boolean {
    return this.mutateReadKey?.store === store && this.mutateReadKey.key === key
  }
}

function cloneValue<T>(value: T): T {
  return value === undefined ? value : structuredClone(value)
}

function createInput(database: FakeDatabase): DocumentRecoveryCommitInput {
  const docId = { kind: 'meta' } as const
  const source = new Y.Doc()
  source.getText('text').insert(0, 'recovered')
  const updateBytes = Y.encodeStateAsUpdate(source)
  source.destroy()
  const row = {
    id: 'outbox-1',
    kind: 'y-update',
    status: 'pending',
    dependsOn: [],
    nextAttemptAt: undefined,
    docId,
    updateBytesBase64: 'AQI=',
  }
  const typedRow = v.parse(v.custom<LocalStoreOutboxRecord>(isLocalStoreOutboxRecord), row)
  const lease: OutboxRunningLease = {
    itemId: typedRow.id,
    kind: 'y-update',
    ownerId: 'device-1',
    leaseExpiresAt: 100,
  }
  database.write('outbox', typedRow.id, typedRow)
  database.write('running-leases', typedRow.id, lease)
  return {
    db: v.parse(fakeIdbDatabase, database),
    docId,
    updateBytes,
    snapshotSeq: 7,
    epoch: createReadyDocumentEpoch({
      docId,
      providerDbName: 'kuroflare-meta:test',
      now: 2,
      epochId: 'ready-epoch',
    }),
    includedOutboxIds: [typedRow.id],
    leaseRows: [lease],
    outboxRecords: [typedRow],
  }
}

describe('document recovery IndexedDB commit', () => {
  test('crash before transaction completion leaves all stores untouched and restart commits once', async () => {
    const database = new FakeDatabase()
    const input = createInput(database)
    database.crashNextTransaction = true
    await expectFailure(commitDocumentRecoveryTransaction(input), 'transaction aborted')
    assert.equal(database.read('metadata', documentEpochMetadataKey(input.docId)), undefined)
    assert.equal(
      v.parse(
        v.custom<LocalStoreOutboxRecord>(isLocalStoreOutboxRecord),
        database.read('outbox', 'outbox-1'),
      ).status,
      'pending',
    )
    assert.notEqual(database.read('running-leases', 'outbox-1'), undefined)

    await commitDocumentRecoveryTransaction(input)
    assert.equal(
      v.parse(
        v.object({ status: v.string() }),
        database.read('metadata', documentEpochMetadataKey(input.docId)),
      ).status,
      'ready',
    )
    assert.equal(
      v.parse(
        v.custom<LocalStoreOutboxRecord>(isLocalStoreOutboxRecord),
        database.read('outbox', 'outbox-1'),
      ).status,
      'done',
    )
    assert.equal(database.read('running-leases', 'outbox-1'), undefined)
    assert.notEqual(database.read('meta-ydoc', 'meta'), undefined)
    assert.notEqual(database.read('remote-cursors', 'meta'), undefined)
  })

  test('CAS rejects a row changed after the evidence read', async () => {
    const database = new FakeDatabase()
    const input = createInput(database)
    database.mutateReadKey = { store: 'outbox', key: 'outbox-1' }
    await expectFailure(
      commitDocumentRecoveryTransaction(input),
      'document-recovery-outbox-cas-mismatch',
    )
    assert.equal(database.read('metadata', documentEpochMetadataKey(input.docId)), undefined)
  })
})

async function expectFailure(operation: Promise<unknown>, message: string): Promise<void> {
  try {
    await operation
  } catch (error: unknown) {
    assert.equal(error instanceof Error ? error.message.includes(message) : false, true)
    return
  }
  throw new Error(`expected failure containing ${message}`)
}
