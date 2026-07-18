import { sValidator } from '@hono/standard-validator'
import {
  BlobHeadRequestSchema,
  BlobHeadResponseSchema,
  BlobMultipartAbortRequestSchema,
  BlobMultipartCompleteRequestSchema,
  BlobUploadIdSchema,
  BlobUploadUrlRequestSchema,
  BlobUploadUrlResponseSchema,
  DeviceIdSchema,
  DeviceTokenRefreshRequestSchema,
  DeviceTokenRefreshResponseSchema,
  DocLatestSnapshotResponseSchema,
  LocalOutboxRepairEvidenceRequestSchema,
  LocalOutboxRepairEvidenceResponseSchema,
  MetaLatestSnapshotResponseSchema,
  QuarantineAuditListResponseSchema,
  QuarantinedUpdateActionHttpRequestSchema,
  QuarantinedUpdateActionHttpResponseSchema,
  QuarantinedUpdateDetailResponseSchema,
  QuarantinedUpdateListResponseSchema,
  RevokeDeviceRequestSchema,
  RevokeDeviceResponseSchema,
  SetupExchangeRequestSchema,
  SetupExchangeResponseSchema,
  Sha256HexSchema,
  SnapshotHealthListResponseSchema,
  SnapshotHealthMutationResponseSchema,
  SnapshotHealthQuarantineRequestSchema,
  SnapshotHealthVerifyRequestSchema,
  SnapshotImportRequestSchema,
  SnapshotImportResponseSchema,
  SnapshotRollbackRequestSchema,
  SnapshotRollbackResponseSchema,
  VaultIdSchema,
  YDocIdSchema,
  verifyHs256DeviceToken,
  type DeviceTokenClaims,
  type VaultId,
} from '@kuroflare/core'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import * as v from 'valibot'

import {
  type WorkerEnv,
  AdminSetupTokenIssueRequestSchema,
  AdminSnapshotSeedRequestSchema,
} from './types'
import { apiErrorBody, extractBearerToken, timingSafeEqualString } from './utils'

// sValidator('json', ...) requires Content-Type: application/json.
// Requests without it receive a 400 with a field-level validation error.

const WEBSOCKET_UPGRADE = 'websocket'
const ADMIN_TOKEN_HEADER = 'x-kuroflare-admin-secret'
const ADMIN_SETUP_TOKEN_PATH = '/admin/setup-tokens'
const ADMIN_SNAPSHOT_SEED_PATH = '/admin/snapshots/seed'

/** Event shape returned by `GET /admin/retention` (matches DO `handleRetentionInspect` response). */
const RetentionEventSchema = v.object({
  docId: v.string(),
  snapshotKey: v.string(),
  action: v.string(),
  error: v.union([v.string(), v.null_()]),
  attemptedAt: v.number(),
})
const RetentionListResponseSchema = v.object({
  items: v.array(RetentionEventSchema),
  nextCursor: v.optional(v.string()),
})

/** Rejects a request unless it carries the operator's admin secret via constant-time compare. */
function authorizeAdminRequest(c: Context<{ Bindings: WorkerEnv }>): Response | undefined {
  const secret = c.env.ADMIN_TOKEN_SECRET
  if (secret === undefined) {
    return c.json(apiErrorBody('server/degraded', 'admin-secret-not-configured'), 503)
  }
  const header = c.req.header(ADMIN_TOKEN_HEADER)
  if (header === undefined || !timingSafeEqualString(header, secret)) {
    return c.json(apiErrorBody('auth/rejected', 'admin-auth-rejected'), 403)
  }
  return undefined
}

async function verifyBearerToken(
  env: WorkerEnv,
  request: Request,
): Promise<DeviceTokenClaims | undefined> {
  const secret = env.DEVICE_TOKEN_SECRET
  const token = extractBearerToken(request.headers.get('Authorization'))
  if (secret === undefined || token === undefined) return undefined
  return verifyHs256DeviceToken({ token, secret })
}

