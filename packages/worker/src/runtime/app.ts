import { sValidator } from '@hono/standard-validator'
import {
  BlobHeadRequestSchema,
  BlobHeadResponseSchema,
  BlobMultipartAbortRequestSchema,
  BlobMultipartCompleteRequestSchema,
  BlobUploadIdSchema,
  BlobUploadUrlRequestSchema,
  BlobUploadUrlResponseSchema,
  CURRENT_PROTOCOL_VERSION,
  DeviceIdSchema,
  DeviceSetupTokenIssueRequestSchema,
  DeviceTokenRefreshRequestSchema,
  DeviceTokenRefreshResponseSchema,
  DocLatestSnapshotResponseSchema,
  LocalOutboxRepairEvidenceRequestSchema,
  LocalOutboxRepairEvidenceResponseSchema,
  MetaLatestSnapshotResponseSchema,
  MINIMUM_PLUGIN_VERSION,
  MIN_SUPPORTED_PROTOCOL_VERSION,
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
  PRODUCT_VERSION,
  ReleaseChannelSchema,
  VaultIdSchema,
  WorkerVersionResponseSchema,
  YDocIdSchema,
  verifyHs256DeviceToken,
  type DeviceTokenClaims,
  type VaultId,
  type WorkerVersionResponse,
} from '@kuroflare/core'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { createMiddleware } from 'hono/factory'
import * as v from 'valibot'

import { DEVICE_SETUP_TOKEN_PATH } from './constants'
import {
  type WorkerEnv,
  AdminSetupTokenIssueRequestSchema,
  AdminSnapshotSeedRequestSchema,
  SetupTokenIssueResponseSchema,
} from './types'
import { apiErrorBody, extractBearerToken, makeOpaqueToken, timingSafeEqualString } from './utils'

// sValidator('json', ...) requires Content-Type: application/json.
// Requests without it receive a 400 with a field-level validation error.

const WEBSOCKET_UPGRADE = 'websocket'
const ADMIN_TOKEN_HEADER = 'x-kuroflare-admin-secret'

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

const QuarantineListQuerySchema = v.object({
  limit: v.optional(
    v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(1)),
  ),
  cursor: v.optional(v.pipe(v.string(), v.minLength(1))),
})

const QuarantineIdParamSchema = v.object({ id: v.pipe(v.string(), v.minLength(1)) })

const SnapshotHealthQuerySchema = v.object({
  docId: v.optional(v.pipe(v.string(), v.minLength(1))),
  limit: v.optional(
    v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(1)),
  ),
  cursor: v.optional(v.pipe(v.string(), v.minLength(1))),
})

const DocIdParamSchema = v.object({ docId: v.pipe(v.string(), v.minLength(1)) })

const BlobHashParamSchema = v.object({ hash: Sha256HexSchema })

const BlobMultipartPartParamSchema = v.object({
  hash: Sha256HexSchema,
  uploadId: BlobUploadIdSchema,
  partNumber: v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(1)),
})

// --- Utility functions ---

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

/**
 * Maps a request-validation failure to the guarded `ApiError` envelope (DR-009 C1).
 * Authenticated routes fail closed at their auth middleware before validation runs, but
 * unauthenticated public routes (`/setup/exchange`, `/auth/refresh`) reach the validator
 * first, so without this hook they would return the validator's raw issue list instead of
 * the envelope every public failure must use.
 */
