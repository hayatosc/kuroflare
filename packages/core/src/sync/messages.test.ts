import * as v from 'valibot'
import { assert, test } from 'vitest'
import * as Y from 'yjs'

import {
  blobManifestMatchesMetaFile,
  decodeMetaValue,
  decodeBinaryFrame,
  DEVICE_TOKEN_ISSUER,
  encodeBlobManifestJson,
  encodeBinaryFrame,
  groupedEntryFromMetaFile,
  LOCAL_OUTBOX_REPAIR_EXPORT_FORMAT,
  LOCAL_OUTBOX_REPAIR_EXPORT_VERSION,
  isMetaFile,
  isMalformedAwarenessUpdate,
  makeFileId,
  makeSha256Hex,
  makeDeviceId,
  makeMessageId,
  makeVaultId,
  makeYDocId,
  parseBlobManifestJson,
  parseControlMessage,
  parseSetupUri,
  stringifyBlobManifest,
  type BlobManifest,
  type BinaryMetaFile,
  type BinaryFrameHeader,
  AwarenessUpdateSchema,
  ClientHelloSchema,
  ControlMessageSchema,
  HelloAcceptedSchema,
  NeedFullSnapshotSchema,
  SyncUpdateRejectedSchema,
  SetupExchangeRequestSchema,
  SetupExchangeResponseSchema,
  SetupTokenIssueResponseSchema,
  DeviceTokenClaimsSchema,
  DeviceTokenScopeSchema,
  DeviceTokenRefreshRequestSchema,
  DeviceTokenRefreshResponseSchema,
  LocalOutboxRepairExportEntrySchema,
  LocalOutboxRepairExportSchema,
  HealthResponseSchema,
  HealthStatusSchema,
  HealthCheckNameSchema,
  BlobHeadRequestSchema,
  BlobHeadResponseSchema,
  BlobUploadUrlRequestSchema,
  BlobUploadUrlResponseSchema,
  MetaLatestSnapshotResponseSchema,
  SnapshotObjectKeySchema,
  DocLatestSnapshotResponseSchema,
  SnapshotImportRequestSchema,
  SnapshotImportResponseSchema,
  AdminOperationRequestSchema,
  AdminOperationResponseSchema,
  QuarantinedUpdateEntrySchema,
  QuarantinedUpdateListResponseSchema,
  QuarantinedUpdateDetailResponseSchema,
  QuarantinedUpdateActionDryRunResponseSchema,
  QuarantinedUpdateActionHttpRequestSchema,
  QuarantinedUpdateActionHttpResponseSchema,
  QuarantinedUpdateActionRequestSchema,
  QuarantinedUpdateActionResponseSchema,
  RevokeDeviceRequestSchema,
  RevokeDeviceResponseSchema,
  ApiErrorSchema,
  RetryableApiErrorSchema,
  BinaryFrameHeaderSchema,
  BlobManifestSchema,
} from '../index'

test('validates client hello', () => {
  const hello = {
    type: 'hello',
    protocolVersion: 1,
    vaultId: makeVaultId('vault-1'),
    deviceId: makeDeviceId('device-1'),
    capabilities: ['awareness', 'binary-v1'],
  }

  assert.equal(v.is(ClientHelloSchema, hello), true)
  assert.equal(v.is(ControlMessageSchema, hello), true)
  assert.equal(v.is(ClientHelloSchema, { ...hello, capabilities: ['unknown'] }), false)
  assert.equal(v.is(ClientHelloSchema, { ...hello, yClientId: 0 }), false)
})

test('validates hello accepted', () => {
  const accepted = {
    type: 'hello-accepted',
    protocolVersion: 1,
    vaultId: makeVaultId('vault-1'),
    deviceId: makeDeviceId('device-1'),
    metadataAccess: 'read-write',
  }

  assert.equal(v.is(HelloAcceptedSchema, accepted), true)
  assert.equal(v.is(ControlMessageSchema, accepted), true)
  assert.equal(v.is(HelloAcceptedSchema, { ...accepted, yClientId: 0 }), false)
  assert.equal(v.is(HelloAcceptedSchema, { ...accepted, metadataAccess: 'read-only' }), true)
  assert.equal(
    v.is(HelloAcceptedSchema, {
      type: accepted.type,
      protocolVersion: accepted.protocolVersion,
      vaultId: accepted.vaultId,
      deviceId: accepted.deviceId,
    }),
    true,
  )
})

test('validates need full snapshot reasons', () => {
  const message = {
    type: 'need-full-snapshot',
    protocolVersion: 1,
    vaultId: makeVaultId('vault-1'),
    deviceId: makeDeviceId('device-1'),
    docId: { kind: 'file', ydocId: makeYDocId('doc-1') },
    reason: 'state-vector-too-old',
  }

  assert.equal(v.is(NeedFullSnapshotSchema, message), true)
  assert.equal(v.is(NeedFullSnapshotSchema, { ...message, reason: 'missing-log' }), true)
  assert.equal(v.is(NeedFullSnapshotSchema, { ...message, reason: 'protocol-upgrade' }), true)
  assert.equal(v.is(NeedFullSnapshotSchema, { ...message, reason: 'large-update-snapshot' }), true)
  assert.equal(v.is(NeedFullSnapshotSchema, { ...message, reason: 'unknown' }), false)
})

test('validates guarded sync update rejection evidence', () => {
  const message = {
    type: 'sync-update-rejected',
    protocolVersion: 1,
    vaultId: makeVaultId('vault-1'),
    deviceId: makeDeviceId('device-1'),
    messageId: makeMessageId('message-1'),
    docId: { kind: 'file', ydocId: makeYDocId('doc-1') },
    updateSha256: makeSha256Hex('a'.repeat(64)),
    reason: 'large-update-requires-snapshot-import',
    retryable: false,
  }

  assert.equal(v.is(SyncUpdateRejectedSchema, message), true)
  assert.equal(v.is(ControlMessageSchema, message), true)
  assert.equal(parseControlMessage(JSON.stringify(message))?.type, 'sync-update-rejected')
  assert.equal(v.is(SyncUpdateRejectedSchema, { ...message, retryable: true }), false)
  assert.equal(v.is(SyncUpdateRejectedSchema, { ...message, updateSha256: undefined }), false)
  assert.equal(v.is(SyncUpdateRejectedSchema, { ...message, reason: 'unknown' }), false)
  assert.equal(v.is(SyncUpdateRejectedSchema, { ...message, reason: 'metadata-read-only' }), true)
  assert.equal(v.is(SyncUpdateRejectedSchema, { ...message, reason: 'hash-mismatch' }), true)
  assert.equal(v.is(SyncUpdateRejectedSchema, { ...message, reason: 'yjs-apply-failed' }), true)
  assert.equal(v.is(SyncUpdateRejectedSchema, { ...message, reason: 'meta-schema-invalid' }), true)
})