function routeVaultRoom(env: WorkerEnv, request: Request, vaultId: VaultId): Promise<Response> {
  const id = env.VAULT_ROOM.idFromName(vaultId)
  const room = env.VAULT_ROOM.get(id)
  return Promise.resolve(room.fetch(request))
}

/** Union of error status codes that the DO may return through `c.json()`. */
type DOErrorStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503

/**
 * Tries to parse the DO response body against `outputSchema`. On success
 * re-serialises it via `c.json` so Hono RPC captures the output type.
 * On error parses the error body and returns it via `c.json` to preserve
 * RPC typing. When the body is not JSON or the schema does not match, the
 * original response is returned unchanged (used by routing tests with text fakes).
 */
async function parseDOorPassthrough<T>(
  c: Context<{ Bindings: WorkerEnv }>,
  response: Response,
  outputSchema: v.GenericSchema<T>,
): Promise<Response> {
  if (!response.ok) {
    let body: unknown
    try {
      const clone = response.clone()
      body = await clone.json()
    } catch {
      return c.json(apiErrorBody('server/error', 'DO-error-not-json'), 500)
    }
    return c.json(body, response.status as DOErrorStatus)
  }
  let body: unknown
  try {
    // Clone the response so the original body is preserved if JSON parsing fails
    const clone = response.clone()
    body = await clone.json()
  } catch {
    return response
  }
  const parsed = v.safeParse(outputSchema, body)
  if (!parsed.success) return response
  return c.json(parsed.output, response.status as 200)
}

/**
 * Forwards the request to the vault room with bearer-token auth and types the
 * successful response against `outputSchema`. Error responses are passed through.
 */
async function forwardAuthorizedTyped<T>(
  c: Context<{ Bindings: WorkerEnv }>,
  outputSchema: v.GenericSchema<T>,
): Promise<Response> {
  const claims = await verifyBearerToken(c.env, c.req.raw)
  if (claims === undefined)
    return c.json(apiErrorBody('auth/rejected', 'auth-reject:invalid-token'), 401)
  const response = await routeVaultRoom(c.env, c.req.raw, claims.aud)
  return parseDOorPassthrough(c, response, outputSchema)
}

export const workerApp = new Hono<{ Bindings: WorkerEnv }>()

workerApp.use(
  '*',
  cors({
    origin: '*',
    allowHeaders: ['Authorization', 'Content-Type', ADMIN_TOKEN_HEADER],
    allowMethods: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT'],
  }),
)

// ---- Admin-only routes (admin secret auth, forward to DO, no response typing) ----

workerApp.post(
  ADMIN_SETUP_TOKEN_PATH,
  sValidator('json', AdminSetupTokenIssueRequestSchema),
  async (c) => {
    const rejection = authorizeAdminRequest(c)
    if (rejection !== undefined) return rejection
    const body = c.req.valid('json')
    const doRequest = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers: c.req.raw.headers,
      body: JSON.stringify(body),
    })
    return routeVaultRoom(c.env, doRequest, body.vaultId)
  },
)

workerApp.post(
  ADMIN_SNAPSHOT_SEED_PATH,
  sValidator('json', AdminSnapshotSeedRequestSchema),
  async (c) => {
    const rejection = authorizeAdminRequest(c)
    if (rejection !== undefined) return rejection
    const body = c.req.valid('json')
    const doRequest = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers: c.req.raw.headers,
      body: JSON.stringify(body),
    })
    return routeVaultRoom(c.env, doRequest, body.vaultId)
  },
)

// ---- Setup exchange (no auth, forward to DO, response typed) ----

workerApp.post('/setup/exchange', sValidator('json', SetupExchangeRequestSchema), async (c) => {
  const body = c.req.valid('json')
  const doRequest = new Request(c.req.raw.url, {
    method: c.req.raw.method,
    headers: c.req.raw.headers,
    body: JSON.stringify(body),
  })
  const response = await routeVaultRoom(c.env, doRequest, body.vaultId)
  return parseDOorPassthrough(c, response, SetupExchangeResponseSchema)
})