function rejectInvalidRequest(c: Context): Response {
  return c.json(apiErrorBody('request/invalid', 'request-validation-failed'), 400)
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

function readVersionResponse(env: WorkerEnv): WorkerVersionResponse | undefined {
  const channel = env.KUROFLARE_RELEASE_CHANNEL
  const buildCommit = env.KUROFLARE_BUILD_COMMIT
  const deploymentVersionId = env.CF_VERSION_METADATA?.id
  if (!v.is(ReleaseChannelSchema, channel)) return undefined
  if (buildCommit === undefined || buildCommit.trim().length === 0) return undefined
  if (deploymentVersionId === undefined || deploymentVersionId.trim().length === 0) return undefined

  const response = {
    productVersion: PRODUCT_VERSION,
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    minimumProtocolVersion: MIN_SUPPORTED_PROTOCOL_VERSION,
    minimumPluginVersion: MINIMUM_PLUGIN_VERSION,
    channel,
    buildCommit,
    deploymentVersionId,
  }
  return v.is(WorkerVersionResponseSchema, response) ? response : undefined
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
  c: Context,
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
    const clone = response.clone()
    body = await clone.json()
  } catch {
    return response
  }
  const parsed = v.safeParse(outputSchema, body)
  if (!parsed.success) return response
  return c.json(parsed.output, response.status as 200)
}

function snapshotHealthRouteDocMatches(
  routeDocId: string,
  docId: { readonly kind: 'meta' } | { readonly kind: 'file'; readonly ydocId: string },
): boolean {
  return docId.kind === 'meta' ? routeDocId === 'meta' : routeDocId === docId.ydocId
}

// --- Middleware ---

const adminAuth = createMiddleware<{ Bindings: WorkerEnv }>(async (c, next) => {
  const rejection = authorizeAdminRequest(c)
  if (rejection !== undefined) return rejection
  await next()
})

const bearerAuth = createMiddleware<{
  Bindings: WorkerEnv
  Variables: { claims: DeviceTokenClaims }
}>(async (c, next) => {
  const claims = await verifyBearerToken(c.env, c.req.raw)
  if (!claims) {
    return c.json(apiErrorBody('auth/rejected', 'auth-reject:invalid-token'), 401)
  }
  c.set('claims', claims)
  await next()
})

type AuthedEnv = { Bindings: WorkerEnv; Variables: { claims: DeviceTokenClaims } }

// --- Sub-routers ---

const adminRouter = new Hono<{ Bindings: WorkerEnv }>()
  .post(
    '/admin/setup-tokens',
    adminAuth,
    sValidator('json', AdminSetupTokenIssueRequestSchema),
    async (c) => {
      const body = c.req.valid('json')
      const doRequest = new Request(c.req.raw.url, {
        method: c.req.raw.method,
        headers: c.req.raw.headers,
        body: JSON.stringify(body),
      })
      return routeVaultRoom(c.env, doRequest, body.vaultId)
    },
  )
  .post(
    '/admin/snapshots/seed',
    adminAuth,
    sValidator('json', AdminSnapshotSeedRequestSchema),
    async (c) => {
      const body = c.req.valid('json')
      const doRequest = new Request(c.req.raw.url, {
        method: c.req.raw.method,
        headers: c.req.raw.headers,
        body: JSON.stringify(body),
      })
      return routeVaultRoom(c.env, doRequest, body.vaultId)
    },
  )