test('validates awareness update frames', () => {
  const message = {
    type: 'awareness-update',
    vaultId: makeVaultId('vault-1'),
    deviceId: makeDeviceId('device-1'),
    docId: { kind: 'file', ydocId: makeYDocId('doc-1') },
    clientId: 1,
    state: { cursor: { anchor: 0, head: 0 } },
  }

  assert.equal(v.is(AwarenessUpdateSchema, message), true)
  assert.equal(v.is(ControlMessageSchema, message), true)
  assert.equal(v.is(AwarenessUpdateSchema, { ...message, state: null }), true)
  assert.equal(v.is(AwarenessUpdateSchema, { ...message, clientId: -1 }), false)
  assert.equal(v.is(AwarenessUpdateSchema, { ...message, clientId: 1.5 }), false)
  assert.equal(v.is(AwarenessUpdateSchema, { ...message, state: 'not-an-object' }), false)
  assert.equal(
    v.is(AwarenessUpdateSchema, { ...message, state: { blob: 'x'.repeat(5_000) } }),
    false,
  )
  assert.equal(parseControlMessage(JSON.stringify(message))?.type, 'awareness-update')
})

test('drops malformed awareness-update frames without closing the session', () => {
  const oversized = {
    type: 'awareness-update',
    vaultId: makeVaultId('vault-1'),
    deviceId: makeDeviceId('device-1'),
    docId: { kind: 'meta' },
    clientId: 1,
    state: { blob: 'x'.repeat(5_000) },
  }

  assert.equal(parseControlMessage(oversized), null)
  assert.equal(isMalformedAwarenessUpdate(oversized), true)
  assert.equal(isMalformedAwarenessUpdate(JSON.stringify(oversized)), true)
  assert.equal(isMalformedAwarenessUpdate({ type: 'sync-request' }), false)
  assert.equal(isMalformedAwarenessUpdate('not json'), false)
  assert.equal(isMalformedAwarenessUpdate({ ...oversized, state: null }), false)
})

test('validates setup exchange request bodies', () => {
  const request = {
    vaultId: makeVaultId('vault-1'),
    setupToken: 'setup-token',
    requestedDeviceName: 'Laptop',
    existingDeviceId: makeDeviceId('device-1'),
  }

  assert.equal(v.is(SetupExchangeRequestSchema, request), true)
  assert.equal(v.is(SetupExchangeRequestSchema, { ...request, setupToken: '' }), false)
  assert.equal(v.is(SetupExchangeRequestSchema, { ...request, requestedDeviceName: '' }), false)
  assert.equal(v.is(SetupExchangeRequestSchema, { ...request, existingDeviceId: '/bad' }), false)
})

test('validates setup exchange response bodies', () => {
  const response = {
    endpoint: 'https://sync.example.test',
    vaultId: makeVaultId('vault-1'),
    deviceId: makeDeviceId('device-1'),
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    tokenVersion: 1,
    protocolVersion: 1,
    bootstrapMode: 'new-vault',
  }

  assert.equal(v.is(SetupExchangeResponseSchema, response), true)
  assert.equal(
    v.is(SetupExchangeResponseSchema, { ...response, endpoint: 'https://u:p@example.test' }),
    false,
  )
  assert.equal(v.is(SetupExchangeResponseSchema, { ...response, yClientId: 0 }), false)
  assert.equal(v.is(SetupExchangeResponseSchema, { ...response, refreshToken: '' }), false)
  assert.equal(v.is(SetupExchangeResponseSchema, { ...response, tokenVersion: 0 }), false)
  assert.equal(v.is(SetupExchangeResponseSchema, { ...response, bootstrapMode: 'other' }), false)
})

test('validates setup token issue response bodies', () => {
  const response = {
    endpoint: 'https://sync.example.test',
    vaultId: makeVaultId('vault-1'),
    setupToken: 'setup-token',
    setupUri:
      'kuroflare://setup?endpoint=https%3A%2F%2Fsync.example.test&vaultId=vault-1&setupToken=setup-token',
    issuedAt: 100,
    expiresAt: 700,
  }

  assert.equal(v.is(SetupTokenIssueResponseSchema, response), true)
  assert.equal(v.is(SetupTokenIssueResponseSchema, { ...response, setupToken: '' }), false)
  assert.equal(v.is(SetupTokenIssueResponseSchema, { ...response, expiresAt: 100 }), false)
  assert.equal(
    v.is(SetupTokenIssueResponseSchema, {
      ...response,
      setupUri:
        'kuroflare://setup?endpoint=https%3A%2F%2Fsync.example.test&vaultId=vault-2&setupToken=setup-token',
    }),
    false,
  )
  assert.equal(
    v.is(SetupTokenIssueResponseSchema, {
      ...response,
      endpoint: 'https://user:pass@sync.example.test',
    }),
    false,
  )
})

test('parses setup URI fields for client settings', () => {
  assert.deepEqual(
    parseSetupUri(
      ' kuroflare://setup?endpoint=https%3A%2F%2Fsync.example.test&vaultId=vault-1&setupToken=setup-token ',
    ),
    {
      endpoint: 'https://sync.example.test',
      vaultId: 'vault-1',
      setupToken: 'setup-token',
    },
  )
  assert.equal(parseSetupUri('https://sync.example.test'), undefined)
  assert.equal(
    parseSetupUri(
      'kuroflare://setup?endpoint=https%3A%2F%2Fuser%3Apass%40sync.example.test&vaultId=vault-1&setupToken=setup-token',
    ),
    undefined,
  )
  assert.equal(
    parseSetupUri('kuroflare://setup?endpoint=https%3A%2F%2Fsync.example.test&vaultId='),
    undefined,
  )
})

