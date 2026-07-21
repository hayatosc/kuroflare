import { makeDeviceId, makeVaultId, makeYDocId } from '@kuroflare/core'
import { assert, test } from 'vitest'

import { createWorkerClient } from '../api-client'
import type { LocalSetupMetadata } from '../engine/setup'
import {
  fetchSnapshotHealthEntries,
  quarantineSnapshotHealthEntry,
  rollbackSnapshotHealthEntry,
  verifySnapshotHealthEntry,
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

function createTestClient(responses: Response[]): {
  client: ReturnType<typeof createWorkerClient>
  requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }>
} {
  const requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = []
  const fetchMock = async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: fetchUrl(url), init })
    const response = responses.shift()
    if (response === undefined) throw new Error(`unexpected fetch: ${fetchUrl(url)}`)
    return response
  }
  const client = createWorkerClient('https://sync.example.test/base', undefined, fetchMock)
  return { client, requests }
}

test('snapshot health list guards responses, sends sync:write bearer, and paginates', async () => {
  const { client, requests } = createTestClient([
    jsonResponse({ entries: [entry], nextCursor: '1' }),
    jsonResponse({ entries: [] }),
  ])

  assert.deepEqual(
    await fetchSnapshotHealthEntries({
      setup,
      accessToken: 'device-access-token',
      docId,
      limit: 1,
      http: client,
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
      http: client,
    }),
    { ok: true, response: { entries: [] } },
  )
  assert.deepEqual(
    requests.map((request) => ({
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
  const { client, requests } = createTestClient([jsonResponse({ unexpected: true })])
  assert.deepEqual(
    await fetchSnapshotHealthEntries({
      setup,
      accessToken: 'device-access-token',
      docId,
      limit: 0,
      http: client,
    }),
    { ok: false, reason: 'invalid-request' },
  )
  assert.equal(requests.length, 0)

  const invalidResponseResult = await fetchSnapshotHealthEntries({
    setup,
    accessToken: 'device-access-token',
    docId,
    http: client,
  })
  assert.deepEqual(invalidResponseResult, { ok: false, reason: 'invalid-response' })
})

test('snapshot health mutations guard request/response and include explicit confirmations', async () => {
  const { client, requests } = createTestClient([
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
    http: client,
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
    http: client,
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
        http: client,
      })
    ).ok,
    true,
  )

  assert.deepEqual(
    requests.map((request) => ({
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
  const { client, requests } = createTestClient([jsonResponse({ error: 'nope' }, 403)])
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
    http: client,
  })
  assert.deepEqual(invalid, { ok: false, reason: 'invalid-request' })
  assert.equal(requests.length, 0)

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
    http: client,
  })
  assert.deepEqual(failed, { ok: false, reason: 'http-failed', status: 403 })
})

test('snapshot health client handles missing credentials and network failures without leaking them', async () => {
  const fetchMock = async (): Promise<Response> => {
    throw new Error('network failure')
  }
  const client = createWorkerClient('https://sync.example.test/base', undefined, fetchMock)

  assert.deepEqual(
    await fetchSnapshotHealthEntries({
      setup,
      accessToken: ' ',
      docId,
      http: client,
    }),
    { ok: false, reason: 'invalid-request' },
  )
  assert.deepEqual(
    await fetchSnapshotHealthEntries({
      setup,
      accessToken: 'device-access-token',
      docId,
      http: client,
    }),
    { ok: false, reason: 'http-failed' },
  )
})

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

function fetchUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}
