import assert from 'node:assert/strict'

import {
  CURRENT_PROTOCOL_VERSION,
  DEVICE_TOKEN_ISSUER,
  decodeBinaryFrame,
  encodeBinaryFrame,
  encodeBlobManifestJson,
  AckSchema,
  QuarantinedUpdateDetailResponseSchema,
  QuarantinedUpdateListResponseSchema,
  makeDeviceId,
  makeFileId,
  makeMessageId,
  makeSha256Hex,
  makeVaultId,
  makeYDocId,
  type Ack,
  type ClientHello,
  type DeviceTokenClaims,
  type DeviceTokenScope,
  type BlobManifest,
  type NeedFullSnapshot,
  type SyncRequest,
  type SyncUpdate,
} from '@kuroflare/core'
import * as v from 'valibot'
import { test } from 'vitest'
import * as Y from 'yjs'

import workerEntrypoint, {
  VaultRoom,
  type DurableObjectIdBinding,
  type DurableObjectSqlStorageBinding,
  type DurableObjectStateBinding,
  type DurableObjectStorageBinding,
  type DurableObjectStubBinding,
  type R2BucketBinding,
  type R2ListOptionsBinding,
  type R2ObjectBodyBinding,
  type R2ObjectsBinding,
  type RuntimeWebSocket,
  type WorkerEnv,
} from './runtime'

const TEST_DEVICE_TOKEN_SECRET = 'test-device-token-secret'

class FakeSocket implements RuntimeWebSocket {
  readonly sent: Array<string | ArrayBuffer> = []
  accepted = false
  closed = false
  closeCode: number | undefined
  closeReason: string | undefined
  private attachment: unknown

  accept(): void {
    this.accepted = true
  }

  send(message: string | ArrayBuffer): void {
    this.sent.push(message)
  }

  close(code?: number, reason?: string): void {
    this.closed = true
    this.closeCode = code
    this.closeReason = reason
  }

  serializeAttachment(attachment: unknown): void {
    this.attachment = attachment
  }

  deserializeAttachment(): unknown {
    return this.attachment
  }
}

class FakeWebSocketPair {
  readonly 0 = new FakeSocket()
  readonly 1 = new FakeSocket()
}

class FakeUpgradeResponse {
  readonly status: number
  readonly webSocket: RuntimeWebSocket | undefined

  constructor(_body: BodyInit | null, init?: ResponseInit & { webSocket?: RuntimeWebSocket }) {
    this.status = init?.status ?? 200
    this.webSocket = init?.webSocket
  }
}

class MemoryStorage implements DurableObjectStorageBinding {
  readonly alarms: Array<number | Date> = []
  private readonly values = new Map<string, unknown>()

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value)
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarms.push(scheduledTime)
  }
}

interface RecordedDocRow {
  readonly kind: string
  readonly latestSeq: number
  readonly latestSnapshotSeq: number
  readonly latestSnapshotKey: string | undefined
  readonly minRetainedSeq: number
  readonly horizonStateVector: Uint8Array | undefined
  readonly updatedAt: number
}

interface RecordedOpLogRow {
  readonly docId: string
  readonly seq: number
  readonly messageId: string
  readonly deviceId: string
  readonly yClientId: number
  readonly updateBytes: Uint8Array
  readonly updateSha256: string
  readonly createdAt: number
}

interface RecordedQuarantineRow {
  readonly id: string
  readonly docId: string
  readonly messageId: string
  readonly deviceId: string
  readonly reason: string
  readonly updateSha256: string
  readonly updateBytes: Uint8Array
  readonly createdAt: number
}

interface RecordedCheckpointRunRow {
  readonly runId: string
  readonly docId: string
  readonly upperSeq: number
  readonly snapshotKey: string
  readonly stateVector: Uint8Array
  readonly status: string
  readonly createdAt: number
  readonly r2WrittenAt: number | undefined
  readonly pointerUpdatedAt: number | undefined
  readonly compactedAt: number | undefined
}

interface RecordedDeviceRow {
  readonly deviceId: string
  readonly yClientId: number
  readonly tokenVersion: number
  readonly revokedAt: number | undefined
}

interface RecordedSetupTokenRow {
  readonly tokenHash: string
  readonly vaultId: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly consumedAt: number | undefined
}

interface RecordedRefreshTokenRow {
  readonly tokenHash: string
  readonly deviceId: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly revokedAt: number | undefined
}

interface RecordedMessageDedupRow {
  readonly docId: string
  readonly messageId: string
  readonly durableSeq: number
  readonly seenAt: number
}

class RecordingSqlStorage implements DurableObjectSqlStorageBinding {
  readonly docs = new Map<string, RecordedDocRow>()
  readonly opLog = new Map<string, RecordedOpLogRow>()
  readonly messageDedup = new Map<string, RecordedMessageDedupRow>()
  readonly quarantines = new Map<string, RecordedQuarantineRow>()
  readonly checkpointRuns = new Map<string, RecordedCheckpointRunRow>()
  readonly setupTokens = new Map<string, RecordedSetupTokenRow>()
  readonly refreshTokens = new Map<string, RecordedRefreshTokenRow>()
  readonly devices = new Map<string, RecordedDeviceRow>([
    [
      'device-1',
      {
        deviceId: 'device-1',
        yClientId: 1,
        tokenVersion: 1,
        revokedAt: undefined,
      },
    ],
  ])
  readonly migrationVersions = new Set<number>()
  readonly queries: string[] = []
  failOnQueryIncludes: string | undefined