const authedCore = new Hono<AuthedEnv>()
  .get('/auth/verify', bearerAuth, (c) => c.json(c.var.claims))
  /**
   * Lets an already-registered device invite another device, so enrolling a
   * second device no longer requires the operator secret. This grants no new
   * authority: any device holding a valid token can already read and write the
   * whole vault and revoke every other device in it, so being able to enrol one
   * more is strictly weaker than what the caller can already do.
   */
  .post(
    DEVICE_SETUP_TOKEN_PATH,
    bearerAuth,
    sValidator('json', DeviceSetupTokenIssueRequestSchema, (result, c) =>
      result.success ? undefined : rejectInvalidRequest(c),
    ),
    async (c) => {
      const body = c.req.valid('json')
      const vaultId = c.var.claims.aud
      const setupToken = makeOpaqueToken()
      const doRequest = new Request(c.req.raw.url, {
        method: c.req.raw.method,
        headers: c.req.raw.headers,
        body: JSON.stringify({ vaultId, setupToken, expiresInMs: body.expiresInMs }),
      })
      const response = await routeVaultRoom(c.env, doRequest, vaultId)
      if (!response.ok) return parseDOorPassthrough(c, response, SetupTokenIssueResponseSchema)
      const issued: unknown = await response.json().catch(() => undefined)
      const parsed = v.safeParse(SetupTokenIssueResponseSchema, issued)
      if (!parsed.success) return c.json(apiErrorBody('server/error', 'DO-error-not-json'), 500)
      return c.json({ setupToken, vaultId, expiresAt: parsed.output.expiresAt }, 200)
    },
  )
  .post(
    '/devices/:deviceId/revoke',
    bearerAuth,
    sValidator('param', v.object({ deviceId: DeviceIdSchema })),
    sValidator('json', RevokeDeviceRequestSchema),
    async (c) => {
      const body = c.req.valid('json')
      const doRequest = new Request(c.req.raw.url, {
        method: c.req.raw.method,
        headers: c.req.raw.headers,
        body: JSON.stringify(body),
      })
      const response = await routeVaultRoom(c.env, doRequest, c.var.claims.aud)
      return parseDOorPassthrough(c, response, RevokeDeviceResponseSchema)
    },
  )
  .post(
    '/repair/local-outbox/evidence',
    bearerAuth,
    sValidator('json', LocalOutboxRepairEvidenceRequestSchema),
    async (c) => {
      const body = c.req.valid('json')
      const doRequest = new Request(c.req.raw.url, {
        method: c.req.raw.method,
        headers: c.req.raw.headers,
        body: JSON.stringify(body),
      })
      const response = await routeVaultRoom(c.env, doRequest, c.var.claims.aud)
      return parseDOorPassthrough(c, response, LocalOutboxRepairEvidenceResponseSchema)
    },
  )

const authedQuarantine = new Hono<AuthedEnv>()
  .get(
    '/admin/quarantine',
    bearerAuth,
    sValidator('query', QuarantineListQuerySchema),
    async (c) => {
      const response = await routeVaultRoom(c.env, c.req.raw, c.var.claims.aud)
      return parseDOorPassthrough(c, response, QuarantinedUpdateListResponseSchema)
    },
  )
  .get(
    '/admin/quarantine/audit',
    bearerAuth,
    sValidator('query', QuarantineListQuerySchema),
    async (c) => {
      const response = await routeVaultRoom(c.env, c.req.raw, c.var.claims.aud)
      return parseDOorPassthrough(c, response, QuarantineAuditListResponseSchema)
    },
  )
  .get(
    '/admin/quarantine/:id',
    bearerAuth,
    sValidator('param', QuarantineIdParamSchema),
    async (c) => {
      const response = await routeVaultRoom(c.env, c.req.raw, c.var.claims.aud)
      return parseDOorPassthrough(c, response, QuarantinedUpdateDetailResponseSchema)
    },
  )
  .post(
    '/admin/quarantine/:id/discard',
    bearerAuth,
    sValidator('param', QuarantineIdParamSchema),
    sValidator('json', QuarantinedUpdateActionHttpRequestSchema),
    async (c) => {
      const body = c.req.valid('json')
      const doRequest = new Request(c.req.raw.url, {
        method: c.req.raw.method,
        headers: c.req.raw.headers,
        body: JSON.stringify(body),
      })
      const response = await routeVaultRoom(c.env, doRequest, c.var.claims.aud)
      return parseDOorPassthrough(c, response, QuarantinedUpdateActionHttpResponseSchema)
    },
  )
  .post(
    '/admin/quarantine/:id/force-apply',
    bearerAuth,
    sValidator('param', QuarantineIdParamSchema),
    sValidator('json', QuarantinedUpdateActionHttpRequestSchema),
    async (c) => {
      const body = c.req.valid('json')
      const doRequest = new Request(c.req.raw.url, {
        method: c.req.raw.method,
        headers: c.req.raw.headers,
        body: JSON.stringify(body),
      })
      const response = await routeVaultRoom(c.env, doRequest, c.var.claims.aud)
      return parseDOorPassthrough(c, response, QuarantinedUpdateActionHttpResponseSchema)
    },
  )