// ---- Auth verify (bearer token, no DO, response typed) ----

workerApp.get('/auth/verify', async (c) => {
  const claims = await verifyBearerToken(c.env, c.req.raw)
  if (claims === undefined)
    return c.json(apiErrorBody('auth/rejected', 'auth-reject:invalid-token'), 401)
  return c.json(claims)
})

// ---- Auth refresh (no auth, forward to DO, response typed) ----

workerApp.post('/auth/refresh', sValidator('json', DeviceTokenRefreshRequestSchema), async (c) => {
  const body = c.req.valid('json')
  const doRequest = new Request(c.req.raw.url, {
    method: c.req.raw.method,
    headers: c.req.raw.headers,
    body: JSON.stringify(body),
  })
  const response = await routeVaultRoom(c.env, doRequest, body.vaultId)
  return parseDOorPassthrough(c, response, DeviceTokenRefreshResponseSchema)
})

// ---- Device revoke (bearer auth, forward to DO, response typed) ----

workerApp.post(
  '/devices/:deviceId/revoke',
  sValidator('param', v.object({ deviceId: DeviceIdSchema })),
  sValidator('json', RevokeDeviceRequestSchema),
  async (c) => {
    const body = c.req.valid('json')
    const doRequest = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers: c.req.raw.headers,
      body: JSON.stringify(body),
    })
    const claims = await verifyBearerToken(c.env, c.req.raw)
    if (claims === undefined)
      return c.json(apiErrorBody('auth/rejected', 'auth-reject:invalid-token'), 401)
    const response = await routeVaultRoom(c.env, doRequest, claims.aud)
    return parseDOorPassthrough(c, response, RevokeDeviceResponseSchema)
  },
)

// ---- Quarantine admin (bearer auth, forward to DO, response typed) ----

const QuarantineListQuerySchema = v.object({
  limit: v.optional(
    v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(1)),
  ),
  cursor: v.optional(v.pipe(v.string(), v.minLength(1))),
})

workerApp.get('/admin/quarantine', sValidator('query', QuarantineListQuerySchema), (c) =>
  forwardAuthorizedTyped(c, QuarantinedUpdateListResponseSchema),
)

workerApp.get('/admin/quarantine/audit', sValidator('query', QuarantineListQuerySchema), (c) =>
  forwardAuthorizedTyped(c, QuarantineAuditListResponseSchema),
)

workerApp.get(
  '/admin/quarantine/:id',
  sValidator('param', v.object({ id: v.pipe(v.string(), v.minLength(1)) })),
  (c) => forwardAuthorizedTyped(c, QuarantinedUpdateDetailResponseSchema),
)

workerApp.get('/admin/retention', sValidator('query', QuarantineListQuerySchema), (c) =>
  forwardAuthorizedTyped(c, RetentionListResponseSchema),
)

// ---- Quarantine action (bearer auth, body validated, forward to DO, response typed) ----

const QuarantineIdParamSchema = v.object({ id: v.pipe(v.string(), v.minLength(1)) })

for (const action of ['discard', 'force-apply'] as const) {
  workerApp.post(
    `/admin/quarantine/:id/${action}`,
    sValidator('param', QuarantineIdParamSchema),
    sValidator('json', QuarantinedUpdateActionHttpRequestSchema),
    async (c) => {
      const body = c.req.valid('json')
      const doRequest = new Request(c.req.raw.url, {
        method: c.req.raw.method,
        headers: c.req.raw.headers,
        body: JSON.stringify(body),
      })
      const claims = await verifyBearerToken(c.env, c.req.raw)
      if (claims === undefined)
        return c.json(apiErrorBody('auth/rejected', 'auth-reject:invalid-token'), 401)
      const response = await routeVaultRoom(c.env, doRequest, claims.aud)
      return parseDOorPassthrough(c, response, QuarantinedUpdateActionHttpResponseSchema)
    },
  )
}