test('validates device token claims', () => {
  const claims = {
    iss: DEVICE_TOKEN_ISSUER,
    aud: makeVaultId('vault-1'),
    sub: makeDeviceId('device-1'),
    scope: ['sync:read', 'sync:write', 'blob:read', 'blob:write'],
    iat: 100,
    exp: 200,
    tokenVersion: 1,
  }

  assert.equal(v.is(DeviceTokenClaimsSchema, claims), true)
  assert.equal(v.is(DeviceTokenClaimsSchema, { ...claims, iss: 'other' }), false)
  assert.equal(v.is(DeviceTokenClaimsSchema, { ...claims, aud: '/bad' }), false)
  assert.equal(
    v.is(DeviceTokenClaimsSchema, { ...claims, scope: ['sync:read', 'sync:read'] }),
    false,
  )
  assert.equal(v.is(DeviceTokenClaimsSchema, { ...claims, scope: [] }), false)
  assert.equal(v.is(DeviceTokenClaimsSchema, { ...claims, exp: 100 }), false)
  assert.equal(v.is(DeviceTokenClaimsSchema, { ...claims, tokenVersion: 0 }), false)
  assert.equal(v.is(DeviceTokenScopeSchema, 'sync:read'), true)
  assert.equal(v.is(DeviceTokenScopeSchema, 'admin'), false)
})

test('validates device token refresh HTTP payloads', () => {
  const request = {
    vaultId: makeVaultId('vault-1'),
    deviceId: makeDeviceId('device-1'),
    refreshToken: 'refresh-token',
    previousTokenVersion: 3,
  }
  const response = {
    accessToken: 'access-token',
    tokenVersion: 4,
    expiresAt: 10_000,
    protocolVersion: 1,
    refreshToken: 'rotated-refresh-token',
  }

  assert.equal(v.is(DeviceTokenRefreshRequestSchema, request), true)
  assert.equal(v.is(DeviceTokenRefreshRequestSchema, { ...request, refreshToken: '' }), false)
  assert.equal(
    v.is(DeviceTokenRefreshRequestSchema, { ...request, previousTokenVersion: 0 }),
    false,
  )
  assert.equal(v.is(DeviceTokenRefreshRequestSchema, { ...request, deviceId: '/bad' }), false)

  assert.equal(v.is(DeviceTokenRefreshResponseSchema, response), true)
  assert.equal(v.is(DeviceTokenRefreshResponseSchema, { ...response, accessToken: '' }), false)
  assert.equal(v.is(DeviceTokenRefreshResponseSchema, { ...response, tokenVersion: 0 }), false)
  assert.equal(v.is(DeviceTokenRefreshResponseSchema, { ...response, expiresAt: -1 }), false)
  assert.equal(v.is(DeviceTokenRefreshResponseSchema, { ...response, protocolVersion: 0 }), false)
  assert.equal(v.is(DeviceTokenRefreshResponseSchema, { ...response, refreshToken: '' }), false)
  assert.equal(
    v.is(DeviceTokenRefreshResponseSchema, {
      accessToken: 'access-token',
      tokenVersion: 4,
      expiresAt: 10_000,
      protocolVersion: 1,
    }),
    true,
  )
})

test('validates local outbox repair export files', () => {
  const entry = {
    id: 'outbox-1',
    kind: 'y-update',
    status: 'pending',
    dependsOn: [],
    createdAt: 100,
    retryCount: 0,
    docId: { kind: 'file', ydocId: makeYDocId('doc-1') },
    messageId: makeMessageId('message-1'),
    updateSha256: makeSha256Hex('a'.repeat(64)),
    updateBytesBase64: 'AQID',
    reason: 'schema repair export',
  }
  const exportFile = {
    format: LOCAL_OUTBOX_REPAIR_EXPORT_FORMAT,
    formatVersion: LOCAL_OUTBOX_REPAIR_EXPORT_VERSION,
    exportedAt: 200,
    vaultId: makeVaultId('vault-1'),
    deviceId: makeDeviceId('device-1'),
    metadata: {
      localStoreVersion: 1,
      targetStoreVersion: 3,
      degradedReason: 'store-version-too-old-with-pending-outbox',
    },
    entries: [entry],
  }

  assert.equal(v.is(LocalOutboxRepairExportEntrySchema, entry), true)
  assert.equal(v.is(LocalOutboxRepairExportSchema, exportFile), true)
  assert.equal(v.is(LocalOutboxRepairExportSchema, { ...exportFile, formatVersion: 2 }), false)
  assert.equal(
    v.is(LocalOutboxRepairExportSchema, {
      ...exportFile,
      metadata: { ...exportFile.metadata, localStoreVersion: 0 },
    }),
    false,
  )
  assert.equal(
    v.is(LocalOutboxRepairExportSchema, {
      ...exportFile,
      entries: [{ ...entry, updateBytesBase64: 'not base64!' }],
    }),
    false,
  )
  assert.equal(
    v.is(LocalOutboxRepairExportSchema, {
      ...exportFile,
      entries: [{ ...entry, dependsOn: [''] }],
    }),
    false,
  )
})

test('validates health responses', () => {
  const response = {
    status: 'ok',
    protocolVersion: 1,
    checkedAt: 100,
    checks: [
      { name: 'worker', status: 'ok' },
      { name: 'durable-object', status: 'ok' },
      { name: 'sqlite', status: 'ok' },
      { name: 'r2', status: 'ok' },
      { name: 'migrations', status: 'ok' },
    ],
  }

  assert.equal(v.is(HealthResponseSchema, response), true)
  assert.equal(v.is(HealthResponseSchema, { ...response, protocolVersion: 0 }), false)
  assert.equal(v.is(HealthResponseSchema, { ...response, checkedAt: -1 }), false)
  assert.equal(
    v.is(HealthResponseSchema, {
      ...response,
      status: 'ok',
      checks: [{ name: 'migrations', status: 'degraded', detail: 'migration-failed' }],
    }),
    false,
  )
  assert.equal(
    v.is(HealthResponseSchema, {
      ...response,
      status: 'degraded',
      checks: [{ name: 'migrations', status: 'degraded', detail: '' }],
    }),
    false,
  )
  assert.equal(
    v.is(HealthResponseSchema, {
      ...response,
      checks: [
        { name: 'worker', status: 'ok' },
        { name: 'worker', status: 'ok' },
      ],
    }),
    false,
  )
  assert.equal(v.is(HealthStatusSchema, 'ok'), true)
  assert.equal(v.is(HealthStatusSchema, 'down'), false)
  assert.equal(v.is(HealthCheckNameSchema, 'sqlite'), true)
  assert.equal(v.is(HealthCheckNameSchema, 'redis'), false)
})