const authedSnapshotAdmin = new Hono<AuthedEnv>()
  .get(
    '/admin/retention',
    bearerAuth,
    sValidator('query', QuarantineListQuerySchema),
    async (c) => {
      const response = await routeVaultRoom(c.env, c.req.raw, c.var.claims.aud)
      return parseDOorPassthrough(c, response, RetentionListResponseSchema)
    },
  )
  .get(
    '/admin/snapshots',
    bearerAuth,
    sValidator('query', SnapshotHealthQuerySchema),
    async (c) => {
      const response = await routeVaultRoom(c.env, c.req.raw, c.var.claims.aud)
      return parseDOorPassthrough(c, response, SnapshotHealthListResponseSchema)
    },
  )
  .post(
    '/admin/snapshots/verify',
    bearerAuth,
    sValidator('json', SnapshotHealthVerifyRequestSchema),
    async (c) => {
      const body = c.req.valid('json')
      const doRequest = new Request(c.req.raw.url, {
        method: c.req.raw.method,
        headers: c.req.raw.headers,
        body: JSON.stringify(body),
      })
      const response = await routeVaultRoom(c.env, doRequest, c.var.claims.aud)
      return parseDOorPassthrough(c, response, SnapshotHealthMutationResponseSchema)
    },
  )
  .post(
    '/admin/snapshots/quarantine',
    bearerAuth,
    sValidator('json', SnapshotHealthQuarantineRequestSchema),
    async (c) => {
      const body = c.req.valid('json')
      const doRequest = new Request(c.req.raw.url, {
        method: c.req.raw.method,
        headers: c.req.raw.headers,
        body: JSON.stringify(body),
      })
      const response = await routeVaultRoom(c.env, doRequest, c.var.claims.aud)
      return parseDOorPassthrough(c, response, SnapshotHealthMutationResponseSchema)
    },
  )
  .post(
    '/admin/snapshots/rollback',
    bearerAuth,
    sValidator('json', SnapshotRollbackRequestSchema),
    async (c) => {
      const body = c.req.valid('json')
      const doRequest = new Request(c.req.raw.url, {
        method: c.req.raw.method,
        headers: c.req.raw.headers,
        body: JSON.stringify(body),
      })
      const response = await routeVaultRoom(c.env, doRequest, c.var.claims.aud)
      return parseDOorPassthrough(c, response, SnapshotRollbackResponseSchema)
    },
  )
  .post(
    '/admin/snapshots/:docId/verify',
    bearerAuth,
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
      const response = await routeVaultRoom(c.env, doRequest, c.var.claims.aud)
      return parseDOorPassthrough(c, response, SnapshotHealthMutationResponseSchema)
    },
  )
  .post(
    '/admin/snapshots/:docId/quarantine',
    bearerAuth,
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
      const response = await routeVaultRoom(c.env, doRequest, c.var.claims.aud)
      return parseDOorPassthrough(c, response, SnapshotHealthMutationResponseSchema)
    },
  )
  .post(
    '/admin/snapshots/:docId/rollback',
    bearerAuth,
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
      const response = await routeVaultRoom(c.env, doRequest, c.var.claims.aud)
      return parseDOorPassthrough(c, response, SnapshotRollbackResponseSchema)
    },
  )