// ---- Snapshot health list (bearer auth, forward to DO, response typed) ----

const SnapshotHealthQuerySchema = v.object({
  docId: v.optional(v.pipe(v.string(), v.minLength(1))),
  limit: v.optional(
    v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(1)),
  ),
  cursor: v.optional(v.pipe(v.string(), v.minLength(1))),
})

workerApp.get('/admin/snapshots', sValidator('query', SnapshotHealthQuerySchema), (c) =>
  forwardAuthorizedTyped(c, SnapshotHealthListResponseSchema),
)

// ---- Snapshot health mutations — each route inlined for type-safe schema handling ----

workerApp.post(
  '/admin/snapshots/verify',
  sValidator('json', SnapshotHealthVerifyRequestSchema),
  async (c) => {
    const body = c.req.valid('json')
    const doRequest = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers: c.req.raw.headers,
      body: JSON.stringify(body),
    })
    const claims = await verifyBearerToken(c.env, c.req.raw)
    if (claims === undefined)
      return c.json(apiErrorBody('auth/rejected', 'auth-reject:invalid-token'), 401)
    const response = await routeVaultRoom(c.env, doRequest, claims.aud)
    return parseDOorPassthrough(c, response, SnapshotHealthMutationResponseSchema)
  },
)

workerApp.post(
  '/admin/snapshots/quarantine',
  sValidator('json', SnapshotHealthQuarantineRequestSchema),
  async (c) => {
    const body = c.req.valid('json')
    const doRequest = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers: c.req.raw.headers,
      body: JSON.stringify(body),
    })
    const claims = await verifyBearerToken(c.env, c.req.raw)
    if (claims === undefined)
      return c.json(apiErrorBody('auth/rejected', 'auth-reject:invalid-token'), 401)
    const response = await routeVaultRoom(c.env, doRequest, claims.aud)
    return parseDOorPassthrough(c, response, SnapshotHealthMutationResponseSchema)
  },
)

workerApp.post(
  '/admin/snapshots/rollback',
  sValidator('json', SnapshotRollbackRequestSchema),
  async (c) => {
    const body = c.req.valid('json')
    const doRequest = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers: c.req.raw.headers,
      body: JSON.stringify(body),
    })
    const claims = await verifyBearerToken(c.env, c.req.raw)
    if (claims === undefined)
      return c.json(apiErrorBody('auth/rejected', 'auth-reject:invalid-token'), 401)
    const response = await routeVaultRoom(c.env, doRequest, claims.aud)
    return parseDOorPassthrough(c, response, SnapshotRollbackResponseSchema)
  },
)

// ---- Snapshot health mutations with :docId param ----

const DocIdParamSchema = v.object({ docId: v.pipe(v.string(), v.minLength(1)) })

function snapshotHealthRouteDocMatches(
  routeDocId: string,
  docId: { readonly kind: 'meta' } | { readonly kind: 'file'; readonly ydocId: string },
): boolean {
  return docId.kind === 'meta' ? routeDocId === 'meta' : routeDocId === docId.ydocId
}

workerApp.post(
  '/admin/snapshots/:docId/verify',
  sValidator('param', DocIdParamSchema),
  sValidator('json', SnapshotHealthVerifyRequestSchema),
  async (c) => {
    const { docId } = c.req.valid('param')
    const body = c.req.valid('json')
    if (!snapshotHealthRouteDocMatches(docId, body.docId)) {
      return c.json(apiErrorBody('request/invalid', 'invalid-snapshot-health-request'), 400)
    }
    const doRequest = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers: c.req.raw.headers,
      body: JSON.stringify(body),
    })
    const claims = await verifyBearerToken(c.env, c.req.raw)
    if (claims === undefined)
      return c.json(apiErrorBody('auth/rejected', 'auth-reject:invalid-token'), 401)
    const response = await routeVaultRoom(c.env, doRequest, claims.aud)
    return parseDOorPassthrough(c, response, SnapshotHealthMutationResponseSchema)
  },
)

