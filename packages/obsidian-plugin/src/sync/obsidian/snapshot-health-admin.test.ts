import { makeDeviceId, makeVaultId, makeYDocId } from '@kuroflare/core'
import { assert, test } from 'vitest'

import type { LocalSetupMetadata } from '../engine/setup'
import {
  fetchSnapshotHealthEntries,
  quarantineSnapshotHealthEntry,
  rollbackSnapshotHealthEntry,
  verifySnapshotHealthEntry,
  type SnapshotHealthAdminHttpPort,
} from './snapshot-health-admin'

const setup = {
  endpoint: 'https://sync.example.test/base',
  vaultId: makeVaultId('vault-1'),
  deviceId: makeDeviceId('device-1'),
  protocolVersion: 1,
  bootstrapMode: 'join-existing',
  tokenVersion: 1,
} satisfies LocalSetupMetadata

const docId = { kind: 'file', ydocId: makeYDocId('ydoc-1') } as const
const snapshotKey = 'snapshots/vault-1/file/1.yupdate'
const entry = {
  docId,
  snapshotKey,
  upperSeq: 1,
  actor: 'device-1',
  authorityStatus: 'authoritative' as const,
  allowedActions: ['quarantine', 'rollback'] as ('verify' | 'quarantine' | 'rollback')[],
  physicalStatus: 'verified' as const,
  logicalStatus: 'healthy' as const,
  reasons: [] as string[],
  observedAt: 10,
}

test('snapshot health list guards responses, sends sync:write bearer, and paginates', async () => {
  const http = new QueueHttpPort([
    jsonResponse({ entries: [entry], nextCursor: '1' }),
    jsonResponse({ entries: [] }),
  ])

  assert.deepEqual(
    await fetchSnapshotHealthEntries({
      setup,
      accessToken: 'device-access-token',
      docId,
      limit: 1,
      http,
    }),
    { ok: true, response: { entries: [entry], nextCursor: '1' } },
  )
  assert.deepEqual(
    await fetchSnapshotHealthEntries({
      setup,
      accessToken: 'device-access-token',
      docId,
      limit: 1,
      cursor: '1',
      http,
    }),
    { ok: true, response: { entries: [] } },
  )
  assert.deepEqual(
    http.requests.map((request) => ({
      url: request.url,
      authorization: headerValue(request.init?.headers, 'Authorization'),
    })),
    [
      {
        url: 'https://sync.example.test/admin/snapshots?docId=file%3Aydoc-1&limit=1',
        authorization: 'Bearer device-access-token',
      },
      {
        url: 'https://sync.example.test/admin/snapshots?docId=file%3Aydoc-1&limit=1&cursor=1',
        authorization: 'Bearer device-access-token',
      },
    ],
  )
})

test('snapshot health list rejects invalid request and invalid response without fetching', async () => {
  const http = new QueueHttpPort([jsonResponse({ unexpected: true })])
  assert.deepEqual(
    await fetchSnapshotHealthEntries({
      setup,
      accessToken: 'device-access-token',
      docId,
      limit: 0,
      http,
    }),
    { ok: false, reason: 'invalid-request' },
  )
  assert.equal(http.requests.length, 0)

  const invalidResponseResult = await fetchSnapshotHealthEntries({
    setup,
    accessToken: 'device-access-token',
    docId,
    http,
  })
  assert.deepEqual(invalidResponseResult, { ok: false, reason: 'invalid-response' })
})