const authedVaults = new Hono<AuthedEnv>()
  .get(
    '/vaults/:vaultId/meta/latest',
    bearerAuth,
    sValidator('param', v.object({ vaultId: VaultIdSchema })),
    async (c) => {
      const { vaultId } = c.req.valid('param')
      if (c.var.claims.aud !== vaultId)
        return c.json(apiErrorBody('auth/rejected', 'vault-mismatch'), 400)
      const response = await routeVaultRoom(c.env, c.req.raw, c.var.claims.aud)
      return parseDOorPassthrough(c, response, MetaLatestSnapshotResponseSchema)
    },
  )
  .get(
    '/vaults/:vaultId/files/:ydocId/latest',
    bearerAuth,
    sValidator('param', v.object({ vaultId: VaultIdSchema, ydocId: YDocIdSchema })),
    async (c) => {
      const { vaultId } = c.req.valid('param')
      if (c.var.claims.aud !== vaultId)
        return c.json(apiErrorBody('auth/rejected', 'vault-mismatch'), 400)
      const response = await routeVaultRoom(c.env, c.req.raw, c.var.claims.aud)
      return parseDOorPassthrough(c, response, DocLatestSnapshotResponseSchema)
    },
  )
  .put(
    '/vaults/:vaultId/meta/snapshot',
    bearerAuth,
    sValidator('param', v.object({ vaultId: VaultIdSchema })),
    sValidator('json', SnapshotImportRequestSchema),
    async (c) => {
      const { vaultId } = c.req.valid('param')
      if (c.var.claims.aud !== vaultId)
        return c.json(apiErrorBody('auth/rejected', 'vault-mismatch'), 400)
      const body = c.req.valid('json')
      const doRequest = new Request(c.req.raw.url, {
        method: c.req.raw.method,
        headers: c.req.raw.headers,
        body: JSON.stringify(body),
      })
      const response = await routeVaultRoom(c.env, doRequest, c.var.claims.aud)
      return parseDOorPassthrough(c, response, SnapshotImportResponseSchema)
    },
  )
  .put(
    '/vaults/:vaultId/files/:ydocId/snapshot',
    bearerAuth,
    sValidator('param', v.object({ vaultId: VaultIdSchema, ydocId: YDocIdSchema })),
    sValidator('json', SnapshotImportRequestSchema),
    async (c) => {
      const { vaultId } = c.req.valid('param')
      if (c.var.claims.aud !== vaultId)
        return c.json(apiErrorBody('auth/rejected', 'vault-mismatch'), 400)
      const body = c.req.valid('json')
      const doRequest = new Request(c.req.raw.url, {
        method: c.req.raw.method,
        headers: c.req.raw.headers,
        body: JSON.stringify(body),
      })
      const response = await routeVaultRoom(c.env, doRequest, c.var.claims.aud)
      return parseDOorPassthrough(c, response, SnapshotImportResponseSchema)
    },
  )

const authedBlobs = new Hono<AuthedEnv>()
  .post('/blobs/head', bearerAuth, sValidator('json', BlobHeadRequestSchema), async (c) => {
    const body = c.req.valid('json')
    const doRequest = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers: c.req.raw.headers,
      body: JSON.stringify(body),
    })
    const response = await routeVaultRoom(c.env, doRequest, c.var.claims.aud)
    return parseDOorPassthrough(c, response, BlobHeadResponseSchema)
  })
  .post(
    '/blobs/upload-url',
    bearerAuth,
    sValidator('json', BlobUploadUrlRequestSchema),
    async (c) => {
      const body = c.req.valid('json')
      const doRequest = new Request(c.req.raw.url, {
        method: c.req.raw.method,
        headers: c.req.raw.headers,
        body: JSON.stringify(body),
      })
      const response = await routeVaultRoom(c.env, doRequest, c.var.claims.aud)
      return parseDOorPassthrough(c, response, BlobUploadUrlResponseSchema)
    },
  )
  .post(
    '/blobs/:hash/complete',
    bearerAuth,
    sValidator('param', v.object({ hash: Sha256HexSchema })),
    sValidator('json', BlobMultipartCompleteRequestSchema),
    async (c) => {
      const body = c.req.valid('json')
      const doRequest = new Request(c.req.raw.url, {
        method: c.req.raw.method,
        headers: c.req.raw.headers,
        body: JSON.stringify(body),
      })
      return routeVaultRoom(c.env, doRequest, c.var.claims.aud)
    },
  )
  .post(
    '/blobs/:hash/abort',
    bearerAuth,
    sValidator('param', v.object({ hash: Sha256HexSchema })),
    sValidator('json', BlobMultipartAbortRequestSchema),
    async (c) => {
      const body = c.req.valid('json')
      const doRequest = new Request(c.req.raw.url, {
        method: c.req.raw.method,
        headers: c.req.raw.headers,
        body: JSON.stringify(body),
      })
      return routeVaultRoom(c.env, doRequest, c.var.claims.aud)
    },
  )
  .on(
    ['GET', 'PUT'],
    '/blobs/:hash',
    bearerAuth,
    sValidator('param', BlobHashParamSchema),
    async (c) => {
      return routeVaultRoom(c.env, c.req.raw, c.var.claims.aud)
    },
  )
  .put(
    '/blobs/:hash/parts/:uploadId/:partNumber',
    bearerAuth,
    sValidator('param', BlobMultipartPartParamSchema),
    async (c) => {
      return routeVaultRoom(c.env, c.req.raw, c.var.claims.aud)
    },
  )
  .on(['GET', 'PUT'], '/blob-manifests/*', bearerAuth, async (c) => {
    return routeVaultRoom(c.env, c.req.raw, c.var.claims.aud)
  })