  exec<T extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    ...bindings: readonly unknown[]
  ): Iterable<T> {
    const normalized = query.toLowerCase().replace(/"/g, '')
    this.queries.push(normalized)
    if (normalized === 'begin immediate' || normalized === 'commit' || normalized === 'rollback') {
      return []
    }
    if (this.failOnQueryIncludes !== undefined && normalized.includes(this.failOnQueryIncludes)) {
      throw new Error(`injected SQL failure: ${this.failOnQueryIncludes}`)
    }
    if (normalized.startsWith('create table') || normalized.startsWith('create index')) {
      return []
    }
    if (normalized.includes('from schema_migrations')) {
      return [...this.migrationVersions].map((version) => ({ version })) as Iterable<T>
    }
    if (normalized.includes('insert into schema_migrations')) {
      this.migrationVersions.add(expectNumber(bindings[0]))
      return []
    }
    if (normalized.includes('from setup_tokens')) {
      const tokenHash = expectString(bindings[0])
      const token = this.setupTokens.get(tokenHash)
      const rows =
        token === undefined
          ? []
          : [
              {
                vaultId: token.vaultId,
                issuedAt: token.issuedAt,
                expiresAt: token.expiresAt,
                consumedAt: token.consumedAt ?? null,
              },
            ]
      return rows as Iterable<T>
    }
    if (normalized.includes('from device_refresh_tokens')) {
      const tokenHash = expectString(bindings[0])
      const token = this.refreshTokens.get(tokenHash)
      const rows =
        token === undefined
          ? []
          : [
              {
                issuedAt: token.issuedAt,
                expiresAt: token.expiresAt,
                revokedAt: token.revokedAt,
              },
            ]
      return rows as Iterable<T>
    }
    if (normalized.includes('from devices')) {
      if (!normalized.includes('where device_id')) {
        return [...this.devices.values()].map((device) => ({
          yClientId: device.yClientId,
        })) as Iterable<T>
      }
      const deviceId = expectString(bindings[0])
      const device = this.devices.get(deviceId)
      const rows =
        device === undefined
          ? []
          : [
              {
                yClientId: device.yClientId,
                tokenVersion: device.tokenVersion,
                revokedAt: device.revokedAt,
              },
            ]
      return rows as Iterable<T>
    }
    if (normalized.includes('update setup_tokens')) {
      const consumedAt = expectNumber(bindings[0])
      const tokenHash = expectString(bindings[1])
      const existing = this.setupTokens.get(tokenHash)
      if (existing !== undefined) {
        this.setupTokens.set(tokenHash, { ...existing, consumedAt })
      }
      return []
    }
    if (normalized.includes('insert into setup_tokens')) {
      const tokenHash = expectString(bindings[0])
      this.setupTokens.set(tokenHash, {
        tokenHash,
        vaultId: expectString(bindings[1]),
        issuedAt: expectNumber(bindings[2]),
        expiresAt: expectNumber(bindings[3]),
        consumedAt: undefined,
      })
      return []
    }
    if (normalized.includes('insert into devices')) {
      const deviceId = expectString(bindings[0])
      const existing = this.devices.get(deviceId)
      this.devices.set(deviceId, {
        deviceId,
        yClientId: existing?.yClientId ?? expectNumber(bindings[1]),
        tokenVersion: existing?.tokenVersion ?? expectNumber(bindings[2]),
        revokedAt: existing?.revokedAt,
      })
      return []
    }
    if (normalized.includes('update devices')) {
      const tokenVersion = expectNumber(bindings[0])
      const revokedAt = expectNumber(bindings[1])
      const deviceId = expectString(bindings[3])
      const existing = this.devices.get(deviceId)
      if (existing !== undefined) {
        this.devices.set(deviceId, { ...existing, tokenVersion, revokedAt })
      }
      return []
    }
    if (normalized.includes('insert into device_refresh_tokens')) {
      const tokenHash = expectString(bindings[0])
      this.refreshTokens.set(tokenHash, {
        tokenHash,
        deviceId: expectString(bindings[1]),
        issuedAt: expectNumber(bindings[2]),
        expiresAt: expectNumber(bindings[3]),
        revokedAt: undefined,
      })
      return []
    }
    if (normalized.includes('update device_refresh_tokens')) {
      const revokedAt = expectNumber(bindings[0])
      const tokenHash = expectString(bindings[1])
      const existing = this.refreshTokens.get(tokenHash)
      if (existing !== undefined) {
        this.refreshTokens.set(tokenHash, { ...existing, revokedAt })
      }
      return []
    }
    if (normalized.includes('select') && normalized.includes('min_retained_seq')) {
      const docId = expectString(bindings[0])
      const doc = this.docs.get(docId)
      const rows =
        doc === undefined
          ? []
          : [
              {
                latestSeq: doc.latestSeq,
                minRetainedSeq: doc.minRetainedSeq,
                horizonStateVector: doc.horizonStateVector,
              },
            ]
      return rows as Iterable<T>
    }
    if (
      normalized.includes('from docs') &&
      normalized.includes('latest_seq > latest_snapshot_seq')
    ) {
      const limit = expectNumber(bindings[0])
      const rows = [...this.docs.entries()]
        .filter(([, doc]) => doc.latestSeq > doc.latestSnapshotSeq)
        .sort(([, left], [, right]) => left.updatedAt - right.updatedAt)
        .slice(0, limit)
        .map(([docId]) => ({ docId }))
      return rows as Iterable<T>
    }
    if (normalized.includes('select latest_seq')) {
      const docId = expectString(bindings[0])
      const doc = this.docs.get(docId)
      const rows = doc === undefined ? [] : [{ latestSeq: doc.latestSeq }]
      return rows as Iterable<T>
    }
    if (normalized.includes('from docs') && normalized.includes('limit') && !normalized.includes('latest_seq > latest_snapshot_seq')) {
      const first = this.docs.keys().next()
      const rows = first.done === true ? [] : [{ docId: first.value }]
      return rows as Iterable<T>
    }
    if (normalized.includes('select') && normalized.includes('latest_snapshot_seq')) {
      const docId = expectString(bindings[0])
      const doc = this.docs.get(docId)
      const rows =
        doc === undefined
          ? []
          : [
              {
                latestSnapshotSeq: doc.latestSnapshotSeq,
                latestSnapshotKey: doc.latestSnapshotKey,
              },
            ]
      return rows as Iterable<T>
    }
    if (
      normalized.includes('select update_bytes') &&
      !normalized.includes('from quarantined_updates')
    ) {
      const docId = expectString(bindings[0])
      const minSeq = expectNumber(bindings[1])
      const rows = [...this.opLog.values()]
        .filter((row) => row.docId === docId)
        .filter((row) => row.seq > minSeq)
        .sort((left, right) => left.seq - right.seq)
        .map((row) => ({ updateBytes: row.updateBytes }))
      return rows as Iterable<T>
    }
    if (normalized.includes('select durable_seq as durableseq')) {
      const docId = expectString(bindings[0])
      const messageId = expectString(bindings[1])
      const row = this.messageDedup.get(`${docId}:${messageId}`)
      const rows = row === undefined ? [] : [{ durableSeq: row.durableSeq }]
      return rows as Iterable<T>
    }
    if (normalized.includes('from checkpoint_runs') && normalized.includes('status in')) {
      const limit = expectNumber(bindings[3])
      const rows = [...this.checkpointRuns.values()]
        .filter(
          (run) =>
            run.status === 'writing' ||
            run.status === 'r2-written' ||
            run.status === 'pointer-updated',
        )
        .sort((left, right) => left.createdAt - right.createdAt)
        .slice(0, limit)
        .map((run) => ({
          runId: run.runId,
          docId: run.docId,
          status: run.status,
          upperSeq: run.upperSeq,
          snapshotKey: run.snapshotKey,
        }))
      return rows as Iterable<T>
    }
    if (normalized.includes('insert into op_log')) {
      const docId = expectString(bindings[0])
      const seq = expectNumber(bindings[1])
      const messageId = expectString(bindings[2])
      this.opLog.set(`${docId}:${messageId}`, {
        docId,
        seq,
        messageId,
        deviceId: expectString(bindings[3]),
        yClientId: expectNumber(bindings[4]),
        updateBytes: expectUint8Array(bindings[5]),
        updateSha256: expectString(bindings[6]),
        createdAt: expectNumber(bindings[7]),
      })
      return []
    }
    if (normalized.includes('insert into docs')) {
      const docId = expectString(bindings[0])
      this.docs.set(docId, {
        kind: expectString(bindings[1]),
        latestSeq: expectNumber(bindings[2]),
        latestSnapshotSeq: this.docs.get(docId)?.latestSnapshotSeq ?? 0,
        latestSnapshotKey: this.docs.get(docId)?.latestSnapshotKey,
        minRetainedSeq: this.docs.get(docId)?.minRetainedSeq ?? 0,
        horizonStateVector: this.docs.get(docId)?.horizonStateVector,
        updatedAt: expectNumber(bindings[3]),
      })
      return []
    }
    if (normalized.includes('insert into message_dedup')) {
      const docId = expectString(bindings[0])
      const messageId = expectString(bindings[1])
      this.messageDedup.set(`${docId}:${messageId}`, {
        docId,
        messageId,
        durableSeq: expectNumber(bindings[2]),
        seenAt: expectNumber(bindings[3]),
      })
      return []
    }
    if (normalized.includes('insert into quarantined_updates')) {
      const id = expectString(bindings[0])
      this.quarantines.set(id, {
        id,
        docId: expectString(bindings[1]),
        messageId: expectString(bindings[2]),
        deviceId: expectString(bindings[3]),
        reason: expectString(bindings[4]),
        updateSha256: expectString(bindings[5]),
        updateBytes: expectUint8Array(bindings[6]),
        createdAt: expectNumber(bindings[7]),
      })
      return []
    }
    if (normalized.includes('from quarantined_updates') && normalized.includes('where id')) {
      const id = expectString(bindings[0])
      const row = this.quarantines.get(id)
      const rows = row === undefined ? [] : [quarantineSqlRow(row)]
      return rows as Iterable<T>
    }
    if (normalized.includes('from quarantined_updates')) {
      const rows = [...this.quarantines.values()]
        .sort((left, right) => left.createdAt - right.createdAt)
        .map(quarantineSqlRow)
      return rows as Iterable<T>
    }
    if (normalized.includes('insert into checkpoint_runs')) {
      const runId = expectString(bindings[0])
      this.checkpointRuns.set(runId, {
        runId,
        docId: expectString(bindings[1]),
        upperSeq: expectNumber(bindings[2]),
        snapshotKey: expectString(bindings[3]),
        stateVector: expectUint8Array(bindings[4]),
        status: expectString(bindings[5]),
        createdAt: expectNumber(bindings[6]),
        r2WrittenAt: undefined,
        pointerUpdatedAt: undefined,
        compactedAt: undefined,
      })
      return []
    }
    if (normalized.includes('update checkpoint_runs') && normalized.includes('r2_written_at')) {
      const status = expectString(bindings[0])
      const r2WrittenAt = expectNumber(bindings[1])
      const runId = expectString(bindings[2])
      const existing = this.checkpointRuns.get(runId)
      if (existing === undefined) {
        throw new Error('checkpoint run not found')
      }
      this.checkpointRuns.set(runId, { ...existing, status, r2WrittenAt })
      return []
    }
    if (
      normalized.includes('update checkpoint_runs') &&
      normalized.includes('set status = ? where run_id')
    ) {
      const status = expectString(bindings[0])
      const runId = expectString(bindings[1])
      const existing = this.checkpointRuns.get(runId)
      if (existing === undefined) {
        throw new Error('checkpoint run not found')
      }
      this.checkpointRuns.set(runId, { ...existing, status })
      return []
    }
    if (
      normalized.includes('update checkpoint_runs') &&
      normalized.includes('pointer_updated_at')
    ) {
      const status = expectString(bindings[0])
      const pointerUpdatedAt = expectNumber(bindings[1])
      const runId = expectString(bindings[2])
      const existing = this.checkpointRuns.get(runId)
      if (existing === undefined) {
        throw new Error('checkpoint run not found')
      }
      this.checkpointRuns.set(runId, { ...existing, status, pointerUpdatedAt })
      return []
    }
    if (normalized.includes('update docs') && normalized.includes('latest_snapshot_seq')) {
      const latestSnapshotSeq = expectNumber(bindings[0])
      const latestSnapshotKey = expectString(bindings[1])
      const docId = expectString(bindings[4])
      const maxSnapshotSeq = expectNumber(bindings[5])
      const existing = this.docs.get(docId)
      if (existing === undefined || existing.latestSnapshotSeq > maxSnapshotSeq) {
        return []
      }
      this.docs.set(docId, {
        ...existing,
        latestSnapshotSeq,
        latestSnapshotKey,
        updatedAt: expectNumber(bindings[3]),
      })
      return []
    }
    if (normalized.includes('delete from op_log')) {
      const docId = expectString(bindings[0])
      const upperSeq = expectNumber(bindings[1])
      for (const [key, row] of this.opLog) {
        if (row.docId === docId && row.seq <= upperSeq) {
          this.opLog.delete(key)
        }
      }
      return []
    }
    if (normalized.includes('update docs') && normalized.includes('min_retained_seq')) {
      const minRetainedSeq = expectNumber(bindings[0])
      const horizonStateVector = expectUint8Array(bindings[1])
      const docId = expectString(bindings[3])
      const maxRetainedSeq = expectNumber(bindings[4])
      const existing = this.docs.get(docId)
      if (existing === undefined || existing.minRetainedSeq > maxRetainedSeq) {
        return []
      }
      this.docs.set(docId, {
        ...existing,
        minRetainedSeq,
        horizonStateVector,
        updatedAt: expectNumber(bindings[2]),
      })
      return []
    }
    if (normalized.includes('update checkpoint_runs') && normalized.includes('compacted_at')) {
      const status = expectString(bindings[0])
      const compactedAt = expectNumber(bindings[1])
      const runId = expectString(bindings[2])
      const existing = this.checkpointRuns.get(runId)
      if (existing === undefined) {
        throw new Error('checkpoint run not found')
      }
      this.checkpointRuns.set(runId, { ...existing, status, compactedAt })
      return []
    }
    throw new Error(`unexpected SQL query: ${query}`)
  }
}

class FakeR2Object implements R2ObjectBodyBinding {
  constructor(private readonly bytes: Uint8Array) {}

  async arrayBuffer(): Promise<ArrayBuffer> {
    const buffer = new ArrayBuffer(this.bytes.byteLength)
    new Uint8Array(buffer).set(this.bytes)
    return buffer
  }
}

class FakeR2Bucket implements R2BucketBinding {
  readonly gets: string[] = []
  readonly heads: string[] = []
  readonly lists: string[] = []
  readonly puts: string[] = []
  private readonly values = new Map<string, Uint8Array>()

  set(key: string, bytes: Uint8Array): void {
    this.values.set(key, bytes)
  }

  async get(key: string): Promise<R2ObjectBodyBinding | null> {
    this.gets.push(key)
    const bytes = this.values.get(key)
    return bytes === undefined ? null : new FakeR2Object(bytes)
  }

  async head(key: string): Promise<{ readonly size: number } | null> {
    this.heads.push(key)
    const bytes = this.values.get(key)
    return bytes === undefined ? null : { size: bytes.byteLength }
  }

  async list(options: R2ListOptionsBinding): Promise<R2ObjectsBinding> {
    this.lists.push(options.prefix)
    return {
      objects: [...this.values.keys()]
        .filter((key) => key.startsWith(options.prefix))
        .map((key) => ({ key })),
    }
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.puts.push(key)
    this.values.set(key, value)
  }
}

class SqlOnlyStorage implements DurableObjectStorageBinding {
  readonly sql = new RecordingSqlStorage()
  readonly alarms: Array<number | Date> = []
  private readonly values = new Map<string, unknown>()

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value)
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarms.push(scheduledTime)
  }
}

class FakeState implements DurableObjectStateBinding {
  readonly accepted: RuntimeWebSocket[] = []

  constructor(readonly storage: DurableObjectStorageBinding = new MemoryStorage()) {}

  acceptWebSocket(webSocket: RuntimeWebSocket): void {
    webSocket.accept?.()
    this.accepted.push(webSocket)
  }

  getWebSockets(): readonly RuntimeWebSocket[] {
    return this.accepted
  }
}

test('worker entrypoint routes vault websocket upgrades to a Durable Object', async () => {
  let routedName = ''
  let routedRequest: Request | undefined
  const env: WorkerEnv = {
    VAULT_ROOM: {
      idFromName(name: string): DurableObjectIdBinding {
        routedName = name
        return {}
      },
      get(): DurableObjectStubBinding {
        return {
          async fetch(request: Request): Promise<Response> {
            routedRequest = request
            return new Response('routed', { status: 209 })
          },
        }
      },
    },
  }

  const request = new Request('https://worker.example/ws/vault-1', {
    headers: { Upgrade: 'websocket' },
  })

  const response = await workerEntrypoint.fetch(request, env)

  assert.equal(response.status, 209)
  assert.equal(await response.text(), 'routed')
  assert.equal(routedName, 'vault-1')
  assert.equal(routedRequest, request)
})

test('worker entrypoint routes setup exchange requests by body vaultId', async () => {
  let routedName = ''
  let routedRequest: Request | undefined
  const env: WorkerEnv = {
    VAULT_ROOM: {
      idFromName(name: string): DurableObjectIdBinding {
        routedName = name
        return {}
      },
      get(): DurableObjectStubBinding {
        return {
          async fetch(request: Request): Promise<Response> {
            routedRequest = request
            return new Response('setup-routed', { status: 207 })
          },
        }
      },
    },
  }

  const request = new Request('https://worker.example/setup/exchange', {
    method: 'POST',
    body: JSON.stringify({
      vaultId: 'vault-1',
      setupToken: 'setup-token',
      requestedDeviceName: 'Laptop',
    }),
  })

  const response = await workerEntrypoint.fetch(request, env)

  assert.equal(response.status, 207)
  assert.equal(await response.text(), 'setup-routed')
  assert.equal(routedName, 'vault-1')
  assert.equal(routedRequest?.url, 'https://worker.example/setup/exchange')
})

