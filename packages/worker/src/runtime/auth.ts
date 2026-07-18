import {
  CURRENT_PROTOCOL_VERSION,
  VaultIdSchema,
  decideClientCapabilityNegotiation,
  verifyHs256DeviceToken,
  type ApiErrorCode,
  type ClientHello,
  type DeviceTokenClaims,
  type DeviceTokenScope,
} from '@kuroflare/core'
import { type Context } from 'hono'
import * as v from 'valibot'

import { decideClientHelloRegistry, type DeviceRegistryEntry } from '../devices'
import { decideAuthAdmission, type AuthAdmissionDecision } from '../http/auth'
import { readDeviceRegistryEntry, persistVaultId } from './storage'
import type {
  RuntimeWebSocket,
  SessionState,
  WebSocketAttachment,
  WebSocketAwarenessAttachment,
} from './types'
import { apiErrorBody, logEvent, extractBearerToken, isWebSocketAttachment } from './utils'
import type { VaultRoom } from './vault-room'

export async function acceptHello(
  room: VaultRoom,
  webSocket: RuntimeWebSocket,
  hello: ClientHello,
): Promise<void> {
  if (room.vaultId !== undefined && hello.vaultId !== room.vaultId) {
    webSocket.close(1008, 'vault-mismatch')
    return
  }
  const negotiation = decideClientCapabilityNegotiation({ advertised: hello.capabilities })
  if (negotiation.action === 'reject') {
    webSocket.close(1008, `capability-required:${negotiation.capability}`)
    return
  }
  const device = await readDeviceRegistryEntry(room, hello.deviceId)
  const tokenVersion = await authorizeHello(room, webSocket, hello, device)
  if (tokenVersion === undefined) return
  const registry = decideClientHelloRegistry({
    device,
    tokenVersion,
  })
  if (registry.action === 'reject') {
    webSocket.close(1008, `hello-reject:${registry.reason}`)
    return
  }
  const metadataAccess = negotiation.accepted.includes('metadata-schema-v2')
    ? 'read-write'
    : 'read-only'
  rememberSession(room, webSocket, {
    vaultId: hello.vaultId,
    deviceId: hello.deviceId,
    metadataAccess,
    metadataCapabilityAdvertised: hello.capabilities.includes('metadata-schema-v2'),
  })
  await persistVaultId(room, hello.vaultId)
  webSocket.send(
    JSON.stringify({
      type: 'hello-accepted',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId: hello.vaultId,
      deviceId: hello.deviceId,
      metadataAccess,
    }),
  )
}

export async function authorizeHello(
  room: VaultRoom,
  webSocket: RuntimeWebSocket,
  hello: ClientHello,
  device: DeviceRegistryEntry | undefined,
): Promise<number | undefined> {
  const secret = room.env.DEVICE_TOKEN_SECRET
  if (secret === undefined) {
    if (room.state.storage.sql !== undefined) {
      logEvent('auth-reject', { vaultId: hello.vaultId, reason: 'missing-secret' })
      webSocket.close(1008, 'auth-reject:missing-secret')
      return undefined
    }
    return device?.tokenVersion ?? 1
  }

  const token = readSocketToken(room, webSocket)
  if (token === undefined) {
    logEvent('auth-reject', { vaultId: hello.vaultId, reason: 'missing-token' })
    webSocket.close(1008, 'auth-reject:missing-token')
    return undefined
  }

  const claims = await verifyHs256DeviceToken({ token, secret })
  if (claims === undefined) {
    logEvent('auth-reject', { vaultId: hello.vaultId, reason: 'invalid-token' })
    webSocket.close(1008, 'auth-reject:invalid-token')
    return undefined
  }

  const admission = decideAuthAdmission({
    claims,
    expectedVaultId: hello.vaultId,
    device,
    requiredScopes: ['sync:read', 'sync:write'],
    now: Date.now(),
  })
  if (admission.action === 'reject') {
    logEvent('auth-reject', { vaultId: hello.vaultId, reason: admission.reason })
    webSocket.close(1008, `auth-reject:${admission.reason}`)
    return undefined
  }

  return claims.tokenVersion
}

export async function verifyRequestClaims(
  room: VaultRoom,
  c: Context,
): Promise<DeviceTokenClaims | undefined> {
  const secret = room.env.DEVICE_TOKEN_SECRET
  const token = extractBearerToken(c.req.header('Authorization') ?? null)
  if (secret === undefined || token === undefined) return undefined
  return verifyHs256DeviceToken({ token, secret })
}

export async function authorizeHttpRequest(
  room: VaultRoom,
  c: Context,
  requiredScopes: readonly DeviceTokenScope[],
): Promise<Response | undefined> {
  const result = await authorizeHttpRequestWithClaims(room, c, requiredScopes)
  return result.action === 'reject' ? result.response : undefined
}

export async function authorizeHttpRequestWithClaims(
  room: VaultRoom,
  c: Context,
  requiredScopes: readonly DeviceTokenScope[],
): Promise<
  | { readonly action: 'accept'; readonly claims: DeviceTokenClaims }
  | { readonly action: 'reject'; readonly response: Response }
