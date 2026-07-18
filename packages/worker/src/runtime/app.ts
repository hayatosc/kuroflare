import {
  DeviceIdSchema,
  DeviceTokenRefreshRequestSchema,
  LocalOutboxRepairEvidenceRequestSchema,
  QuarantinedUpdateActionHttpRequestSchema,
  RevokeDeviceRequestSchema,
  SetupExchangeRequestSchema,
  SnapshotImportRequestSchema,
  SnapshotHealthQuarantineRequestSchema,
  SnapshotHealthVerifyRequestSchema,
  SnapshotRollbackRequestSchema,
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

const WEBSOCKET_UPGRADE = 'websocket'
const ADMIN_TOKEN_HEADER = 'x-kuroflare-admin-secret'
const ADMIN_SETUP_TOKEN_PATH = '/admin/setup-tokens'
const ADMIN_SNAPSHOT_SEED_PATH = '/admin/snapshots/seed'

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

function routeVaultRoom(request: Request, env: WorkerEnv, vaultId: VaultId): Promise<Response> {
  const id = env.VAULT_ROOM.idFromName(vaultId)
  const room = env.VAULT_ROOM.get(id)
  return Promise.resolve(room.fetch(request))
}

async function routeAuthorizedVaultRoom(c: Context<{ Bindings: WorkerEnv }>): Promise<Response> {
  const claims = await verifyBearerToken(c.env, c.req.raw)
  if (claims === undefined)
    return c.json(apiErrorBody('auth/rejected', 'auth-reject:invalid-token'), 401)
  return routeVaultRoom(c.req.raw, c.env, claims.aud)
}

const workerApp = new Hono<{ Bindings: WorkerEnv }>()

workerApp.use(
  '*',
  cors({
    origin: '*',
    allowHeaders: ['Authorization', 'Content-Type', ADMIN_TOKEN_HEADER],
    allowMethods: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT'],
  }),
)

workerApp.post(ADMIN_SETUP_TOKEN_PATH, async (c) => {
  const rejection = authorizeAdminRequest(c)
  if (rejection !== undefined) return rejection
  const body: unknown = await c.req.raw
    .clone()
    .json()
    .catch(() => undefined)
  if (!v.is(AdminSetupTokenIssueRequestSchema, body)) {
    return c.json(apiErrorBody('request/invalid', 'invalid-admin-setup-token-issue-request'), 400)
  }
  return routeVaultRoom(c.req.raw, c.env, body.vaultId)
})

workerApp.post(ADMIN_SNAPSHOT_SEED_PATH, async (c) => {
  const rejection = authorizeAdminRequest(c)
  if (rejection !== undefined) return rejection
  const body: unknown = await c.req.raw
    .clone()
    .json()
    .catch(() => undefined)
  if (!v.is(AdminSnapshotSeedRequestSchema, body)) {
    return c.json(apiErrorBody('request/invalid', 'invalid-admin-snapshot-seed-request'), 400)
  }
  return routeVaultRoom(c.req.raw, c.env, body.vaultId)
})

workerApp.post('/setup/exchange', async (c) => {
  const body: unknown = await c.req.raw
    .clone()
    .json()
    .catch(() => undefined)
  if (!v.is(SetupExchangeRequestSchema, body)) {
    return c.json(apiErrorBody('request/invalid', 'invalid-setup-exchange-request'), 400)
  }
  return routeVaultRoom(c.req.raw, c.env, body.vaultId)
})

workerApp.get('/auth/verify', async (c) => {
  const claims = await verifyBearerToken(c.env, c.req.raw)
  if (claims === undefined)
    return c.json(apiErrorBody('auth/rejected', 'auth-reject:invalid-token'), 401)
  return c.json(claims)
})

workerApp.post('/auth/refresh', async (c) => {
  const body: unknown = await c.req.raw
    .clone()
    .json()
    .catch(() => undefined)
  if (!v.is(DeviceTokenRefreshRequestSchema, body)) {
    return c.json(apiErrorBody('request/invalid', 'invalid-auth-refresh-request'), 400)
  }
  return routeVaultRoom(c.req.raw, c.env, body.vaultId)
})

workerApp.post('/devices/:deviceId/revoke', async (c) => {
  const rawDeviceId = c.req.param('deviceId')
  if (!v.is(DeviceIdSchema, rawDeviceId)) {
    return c.json(apiErrorBody('request/invalid', 'invalid-device-id'), 400)
  }
  const body: unknown = await c.req.raw
    .clone()
    .json()
    .catch(() => undefined)
  if (!v.is(RevokeDeviceRequestSchema, body)) {
    return c.json(apiErrorBody('request/invalid', 'invalid-revoke-device-request'), 400)
  }
  return routeAuthorizedVaultRoom(c)
})

workerApp.get('/admin/quarantine', routeAuthorizedVaultRoom)
workerApp.get('/admin/quarantine/audit', routeAuthorizedVaultRoom)
workerApp.get('/admin/quarantine/:id', routeAuthorizedVaultRoom)
workerApp.get('/admin/retention', routeAuthorizedVaultRoom)
workerApp.get('/admin/snapshots', routeAuthorizedVaultRoom)

for (const [path, schema] of [
  ['/admin/snapshots/verify', SnapshotHealthVerifyRequestSchema],
  ['/admin/snapshots/quarantine', SnapshotHealthQuarantineRequestSchema],
  ['/admin/snapshots/rollback', SnapshotRollbackRequestSchema],
] as const) {
  workerApp.post(path, async (c) => {
    const body: unknown = await c.req.raw
      .clone()
      .json()
      .catch(() => undefined)
    if (!v.is(schema, body))
      return c.json(apiErrorBody('request/invalid', 'invalid-snapshot-health-request'), 400)
    return routeAuthorizedVaultRoom(c)
  })
}

for (const [action, schema] of [
  ['verify', SnapshotHealthVerifyRequestSchema],
  ['quarantine', SnapshotHealthQuarantineRequestSchema],
  ['rollback', SnapshotRollbackRequestSchema],
] as const) {
  workerApp.post(`/admin/snapshots/:docId/${action}`, async (c) => {
    const body: unknown = await c.req.raw
      .clone()
      .json()
      .catch(() => undefined)
    if (!v.is(schema, body) || !snapshotHealthRouteDocMatches(c.req.param('docId'), body.docId)) {
      return c.json(apiErrorBody('request/invalid', 'invalid-snapshot-health-request'), 400)
    }
    return routeAuthorizedVaultRoom(c)
  })
}

function snapshotHealthRouteDocMatches(
  routeDocId: string,
  docId: { readonly kind: 'meta' } | { readonly kind: 'file'; readonly ydocId: string },
): boolean {
  return docId.kind === 'meta' ? routeDocId === 'meta' : routeDocId === docId.ydocId
}

for (const action of ['discard', 'force-apply'] as const) {
  workerApp.post(`/admin/quarantine/:id/${action}`, async (c) => {
    const body: unknown = await c.req.raw
      .clone()
      .json()
      .catch(() => undefined)
    if (!v.is(QuarantinedUpdateActionHttpRequestSchema, body)) {
      return c.json(apiErrorBody('request/invalid', 'invalid-quarantine-action-request'), 400)
    }
    return routeAuthorizedVaultRoom(c)
  })
}

workerApp.post('/repair/local-outbox/evidence', async (c) => {
  const body: unknown = await c.req.raw
    .clone()
    .json()
    .catch(() => undefined)
  if (!v.is(LocalOutboxRepairEvidenceRequestSchema, body)) {
    return c.json(
      apiErrorBody('request/invalid', 'invalid-local-outbox-repair-evidence-request'),
      400,
    )
  }
  return routeAuthorizedVaultRoom(c)
})

workerApp.get('/vaults/:vaultId/meta/latest', async (c) => {
  const vaultId = c.req.param('vaultId')
  if (!v.is(VaultIdSchema, vaultId))
    return c.json(apiErrorBody('request/invalid', 'invalid-vault-id'), 400)
  const claims = await verifyBearerToken(c.env, c.req.raw)
  if (claims === undefined)
    return c.json(apiErrorBody('auth/rejected', 'auth-reject:invalid-token'), 401)
  if (claims.aud !== vaultId) return c.json(apiErrorBody('auth/rejected', 'vault-mismatch'), 400)
  return routeVaultRoom(c.req.raw, c.env, claims.aud)
})

workerApp.get('/vaults/:vaultId/files/:ydocId/latest', async (c) => {
  const vaultId = c.req.param('vaultId')
  const ydocId = c.req.param('ydocId')
  if (!v.is(VaultIdSchema, vaultId))
    return c.json(apiErrorBody('request/invalid', 'invalid-vault-id'), 400)
  if (!v.is(YDocIdSchema, ydocId))
    return c.json(apiErrorBody('request/invalid', 'invalid-ydoc-id'), 400)
  const claims = await verifyBearerToken(c.env, c.req.raw)
  if (claims === undefined)
    return c.json(apiErrorBody('auth/rejected', 'auth-reject:invalid-token'), 401)
  if (claims.aud !== vaultId) return c.json(apiErrorBody('auth/rejected', 'vault-mismatch'), 400)
  return routeVaultRoom(c.req.raw, c.env, claims.aud)
})

workerApp.put('/vaults/:vaultId/meta/snapshot', async (c) => {
  const vaultId = c.req.param('vaultId')
  if (!v.is(VaultIdSchema, vaultId))
    return c.json(apiErrorBody('request/invalid', 'invalid-vault-id'), 400)
  const body: unknown = await c.req.raw
    .clone()
    .json()
    .catch(() => undefined)
  if (!v.is(SnapshotImportRequestSchema, body)) {
    return c.json(apiErrorBody('request/invalid', 'invalid-snapshot-import-request'), 400)
  }
  const claims = await verifyBearerToken(c.env, c.req.raw)
  if (claims === undefined)
    return c.json(apiErrorBody('auth/rejected', 'auth-reject:invalid-token'), 401)
  if (claims.aud !== vaultId) return c.json(apiErrorBody('auth/rejected', 'vault-mismatch'), 400)
  return routeVaultRoom(c.req.raw, c.env, claims.aud)
})

workerApp.put('/vaults/:vaultId/files/:ydocId/snapshot', async (c) => {
  const vaultId = c.req.param('vaultId')
  const ydocId = c.req.param('ydocId')
  if (!v.is(VaultIdSchema, vaultId))
    return c.json(apiErrorBody('request/invalid', 'invalid-vault-id'), 400)
  if (!v.is(YDocIdSchema, ydocId))
    return c.json(apiErrorBody('request/invalid', 'invalid-ydoc-id'), 400)
  const body: unknown = await c.req.raw
    .clone()
    .json()
    .catch(() => undefined)
  if (!v.is(SnapshotImportRequestSchema, body)) {
    return c.json(apiErrorBody('request/invalid', 'invalid-snapshot-import-request'), 400)
  }
  const claims = await verifyBearerToken(c.env, c.req.raw)
  if (claims === undefined)
    return c.json(apiErrorBody('auth/rejected', 'auth-reject:invalid-token'), 401)
  if (claims.aud !== vaultId) return c.json(apiErrorBody('auth/rejected', 'vault-mismatch'), 400)
  return routeVaultRoom(c.req.raw, c.env, claims.aud)
})

workerApp.post('/blobs/head', routeAuthorizedVaultRoom)
workerApp.post('/blobs/upload-url', routeAuthorizedVaultRoom)
workerApp.on(['GET', 'PUT'], '/blobs/:hash', routeAuthorizedVaultRoom)
workerApp.put('/blobs/:hash/parts/:uploadId/:partNumber', routeAuthorizedVaultRoom)
workerApp.post('/blobs/:hash/complete', routeAuthorizedVaultRoom)
workerApp.post('/blobs/:hash/abort', routeAuthorizedVaultRoom)
workerApp.on(['GET', 'PUT'], '/blob-manifests/*', routeAuthorizedVaultRoom)

workerApp.get('/ws/:vaultId', async (c) => {
  const vaultId = c.req.param('vaultId')
  if (!v.is(VaultIdSchema, vaultId)) {
    return c.json(apiErrorBody('request/invalid', 'invalid-vault-id'), 400)
  }
  if (c.req.header('Upgrade')?.toLowerCase() !== WEBSOCKET_UPGRADE) {
    return c.json(apiErrorBody('request/invalid', 'expected-websocket-upgrade'), 426)
  }
  return routeVaultRoom(c.req.raw, c.env, vaultId)
})

export const workerEntrypoint = workerApp
export default workerApp