const publicRouter = new Hono<{ Bindings: WorkerEnv }>()
  .get('/version', (c) => {
    const response = readVersionResponse(c.env)
    if (response === undefined) {
      return c.json(apiErrorBody('server/degraded', 'version-metadata-not-configured'), 503)
    }
    return c.json(response)
  })
  .post(
    '/setup/exchange',
    sValidator('json', SetupExchangeRequestSchema, (result, c) =>
      result.success ? undefined : rejectInvalidRequest(c),
    ),
    async (c) => {
      const body = c.req.valid('json')
      const doRequest = new Request(c.req.raw.url, {
        method: c.req.raw.method,
        headers: c.req.raw.headers,
        body: JSON.stringify(body),
      })
      const response = await routeVaultRoom(c.env, doRequest, body.vaultId)
      return parseDOorPassthrough(c, response, SetupExchangeResponseSchema)
    },
  )
  .post(
    '/auth/refresh',
    sValidator('json', DeviceTokenRefreshRequestSchema, (result, c) =>
      result.success ? undefined : rejectInvalidRequest(c),
    ),
    async (c) => {
      const body = c.req.valid('json')
      const doRequest = new Request(c.req.raw.url, {
        method: c.req.raw.method,
        headers: c.req.raw.headers,
        body: JSON.stringify(body),
      })
      const response = await routeVaultRoom(c.env, doRequest, body.vaultId)
      return parseDOorPassthrough(c, response, DeviceTokenRefreshResponseSchema)
    },
  )
  .get(
    '/ws/:vaultId',
    sValidator('param', v.object({ vaultId: VaultIdSchema }), (result, c) =>
      result.success ? undefined : rejectInvalidRequest(c),
    ),
    async (c) => {
      const { vaultId } = c.req.valid('param')
      if (c.req.header('Upgrade')?.toLowerCase() !== WEBSOCKET_UPGRADE) {
        return c.json(apiErrorBody('request/invalid', 'expected-websocket-upgrade'), 426)
      }
      return routeVaultRoom(c.env, c.req.raw, vaultId)
    },
  )

// --- Compose ---

const app = new Hono<{ Bindings: WorkerEnv }>()
  .use(
    '*',
    cors({
      origin: '*',
      allowHeaders: ['Authorization', 'Content-Type', ADMIN_TOKEN_HEADER],
      allowMethods: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT'],
    }),
  )
  .route('/', adminRouter)
  .route('/', authedCore)
  .route('/', authedQuarantine)
  .route('/', authedSnapshotAdmin)
  .route('/', authedVaults)
  .route('/', authedBlobs)
  .route('/', publicRouter)

/**
 * Expose the StandardSchema Issue type locally so that tsgo can name the
 * accumulated Hono route type without TS2883.
 */
type _ = StandardSchemaV1.Issue

/** Hono application type — used by `hono/client` for typed RPC. */
export type AppType = typeof app

export const workerApp = app
export default app

/** Legacy alias used by entrypoint routing and existing test imports. */
export const workerEntrypoint = app