test('validates blob head request and response bodies', () => {
  const hash = makeSha256Hex('a'.repeat(64))
  const otherHash = makeSha256Hex('b'.repeat(64))

  assert.equal(v.is(BlobHeadRequestSchema, { hashes: [hash, otherHash] }), true)
  assert.equal(v.is(BlobHeadRequestSchema, { hashes: [] }), false)
  assert.equal(
    v.is(BlobHeadRequestSchema, { hashes: Array.from({ length: 513 }, () => hash) }),
    false,
  )
  assert.equal(v.is(BlobHeadRequestSchema, { hashes: ['not-a-hash'] }), false)

  assert.equal(
    v.is(BlobHeadResponseSchema, {
      exists: {
        [hash]: { found: true, size: 123 },
        [otherHash]: { found: false },
      },
    }),
    true,
  )
  assert.equal(
    v.is(BlobHeadResponseSchema, { exists: { [hash]: { found: false, size: 1 } } }),
    false,
  )
  assert.equal(v.is(BlobHeadResponseSchema, { exists: { 'not-a-hash': { found: true } } }), false)
})

test('validates blob upload-url request and response bodies', () => {
  const hash = makeSha256Hex('a'.repeat(64))
  const request = { sha256: hash, size: 0, multipart: false }

  assert.equal(v.is(BlobUploadUrlRequestSchema, request), true)
  assert.equal(v.is(BlobUploadUrlRequestSchema, { ...request, sha256: 'bad' }), false)
  assert.equal(v.is(BlobUploadUrlRequestSchema, { ...request, size: -1 }), false)
  assert.equal(v.is(BlobUploadUrlRequestSchema, { ...request, multipart: 'yes' }), false)

  assert.equal(v.is(BlobUploadUrlResponseSchema, { kind: 'already-exists' }), true)
  assert.equal(
    v.is(BlobUploadUrlResponseSchema, {
      kind: 'single-put',
      url: 'https://sync.example.test/upload',
      headers: { 'content-type': 'application/octet-stream' },
      expiresAt: 1,
    }),
    true,
  )
  assert.equal(
    v.is(BlobUploadUrlResponseSchema, {
      kind: 'single-put',
      url: 'https://user:pass@sync.example.test/upload',
      headers: {},
      expiresAt: 1,
    }),
    false,
  )
  assert.equal(
    v.is(BlobUploadUrlResponseSchema, {
      kind: 'single-put',
      url: 'https://sync.example.test/upload',
      headers: { 'bad\nheader': 'value' },
      expiresAt: 1,
    }),
    false,
  )
  assert.equal(
    v.is(BlobUploadUrlResponseSchema, {
      kind: 'multipart',
      uploadId: 'upload-1',
      parts: [
        {
          partNumber: 1,
          url: 'https://sync.example.test/upload/part-1',
          headers: {},
        },
      ],
      expiresAt: 1,
    }),
    true,
  )
  assert.equal(
    v.is(BlobUploadUrlResponseSchema, {
      kind: 'multipart',
      uploadId: 'upload-1',
      parts: [],
      expiresAt: 1,
    }),
    false,
  )
})

test('validates meta latest snapshot response bodies', () => {
  const response = {
    manifestSeq: 1,
    snapshotKey: 'snapshots/vault-1/meta/1.yupdate',
    snapshotSeq: 1,
    updateSha256: makeSha256Hex('a'.repeat(64)),
    stateVectorSha256: makeSha256Hex('b'.repeat(64)),
    stateVector: '',
    updateBytesBase64: 'AQID',
  }

  assert.equal(v.is(MetaLatestSnapshotResponseSchema, response), true)
  assert.equal(
    v.is(MetaLatestSnapshotResponseSchema, { ...response, snapshotKey: 'blob/1.yupdate' }),
    false,
  )
  assert.equal(
    v.is(MetaLatestSnapshotResponseSchema, { ...response, snapshotKey: 'snapshots//bad.yupdate' }),
    false,
  )
  assert.equal(v.is(MetaLatestSnapshotResponseSchema, { ...response, updateSha256: 'bad' }), false)
  assert.equal(
    v.is(MetaLatestSnapshotResponseSchema, { ...response, stateVectorSha256: 'bad' }),
    false,
  )
  assert.equal(
    v.is(MetaLatestSnapshotResponseSchema, { ...response, updateBytesBase64: 'not base64!' }),
    false,
  )
  assert.equal(v.is(SnapshotObjectKeySchema, 'snapshots/vault-1/files/doc-1/2.yupdate'), true)
  assert.equal(v.is(SnapshotObjectKeySchema, 'snapshots/vault-1/files/doc-1/2.json'), false)
})

test('validates doc latest snapshot response bodies', () => {
  const response = {
    docId: { kind: 'file', ydocId: makeYDocId('doc-1') },
    manifestSeq: 1,
    snapshotKey: 'snapshots/vault-1/files/doc-1/1.yupdate',
    snapshotSeq: 1,
    updateSha256: makeSha256Hex('a'.repeat(64)),
    stateVectorSha256: makeSha256Hex('b'.repeat(64)),
    stateVector: '',
    updateBytesBase64: 'AQID',
  }

  assert.equal(v.is(DocLatestSnapshotResponseSchema, response), true)
  assert.equal(
    v.is(DocLatestSnapshotResponseSchema, { ...response, docId: { kind: 'meta' } }),
    true,
  )
  assert.equal(
    v.is(DocLatestSnapshotResponseSchema, { ...response, docId: { kind: 'file' } }),
    false,
  )
  assert.equal(v.is(DocLatestSnapshotResponseSchema, { ...response, docId: 'doc-1' }), false)
  assert.equal(v.is(DocLatestSnapshotResponseSchema, { ...response, updateSha256: 'bad' }), false)
  assert.equal(
    v.is(DocLatestSnapshotResponseSchema, { ...response, stateVectorSha256: 'bad' }),
    false,
  )
  assert.equal(
    v.is(DocLatestSnapshotResponseSchema, { ...response, snapshotKey: 'snapshots//bad.yupdate' }),
    false,
  )
  assert.equal(v.is(DocLatestSnapshotResponseSchema, { ...response, docId: undefined }), false)
})