> {
  const claims = await verifyRequestClaims(room, c)
  if (claims === undefined) {
    logEvent('auth-reject', { vaultId: room.vaultId, reason: 'invalid-token' })
    return {
      action: 'reject',
      response: c.json(apiErrorBody('auth/rejected', 'auth-reject:invalid-token'), 401),
    }
  }
  if (room.vaultId !== undefined && claims.aud !== room.vaultId) {
    return {
      action: 'reject',
      response: c.json(apiErrorBody('auth/rejected', 'vault-mismatch'), 400),
    }
  }
  room.vaultId = claims.aud

  const actorDevice = await readDeviceRegistryEntry(room, claims.sub)
  const admission = decideAuthAdmission({
    claims,
    expectedVaultId: claims.aud,
    device: actorDevice,
    requiredScopes,
    now: Date.now(),
  })
  if (admission.action === 'reject') {
    logEvent('auth-reject', { vaultId: claims.aud, reason: admission.reason })
    return {
      action: 'reject',
      response: c.json(
        apiErrorBody(
          apiErrorCodeForAuthAdmission(admission.reason),
          `auth-reject:${admission.reason}`,
        ),
        403,
      ),
    }
  }
  return { action: 'accept', claims }
}

/** Maps a device-token admission rejection to its guarded `ApiError` code. */
function apiErrorCodeForAuthAdmission(
  reason: Extract<AuthAdmissionDecision, { readonly action: 'reject' }>['reason'],
): ApiErrorCode {
  switch (reason) {
    case 'token-expired':
      return 'auth/expired'
    case 'device-revoked':
    case 'stale-token':
      return 'auth/revoked'
    default:
      return 'auth/rejected'
  }
}

export function messageMatchesSession(
  session: SessionState,
  message: { vaultId: string; deviceId: string },
): boolean {
  return message.vaultId === session.vaultId && message.deviceId === session.deviceId
}

export function rememberSocketToken(
  room: VaultRoom,
  webSocket: RuntimeWebSocket,
  authToken: string | undefined,
): void {
  room.socketTokens.set(webSocket, authToken)
  writeSocketAttachment(webSocket, {
    ...readSocketAttachment(webSocket),
    ...(authToken === undefined ? {} : { authToken }),
  })
}

export function readSocketToken(room: VaultRoom, webSocket: RuntimeWebSocket): string | undefined {
  const token = room.socketTokens.get(webSocket)
  if (token !== undefined) return token

  const attachmentToken = readSocketAttachment(webSocket).authToken
  if (attachmentToken !== undefined) room.socketTokens.set(webSocket, attachmentToken)
  return attachmentToken
}

export function rememberSession(
  room: VaultRoom,
  webSocket: RuntimeWebSocket,
  session: SessionState,
): void {
  room.sessions.add(webSocket)
  room.sessionStates.set(webSocket, session)
  writeSocketAttachment(webSocket, { ...readSocketAttachment(webSocket), session })
}

export function readSession(
  room: VaultRoom,
  webSocket: RuntimeWebSocket,
): SessionState | undefined {
  const session = room.sessionStates.get(webSocket)
  if (session !== undefined) return session

  const attachmentSession = readSocketAttachment(webSocket).session
  if (attachmentSession !== undefined) {
    room.sessions.add(webSocket)
    room.sessionStates.set(webSocket, attachmentSession)
  }
  return attachmentSession
}

export function rememberAwarenessAttachment(
  room: VaultRoom,
  webSocket: RuntimeWebSocket,
  awareness: WebSocketAwarenessAttachment,
): void {
  room.awarenessByWebSocket.set(webSocket, awareness)
  writeSocketAttachment(webSocket, { ...readSocketAttachment(webSocket), awareness })
}

export function readAwarenessAttachment(
  room: VaultRoom,
  webSocket: RuntimeWebSocket,
): WebSocketAwarenessAttachment | undefined {
  const remembered = room.awarenessByWebSocket.get(webSocket)
  if (remembered !== undefined) return remembered

  const attachmentAwareness = readSocketAttachment(webSocket).awareness
  if (attachmentAwareness !== undefined)
    room.awarenessByWebSocket.set(webSocket, attachmentAwareness)
  return attachmentAwareness
}

export function readSocketAttachment(webSocket: RuntimeWebSocket): WebSocketAttachment {
  const attachment = webSocket.deserializeAttachment?.()
  return isWebSocketAttachment(attachment) ? attachment : {}
}

export function writeSocketAttachment(
  webSocket: RuntimeWebSocket,
  attachment: WebSocketAttachment,
): void {
  webSocket.serializeAttachment?.(attachment)
}

export function broadcast(
  room: VaultRoom,
  sender: RuntimeWebSocket,
  message: string | ArrayBuffer,
): void {
  for (const session of connectedAuthenticatedSockets(room)) {
    if (session !== sender) session.send(message)
  }
}

export function connectedAuthenticatedSockets(room: VaultRoom): readonly RuntimeWebSocket[] {
  const hibernated = room.state.getWebSockets?.() ?? []
  return [...new Set([...room.sessions, ...hibernated])].filter(
    (session) => readSession(room, session) !== undefined,
  )
}

export function rememberVaultId(room: VaultRoom, request: Request): void {
  const match = /^\/ws\/([^/]+)$/.exec(new URL(request.url).pathname)
  const id = match?.[1]
  if (id !== undefined && v.is(VaultIdSchema, id)) room.vaultId = id
}