test('worker entrypoint keeps the e2e setup token seed endpoint disabled without a secret', async () => {
  const response = await workerEntrypoint.fetch(
    new Request('https://worker.example/__e2e/setup-token', {
      method: 'POST',
      body: JSON.stringify({
        vaultId: 'vault-1',
        setupToken: 'setup-token',
      }),
    }),
    makeEnv(),
  )

  assert.equal(response.status, 404)
})

test('worker entrypoint routes e2e setup token seeds by body vaultId when enabled', async () => {
  let routedName = ''
  let routedRequest: Request | undefined
  const env: WorkerEnv = {
    E2E_SETUP_TOKEN_SECRET: 'seed-secret',
    VAULT_ROOM: {
      idFromName(name: string): DurableObjectIdBinding {
        routedName = name
        return {}
      },
      get(): DurableObjectStubBinding {
        return {
          async fetch(request: Request): Promise<Response> {
            routedRequest = request
            return new Response('seed-routed', { status: 206 })
          },
        }
      },
    },
  }

  const response = await workerEntrypoint.fetch(
    new Request('https://worker.example/__e2e/setup-token', {
      method: 'POST',
      headers: { 'x-kuroflare-e2e-secret': 'seed-secret' },
      body: JSON.stringify({
        vaultId: 'vault-1',
        setupToken: 'setup-token',
      }),
    }),
    env,
  )

  assert.equal(response.status, 206)
  assert.equal(await response.text(), 'seed-routed')
  assert.equal(routedName, 'vault-1')
  assert.equal(routedRequest?.url, 'https://worker.example/__e2e/setup-token')
})

test('worker entrypoint routes auth refresh requests by body vaultId', async () => {
  let routedName = ''
  let routedRequest: Request | undefined
  const env: WorkerEnv = {
    VAULT_ROOM: {
      idFromName(name: string): DurableObjectIdBinding {
        routedName = name
        return {}
      },
      get(): DurableObjectStubBinding {
        return {
          async fetch(request: Request): Promise<Response> {
            routedRequest = request
            return new Response('refresh-routed', { status: 208 })
          },
        }
      },
    },
  }

  const request = new Request('https://worker.example/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({
      vaultId: 'vault-1',
      deviceId: 'device-1',
      refreshToken: 'refresh-token',
      previousTokenVersion: 1,
    }),
  })

  const response = await workerEntrypoint.fetch(request, env)

  assert.equal(response.status, 208)
  assert.equal(await response.text(), 'refresh-routed')
  assert.equal(routedName, 'vault-1')
  assert.equal(routedRequest?.url, 'https://worker.example/auth/refresh')
})

test('worker entrypoint routes device revoke requests by token vault', async () => {
  let routedName = ''
  let routedRequest: Request | undefined
  const secret = 'test-device-token-secret'
  const env: WorkerEnv = {
    ...makeEnvWithDeviceTokenSecret(secret),
    VAULT_ROOM: {
      idFromName(name: string): DurableObjectIdBinding {
        routedName = name
        return {}
      },
      get(): DurableObjectStubBinding {
        return {
          async fetch(request: Request): Promise<Response> {
            routedRequest = request
            return new Response('revoke-routed', { status: 206 })
          },
        }
      },
    },
  }

  const request = new Request('https://worker.example/devices/device-2/revoke', {
    method: 'POST',
    headers: { Authorization: `Bearer ${await makeDeviceToken(secret)}` },
    body: JSON.stringify({ reason: 'lost' }),
  })

  const response = await workerEntrypoint.fetch(request, env)

  assert.equal(response.status, 206)
  assert.equal(await response.text(), 'revoke-routed')
  assert.equal(routedName, 'vault-1')
  assert.equal(routedRequest?.url, 'https://worker.example/devices/device-2/revoke')
})

test('worker entrypoint routes quarantine inspect requests by token vault', async () => {
  let routedName = ''
  let routedRequest: Request | undefined
  const secret = 'test-device-token-secret'
  const env: WorkerEnv = {
    ...makeEnvWithDeviceTokenSecret(secret),
    VAULT_ROOM: {
      idFromName(name: string): DurableObjectIdBinding {
        routedName = name
        return {}
      },
      get(): DurableObjectStubBinding {
        return {
          async fetch(request: Request): Promise<Response> {
            routedRequest = request
            return new Response('quarantine-routed', { status: 209 })
          },
        }
      },
    },
  }

  const request = new Request('https://worker.example/admin/quarantine/q-message-bad', {
    headers: { Authorization: `Bearer ${await makeDeviceToken(secret)}` },
  })

  const response = await workerEntrypoint.fetch(request, env)

  assert.equal(response.status, 209)
  assert.equal(await response.text(), 'quarantine-routed')
  assert.equal(routedName, 'vault-1')
  assert.equal(routedRequest?.url, 'https://worker.example/admin/quarantine/q-message-bad')
})

test('worker entrypoint rejects invalid routes before touching Durable Objects', async () => {
  const env: WorkerEnv = {
    VAULT_ROOM: {
      idFromName(): DurableObjectIdBinding {
        throw new Error('should not route')
      },
      get(): DurableObjectStubBinding {
        throw new Error('should not route')
      },
    },
  }

  assert.equal(
    (await workerEntrypoint.fetch(new Request('https://worker.example/'), env)).status,
    404,
  )
  assert.equal(
    (
      await workerEntrypoint.fetch(
        new Request('https://worker.example/ws/bad id', {
          headers: { Upgrade: 'websocket' },
        }),
        env,
      )
    ).status,
    400,
  )
  assert.equal(
    (await workerEntrypoint.fetch(new Request('https://worker.example/ws/vault-1'), env)).status,
    426,
  )
  assert.equal(
    (
      await workerEntrypoint.fetch(
        new Request('https://worker.example/setup/exchange', {
          method: 'POST',
          body: JSON.stringify({ vaultId: 'bad id' }),
        }),
        env,
      )
    ).status,
    400,
  )
  assert.equal(
    (
      await workerEntrypoint.fetch(
        new Request('https://worker.example/auth/refresh', {
          method: 'POST',
          body: JSON.stringify({ vaultId: 'bad id' }),
        }),
        env,
      )
    ).status,
    400,
  )
  assert.equal(
    (
      await workerEntrypoint.fetch(
        new Request('https://worker.example/devices/bad id/revoke', {
          method: 'POST',
          body: JSON.stringify({}),
        }),
        env,
      )
    ).status,
    400,
  )
})

test('VaultRoom accepts websocket upgrades and rejects malformed binary frames', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const state = new FakeState()
    const room = new VaultRoom(state, makeEnv())
    const request = new Request('https://worker.example/ws/vault-1', {
      headers: { Upgrade: 'websocket' },
    })

    const firstResponse = await room.fetch(request)
    const secondResponse = await room.fetch(request)
    assert.equal(firstResponse.status, 101)
    assert.equal(secondResponse.status, 101)
    assert.equal(state.accepted.length, 2)

    const firstServer = state.accepted[0]
    const secondServer = state.accepted[1]
    assert(firstServer instanceof FakeSocket)
    assert(secondServer instanceof FakeSocket)

    const update = new Uint8Array([1, 2, 3]).buffer
    await room.webSocketMessage(firstServer, update)

    assert.deepEqual(syncMessages(firstServer.sent), [])
    assert.equal(firstServer.closed, true)
    assert.equal(firstServer.closeReason, 'invalid-binary-frame')
    assert.deepEqual(syncMessages(secondServer.sent), [])
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom exchanges setup tokens for device credentials', async () => {
  const storage = new SqlOnlyStorage()
  const setupToken = 'setup-token-1'
  const setupTokenHash = await hashTestText(setupToken)
  storage.sql.setupTokens.set(setupTokenHash, {
    tokenHash: setupTokenHash,
    vaultId: 'vault-1',
    issuedAt: 1,
    expiresAt: Date.now() + 60_000,
    consumedAt: undefined,
  })
  const room = new VaultRoom(new FakeState(storage), makeEnvWithDeviceTokenSecret('secret'))

  const response = await room.fetch(
    new Request('https://worker.example/setup/exchange', {
      method: 'POST',
      body: JSON.stringify({
        vaultId: 'vault-1',
        setupToken,
        requestedDeviceName: 'Laptop',
      }),
    }),
  )

  assert.equal(response.status, 200)
  const body = (await response.json()) as {
    readonly endpoint?: unknown
    readonly vaultId?: unknown
    readonly deviceId?: unknown
    readonly yClientId?: unknown
    readonly accessToken?: unknown
    readonly refreshToken?: unknown
    readonly tokenVersion?: unknown
    readonly bootstrapMode?: unknown
  }
  assert.equal(body.endpoint, 'https://worker.example')
  assert.equal(body.vaultId, 'vault-1')
  assert.equal(body.yClientId, 2)
  assert.equal(body.tokenVersion, 1)
  assert.equal(body.bootstrapMode, 'new-vault')
  assert.equal(typeof body.deviceId, 'string')
  assert.equal(typeof body.accessToken, 'string')
  assert.equal(typeof body.refreshToken, 'string')
  assert.equal((body.accessToken as string).split('.').length, 3)
  assert.equal(storage.sql.setupTokens.get(setupTokenHash)?.consumedAt !== undefined, true)
  assert.equal(storage.sql.refreshTokens.size, 1)
  assert.equal(storage.sql.devices.size, 2)
  assert(storage.sql.queries.includes('begin immediate'))
  assert(storage.sql.queries.includes('commit'))
  assert.equal(storage.sql.queries.includes('rollback'), false)
})

test('VaultRoom rolls back setup exchange persistence failures', async () => {
  const storage = new SqlOnlyStorage()
  const setupToken = 'setup-token-rollback'
  const setupTokenHash = await hashTestText(setupToken)
  storage.sql.setupTokens.set(setupTokenHash, {
    tokenHash: setupTokenHash,
    vaultId: 'vault-1',
    issuedAt: 1,
    expiresAt: Date.now() + 60_000,
    consumedAt: undefined,
  })
  storage.sql.failOnQueryIncludes = 'insert into device_refresh_tokens'
  const room = new VaultRoom(new FakeState(storage), makeEnvWithDeviceTokenSecret('secret'))

  const response = await room.fetch(
    new Request('https://worker.example/setup/exchange', {
      method: 'POST',
      body: JSON.stringify({
        vaultId: 'vault-1',
        setupToken,
        requestedDeviceName: 'Laptop',
      }),
    }),
  )

  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), { error: 'setup-persist:transaction-failed' })
  assert(storage.sql.queries.includes('begin immediate'))
  assert(storage.sql.queries.includes('rollback'))
  assert.equal(storage.sql.queries.includes('commit'), false)
})