test('validates snapshot import request and response bodies', () => {
  const request = {
    updateBytesBase64: 'AQID',
    latestSeq: 2,
  }
  const response = {
    ok: true,
    vaultId: makeVaultId('vault-1'),
    docId: { kind: 'file', ydocId: makeYDocId('doc-1') },
    snapshotKey: 'snapshots/vault-1/files/doc-1/2.yupdate',
    snapshotSeq: 2,
  }

  assert.equal(v.is(SnapshotImportRequestSchema, request), true)
  assert.equal(v.is(SnapshotImportRequestSchema, { ...request, metadataSchemaVersion: 2 }), true)
  assert.equal(v.is(SnapshotImportRequestSchema, { ...request, metadataSchemaVersion: 1 }), false)
  assert.equal(v.is(SnapshotImportRequestSchema, { ...request, latestSeq: 0 }), false)
  assert.equal(
    v.is(SnapshotImportRequestSchema, { ...request, updateBytesBase64: 'not base64!' }),
    false,
  )
  assert.equal(v.is(SnapshotImportResponseSchema, response), true)
  assert.equal(v.is(SnapshotImportResponseSchema, { ...response, snapshotSeq: 0 }), false)
  assert.equal(
    v.is(SnapshotImportResponseSchema, { ...response, snapshotKey: 'blob/doc-1/2.yupdate' }),
    false,
  )
})

test('validates admin operation request bodies', () => {
  assert.equal(
    v.is(AdminOperationRequestSchema, {
      operation: 'gc',
      mode: 'dry-run',
      reason: 'cleanup',
    }),
    true,
  )
  assert.equal(
    v.is(AdminOperationRequestSchema, {
      operation: 'gc',
      mode: 'execute',
      confirmationToken: 'confirm-token',
    }),
    true,
  )
  assert.equal(
    v.is(AdminOperationRequestSchema, {
      operation: 'gc',
      mode: 'execute',
    }),
    false,
  )
  assert.equal(
    v.is(AdminOperationRequestSchema, {
      operation: 'gc',
      mode: 'dry-run',
      confirmationToken: 'stale-token',
    }),
    false,
  )
  assert.equal(v.is(AdminOperationRequestSchema, { operation: 'unknown', mode: 'dry-run' }), false)
})

test('validates admin operation response bodies', () => {
  assert.equal(
    v.is(AdminOperationResponseSchema, {
      operation: 'rebuild',
      mode: 'dry-run',
      confirmationRequired: true,
      confirmationToken: 'confirm-token',
      effects: [{ kind: 'rebuild-index', count: 1 }],
    }),
    true,
  )
  assert.equal(
    v.is(AdminOperationResponseSchema, {
      operation: 'rebuild',
      mode: 'execute',
      confirmationRequired: false,
      effects: [{ kind: 'rebuild-index', count: 1, detail: 'meta' }],
    }),
    true,
  )
  assert.equal(
    v.is(AdminOperationResponseSchema, {
      operation: 'rebuild',
      mode: 'execute',
      confirmationRequired: false,
      confirmationToken: 'should-not-return',
      effects: [],
    }),
    false,
  )
  assert.equal(
    v.is(AdminOperationResponseSchema, {
      operation: 'gc',
      mode: 'dry-run',
      confirmationRequired: true,
      confirmationToken: 'confirm-token',
      effects: [{ kind: 'delete-blob', count: -1 }],
    }),
    false,
  )
})

test('validates quarantined update admin response bodies', () => {
  const entry = {
    id: 'quarantine-1',
    docId: { kind: 'file', ydocId: makeYDocId('doc-1') },
    messageId: makeMessageId('message-1'),
    deviceId: makeDeviceId('device-1'),
    reason: 'meta-schema-invalid',
    updateSha256: makeSha256Hex('a'.repeat(64)),
    updateBytesLength: 42,
    createdAt: 100,
  }

  assert.equal(v.is(QuarantinedUpdateEntrySchema, entry), true)
  assert.equal(v.is(QuarantinedUpdateEntrySchema, { ...entry, reason: 'unknown' }), false)
  assert.equal(v.is(QuarantinedUpdateEntrySchema, { ...entry, updateBytesLength: 0 }), false)

  assert.equal(v.is(QuarantinedUpdateListResponseSchema, { entries: [entry] }), true)
  assert.equal(
    v.is(QuarantinedUpdateListResponseSchema, { entries: [{ ...entry, id: '' }] }),
    false,
  )

  assert.equal(
    v.is(QuarantinedUpdateDetailResponseSchema, {
      entry,
      updateBytesBase64: 'AQID',
    }),
    true,
  )
  assert.equal(
    v.is(QuarantinedUpdateDetailResponseSchema, {
      entry,
      updateBytesBase64: '*bad*',
    }),
    false,
  )
})

test('validates quarantined update admin action bodies', () => {
  assert.equal(v.is(QuarantinedUpdateActionHttpRequestSchema, { mode: 'dry-run' }), true)
  assert.equal(
    v.is(QuarantinedUpdateActionHttpRequestSchema, {
      mode: 'execute',
      confirmationToken: 'confirm-token',
      reason: 'bad update',
    }),
    true,
  )
  assert.equal(
    v.is(QuarantinedUpdateActionHttpRequestSchema, {
      mode: 'execute',
      reason: 'bad update',
    }),
    false,
  )
  assert.equal(
    v.is(QuarantinedUpdateActionHttpRequestSchema, {
      mode: 'dry-run',
      confirmationToken: 'confirm-token',
    }),
    false,
  )

  assert.equal(
    v.is(QuarantinedUpdateActionRequestSchema, {
      action: 'discard',
      confirmationToken: 'confirm-token',
      reason: 'bad update',
    }),
    true,
  )
  assert.equal(
    v.is(QuarantinedUpdateActionRequestSchema, {
      action: 'force-apply',
      confirmationToken: 'confirm-token',
    }),
    true,
  )
  assert.equal(
    v.is(QuarantinedUpdateActionRequestSchema, {
      action: 'inspect',
      confirmationToken: 'confirm-token',
    }),
    false,
  )
  assert.equal(v.is(QuarantinedUpdateActionRequestSchema, { action: 'discard' }), false)

  assert.equal(
    v.is(QuarantinedUpdateActionResponseSchema, {
      action: 'discard',
      id: 'quarantine-1',
      applied: true,
      effects: [{ kind: 'quarantine-discard', count: 1 }],
    }),
    true,
  )
  assert.equal(
    v.is(QuarantinedUpdateActionResponseSchema, {
      action: 'force-apply',
      id: 'quarantine-1',
      applied: true,
      effects: [{ kind: 'quarantine-force-apply', count: 1, detail: 'seq=11' }],
    }),
    true,
  )
  assert.equal(
    v.is(QuarantinedUpdateActionResponseSchema, {
      action: 'discard',
      id: 'quarantine-1',
      applied: false,
      effects: [{ kind: 'quarantine-discard', count: 1 }],
    }),
    false,
  )
  assert.equal(
    v.is(QuarantinedUpdateActionDryRunResponseSchema, {
      action: 'discard',
      id: 'quarantine-1',
      mode: 'dry-run',
      confirmationRequired: true,
      confirmationToken: 'confirm-token',
      effects: [{ kind: 'quarantine-discard', count: 1, detail: 'quarantine-1' }],
    }),
    true,
  )
  assert.equal(
    v.is(QuarantinedUpdateActionHttpResponseSchema, {
      action: 'force-apply',
      id: 'quarantine-1',
      applied: true,
      effects: [{ kind: 'quarantine-force-apply', count: 1, detail: 'seq=11' }],
    }),
    true,
  )
  assert.equal(
    v.is(QuarantinedUpdateActionHttpResponseSchema, {
      action: 'discard',
      id: 'quarantine-1',
      mode: 'dry-run',
      confirmationRequired: true,
      confirmationToken: 'confirm-token',
      effects: [{ kind: 'quarantine-discard', count: 1, detail: 'quarantine-1' }],
    }),
    true,
  )
})