workerApp.post(
  '/admin/snapshots/:docId/quarantine',
  sValidator('param', DocIdParamSchema),
  sValidator('json', SnapshotHealthQuarantineRequestSchema),
  async (c) => {
    const { docId } = c.req.valid('param')
    const body = c.req.valid('json')
    if (!snapshotHealthRouteDocMatches(docId, body.docId)) {
      return c.json(apiErrorBody('request/invalid', 'invalid-snapshot-health-request'), 400)
    }
    const doRequest = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers: c.req.raw.headers,
      body: JSON.stringify(body),
    })
    const claims = await verifyBearerToken(c.env, c.req.raw)
    if (claims === undefined)
      return c.json(apiErrorBody('auth/rejected', 'auth-reject:invalid-token'), 401)
    const response = await routeVaultRoom(c.env, doRequest, claims.aud)
    return parseDOorPassthrough(c, response, SnapshotHealthMutationResponseSchema)
  },
)

workerApp.post(
  '/admin/snapshots/:docId/rollback',
  sValidator('param', DocIdParamSchema),
  sValidator('json', SnapshotRollbackRequestSchema),
  async (c) => {
    const { docId } = c.req.valid('param')
    const body = c.req.valid('json')
    if (!snapshotHealthRouteDocMatches(docId, body.docId)) {
      return c.json(apiErrorBody('request/invalid', 'invalid-snapshot-health-request'), 400)
    }
    const doRequest = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers: c.req.raw.headers,
      body: JSON.stringify(body),
    })
    const claims = await verifyBearerToken(c.env, c.req.raw)
    if (claims === undefined)
      return c.json(apiErrorBody('auth/rejected', 'auth-reject:invalid-token'), 401)
    const response = await routeVaultRoom(c.env, doRequest, claims.aud)
    return parseDOorPassthrough(c, response, SnapshotRollbackResponseSchema)
  },
)

// ---- Local outbox repair evidence (bearer auth, body validated, forward to DO, response typed) ----

workerApp.post(
  '/repair/local-outbox/evidence',
  sValidator('json', LocalOutboxRepairEvidenceRequestSchema),
  async (c) => {
    const body = c.req.valid('json')
    const doRequest = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers: c.req.raw.headers,
      body: JSON.stringify(body),
    })
    const claims = await verifyBearerToken(c.env, c.req.raw)
    if (claims === undefined)
      return c.json(apiErrorBody('auth/rejected', 'auth-reject:invalid-token'), 401)
    const response = await routeVaultRoom(c.env, doRequest, claims.aud)
    return parseDOorPassthrough(c, response, LocalOutboxRepairEvidenceResponseSchema)
  },
)

// ---- Vault snapshot latest (bearer auth, param validated, forward to DO, response typed) ----

workerApp.get(
  '/vaults/:vaultId/meta/latest',
  sValidator('param', v.object({ vaultId: VaultIdSchema })),
  async (c) => {
    const { vaultId } = c.req.valid('param')
    const claims = await verifyBearerToken(c.env, c.req.raw)
    if (claims === undefined)
      return c.json(apiErrorBody('auth/rejected', 'auth-reject:invalid-token'), 401)
    if (claims.aud !== vaultId) return c.json(apiErrorBody('auth/rejected', 'vault-mismatch'), 400)
    const response = await routeVaultRoom(c.env, c.req.raw, claims.aud)
    return parseDOorPassthrough(c, response, MetaLatestSnapshotResponseSchema)
  },
)