test('VaultRoom refreshes device access tokens and rotates refresh tokens', async () => {
  const storage = new SqlOnlyStorage()
  const refreshToken = 'refresh-token-1'
  const refreshTokenHash = await hashTestText(refreshToken)
  storage.sql.refreshTokens.set(refreshTokenHash, {
    tokenHash: refreshTokenHash,
    deviceId: 'device-1',
    issuedAt: 1,
    expiresAt: Date.now() + 60_000,
    revokedAt: undefined,
  })
  const room = new VaultRoom(new FakeState(storage), makeEnvWithDeviceTokenSecret('secret'))

  const response = await room.fetch(
    new Request('https://worker.example/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({
        vaultId: 'vault-1',
        deviceId: 'device-1',
        refreshToken,
        previousTokenVersion: 1,
      }),
    }),
  )

  assert.equal(response.status, 200)
  const body = (await response.json()) as {
    readonly accessToken?: unknown
    readonly refreshToken?: unknown
    readonly tokenVersion?: unknown
    readonly expiresAt?: unknown
    readonly protocolVersion?: unknown
  }
  assert.equal(typeof body.accessToken, 'string')
  assert.equal(typeof body.refreshToken, 'string')
  assert.equal(body.tokenVersion, 1)
  assert.equal(body.protocolVersion, CURRENT_PROTOCOL_VERSION)
  assert.equal(typeof body.expiresAt, 'number')
  assert.equal(storage.sql.refreshTokens.get(refreshTokenHash)?.revokedAt !== undefined, true)
  assert.equal(storage.sql.refreshTokens.size, 2)
  assert(storage.sql.queries.includes('begin immediate'))
  assert(storage.sql.queries.includes('commit'))
})

test('VaultRoom rolls back auth refresh rotation failures', async () => {
  const storage = new SqlOnlyStorage()
  const refreshToken = 'refresh-token-rollback'
  const refreshTokenHash = await hashTestText(refreshToken)
  storage.sql.refreshTokens.set(refreshTokenHash, {
    tokenHash: refreshTokenHash,
    deviceId: 'device-1',
    issuedAt: 1,
    expiresAt: Date.now() + 60_000,
    revokedAt: undefined,
  })
  storage.sql.failOnQueryIncludes = 'insert into device_refresh_tokens'
  const room = new VaultRoom(new FakeState(storage), makeEnvWithDeviceTokenSecret('secret'))

  const response = await room.fetch(
    new Request('https://worker.example/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({
        vaultId: 'vault-1',
        deviceId: 'device-1',
        refreshToken,
        previousTokenVersion: 1,
      }),
    }),
  )

  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), {
    error: 'auth-refresh-persist:transaction-failed',
  })
  assert(storage.sql.queries.includes('begin immediate'))
  assert(storage.sql.queries.includes('rollback'))
  assert.equal(storage.sql.queries.includes('commit'), false)
})

test('VaultRoom revokes devices through authenticated HTTP requests', async () => {
  const secret = 'test-device-token-secret'
  const storage = new SqlOnlyStorage()
  storage.sql.devices.set('device-2', {
    deviceId: 'device-2',
    yClientId: 2,
    tokenVersion: 3,
    revokedAt: undefined,
  })
  const room = new VaultRoom(new FakeState(storage), makeEnvWithDeviceTokenSecret(secret))

  const response = await room.fetch(
    new Request('https://worker.example/devices/device-2/revoke', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await makeDeviceToken(secret)}` },
      body: JSON.stringify({ reason: 'lost' }),
    }),
  )

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    deviceId: 'device-2',
    status: 'revoked',
    revokedAt: storage.sql.devices.get('device-2')?.revokedAt,
    tokenVersion: 4,
  })
  assert.equal(storage.sql.devices.get('device-2')?.tokenVersion, 4)
  assert.equal(typeof storage.sql.devices.get('device-2')?.revokedAt, 'number')
})

test('VaultRoom device revoke is idempotent for already revoked devices', async () => {
  const secret = 'test-device-token-secret'
  const storage = new SqlOnlyStorage()
  storage.sql.devices.set('device-2', {
    deviceId: 'device-2',
    yClientId: 2,
    tokenVersion: 4,
    revokedAt: 123,
  })
  const room = new VaultRoom(new FakeState(storage), makeEnvWithDeviceTokenSecret(secret))

  const response = await room.fetch(
    new Request('https://worker.example/devices/device-2/revoke', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await makeDeviceToken(secret)}` },
      body: JSON.stringify({}),
    }),
  )

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    deviceId: 'device-2',
    status: 'already-revoked',
    revokedAt: 123,
    tokenVersion: 4,
  })
  assert.equal(storage.sql.devices.get('device-2')?.revokedAt, 123)
})

test('VaultRoom serves authenticated blob head, upload, and download proxy requests', async () => {
  const secret = TEST_DEVICE_TOKEN_SECRET
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, secret),
  )
  const existingBytes = new TextEncoder().encode('existing blob payload')
  const existingHash = makeSha256Hex(await hashTestText('existing blob payload'))
  const missingHash = makeSha256Hex('a'.repeat(64))
  bucket.set(`vaults/vault-1/blobs/${existingHash}`, existingBytes)

  const headResponse = await room.fetch(
    new Request('https://worker.example/blobs/head', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(secret, { scope: ['blob:read'], tokenVersion: 1 })}`,
      },
      body: JSON.stringify({ hashes: [existingHash, missingHash] }),
    }),
  )

  assert.equal(headResponse.status, 200)
  assert.deepEqual(await headResponse.json(), {
    exists: {
      [existingHash]: { found: true, size: existingBytes.byteLength },
      [missingHash]: { found: false },
    },
  })
  assert.deepEqual(bucket.heads, [
    `vaults/vault-1/blobs/${existingHash}`,
    `vaults/vault-1/blobs/${missingHash}`,
  ])
  assert.equal(bucket.gets.length, 0)

  const uploadBytes = new TextEncoder().encode('new upload payload')
  const uploadHash = makeSha256Hex(await hashTestText('new upload payload'))
  const uploadUrlResponse = await room.fetch(
    new Request('https://worker.example/blobs/upload-url', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(secret, { scope: ['blob:write'], tokenVersion: 1 })}`,
      },
      body: JSON.stringify({ sha256: uploadHash, size: uploadBytes.byteLength }),
    }),
  )
  assert.equal(uploadUrlResponse.status, 200)
  const uploadUrlBody = (await uploadUrlResponse.json()) as {
    readonly kind?: unknown
    readonly url?: unknown
    readonly headers?: unknown
  }
  assert.equal(uploadUrlBody.kind, 'single-put')
  assert.equal(typeof uploadUrlBody.url, 'string')
  assert((uploadUrlBody.url as string).startsWith(`https://worker.example/blobs/${uploadHash}?`))
  assert.equal(
    new URL(uploadUrlBody.url as string).searchParams.get('size'),
    String(uploadBytes.byteLength),
  )
  assert.equal(new URL(uploadUrlBody.url as string).searchParams.get('expiresAt'), null)
  assert.deepEqual(uploadUrlBody.headers, {})

  const putResponse = await room.fetch(
    new Request(uploadUrlBody.url as string, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(secret, { scope: ['blob:write'], tokenVersion: 1 })}`,
        'content-length': String(uploadBytes.byteLength),
      },
      body: uploadBytes,
    }),
  )
  assert.equal(putResponse.status, 200)
  assert.deepEqual(await putResponse.json(), {
    status: 'stored',
    sha256: uploadHash,
    size: uploadBytes.byteLength,
  })
  assert.deepEqual(bucket.puts, [`vaults/vault-1/blobs/${uploadHash}`])

  const getResponse = await room.fetch(
    new Request(`https://worker.example/blobs/${uploadHash}`, {
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(secret, { scope: ['blob:read'], tokenVersion: 1 })}`,
      },
    }),
  )
  assert.equal(getResponse.status, 200)
  assert.equal(getResponse.headers.get('x-content-sha256'), uploadHash)
  assert.deepEqual(new Uint8Array(await getResponse.arrayBuffer()), uploadBytes)
  assert(bucket.gets.includes(`vaults/vault-1/blobs/${uploadHash}`))
})

test('VaultRoom rejects blob uploads whose body hash does not match the addressed hash', async () => {
  const secret = TEST_DEVICE_TOKEN_SECRET
  const bucket = new FakeR2Bucket()
  const room = new VaultRoom(
    new FakeState(new SqlOnlyStorage()),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, secret),
  )
  const claimedHash = makeSha256Hex('b'.repeat(64))
  const bytes = new TextEncoder().encode('different bytes')

  const response = await room.fetch(
    new Request(`https://worker.example/blobs/${claimedHash}?size=${bytes.byteLength}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(secret, { scope: ['blob:write'], tokenVersion: 1 })}`,
        'content-length': String(bytes.byteLength),
      },
      body: bytes,
    }),
  )

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'blob/hash-mismatch' })
  assert.deepEqual(bucket.puts, [])
})

test('VaultRoom rejects multipart-sized blob proxy uploads until multipart is implemented', async () => {
  const secret = TEST_DEVICE_TOKEN_SECRET
  const bucket = new FakeR2Bucket()
  const room = new VaultRoom(
    new FakeState(new SqlOnlyStorage()),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, secret),
  )
  const hash = makeSha256Hex('c'.repeat(64))

  const uploadUrlResponse = await room.fetch(
    new Request('https://worker.example/blobs/upload-url', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(secret, { scope: ['blob:write'], tokenVersion: 1 })}`,
      },
      body: JSON.stringify({ sha256: hash, size: 16 * 1024 * 1024 }),
    }),
  )

  assert.equal(uploadUrlResponse.status, 413)
  assert.deepEqual(await uploadUrlResponse.json(), {
    error: 'blob-upload-url:multipart-unimplemented',
  })
})

test('VaultRoom stores blob objects under a vault-scoped R2 prefix', async () => {
  const secret = TEST_DEVICE_TOKEN_SECRET
  const bucket = new FakeR2Bucket()
  const storage = new SqlOnlyStorage()
  storage.sql.devices.set('device-2', {
    deviceId: 'device-2',
    yClientId: 2,
    tokenVersion: 1,
    revokedAt: undefined,
  })
  const bytes = new TextEncoder().encode('same hash in another vault')
  const hash = makeSha256Hex(await hashTestText('same hash in another vault'))
  bucket.set(`vaults/vault-2/blobs/${hash}`, bytes)
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, secret),
  )

  const response = await room.fetch(
    new Request('https://worker.example/blobs/head', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(secret, {
          aud: makeVaultId('vault-1'),
          sub: makeDeviceId('device-1'),
          scope: ['blob:read'],
          tokenVersion: 1,
        })}`,
      },
      body: JSON.stringify({ hashes: [hash] }),
    }),
  )

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { exists: { [hash]: { found: false } } })
  assert.deepEqual(bucket.heads, [`vaults/vault-1/blobs/${hash}`])
})

test('VaultRoom serves authenticated blob manifest upload and download proxy requests', async () => {
  const secret = TEST_DEVICE_TOKEN_SECRET
  const bucket = new FakeR2Bucket()
  const room = new VaultRoom(
    new FakeState(new SqlOnlyStorage()),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, secret),
  )
  const manifest = testBlobManifest()
  const canonicalBytes = encodeBlobManifestJson(manifest)
  const manifestHash = makeSha256Hex(await hashTestBytes(canonicalBytes))

  const putResponse = await room.fetch(
    new Request(`https://worker.example/blob-manifests/${manifestHash}.json`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(secret, { scope: ['blob:write'], tokenVersion: 1 })}`,
        'content-length': String(canonicalBytes.byteLength),
      },
      body: JSON.stringify({
        createdAt: manifest.createdAt,
        createdBy: manifest.createdBy,
        chunks: manifest.chunks,
        size: manifest.size,
        contentSha256: manifest.contentSha256,
        fileId: manifest.fileId,
        version: manifest.version,
      }),
    }),
  )

  assert.equal(putResponse.status, 200)
  assert.deepEqual(await putResponse.json(), {
    status: 'stored',
    sha256: manifestHash,
    size: canonicalBytes.byteLength,
  })
  assert.deepEqual(bucket.puts, [`vaults/vault-1/blob-manifests/${manifestHash}.json`])

  const getResponse = await room.fetch(
    new Request(`https://worker.example/blob-manifests/${manifestHash}.json`, {
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(secret, { scope: ['blob:read'], tokenVersion: 1 })}`,
      },
    }),
  )

  assert.equal(getResponse.status, 200)
  assert.equal(getResponse.headers.get('x-content-sha256'), manifestHash)
  assert.deepEqual(new Uint8Array(await getResponse.arrayBuffer()), canonicalBytes)
  assert(bucket.gets.includes(`vaults/vault-1/blob-manifests/${manifestHash}.json`))
})

test('VaultRoom rejects blob manifest uploads whose canonical body hash does not match the addressed hash', async () => {
  const secret = TEST_DEVICE_TOKEN_SECRET
  const bucket = new FakeR2Bucket()
  const room = new VaultRoom(
    new FakeState(new SqlOnlyStorage()),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, secret),
  )
  const manifest = testBlobManifest()

  const response = await room.fetch(
    new Request(`https://worker.example/blob-manifests/${makeSha256Hex('0'.repeat(64))}.json`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(secret, { scope: ['blob:write'], tokenVersion: 1 })}`,
        'content-length': String(encodeBlobManifestJson(manifest).byteLength),
      },
      body: JSON.stringify(manifest),
    }),
  )

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'blob-manifest/hash-mismatch' })
  assert.deepEqual(bucket.puts, [])
})