test('validates revoke device request and response bodies', () => {
  assert.equal(v.is(RevokeDeviceRequestSchema, {}), true)
  assert.equal(v.is(RevokeDeviceRequestSchema, { reason: 'lost laptop' }), true)
  assert.equal(v.is(RevokeDeviceRequestSchema, { reason: '' }), false)
  assert.equal(v.is(RevokeDeviceRequestSchema, { reason: 1 }), false)

  const response = {
    deviceId: makeDeviceId('device-1'),
    status: 'revoked',
    revokedAt: 100,
    tokenVersion: 2,
  }

  assert.equal(v.is(RevokeDeviceResponseSchema, response), true)
  assert.equal(v.is(RevokeDeviceResponseSchema, { ...response, status: 'already-revoked' }), true)
  assert.equal(v.is(RevokeDeviceResponseSchema, { ...response, deviceId: '/bad' }), false)
  assert.equal(v.is(RevokeDeviceResponseSchema, { ...response, revokedAt: -1 }), false)
  assert.equal(v.is(RevokeDeviceResponseSchema, { ...response, tokenVersion: 0 }), false)
})

test('parses sync request JSON', () => {
  const json = JSON.stringify({
    type: 'sync-request',
    protocolVersion: 1,
    vaultId: 'vault-1',
    deviceId: 'device-1',
    messageId: 'message-1',
    docId: { kind: 'file', ydocId: 'doc-1' },
    stateVector: 'AQID',
  })

  const parsed = parseControlMessage(json)
  assert(parsed)
  assert.equal(parsed.type, 'sync-request')
  if (parsed.type !== 'sync-request') {
    throw new Error(`unexpected parsed message type: ${parsed.type}`)
  }
  assert.equal(parsed.docId.kind, 'file')
})

test('rejects unsupported protocol and malformed base64', () => {
  assert.equal(
    parseControlMessage({
      type: 'sync-update',
      protocolVersion: 999,
      vaultId: 'vault-1',
      deviceId: 'device-1',
      messageId: 'message-1',
      docId: { kind: 'meta' },
      update: 'AQID',
    }),
    null,
  )

  assert.equal(
    parseControlMessage({
      type: 'sync-update',
      protocolVersion: 1,
      vaultId: 'vault-1',
      deviceId: 'device-1',
      messageId: 'message-1',
      docId: { kind: 'meta' },
      update: 'not base64!',
    }),
    null,
  )

  assert.equal(
    parseControlMessage({
      type: 'sync-update',
      protocolVersion: 1,
      vaultId: 'vault-1',
      deviceId: 'device-1',
      messageId: 'message-1',
      docId: { kind: 'meta' },
      update: 'AQID',
      updateSha256: 'not-sha',
    }),
    null,
  )
})

test('validates binary frame header', () => {
  assert.equal(
    v.is(BinaryFrameHeaderSchema, {
      type: 'sync-update',
      protocolVersion: 1,
      vaultId: makeVaultId('vault-1'),
      deviceId: makeDeviceId('device-1'),
      messageId: makeMessageId('message-1'),
      docId: { kind: 'file', ydocId: makeYDocId('doc-1') },
      updateSha256: makeSha256Hex('a'.repeat(64)),
      durableSeq: 1,
    }),
    true,
  )
  assert.equal(
    v.is(BinaryFrameHeaderSchema, {
      type: 'sync-update',
      protocolVersion: 1,
      vaultId: makeVaultId('vault-1'),
      deviceId: makeDeviceId('device-1'),
      messageId: makeMessageId('message-1'),
      docId: { kind: 'file', ydocId: makeYDocId('doc-1') },
      durableSeq: -1,
    }),
    false,
  )
  assert.equal(
    v.is(BinaryFrameHeaderSchema, {
      type: 'sync-update',
      protocolVersion: 1,
      vaultId: makeVaultId('vault-1'),
      deviceId: makeDeviceId('device-1'),
      messageId: makeMessageId('message-1'),
      docId: { kind: 'file', ydocId: makeYDocId('doc-1') },
      updateSha256: 'not-sha',
    }),
    false,
  )
})

test('round-trips binary frames', () => {
  const header: BinaryFrameHeader = {
    type: 'sync-update',
    protocolVersion: 1,
    vaultId: makeVaultId('vault-1'),
    deviceId: makeDeviceId('device-1'),
    messageId: makeMessageId('message-1'),
    docId: { kind: 'file', ydocId: makeYDocId('doc-1') },
    updateSha256: makeSha256Hex('b'.repeat(64)),
    durableSeq: 2,
  }
  const payload = Uint8Array.from([1, 2, 3, 4])

  const decoded = decodeBinaryFrame(encodeBinaryFrame(header, payload))

  assert(decoded)
  assert.deepEqual(decoded.header, header)
  assert.deepEqual(decoded.payload, payload)
})

test('rejects invalid binary frame headers during encode', () => {
  assert.throws(() =>
    encodeBinaryFrame(
      {
        type: 'sync-update',
        protocolVersion: 999,
        vaultId: makeVaultId('vault-1'),
        deviceId: makeDeviceId('device-1'),
        messageId: makeMessageId('message-1'),
        docId: { kind: 'meta' },
      },
      Uint8Array.from([1]),
    ),
  )
})