workerApp.get(
  '/vaults/:vaultId/files/:ydocId/latest',
  sValidator('param', v.object({ vaultId: VaultIdSchema, ydocId: YDocIdSchema })),
  async (c) => {
    const { vaultId } = c.req.valid('param')
    const claims = await verifyBearerToken(c.env, c.req.raw)
    if (claims === undefined)
      return c.json(apiErrorBody('auth/rejected', 'auth-reject:invalid-token'), 401)
    if (claims.aud !== vaultId) return c.json(apiErrorBody('auth/rejected', 'vault-mismatch'), 400)
    const response = await routeVaultRoom(c.env, c.req.raw, claims.aud)
    return parseDOorPassthrough(c, response, DocLatestSnapshotResponseSchema)
  },
)

// ---- Vault snapshot import (bearer auth, body validated, forward to DO, response typed) ----

workerApp.put(
  '/vaults/:vaultId/meta/snapshot',
  sValidator('param', v.object({ vaultId: VaultIdSchema })),
  sValidator('json', SnapshotImportRequestSchema),
  async (c) => {
    const { vaultId } = c.req.valid('param')
    const body = c.req.valid('json')
    const doRequest = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers: c.req.raw.headers,
      body: JSON.stringify(body),
    })
    const claims = await verifyBearerToken(c.env, c.req.raw)
    if (claims === undefined)
      return c.json(apiErrorBody('auth/rejected', 'auth-reject:invalid-token'), 401)
    if (claims.aud !== vaultId) return c.json(apiErrorBody('auth/rejected', 'vault-mismatch'), 400)
    const response = await routeVaultRoom(c.env, doRequest, claims.aud)
    return parseDOorPassthrough(c, response, SnapshotImportResponseSchema)
  },
)

workerApp.put(
  '/vaults/:vaultId/files/:ydocId/snapshot',
  sValidator('param', v.object({ vaultId: VaultIdSchema, ydocId: YDocIdSchema })),
  sValidator('json', SnapshotImportRequestSchema),
  async (c) => {
    const { vaultId } = c.req.valid('param')
    const body = c.req.valid('json')
    const doRequest = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers: c.req.raw.headers,
      body: JSON.stringify(body),
    })
    const claims = await verifyBearerToken(c.env, c.req.raw)
    if (claims === undefined)
      return c.json(apiErrorBody('auth/rejected', 'auth-reject:invalid-token'), 401)
    if (claims.aud !== vaultId) return c.json(apiErrorBody('auth/rejected', 'vault-mismatch'), 400)
    const response = await routeVaultRoom(c.env, doRequest, claims.aud)
    return parseDOorPassthrough(c, response, SnapshotImportResponseSchema)
  },
)

// ---- Blob HEAD (bearer auth, body validated, forward to DO, response typed) ----

workerApp.post('/blobs/head', sValidator('json', BlobHeadRequestSchema), async (c) => {
  const body = c.req.valid('json')
  const doRequest = new Request(c.req.raw.url, {
    method: c.req.raw.method,
    headers: c.req.raw.headers,
    body: JSON.stringify(body),
  })
  const claims = await verifyBearerToken(c.env, c.req.raw)
  if (claims === undefined)
    return c.json(apiErrorBody('auth/rejected', 'auth-reject:invalid-token'), 401)
  const response = await routeVaultRoom(c.env, doRequest, claims.aud)
  return parseDOorPassthrough(c, response, BlobHeadResponseSchema)
})

// ---- Blob upload URL (bearer auth, body validated, forward to DO, response typed) ----

workerApp.post('/blobs/upload-url', sValidator('json', BlobUploadUrlRequestSchema), async (c) => {
  const body = c.req.valid('json')
  const doRequest = new Request(c.req.raw.url, {
    method: c.req.raw.method,
    headers: c.req.raw.headers,
    body: JSON.stringify(body),
  })
  const claims = await verifyBearerToken(c.env, c.req.raw)
  if (claims === undefined)
    return c.json(apiErrorBody('auth/rejected', 'auth-reject:invalid-token'), 401)
  const response = await routeVaultRoom(c.env, doRequest, claims.aud)
  return parseDOorPassthrough(c, response, BlobUploadUrlResponseSchema)
})