test('snapshot health mutations guard request/response and include explicit confirmations', async () => {
  const http = new QueueHttpPort([
    jsonResponse({ ok: true, entry }),
    jsonResponse({
      ok: true,
      entry: {
        ...entry,
        logicalStatus: 'quarantined',
        allowedActions: [],
        actionBlockReason: 'snapshot-health-already-quarantined',
      },
    }),
    jsonResponse({
      ok: true,
      docId,
      actor: 'device-1',
      snapshotKey: 'snapshots/vault-1/file/2.yupdate',
      snapshotSeq: 2,
      sourceSnapshotKey: snapshotKey,
      sourceSnapshotSeq: 1,
      auditId: 'audit-1',
    }),
  ])

  const verifyResult = await verifySnapshotHealthEntry({
    setup,
    accessToken: 'device-access-token',
    request: {
      docId,
      snapshotKey,
      upperSeq: 1,
      reason: 'operator verified bytes',
      confirmation: 'verify',
    },
    http,
  })
  assert.equal(verifyResult.ok, true)
  if (verifyResult.ok) assert.equal(verifyResult.response.entry.authorityStatus, 'authoritative')

  const quarantineResult = await quarantineSnapshotHealthEntry({
    setup,
    accessToken: 'device-access-token',
    request: {
      docId,
      snapshotKey,
      upperSeq: 1,
      reason: 'operator quarantined source',
      confirmation: 'quarantine',
    },
    http,
  })
  assert.equal(quarantineResult.ok, true)
  if (quarantineResult.ok) {
    assert.equal(quarantineResult.response.entry.logicalStatus, 'quarantined')
    assert.equal(quarantineResult.response.entry.authorityStatus, 'authoritative')
  }
  assert.equal(
    (
      await rollbackSnapshotHealthEntry({
        setup,
        accessToken: 'device-access-token',
        request: {
          docId,
          snapshotKey,
          upperSeq: 1,
          reason: 'operator rolled back source',
          confirmation: 'rollback',
        },
        http,
      })
    ).ok,
    true,
  )

  assert.deepEqual(
    http.requests.map((request) => ({
      url: request.url,
      method: request.init?.method,
      authorization: headerValue(request.init?.headers, 'Authorization'),
      body: requestBodyJson(request.init?.body),
    })),
    [
      {
        url: 'https://sync.example.test/admin/snapshots/verify',
        method: 'POST',
        authorization: 'Bearer device-access-token',
        body: {
          docId,
          snapshotKey,
          upperSeq: 1,
          reason: 'operator verified bytes',
          confirmation: 'verify',
        },
      },
      {
        url: 'https://sync.example.test/admin/snapshots/quarantine',
        method: 'POST',
        authorization: 'Bearer device-access-token',
        body: {
          docId,
          snapshotKey,
          upperSeq: 1,
          reason: 'operator quarantined source',
          confirmation: 'quarantine',
        },
      },
      {
        url: 'https://sync.example.test/admin/snapshots/rollback',
        method: 'POST',
        authorization: 'Bearer device-access-token',
        body: {
          docId,
          snapshotKey,
          upperSeq: 1,
          reason: 'operator rolled back source',
          confirmation: 'rollback',
        },
      },
    ],
  )
})

test('snapshot health mutations reject invalid confirmation and HTTP errors', async () => {
  const http = new QueueHttpPort([jsonResponse({ error: 'nope' }, 403)])
  const invalid = await verifySnapshotHealthEntry({
    setup,
    accessToken: 'device-access-token',
    request: {
      docId,
      snapshotKey,
      upperSeq: 1,
      reason: 'operator reason',
      confirmation: 'wrong',
    },
    http,
  })
  assert.deepEqual(invalid, { ok: false, reason: 'invalid-request' })
  assert.equal(http.requests.length, 0)

  const failed = await rollbackSnapshotHealthEntry({
    setup,
    accessToken: 'device-access-token',
    request: {
      docId,
      snapshotKey,
      upperSeq: 1,
      reason: 'operator reason',
      confirmation: 'rollback',
    },
    http,
  })
  assert.deepEqual(failed, { ok: false, reason: 'http-failed', status: 403 })
})

test('snapshot health client handles missing credentials and network failures without leaking them', async () => {
  const http = new ThrowingHttpPort()
  assert.deepEqual(
    await fetchSnapshotHealthEntries({
      setup,
      accessToken: ' ',
      docId,
      http,
    }),
    { ok: false, reason: 'invalid-request' },
  )
  assert.deepEqual(
    await fetchSnapshotHealthEntries({
      setup,
      accessToken: 'device-access-token',
      docId,
      http,
    }),
    { ok: false, reason: 'http-failed' },
  )
})

class QueueHttpPort implements SnapshotHealthAdminHttpPort {
  readonly requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = []

  constructor(private readonly responses: Response[]) {}

  async fetch(url: string, init?: RequestInit): Promise<Response> {
    this.requests.push({ url, init })
    const response = this.responses.shift()
    if (response === undefined) throw new Error(`unexpected fetch: ${url}`)
    return response
  }
}

class ThrowingHttpPort implements SnapshotHealthAdminHttpPort {
  async fetch(): Promise<Response> {
    throw new Error('network failure')
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function headerValue(headers: HeadersInit | undefined, key: string): string | undefined {
  if (headers === undefined) return undefined
  if (headers instanceof Headers) return headers.get(key) ?? undefined
  if (Array.isArray(headers)) {
    return headers.find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1]
  }
  return headers[key]
}

function requestBodyJson(body: BodyInit | null | undefined): unknown {
  return typeof body === 'string' ? JSON.parse(body) : undefined
}