test('rejects malformed binary frames', () => {
  const header: BinaryFrameHeader = {
    type: 'sync-update',
    protocolVersion: 1,
    vaultId: makeVaultId('vault-1'),
    deviceId: makeDeviceId('device-1'),
    messageId: makeMessageId('message-1'),
    docId: { kind: 'meta' },
  }
  const frame = encodeBinaryFrame(header, Uint8Array.from([1, 2, 3]))

  const badMagic = frame.slice()
  badMagic[0] = 0
  assert.equal(decodeBinaryFrame(badMagic), null)

  const badVersion = frame.slice()
  new DataView(badVersion.buffer, badVersion.byteOffset, badVersion.byteLength).setUint16(
    2,
    999,
    false,
  )
  assert.equal(decodeBinaryFrame(badVersion), null)

  const truncatedHeader = frame.slice()
  new DataView(
    truncatedHeader.buffer,
    truncatedHeader.byteOffset,
    truncatedHeader.byteLength,
  ).setUint32(4, 9999, false)
  assert.equal(decodeBinaryFrame(truncatedHeader), null)

  const invalidHeader = encodeBinaryFrame(
    { ...header, docId: { kind: 'file', ydocId: makeYDocId('doc-1') } },
    Uint8Array.from([1]),
  )
  const invalidHeaderJson = new TextEncoder().encode(
    JSON.stringify({ ...header, messageId: '/bad' }),
  )
  new DataView(invalidHeader.buffer, invalidHeader.byteOffset, invalidHeader.byteLength).setUint32(
    4,
    invalidHeaderJson.byteLength,
    false,
  )
  invalidHeader.set(invalidHeaderJson, 8)
  assert.equal(decodeBinaryFrame(invalidHeader), null)
})

test('validates API errors', () => {
  const retryable = {
    code: 'server/degraded',
    retryable: true,
    retryAfterMs: 1000,
  }
  const fatal = { code: 'auth/revoked', retryable: false }

  assert.equal(v.is(ApiErrorSchema, retryable), true)
  assert.equal(v.is(RetryableApiErrorSchema, retryable), true)
  assert.equal(v.is(ApiErrorSchema, fatal), true)
  assert.equal(v.is(RetryableApiErrorSchema, fatal), false)

  for (const code of [
    'auth/rejected',
    'server/error',
    'request/invalid',
    'request/not-found',
    'request/conflict',
  ]) {
    assert.equal(v.is(ApiErrorSchema, { code, retryable: false, detail: 'x' }), true)
  }
  assert.equal(v.is(ApiErrorSchema, { code: 'unknown/code', retryable: false }), false)
})

test('rejects invalid branded IDs', () => {
  assert.throws(() => makeVaultId(''))
  assert.throws(() => makeDeviceId('/bad'))
})

test('validates text meta files', () => {
  const fileId = makeFileId('file-1')
  const entry = {
    schemaVersion: 1,
    fileId,
    path: 'Notes/Idea.md',
    canonicalPath: 'notes/idea.md',
    type: 'text',
    ydocId: makeYDocId('doc-1'),
    deleted: false,
    createdAt: 1,
    createdBy: makeDeviceId('device-1'),
    contentUpdatedAt: 2,
    contentUpdatedBy: makeDeviceId('device-1'),
    updatedAt: 3,
    updatedBy: makeDeviceId('device-1'),
    mtime: 4,
  }

  assert.equal(isMetaFile(entry, fileId), true)
  assert.equal(isMetaFile({ ...entry, fileId: makeFileId('file-2') }, fileId), false)
  assert.equal(isMetaFile({ ...entry, canonicalPath: 'wrong' }, fileId), false)
  assert.equal(
    isMetaFile({ ...entry, blobManifestHash: makeSha256Hex('a'.repeat(64)) }, fileId),
    false,
  )
})

test('validates binary meta files', () => {
  const fileId = makeFileId('file-1')
  const chunk = makeSha256Hex('a'.repeat(64))
  const entry = {
    schemaVersion: 1,
    fileId,
    path: 'Assets/image.png',
    canonicalPath: 'assets/image.png',
    type: 'binary',
    blobManifestHash: makeSha256Hex('b'.repeat(64)),
    blobChunks: [chunk],
    deleted: true,
    deletedAt: 5,
    deletedBy: makeDeviceId('device-2'),
    createdAt: 1,
    createdBy: makeDeviceId('device-1'),
    contentUpdatedAt: 2,
    contentUpdatedBy: makeDeviceId('device-1'),
    updatedAt: 3,
    updatedBy: makeDeviceId('device-2'),
    mtime: 4,
  }

  assert.equal(isMetaFile(entry, fileId), true)
  assert.equal(isMetaFile({ ...entry, ydocId: makeYDocId('doc-1') }, fileId), false)
  assert.equal(isMetaFile({ ...entry, blobChunks: [] }, fileId), false)
  assert.equal(isMetaFile({ ...entry, path: '.obsidian/plugins/foo' }, fileId), false)
})

test('decodes grouped metadata, preserves normalized fields, and classifies unsupported values', () => {
  const fileId = makeFileId('grouped-file')
  const deviceId = makeDeviceId('grouped-device')
  const entry = {
    schemaVersion: 1 as const,
    fileId,
    path: 'Assets/Grouped.bin',
    canonicalPath: 'assets/grouped.bin',
    type: 'binary' as const,
    blobManifestHash: makeSha256Hex('a'.repeat(64)),
    blobChunks: [makeSha256Hex('b'.repeat(64))],
    deleted: true as const,
    deletedAt: 8,
    deletedBy: deviceId,
    deletedContentVersion: {
      kind: 'binary' as const,
      blobManifestHash: makeSha256Hex('a'.repeat(64)),
    },
    createdAt: 2,
    createdBy: deviceId,
    contentUpdatedAt: 7,
    contentUpdatedBy: deviceId,
    updatedAt: 6,
    updatedBy: deviceId,
    mtime: 99,
  }
  const grouped = groupedEntryFromMetaFile(entry)
  const doc = new Y.Doc()
  const child = new Y.Map<unknown>()
  child.set('identity', grouped.identity)
  child.set('location', grouped.location)
  child.set('content', grouped.content)
  child.set('deletion', grouped.deletion)
  doc.getMap('meta').set(fileId, child)

  const decoded = decodeMetaValue(doc.getMap('meta').get(fileId), fileId)
  assert.equal(decoded.disposition, 'supported-v2')
  assert.deepEqual(decoded.metaFile, entry)
  assert.equal(isMetaFile(doc.getMap('meta').get(fileId), fileId), false)
  assert.equal(decodeMetaValue(entry, fileId).disposition, 'legacy-v1')
  assert.equal(decodeMetaValue(new Map(Object.entries(grouped)), fileId).disposition, 'invalid')
  assert.equal(decodeMetaValue({ schemaVersion: 3 }, fileId).disposition, 'unsupported')
  assert.equal(decodeMetaValue(new Y.Map<unknown>(), fileId).disposition, 'invalid')

  child.set('location', { ...grouped.location, canonicalPath: 'wrong' })
  assert.equal(decodeMetaValue(child, fileId).disposition, 'invalid')
  doc.destroy()
})