// ---- Blob multipart complete (bearer auth, body validated, forward to DO) ----

workerApp.post(
  '/blobs/:hash/complete',
  sValidator('param', v.object({ hash: Sha256HexSchema })),
  sValidator('json', BlobMultipartCompleteRequestSchema),
  async (c) => {
    const body = c.req.valid('json')
    const doRequest = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers: c.req.raw.headers,
      body: JSON.stringify(body),
    })
    const claims = await verifyBearerToken(c.env, c.req.raw)
    if (claims === undefined)
      return c.json(apiErrorBody('auth/rejected', 'auth-reject:invalid-token'), 401)
    return routeVaultRoom(c.env, doRequest, claims.aud)
  },
)

// ---- Blob multipart abort (bearer auth, body validated, forward to DO) ----

workerApp.post(
  '/blobs/:hash/abort',
  sValidator('param', v.object({ hash: Sha256HexSchema })),
  sValidator('json', BlobMultipartAbortRequestSchema),
  async (c) => {
    const body = c.req.valid('json')
    const doRequest = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers: c.req.raw.headers,
      body: JSON.stringify(body),
    })
    const claims = await verifyBearerToken(c.env, c.req.raw)
    if (claims === undefined)
      return c.json(apiErrorBody('auth/rejected', 'auth-reject:invalid-token'), 401)
    return routeVaultRoom(c.env, doRequest, claims.aud)
  },
)

// ---- Blob binary routes (bearer auth, forward to DO, no typing) ----
// These handle binary streams where RPC typing provides no benefit.

const BlobHashParamSchema = v.object({ hash: Sha256HexSchema })

workerApp.on(
  ['GET', 'PUT'],
  '/blobs/:hash',
  sValidator('param', BlobHashParamSchema),
  async (c) => {
    const claims = await verifyBearerToken(c.env, c.req.raw)
    if (claims === undefined)
      return c.json(apiErrorBody('auth/rejected', 'auth-reject:invalid-token'), 401)
    return routeVaultRoom(c.env, c.req.raw, claims.aud)
  },
)

const BlobMultipartPartParamSchema = v.object({
  hash: Sha256HexSchema,
  uploadId: BlobUploadIdSchema,
  partNumber: v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(1)),
})

workerApp.put(
  '/blobs/:hash/parts/:uploadId/:partNumber',
  sValidator('param', BlobMultipartPartParamSchema),
  async (c) => {
    const claims = await verifyBearerToken(c.env, c.req.raw)
    if (claims === undefined)
      return c.json(apiErrorBody('auth/rejected', 'auth-reject:invalid-token'), 401)
    return routeVaultRoom(c.env, c.req.raw, claims.aud)
  },
)

workerApp.on(['GET', 'PUT'], '/blob-manifests/*', async (c) => {
  const claims = await verifyBearerToken(c.env, c.req.raw)
  if (claims === undefined)
    return c.json(apiErrorBody('auth/rejected', 'auth-reject:invalid-token'), 401)
  return routeVaultRoom(c.env, c.req.raw, claims.aud)
})

// ---- WebSocket upgrade (param validated, forward to DO, no typing) ----

workerApp.get(
  '/ws/:vaultId',
  sValidator('param', v.object({ vaultId: VaultIdSchema })),
  async (c) => {
    const { vaultId } = c.req.valid('param')
    if (c.req.header('Upgrade')?.toLowerCase() !== WEBSOCKET_UPGRADE) {
      return c.json(apiErrorBody('request/invalid', 'expected-websocket-upgrade'), 426)
    }
    return routeVaultRoom(c.env, c.req.raw, vaultId)
  },
)

/** Hono application type — used by `hono/client` for typed RPC. */
export type AppType = typeof workerApp

/** Legacy alias used by entrypoint routing and existing test imports. */
export const workerEntrypoint = workerApp
export default workerApp
