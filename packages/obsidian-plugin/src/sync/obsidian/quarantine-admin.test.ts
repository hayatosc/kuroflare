import { makeDeviceId, makeVaultId } from '@kuroflare/core'
import { assert, test } from 'vitest'

import type { LocalSetupMetadata } from '../engine/setup'
import {
  executeQuarantineAdminAction,
  fetchQuarantineAdminDetail,
  fetchQuarantineAdminEntries,
  prepareQuarantineAdminAction,
  type QuarantineAdminHttpPort,
} from './quarantine-admin'

const setup = {
  endpoint: 'https://sync.example.test/base',
  vaultId: makeVaultId('vault-1'),
  deviceId: makeDeviceId('device-1'),
  yClientId: 1,
  protocolVersion: 1,
  bootstrapMode: 'join-existing',
  tokenVersion: 1,
} satisfies LocalSetupMetadata

const entry = {
  id: 'quarantine-1',
  docId: { kind: 'meta' },
  messageId: 'message-1',
  deviceId: makeDeviceId('device-1'),
  reason: 'meta-schema-invalid',
  updateSha256: 'a'.repeat(64),
  updateBytesLength: 4,
  createdAt: 10,
} as const

test('quarantine admin fetches and guards list/detail responses', async () => {
  const http = new QueueHttpPort([
    jsonResponse({ entries: [entry] }),
    jsonResponse({ entry, updateBytesBase64: 'AQIDBA==' }),
  ])

  assert.deepEqual(
    await fetchQuarantineAdminEntries({ setup, accessToken: 'access-token', http }),
    { ok: true, entries: [entry] },
  )
  assert.deepEqual(
    await fetchQuarantineAdminDetail({
      setup,
      accessToken: 'access-token',
      id: entry.id,
      http,
    }),
    { ok: true, detail: { entry, updateBytesBase64: 'AQIDBA==' } },
  )
  assert.deepEqual(
    http.requests.map((request) => ({
      url: request.url,
      authorization: headerValue(request.init?.headers, 'Authorization'),
    })),
    [
      {
        url: 'https://sync.example.test/admin/quarantine',
        authorization: 'Bearer access-token',
      },
      {
        url: 'https://sync.example.test/admin/quarantine/quarantine-1',
        authorization: 'Bearer access-token',
      },
    ],
  )
})

test('quarantine admin prepares and executes actions with server confirmation tokens', async () => {
  const http = new QueueHttpPort([
    jsonResponse({
      action: 'discard',
      id: entry.id,
      mode: 'dry-run',
      confirmationRequired: true,
      confirmationToken: 'confirmation-token',
      effects: [{ kind: 'quarantine-discard', count: 1 }],
    }),
    jsonResponse({
      action: 'discard',
      id: entry.id,
      applied: true,
      effects: [{ kind: 'quarantine-discard', count: 1 }],
    }),
  ])

  assert.deepEqual(
    await prepareQuarantineAdminAction({
      setup,
      accessToken: 'access-token',
      id: entry.id,
      action: 'discard',
      http,
    }),
    {
      ok: true,
      dryRun: {
        action: 'discard',
        id: entry.id,
        mode: 'dry-run',
        confirmationRequired: true,
        confirmationToken: 'confirmation-token',
        effects: [{ kind: 'quarantine-discard', count: 1 }],
      },
    },
  )
  assert.deepEqual(
    await executeQuarantineAdminAction({
      setup,
      accessToken: 'access-token',
      id: entry.id,
      action: 'discard',
      confirmationToken: 'confirmation-token',
      http,
    }),
    {
      ok: true,
      response: {
        action: 'discard',
        id: entry.id,
        applied: true,
        effects: [{ kind: 'quarantine-discard', count: 1 }],
      },
    },
  )

  assert.deepEqual(
    http.requests.map((request) => ({
      url: request.url,
      method: request.init?.method,
      body: requestBodyJson(request.init?.body),
    })),
    [
      {
        url: 'https://sync.example.test/admin/quarantine/quarantine-1/discard',
        method: 'POST',
        body: { mode: 'dry-run' },
      },
      {
        url: 'https://sync.example.test/admin/quarantine/quarantine-1/discard',
        method: 'POST',
        body: {
          mode: 'execute',
          confirmationToken: 'confirmation-token',
          reason: 'obsidian-plugin-admin',
        },
      },
    ],
  )
})

test('quarantine admin rejects mismatched action responses', async () => {
  const http = new QueueHttpPort([
    jsonResponse({
      action: 'force-apply',
      id: entry.id,
      mode: 'dry-run',
      confirmationRequired: true,
      confirmationToken: 'confirmation-token',
      effects: [{ kind: 'quarantine-force-apply', count: 1 }],
    }),
  ])

  assert.deepEqual(
    await prepareQuarantineAdminAction({
      setup,
      accessToken: 'access-token',
      id: entry.id,
      action: 'discard',
      http,
    }),
    { ok: false, reason: 'mismatched-response' },
  )
})

class QueueHttpPort implements QuarantineAdminHttpPort {
  readonly requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = []

  constructor(private readonly responses: Response[]) {}

  async fetch(url: string, init?: RequestInit): Promise<Response> {
    this.requests.push({ url, init })
    const response = this.responses.shift()
    if (response === undefined) {
      throw new Error(`unexpected fetch: ${url}`)
    }
    return response
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function headerValue(headers: HeadersInit | undefined, key: string): string | undefined {
  if (headers === undefined) {
    return undefined
  }
  if (headers instanceof Headers) {
    return headers.get(key) ?? undefined
  }
  if (Array.isArray(headers)) {
    return headers.find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1]
  }
  return headers[key]
}

function requestBodyJson(body: BodyInit | null | undefined): unknown {
  if (typeof body !== 'string') {
    return undefined
  }
  return JSON.parse(body)
}