test('fails closed for missing, mismatched, or active deletion witnesses', () => {
  const fileId = makeFileId('witness-validation')
  const entry = {
    schemaVersion: 1 as const,
    fileId,
    path: 'Note.md',
    canonicalPath: 'note.md',
    type: 'text' as const,
    ydocId: makeYDocId('witness-doc'),
    deleted: true as const,
    deletedAt: 1,
    deletedBy: makeDeviceId('witness-device'),
    deletedContentVersion: {
      kind: 'text' as const,
      stateVectorBase64: 'AA==',
      contentSha256: makeSha256Hex('a'.repeat(64)),
    },
    createdAt: 1,
    createdBy: makeDeviceId('witness-device'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('witness-device'),
    updatedAt: 1,
    updatedBy: makeDeviceId('witness-device'),
    mtime: 1,
  }
  const grouped = groupedEntryFromMetaFile(entry)
  const doc = new Y.Doc()
  const child = new Y.Map<unknown>()
  child.set('identity', grouped.identity)
  child.set('location', grouped.location)
  child.set('content', grouped.content)
  child.set('deletion', { deleted: true, deletedAt: 1, deletedBy: entry.deletedBy })
  doc.getMap('meta').set(fileId, child)
  assert.equal(decodeMetaValue(child, fileId).disposition, 'invalid')

  child.set('deletion', {
    deleted: true,
    deletedAt: 1,
    deletedBy: entry.deletedBy,
    deletedContentVersion: { kind: 'binary', blobManifestHash: makeSha256Hex('b'.repeat(64)) },
  })
  assert.equal(decodeMetaValue(child, fileId).disposition, 'invalid')

  child.set('deletion', {
    deleted: false,
    deletedContentVersion: entry.deletedContentVersion,
  })
  assert.equal(decodeMetaValue(child, fileId).disposition, 'invalid')
  doc.destroy()
})

test('validates blob manifests', () => {
  const fileId = makeFileId('file-1')
  const firstChunk = makeSha256Hex('a'.repeat(64))
  const secondChunk = makeSha256Hex('b'.repeat(64))
  const manifest: BlobManifest = {
    version: 1,
    fileId,
    contentSha256: makeSha256Hex('c'.repeat(64)),
    size: 12,
    chunks: [
      { sha256: firstChunk, offset: 0, size: 5 },
      { sha256: secondChunk, offset: 5, size: 7 },
    ],
    createdBy: makeDeviceId('device-1'),
    createdAt: 10,
  }

  assert.equal(v.is(BlobManifestSchema, manifest) && manifest.fileId === fileId, true)
  assert.equal(
    v.is(BlobManifestSchema, {
      ...manifest,
      chunks: [{ sha256: firstChunk, offset: 1, size: 12 }],
    }) && manifest.fileId === fileId,
    false,
  )
  assert.equal(
    v.is(BlobManifestSchema, { ...manifest, size: 11 }) && manifest.fileId === fileId,
    false,
  )
  assert.equal(
    v.is(BlobManifestSchema, { ...manifest, contentSha256: 'not-a-hash' }) &&
      manifest.fileId === fileId,
    false,
  )
})

test('canonicalizes blob manifest JSON', () => {
  const fileId = makeFileId('file-1')
  const manifest: BlobManifest = {
    version: 1,
    fileId,
    contentSha256: makeSha256Hex('c'.repeat(64)),
    size: 5,
    chunks: [{ sha256: makeSha256Hex('a'.repeat(64)), offset: 0, size: 5 }],
    createdBy: makeDeviceId('device-1'),
    createdAt: 10,
  }
  const canonicalJson =
    '{"version":1,"fileId":"file-1","contentSha256":"' +
    'c'.repeat(64) +
    '","size":5,"chunks":[{"sha256":"' +
    'a'.repeat(64) +
    '","offset":0,"size":5}],"createdBy":"device-1","createdAt":10}'
  const shuffledJson =
    '{"createdAt":10,"createdBy":"device-1","chunks":[{"size":5,"offset":0,"sha256":"' +
    'a'.repeat(64) +
    '"}],"size":5,"contentSha256":"' +
    'c'.repeat(64) +
    '","fileId":"file-1","version":1}'

  assert.equal(stringifyBlobManifest(manifest), canonicalJson)
  assert.deepEqual(encodeBlobManifestJson(manifest), new TextEncoder().encode(canonicalJson))
  assert.deepEqual(parseBlobManifestJson(shuffledJson, fileId), manifest)
  assert.equal(parseBlobManifestJson('{', fileId), null)
})

test('matches blob manifests to binary meta files', () => {
  const fileId = makeFileId('file-1')
  const firstChunk = makeSha256Hex('a'.repeat(64))
  const secondChunk = makeSha256Hex('b'.repeat(64))
  const metaFile: BinaryMetaFile = {
    schemaVersion: 1,
    fileId,
    path: 'Assets/image.png',
    canonicalPath: 'assets/image.png',
    type: 'binary',
    blobManifestHash: makeSha256Hex('d'.repeat(64)),
    blobChunks: [firstChunk, secondChunk],
    deleted: false,
    createdAt: 1,
    createdBy: makeDeviceId('device-1'),
    contentUpdatedAt: 2,
    contentUpdatedBy: makeDeviceId('device-1'),
    updatedAt: 3,
    updatedBy: makeDeviceId('device-1'),
    mtime: 4,
  }
  const manifest: BlobManifest = {
    version: 1,
    fileId,
    contentSha256: makeSha256Hex('c'.repeat(64)),
    size: 2,
    chunks: [
      { sha256: firstChunk, offset: 0, size: 1 },
      { sha256: secondChunk, offset: 1, size: 1 },
    ],
    createdBy: makeDeviceId('device-1'),
    createdAt: 5,
  }

  assert.equal(v.is(BlobManifestSchema, manifest) && manifest.fileId === fileId, true)
  assert.equal(blobManifestMatchesMetaFile(manifest, metaFile), true)
  assert.equal(
    blobManifestMatchesMetaFile(
      {
        ...manifest,
        chunks: [
          { sha256: secondChunk, offset: 0, size: 1 },
          { sha256: firstChunk, offset: 1, size: 1 },
        ],
      },
      metaFile,
    ),
    false,
  )
})