test('VaultRoom appends JSON sync updates, acks the sender, and broadcasts to peers', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))

    room.fetch(await makeAuthenticatedWebSocketRequest())
    room.fetch(await makeAuthenticatedWebSocketRequest())
    room.fetch(await makeAuthenticatedWebSocketRequest())

    const firstServer = state.accepted[0]
    const secondServer = state.accepted[1]
    const unauthenticatedServer = state.accepted[2]
    assert(firstServer instanceof FakeSocket)
    assert(secondServer instanceof FakeSocket)
    assert(unauthenticatedServer instanceof FakeSocket)

    await room.webSocketMessage(firstServer, JSON.stringify(makeHello()))
    await room.webSocketMessage(secondServer, JSON.stringify(makeHello()))

    const update = makeSyncUpdate(makeMessageId('message-1'))
    const updateJson = JSON.stringify(update)

    await room.webSocketMessage(firstServer, updateJson)

    const ack = stringMessageAt(firstServer.sent, 0)
    if (typeof ack !== 'string') {
      throw new Error('expected ack string')
    }
    assert.deepEqual(JSON.parse(ack) as Ack, {
      type: 'ack',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId: makeVaultId('vault-1'),
      deviceId: makeDeviceId('device-1'),
      messageId: makeMessageId('message-1'),
      docId: { kind: 'meta' },
      durableSeq: 1,
    })
    assert.deepEqual(syncMessages(secondServer.sent), [
      JSON.stringify({ ...update, durableSeq: 1 }),
    ])
    assert.deepEqual(syncMessages(unauthenticatedServer.sent), [])

    await room.webSocketMessage(firstServer, updateJson)

    const duplicateAck = stringMessageAt(firstServer.sent, 1)
    if (typeof duplicateAck !== 'string') {
      throw new Error('expected duplicate ack string')
    }
    assert.deepEqual(JSON.parse(duplicateAck) as Ack, {
      type: 'ack',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId: makeVaultId('vault-1'),
      deviceId: makeDeviceId('device-1'),
      messageId: makeMessageId('message-1'),
      docId: { kind: 'meta' },
      durableSeq: 1,
    })
    assert.deepEqual(syncMessages(secondServer.sent), [
      JSON.stringify({ ...update, durableSeq: 1 }),
    ])
    assert.deepEqual(syncMessages(unauthenticatedServer.sent), [])
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom persists JSON sync updates through Durable Object SQL storage', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    const request = await makeAuthenticatedWebSocketRequest()

    room.fetch(request)
    room.fetch(request)

    const firstServer = state.accepted[0]
    const secondServer = state.accepted[1]
    assert(firstServer instanceof FakeSocket)
    assert(secondServer instanceof FakeSocket)

    await room.webSocketMessage(firstServer, JSON.stringify(makeHello()))
    await room.webSocketMessage(secondServer, JSON.stringify(makeHello()))

    const update = makeSyncUpdate(makeMessageId('message-sql'))
    const updateJson = JSON.stringify(update)

    await room.webSocketMessage(firstServer, updateJson)

    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 1)
    assert.equal(storage.sql.docs.get('meta')?.kind, 'meta')
    assert.equal(storage.sql.opLog.get('meta:message-sql')?.seq, 1)
    assert.equal(storage.sql.messageDedup.has('meta:message-sql'), true)
    assert.deepEqual(syncMessages(secondServer.sent), [
      JSON.stringify({ ...update, durableSeq: 1 }),
    ])

    const ack = stringMessageAt(firstServer.sent, 0)
    if (typeof ack !== 'string') {
      throw new Error('expected SQL ack string')
    }
    assert.equal((JSON.parse(ack) as Ack).durableSeq, 1)

    await room.webSocketMessage(firstServer, updateJson)

    const duplicateAck = stringMessageAt(firstServer.sent, 1)
    if (typeof duplicateAck !== 'string') {
      throw new Error('expected SQL duplicate ack string')
    }
    assert.equal((JSON.parse(duplicateAck) as Ack).durableSeq, 1)
    assert.deepEqual(syncMessages(secondServer.sent), [
      JSON.stringify({ ...update, durableSeq: 1 }),
    ])
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom applies pending schema migrations once before serving SQL traffic', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))

    room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    const created = storage.sql.queries.filter((query) =>
      query.includes('create table if not exists devices'),
    )
    assert.equal(created.length, 1)
    assert.deepEqual([...storage.sql.migrationVersions], [1])

    await room.webSocketMessage(
      server,
      JSON.stringify(makeSyncUpdate(makeMessageId('after-migrate'))),
    )

    const insertedVersions = storage.sql.queries.filter((query) =>
      query.includes('insert into schema_migrations'),
    )
    assert.equal(insertedVersions.length, 1)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom serializes concurrent sync update appends per document', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))

    room.fetch(await makeAuthenticatedWebSocketRequest())
    room.fetch(await makeAuthenticatedWebSocketRequest())
    const firstServer = state.accepted[0]
    const secondServer = state.accepted[1]
    assert(firstServer instanceof FakeSocket)
    assert(secondServer instanceof FakeSocket)

    await room.webSocketMessage(firstServer, JSON.stringify(makeHello()))
    await room.webSocketMessage(secondServer, JSON.stringify(makeHello()))

    await Promise.all([
      room.webSocketMessage(
        firstServer,
        JSON.stringify(makeSyncUpdate(makeMessageId('message-concurrent-a'))),
      ),
      room.webSocketMessage(
        secondServer,
        JSON.stringify(makeSyncUpdate(makeMessageId('message-concurrent-b'))),
      ),
    ])

    const rows = [...storage.sql.opLog.values()]
      .filter(
        (row) =>
          row.messageId === 'message-concurrent-a' || row.messageId === 'message-concurrent-b',
      )
      .sort((left, right) => left.seq - right.seq)
    assert.deepEqual(
      rows.map((row) => row.seq),
      [1, 2],
    )
    const firstAck = findAckForMessage(firstServer.sent, 'message-concurrent-a')
    const secondAck = findAckForMessage(secondServer.sent, 'message-concurrent-b')
    assert.equal(firstAck?.durableSeq, storage.sql.opLog.get('meta:message-concurrent-a')?.seq)
    assert.equal(secondAck?.durableSeq, storage.sql.opLog.get('meta:message-concurrent-b')?.seq)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom acks snapshot-escape duplicates from message_dedup without reissuing boundaries', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))

    room.fetch(await makeAuthenticatedWebSocketRequest())

    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    const docId = { kind: 'file', ydocId: makeYDocId('large-file-doc') } as const
    const update = {
      ...makeSyncUpdate(makeMessageId('message-large-update')),
      docId,
      update: makeLargeFileYjsUpdateBase64(),
    } satisfies SyncUpdate
    const updateJson = JSON.stringify(update)

    await room.webSocketMessage(server, updateJson)

    assert.equal(storage.sql.opLog.has('file:large-file-doc:message-large-update'), false)
    assert.equal(storage.sql.docs.get('file:large-file-doc')?.latestSeq, 1)
    assert.deepEqual(storage.sql.messageDedup.get('file:large-file-doc:message-large-update'), {
      docId: 'file:large-file-doc',
      messageId: 'message-large-update',
      durableSeq: 1,
      seenAt: storage.sql.messageDedup.get('file:large-file-doc:message-large-update')?.seenAt,
    })
    assert.equal(syncMessages(server.sent).length, 2)
    assert.equal((JSON.parse(stringMessageAt(server.sent, 0)) as Ack).durableSeq, 1)
    assert.equal(
      (JSON.parse(stringMessageAt(server.sent, 1)) as NeedFullSnapshot).reason,
      'large-update-snapshot',
    )

    await room.webSocketMessage(server, updateJson)

    assert.equal(syncMessages(server.sent).length, 3)
    assert.deepEqual(JSON.parse(stringMessageAt(server.sent, 2)) as Ack, {
      type: 'ack',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId: makeVaultId('vault-1'),
      deviceId: makeDeviceId('device-1'),
      messageId: makeMessageId('message-large-update'),
      docId,
      durableSeq: 1,
    })
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom requires hello before accepting binary sync frames', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const state = new FakeState(new SqlOnlyStorage())
    const room = new VaultRoom(state, makeEnv())
    const request = new Request('https://worker.example/ws/vault-1', {
      headers: { Upgrade: 'websocket' },
    })

    room.fetch(request)
    room.fetch(request)
    const firstServer = state.accepted[0]
    const secondServer = state.accepted[1]
    assert(firstServer instanceof FakeSocket)
    assert(secondServer instanceof FakeSocket)

    const update = makeSyncUpdate(makeMessageId('message-binary-before-hello'))
    const frame = makeArrayBuffer(
      encodeBinaryFrame(
        {
          type: 'sync-update',
          protocolVersion: update.protocolVersion,
          vaultId: update.vaultId,
          deviceId: update.deviceId,
          messageId: update.messageId,
          docId: update.docId,
        },
        makeYjsUpdateBytes(update.messageId),
      ),
    )

    await room.webSocketMessage(firstServer, frame)

    assert.equal(firstServer.closed, true)
    assert.equal(firstServer.closeReason, 'hello-required')
    assert.deepEqual(syncMessages(secondServer.sent), [])
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom persists binary sync frames before acking and broadcasting', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    const request = await makeAuthenticatedWebSocketRequest()

    room.fetch(request)
    room.fetch(request)
    room.fetch(request)
    const firstServer = state.accepted[0]
    const secondServer = state.accepted[1]
    const unauthenticatedServer = state.accepted[2]
    assert(firstServer instanceof FakeSocket)
    assert(secondServer instanceof FakeSocket)
    assert(unauthenticatedServer instanceof FakeSocket)
    await room.webSocketMessage(firstServer, JSON.stringify(makeHello()))
    await room.webSocketMessage(secondServer, JSON.stringify(makeHello()))

    const update = makeSyncUpdate(makeMessageId('message-binary'))
    const payload = makeYjsUpdateBytes(update.messageId)
    const frame = makeArrayBuffer(
      encodeBinaryFrame(
        {
          type: 'sync-update',
          protocolVersion: update.protocolVersion,
          vaultId: update.vaultId,
          deviceId: update.deviceId,
          messageId: update.messageId,
          docId: update.docId,
        },
        payload,
      ),
    )

    await room.webSocketMessage(firstServer, frame)

    assert.equal(storage.sql.opLog.get('meta:message-binary')?.seq, 1)
    const ack = stringMessageAt(firstServer.sent, 0)
    if (typeof ack !== 'string') {
      throw new Error('expected binary ack string')
    }
    assert.equal((JSON.parse(ack) as Ack).durableSeq, 1)
    assert.equal(syncMessages(secondServer.sent).length, 1)
    const broadcast = syncMessages(secondServer.sent)[0]
    assert(broadcast !== undefined)
    if (typeof broadcast === 'string') {
      throw new Error('expected binary broadcast frame')
    }
    const decoded = decodeBinaryFrame(new Uint8Array(broadcast))
    assert(decoded)
    assert.deepEqual(decoded.header, {
      type: 'sync-update',
      protocolVersion: update.protocolVersion,
      vaultId: update.vaultId,
      deviceId: update.deviceId,
      messageId: update.messageId,
      docId: update.docId,
      durableSeq: 1,
    })
    assert.deepEqual(decoded.payload, payload)
    assert.deepEqual(syncMessages(unauthenticatedServer.sent), [])
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom restores WebSocket sessions from hibernation attachments', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const request = await makeAuthenticatedWebSocketRequest()

    const initialRoom = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    initialRoom.fetch(request)
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await initialRoom.webSocketMessage(server, JSON.stringify(makeHello()))

    const resumedRoom = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    await resumedRoom.webSocketMessage(
      server,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-after-hibernation'))),
    )

    assert.equal(server.closed, false)
    const ack = stringMessageAt(server.sent, 0)
    if (typeof ack !== 'string') {
      throw new Error('expected resumed session ack string')
    }
    assert.deepEqual(JSON.parse(ack) as Ack, {
      type: 'ack',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId: makeVaultId('vault-1'),
      deviceId: makeDeviceId('device-1'),
      messageId: makeMessageId('message-after-hibernation'),
      docId: { kind: 'meta' },
      durableSeq: 1,
    })
    assert.equal(storage.sql.opLog.get('meta:message-after-hibernation')?.seq, 1)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom checkpoints an active document to R2 and advances the SQL snapshot pointer', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    await room.webSocketMessage(server, JSON.stringify(makeSyncUpdate(makeMessageId('message-cp'))))

    const result = await room.checkpointDoc({ kind: 'meta' }, 99)

    assert.deepEqual(result, {
      action: 'checkpointed',
      snapshotKey: 'snapshots/vault-1/meta/1.yupdate',
      upperSeq: 1,
      compactedSeq: 1,
    })
    assert.deepEqual(bucket.puts, ['snapshots/vault-1/meta/1.yupdate'])
    assert.equal(storage.sql.docs.get('meta')?.latestSnapshotSeq, 1)
    assert.equal(storage.sql.docs.get('meta')?.minRetainedSeq, 1)
    assert(storage.sql.docs.get('meta')?.horizonStateVector instanceof Uint8Array)
    assert.equal(storage.sql.opLog.has('meta:message-cp'), false)
    assert.equal(
      storage.sql.docs.get('meta')?.latestSnapshotKey,
      'snapshots/vault-1/meta/1.yupdate',
    )
    const run = storage.sql.checkpointRuns.get('checkpoint:snapshots/vault-1/meta/1.yupdate:99')
    assert(run)
    assert.equal(run.status, 'compacted')
    assert.equal(run.r2WrittenAt, 99)
    assert.equal(run.pointerUpdatedAt, 99)
    assert.equal(run.compactedAt, 99)

    assert.deepEqual(await room.checkpointDoc({ kind: 'meta' }, 100), {
      action: 'skipped',
      reason: 'no-new-ops',
    })
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom schedules and runs checkpoint alarms after durable appends', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const state = new FakeState(storage)
    const env = makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET)
    const room = new VaultRoom(state, env)
    room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    await room.webSocketMessage(
      server,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-alarm'))),
    )

    assert.equal(storage.alarms.length, 1)
    assert.equal(typeof storage.alarms[0], 'number')
    assert.equal(storage.sql.docs.get('meta')?.latestSnapshotSeq, 0)

    const resumedRoom = new VaultRoom(new FakeState(storage), env)
    await resumedRoom.alarm()

    assert.deepEqual(bucket.puts, ['snapshots/vault-1/meta/1.yupdate'])
    assert.equal(storage.sql.docs.get('meta')?.latestSnapshotSeq, 1)
    assert.equal(
      storage.sql.docs.get('meta')?.latestSnapshotKey,
      'snapshots/vault-1/meta/1.yupdate',
    )
    assert.equal(storage.sql.opLog.has('meta:message-alarm'), false)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom schedules an immediate checkpoint alarm after the op threshold', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    storage.sql.docs.set('meta', {
      kind: 'meta',
      latestSeq: 127,
      latestSnapshotSeq: 0,
      latestSnapshotKey: undefined,
      minRetainedSeq: 0,
      horizonStateVector: undefined,
      updatedAt: 1,
    })
    room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    await room.webSocketMessage(
      server,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-threshold'))),
    )

    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 128)
    assert.equal(storage.alarms.length, 1)
    const scheduled = storage.alarms[0]
    assert(typeof scheduled === 'number')
    assert(scheduled <= Date.now())
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom alarm recovers orphaned checkpoint runs before new checkpoints', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const snapshotBytes = makeYjsUpdateBytes(makeMessageId('message-recovered-snapshot'))
  bucket.set('snapshots/vault-1/meta/2.yupdate', snapshotBytes)
  storage.sql.docs.set('meta', {
    kind: 'meta',
    latestSeq: 2,
    latestSnapshotSeq: 0,
    latestSnapshotKey: undefined,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  storage.sql.checkpointRuns.set('run-writing', {
    runId: 'run-writing',
    docId: 'meta',
    upperSeq: 2,
    snapshotKey: 'snapshots/vault-1/meta/2.yupdate',
    stateVector: new Uint8Array(),
    status: 'writing',
    createdAt: 1,
    r2WrittenAt: undefined,
    pointerUpdatedAt: undefined,
    compactedAt: undefined,
  })
  const room = new VaultRoom(new FakeState(storage), makeEnvWithSnapshotBucket(bucket))

  await room.alarm()

  assert.equal(storage.sql.checkpointRuns.get('run-writing')?.status, 'r2-written')
  assert.equal(storage.sql.checkpointRuns.get('run-writing')?.r2WrittenAt !== undefined, true)
})

test('VaultRoom alarm advances and compacts recovered checkpoint pointers', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const snapshotBytes = makeYjsUpdateBytes(makeMessageId('message-pointer-snapshot'))
  bucket.set('snapshots/vault-1/meta/2.yupdate', snapshotBytes)
  storage.sql.docs.set('meta', {
    kind: 'meta',
    latestSeq: 2,
    latestSnapshotSeq: 0,
    latestSnapshotKey: undefined,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  storage.sql.opLog.set('meta:message-before-snapshot', {
    docId: 'meta',
    seq: 1,
    messageId: 'message-before-snapshot',
    deviceId: 'device-1',
    yClientId: 1,
    updateBytes: makeYjsUpdateBytes(makeMessageId('message-before-snapshot')),
    updateSha256: 'sha',
    createdAt: 1,
  })
  storage.sql.checkpointRuns.set('run-r2', {
    runId: 'run-r2',
    docId: 'meta',
    upperSeq: 2,
    snapshotKey: 'snapshots/vault-1/meta/2.yupdate',
    stateVector: new Uint8Array(),
    status: 'r2-written',
    createdAt: 1,
    r2WrittenAt: 2,
    pointerUpdatedAt: undefined,
    compactedAt: undefined,
  })
  const room = new VaultRoom(new FakeState(storage), makeEnvWithSnapshotBucket(bucket))

  await room.alarm()

  assert.equal(storage.sql.checkpointRuns.get('run-r2')?.status, 'pointer-updated')
  assert.equal(storage.sql.docs.get('meta')?.latestSnapshotSeq, 2)
  assert.equal(storage.sql.docs.get('meta')?.latestSnapshotKey, 'snapshots/vault-1/meta/2.yupdate')

  await room.alarm()

  assert.equal(storage.sql.checkpointRuns.get('run-r2')?.status, 'compacted')
  assert.equal(storage.sql.docs.get('meta')?.minRetainedSeq, 2)
  assert(storage.sql.docs.get('meta')?.horizonStateVector instanceof Uint8Array)
  assert.equal(storage.sql.opLog.has('meta:message-before-snapshot'), false)
})

test('VaultRoom answers sync requests with Yjs diffs and no-ops empty diffs', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    const update = makeSyncUpdate(makeMessageId('message-sync-source'))
    await room.webSocketMessage(server, JSON.stringify(update))

    const emptyStateVector = makeStateVectorBase64(new Y.Doc())
    await room.webSocketMessage(
      server,
      JSON.stringify(makeSyncRequest(makeMessageId('message-sync-request'), emptyStateVector)),
    )

    const response = stringMessageAt(server.sent, 1)
    if (typeof response !== 'string') {
      throw new Error('expected sync-request response string')
    }
    const parsed = JSON.parse(response) as SyncUpdate
    assert.equal(parsed.type, 'sync-update')
    assert.equal(parsed.messageId, makeMessageId('message-sync-request'))
    assert.equal(parsed.baseStateVector, emptyStateVector)

    const localDoc = new Y.Doc()
    Y.applyUpdate(localDoc, decodeTestBase64(update.update))
    await room.webSocketMessage(
      server,
      JSON.stringify(
        makeSyncRequest(makeMessageId('message-sync-current'), makeStateVectorBase64(localDoc)),
      ),
    )

    assert.equal(syncMessages(server.sent).length, 2)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom requires a full snapshot when sync request state vector is older than horizon', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    await room.webSocketMessage(
      server,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-horizon'))),
    )
    await room.checkpointDoc({ kind: 'meta' }, 10)

    await room.webSocketMessage(
      server,
      JSON.stringify(
        makeSyncRequest(makeMessageId('message-old-horizon'), makeStateVectorBase64(new Y.Doc())),
      ),
    )

    const response = stringMessageAt(server.sent, 1)
    if (typeof response !== 'string') {
      throw new Error('expected need-full-snapshot response string')
    }
    assert.deepEqual(JSON.parse(response) as NeedFullSnapshot, {
      type: 'need-full-snapshot',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId: makeVaultId('vault-1'),
      deviceId: makeDeviceId('device-1'),
      docId: { kind: 'meta' },
      reason: 'state-vector-too-old',
    })
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom hydrates active Y.Doc from SQL op_log after Durable Object restart', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const request = await makeAuthenticatedWebSocketRequest()

    const firstState = new FakeState(storage)
    const firstRoom = new VaultRoom(
      firstState,
      makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
    )
    firstRoom.fetch(request)
    const firstServer = firstState.accepted[0]
    assert(firstServer instanceof FakeSocket)
    await firstRoom.webSocketMessage(firstServer, JSON.stringify(makeHello()))
    await firstRoom.webSocketMessage(
      firstServer,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-before-restart'))),
    )

    const queryCountBeforeRestart = storage.sql.queries.length
    const secondState = new FakeState(storage)
    const secondRoom = new VaultRoom(
      secondState,
      makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
    )
    secondRoom.fetch(request)
    const secondServer = secondState.accepted[0]
    assert(secondServer instanceof FakeSocket)
    await secondRoom.webSocketMessage(secondServer, JSON.stringify(makeHello()))
    await secondRoom.webSocketMessage(
      secondServer,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-after-restart'))),
    )

    const restartQueries = storage.sql.queries.slice(queryCountBeforeRestart)
    assert(
      restartQueries.some((query) => query.includes('select update_bytes')),
      'expected restarted room to replay op_log before appending',
    )
    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 2)
    assert.equal(storage.sql.opLog.get('meta:message-before-restart')?.seq, 1)
    assert.equal(storage.sql.opLog.get('meta:message-after-restart')?.seq, 2)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom hydrates active Y.Doc from R2 snapshot plus residual SQL op_log', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const snapshotKey = 'snapshots/vault-1/pointers/meta.json'
    bucket.set(snapshotKey, makeYjsUpdateBytes(makeMessageId('message-snapshot')))
    storage.sql.docs.set('meta', {
      kind: 'meta',
      latestSeq: 2,
      latestSnapshotSeq: 1,
      latestSnapshotKey: snapshotKey,
      minRetainedSeq: 0,
      horizonStateVector: undefined,
      updatedAt: 1,
    })
    storage.sql.opLog.set('meta:message-residual', {
      docId: 'meta',
      seq: 2,
      messageId: 'message-residual',
      deviceId: 'device-1',
      yClientId: 1,
      updateBytes: makeYjsUpdateBytes(makeMessageId('message-residual')),
      updateSha256: 'a'.repeat(64),
      createdAt: 2,
    })

    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    await room.webSocketMessage(
      server,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-after-snapshot'))),
    )

    assert.deepEqual(bucket.gets, [snapshotKey])
    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 3)
    assert.equal(storage.sql.opLog.get('meta:message-after-snapshot')?.seq, 3)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom stops sync updates when the recorded R2 snapshot is missing', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const snapshotKey = 'snapshots/vault-1/meta/1.yupdate'
    storage.sql.docs.set('meta', {
      kind: 'meta',
      latestSeq: 1,
      latestSnapshotSeq: 1,
      latestSnapshotKey: snapshotKey,
      minRetainedSeq: 0,
      horizonStateVector: undefined,
      updatedAt: 1,
    })

    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    await room.webSocketMessage(
      server,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-after-missing-snapshot'))),
    )

    assert.deepEqual(bucket.gets, [snapshotKey])
    assert.equal(server.closed, true)
    assert.equal(server.closeCode, 1011)
    assert.equal(server.closeReason, 'hydrate-failed')
    assert.deepEqual(syncMessages(server.sent), [])
    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 1)
    assert.equal(storage.sql.opLog.has('meta:message-after-missing-snapshot'), false)
    assert.equal(storage.sql.quarantines.size, 0)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom falls back from a missing snapshot pointer to the newest listed snapshot', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const stalePointerKey = 'snapshots/vault-1/meta/1.yupdate'
    const fallbackKey = 'snapshots/vault-1/meta/2.yupdate'
    bucket.set(fallbackKey, makeYjsUpdateBytes(makeMessageId('message-fallback-snapshot')))
    storage.sql.docs.set('meta', {
      kind: 'meta',
      latestSeq: 2,
      latestSnapshotSeq: 1,
      latestSnapshotKey: stalePointerKey,
      minRetainedSeq: 0,
      horizonStateVector: undefined,
      updatedAt: 1,
    })

    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    await room.webSocketMessage(
      server,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-after-fallback'))),
    )

    assert.deepEqual(bucket.lists, ['snapshots/vault-1/meta/'])
    assert.deepEqual(bucket.gets, [fallbackKey])
    assert.equal(server.closed, false)
    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 3)
    assert.equal(storage.sql.opLog.get('meta:message-after-fallback')?.seq, 3)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom validates client hello against the SQL device registry', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    storage.sql.devices.delete('device-1')
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    assert.equal(server.closed, true)
    assert.equal(server.closeCode, 1008)
    assert.equal(server.closeReason, 'auth-reject:unknown-device')
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom blocks reinstalled and revoked devices before normal sync', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    room.fetch(await makeAuthenticatedWebSocketRequest())
    room.fetch(await makeAuthenticatedWebSocketRequest())
    const reinstalled = state.accepted[0]
    const revoked = state.accepted[1]
    assert(reinstalled instanceof FakeSocket)
    assert(revoked instanceof FakeSocket)

    await room.webSocketMessage(reinstalled, JSON.stringify({ ...makeHello(), yClientId: 2 }))
    storage.sql.devices.set('device-1', {
      deviceId: 'device-1',
      yClientId: 1,
      tokenVersion: 1,
      revokedAt: 50,
    })
    await room.webSocketMessage(revoked, JSON.stringify(makeHello()))

    assert.equal(reinstalled.closeCode, 1008)
    assert.equal(reinstalled.closeReason, 'hello-requires-full-snapshot:device-reinstalled')
    assert.equal(revoked.closeCode, 1008)
    assert.equal(revoked.closeReason, 'auth-reject:device-revoked')
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom rejects sync messages that do not match the accepted hello identity', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    await room.webSocketMessage(
      server,
      JSON.stringify({
        ...makeSyncUpdate(makeMessageId('message-mismatch')),
        deviceId: makeDeviceId('device-2'),
      }),
    )

    assert.equal(server.closeCode, 1008)
    assert.equal(server.closeReason, 'session-mismatch')
    assert.equal(storage.sql.opLog.size, 0)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom requires a valid signed device token when WS auth is configured', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const secret = 'test-device-token-secret'
    const token = await makeDeviceToken(secret)
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(secret))
    room.fetch(
      new Request('https://worker.example/ws/vault-1', {
        headers: { Upgrade: 'websocket', Authorization: `Bearer ${token}` },
      }),
    )
    room.fetch(
      new Request('https://worker.example/ws/vault-1', {
        headers: { Upgrade: 'websocket' },
      }),
    )
    const authorized = state.accepted[0]
    const missingToken = state.accepted[1]
    assert(authorized instanceof FakeSocket)
    assert(missingToken instanceof FakeSocket)

    await room.webSocketMessage(authorized, JSON.stringify(makeHello()))
    await room.webSocketMessage(missingToken, JSON.stringify(makeHello()))

    assert.equal(authorized.closed, false)
    assert.equal(missingToken.closeCode, 1008)
    assert.equal(missingToken.closeReason, 'auth-reject:missing-token')
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom accepts browser-compatible WebSocket token transports', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const secret = 'test-device-token-secret'
    const queryToken = await makeDeviceToken(secret)
    const protocolToken = await makeDeviceToken(secret)
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(secret))
    room.fetch(
      new Request(`https://worker.example/ws/vault-1?access_token=${queryToken}`, {
        headers: { Upgrade: 'websocket' },
      }),
    )
    room.fetch(
      new Request('https://worker.example/ws/vault-1', {
        headers: {
          Upgrade: 'websocket',
          'Sec-WebSocket-Protocol': `kuroflare.v1, ${protocolToken}`,
        },
      }),
    )
    const querySocket = state.accepted[0]
    const protocolSocket = state.accepted[1]
    assert(querySocket instanceof FakeSocket)
    assert(protocolSocket instanceof FakeSocket)

    await room.webSocketMessage(querySocket, JSON.stringify(makeHello()))
    await room.webSocketMessage(protocolSocket, JSON.stringify(makeHello()))

    assert.equal(querySocket.closed, false)
    assert.equal(protocolSocket.closed, false)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom fails closed when SQL device auth is configured without a token secret', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnv())
    room.fetch(
      new Request('https://worker.example/ws/vault-1', {
        headers: { Upgrade: 'websocket' },
      }),
    )

    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    assert.equal(server.closed, true)
    assert.equal(server.closeReason, 'auth-reject:missing-secret')
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom applies signed token scopes and tokenVersion to hello admission', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const secret = 'test-device-token-secret'
    const storage = new SqlOnlyStorage()
    storage.sql.devices.set('device-1', {
      deviceId: 'device-1',
      yClientId: 1,
      tokenVersion: 2,
      revokedAt: undefined,
    })
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(secret))
    room.fetch(
      new Request('https://worker.example/ws/vault-1', {
        headers: {
          Upgrade: 'websocket',
          Authorization: `Bearer ${await makeDeviceToken(secret, { tokenVersion: 1 })}`,
        },
      }),
    )
    room.fetch(
      new Request('https://worker.example/ws/vault-1', {
        headers: {
          Upgrade: 'websocket',
          Authorization: `Bearer ${await makeDeviceToken(secret, { scope: ['sync:read'] })}`,
        },
      }),
    )
    const staleToken = state.accepted[0]
    const missingScope = state.accepted[1]
    assert(staleToken instanceof FakeSocket)
    assert(missingScope instanceof FakeSocket)

    await room.webSocketMessage(staleToken, JSON.stringify(makeHello()))
    await room.webSocketMessage(missingScope, JSON.stringify(makeHello()))

    assert.equal(staleToken.closeCode, 1008)
    assert.equal(staleToken.closeReason, 'auth-reject:stale-token')
    assert.equal(missingScope.closeCode, 1008)
    assert.equal(missingScope.closeReason, 'auth-reject:missing-scope')
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom requires hello before sync updates', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const state = new FakeState()
    const room = new VaultRoom(state, makeEnv())
    room.fetch(
      new Request('https://worker.example/ws/vault-1', {
        headers: { Upgrade: 'websocket' },
      }),
    )

    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeSyncUpdate(makeMessageId('message-1'))))

    assert.equal(server.closed, true)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom quarantines invalid Yjs updates without acking or broadcasting', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))

    room.fetch(await makeAuthenticatedWebSocketRequest())
    room.fetch(await makeAuthenticatedWebSocketRequest())

    const firstServer = state.accepted[0]
    const secondServer = state.accepted[1]
    assert(firstServer instanceof FakeSocket)
    assert(secondServer instanceof FakeSocket)

    await room.webSocketMessage(firstServer, JSON.stringify(makeHello()))

    await room.webSocketMessage(
      firstServer,
      JSON.stringify({
        ...makeSyncUpdate(makeMessageId('message-bad')),
        update: 'AQID',
      } satisfies SyncUpdate),
    )

    assert.deepEqual(syncMessages(firstServer.sent), [])
    assert.deepEqual(syncMessages(secondServer.sent), [])
    const quarantined = storage.sql.quarantines.get('q-message-bad')
    assert(quarantined)
    assert.equal(Number.isSafeInteger(quarantined.createdAt), true)
    assert.deepEqual(quarantined, {
      id: 'q-message-bad',
      docId: 'meta',
      messageId: makeMessageId('message-bad'),
      deviceId: makeDeviceId('device-1'),
      reason: 'yjs-apply-failed',
      updateSha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
      updateBytes: Uint8Array.from([1, 2, 3]),
      createdAt: quarantined.createdAt,
    })
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom quarantines updates with mismatched wire hashes', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))

    room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    const update = {
      ...makeSyncUpdate(makeMessageId('message-hash-mismatch')),
      updateSha256: makeSha256Hex('0'.repeat(64)),
    } satisfies SyncUpdate
    await room.webSocketMessage(server, JSON.stringify(update))

    assert.deepEqual(syncMessages(server.sent), [])
    assert.equal(storage.sql.opLog.has('meta:message-hash-mismatch'), false)
    assert.equal(storage.sql.quarantines.get('q-message-hash-mismatch')?.reason, 'hash-mismatch')
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom treats repeated quarantine inserts as idempotent', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))

    room.fetch(await makeAuthenticatedWebSocketRequest())

    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    const invalidUpdate = JSON.stringify({
      ...makeSyncUpdate(makeMessageId('message-repeat-bad')),
      update: 'AQID',
    } satisfies SyncUpdate)

    await room.webSocketMessage(server, invalidUpdate)
    await room.webSocketMessage(server, invalidUpdate)

    assert.deepEqual(syncMessages(server.sent), [])
    assert.equal(server.closed, false)
    assert.equal(storage.sql.quarantines.get('q-message-repeat-bad')?.reason, 'yjs-apply-failed')
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom quarantines meta updates that fail MetaFile schema validation', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))

    room.fetch(await makeAuthenticatedWebSocketRequest())
    room.fetch(await makeAuthenticatedWebSocketRequest())

    const firstServer = state.accepted[0]
    const secondServer = state.accepted[1]
    assert(firstServer instanceof FakeSocket)
    assert(secondServer instanceof FakeSocket)

    await room.webSocketMessage(firstServer, JSON.stringify(makeHello()))

    await room.webSocketMessage(
      firstServer,
      JSON.stringify({
        ...makeSyncUpdate(makeMessageId('message-bad-meta')),
        update: makeInvalidMetaSchemaYjsUpdateBase64(),
      } satisfies SyncUpdate),
    )

    assert.deepEqual(syncMessages(firstServer.sent), [])
    assert.deepEqual(syncMessages(secondServer.sent), [])
    const quarantined = storage.sql.quarantines.get('q-message-bad-meta')
    assert(quarantined)
    assert.equal(quarantined.reason, 'meta-schema-invalid')
    assert.equal(quarantined.docId, 'meta')
    assert.equal(quarantined.messageId, makeMessageId('message-bad-meta'))
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom exposes authenticated quarantine list and detail inspection', async () => {
  const storage = new SqlOnlyStorage()
  storage.sql.quarantines.set('q-message-bad', {
    id: 'q-message-bad',
    docId: 'meta',
    messageId: 'message-bad',
    deviceId: 'device-1',
    reason: 'yjs-apply-failed',
    updateSha256: 'a'.repeat(64),
    updateBytes: Uint8Array.from([1, 2, 3]),
    createdAt: 123,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
  )

  const listResponse = await room.fetch(
    new Request('https://worker.example/admin/quarantine', {
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
          tokenVersion: 1,
        })}`,
      },
    }),
  )

  assert.equal(listResponse.status, 200)
  const listBody = await listResponse.json()
  assert.equal(v.is(QuarantinedUpdateListResponseSchema, listBody), true)
  assert.deepEqual(listBody, {
    entries: [
      {
        id: 'q-message-bad',
        docId: { kind: 'meta' },
        messageId: 'message-bad',
        deviceId: 'device-1',
        reason: 'yjs-apply-failed',
        updateSha256: 'a'.repeat(64),
        updateBytesLength: 3,
        createdAt: 123,
      },
    ],
  })

  const detailResponse = await room.fetch(
    new Request('https://worker.example/admin/quarantine/q-message-bad', {
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
          tokenVersion: 1,
        })}`,
      },
    }),
  )

  assert.equal(detailResponse.status, 200)
  const detailBody = await detailResponse.json()
  assert.equal(v.is(QuarantinedUpdateDetailResponseSchema, detailBody), true)
  assert.deepEqual(detailBody, {
    entry: listBody.entries[0],
    updateBytesBase64: 'AQID',
  })

  const missingResponse = await room.fetch(
    new Request('https://worker.example/admin/quarantine/q-missing', {
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
          tokenVersion: 1,
        })}`,
      },
    }),
  )
  assert.equal(missingResponse.status, 404)
  assert.deepEqual(await missingResponse.json(), { error: 'unknown-quarantine' })
})

test('VaultRoom rejects non-upgrade requests', async () => {
  const room = new VaultRoom(new FakeState(), makeEnv())

  const response = await room.fetch(new Request('https://worker.example/ws/vault-1'))

  assert.equal(response.status, 426)
})

function makeEnv(): WorkerEnv {
  return {
    VAULT_ROOM: {
      idFromName(): DurableObjectIdBinding {
        return {}
      },
      get(): DurableObjectStubBinding {
        return {
          async fetch(): Promise<Response> {
            return new Response('unused')
          },
        }
      },
    },
  }
}

function quarantineSqlRow(row: RecordedQuarantineRow): Record<string, unknown> {
  return {
    id: row.id,
    docId: row.docId,
    messageId: row.messageId,
    deviceId: row.deviceId,
    reason: row.reason,
    updateSha256: row.updateSha256,
    updateBytes: row.updateBytes,
    createdAt: row.createdAt,
  }
}

function makeEnvWithSnapshotBucket(bucket: R2BucketBinding): WorkerEnv {
  return { ...makeEnv(), SNAPSHOT_BUCKET: bucket }
}

function makeEnvWithSnapshotBucketAndDeviceTokenSecret(
  bucket: R2BucketBinding,
  secret: string,
): WorkerEnv {
  return { ...makeEnvWithSnapshotBucket(bucket), DEVICE_TOKEN_SECRET: secret }
}

function makeEnvWithDeviceTokenSecret(secret: string): WorkerEnv {
  return { ...makeEnv(), DEVICE_TOKEN_SECRET: secret }
}

async function makeAuthenticatedWebSocketRequest(
  secret = TEST_DEVICE_TOKEN_SECRET,
  overrides: Partial<DeviceTokenClaims> = {},
): Promise<Request> {
  return new Request('https://worker.example/ws/vault-1', {
    headers: {
      Upgrade: 'websocket',
      Authorization: `Bearer ${await makeDeviceToken(secret, {
        tokenVersion: 1,
        ...overrides,
      })}`,
    },
  })
}

function makeHello(): ClientHello {
  return {
    type: 'hello',
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    vaultId: makeVaultId('vault-1'),
    deviceId: makeDeviceId('device-1'),
    yClientId: 1,
    capabilities: [],
  }
}

function makeSyncUpdate(messageId: SyncUpdate['messageId']): SyncUpdate {
  return {
    type: 'sync-update',
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    vaultId: makeVaultId('vault-1'),
    deviceId: makeDeviceId('device-1'),
    messageId,
    docId: { kind: 'meta' },
    update: makeYjsUpdateBase64(messageId),
  }
}

function makeSyncRequest(messageId: SyncRequest['messageId'], stateVector: string): SyncRequest {
  return {
    type: 'sync-request',
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    vaultId: makeVaultId('vault-1'),
    deviceId: makeDeviceId('device-1'),
    messageId,
    docId: { kind: 'meta' },
    stateVector,
  }
}

function makeYjsUpdateBase64(messageId: SyncUpdate['messageId']): string {
  const doc = new Y.Doc()
  const fileId = makeFileId(`file-${messageId}`)
  doc.getMap('meta').set(fileId, {
    schemaVersion: 1,
    fileId,
    path: `${messageId}.md`,
    canonicalPath: `${messageId}.md`,
    deleted: false,
    type: 'text',
    ydocId: makeYDocId(`ydoc-${messageId}`),
    createdAt: 1,
    createdBy: makeDeviceId('device-1'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('device-1'),
    updatedAt: 1,
    updatedBy: makeDeviceId('device-1'),
    mtime: 1,
  })
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
}

function makeInvalidMetaSchemaYjsUpdateBase64(): string {
  const doc = new Y.Doc()
  const fileId = makeFileId('file-invalid-meta')
  doc.getMap('meta').set(fileId, {
    schemaVersion: 1,
    fileId,
    path: 'Valid.md',
    canonicalPath: 'wrong.md',
    deleted: false,
    type: 'text',
    ydocId: makeYDocId('ydoc-invalid-meta'),
    createdAt: 1,
    createdBy: makeDeviceId('device-1'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('device-1'),
    updatedAt: 1,
    updatedBy: makeDeviceId('device-1'),
    mtime: 1,
  })
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
}

function makeLargeFileYjsUpdateBase64(): string {
  const doc = new Y.Doc()
  doc.getText('content').insert(0, 'x'.repeat(600 * 1024))
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
}

function makeYjsUpdateBytes(messageId: SyncUpdate['messageId']): Uint8Array {
  return new Uint8Array(Buffer.from(makeYjsUpdateBase64(messageId), 'base64'))
}

function stringMessageAt(messages: readonly (string | ArrayBuffer)[], index: number): string {
  const message = syncMessages(messages)[index]
  if (message === undefined) {
    throw new Error(`missing message at index ${index}`)
  }
  return stringMessage(message)
}

function findAckForMessage(
  messages: readonly (string | ArrayBuffer)[],
  messageId: string,
): Ack | undefined {
  for (const message of syncMessages(messages)) {
    if (typeof message !== 'string') {
      continue
    }
    const parsed = JSON.parse(message) as unknown
    if (v.is(AckSchema, parsed) && parsed.messageId === messageId) {
      return parsed
    }
  }
  return undefined
}

function syncMessages(
  messages: readonly (string | ArrayBuffer)[],
): readonly (string | ArrayBuffer)[] {
  return messages.filter((message) => {
    if (typeof message !== 'string') {
      return true
    }
    return (JSON.parse(message) as { readonly type?: string }).type !== 'hello-accepted'
  })
}

function stringMessage(message: string | ArrayBuffer): string {
  if (typeof message !== 'string') {
    throw new Error('expected string message')
  }
  return message
}

function makeArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

function makeStateVectorBase64(doc: Y.Doc): string {
  return Buffer.from(Y.encodeStateVector(doc)).toString('base64')
}

function decodeTestBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'))
}

async function makeDeviceToken(
  secret: string,
  overrides: Partial<DeviceTokenClaims> = {},
): Promise<string> {
  const now = Date.now()
  const claims: DeviceTokenClaims = {
    iss: DEVICE_TOKEN_ISSUER,
    aud: makeVaultId('vault-1'),
    sub: makeDeviceId('device-1'),
    scope: ['sync:read', 'sync:write'] satisfies readonly DeviceTokenScope[],
    iat: now - 1_000,
    exp: now + 60_000,
    tokenVersion: 2,
    ...overrides,
  }
  const encodedHeader = encodeTestBase64Url(
    new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
  )
  const encodedPayload = encodeTestBase64Url(new TextEncoder().encode(JSON.stringify(claims)))
  const signature = await signTestHs256(`${encodedHeader}.${encodedPayload}`, secret)
  return `${encodedHeader}.${encodedPayload}.${encodeTestBase64Url(signature)}`
}

async function signTestHs256(data: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)))
}

function encodeTestBase64Url(value: Uint8Array): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

async function hashTestText(value: string): Promise<string> {
  return hashTestBytes(new TextEncoder().encode(value))
}

async function hashTestBytes(value: Uint8Array): Promise<string> {
  const bytes = new Uint8Array(value.byteLength)
  bytes.set(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function testBlobManifest(): BlobManifest {
  return {
    version: 1,
    fileId: makeFileId('file-1'),
    contentSha256: makeSha256Hex('f'.repeat(64)),
    size: 123,
    chunks: [
      { sha256: makeSha256Hex('d'.repeat(64)), offset: 0, size: 64 },
      { sha256: makeSha256Hex('e'.repeat(64)), offset: 64, size: 59 },
    ],
    createdBy: makeDeviceId('device-1'),
    createdAt: 1_000,
  }
}

function expectString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('expected string SQL binding')
  }
  return value
}

function expectNumber(value: unknown): number {
  if (typeof value !== 'number') {
    throw new Error('expected number SQL binding')
  }
  return value
}

function expectUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }
  throw new Error('expected Uint8Array SQL binding')
}

function installFakeWebSocketPair(): unknown {
  const globalWithPair = globalThis as typeof globalThis & {
    WebSocketPair?: typeof FakeWebSocketPair
  }
  const previous = globalWithPair.WebSocketPair
  globalWithPair.WebSocketPair = FakeWebSocketPair
  return previous
}

function installFakeUpgradeResponse(): unknown {
  const globalWithResponse = globalThis as typeof globalThis & {
    Response: typeof Response
  }
  const previous = globalWithResponse.Response
  globalWithResponse.Response = FakeUpgradeResponse as unknown as typeof Response
  return previous
}

function restoreWebSocketPair(previous: unknown): void {
  const globalWithPair = globalThis as typeof globalThis & {
    WebSocketPair?: typeof FakeWebSocketPair
  }
  if (previous === undefined) {
    delete globalWithPair.WebSocketPair
    return
  }
  globalWithPair.WebSocketPair = previous as typeof FakeWebSocketPair
}

function restoreResponse(previous: unknown): void {
  const globalWithResponse = globalThis as typeof globalThis & {
    Response: typeof Response
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  globalWithResponse.Response = previous as typeof Response
}
