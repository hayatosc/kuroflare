import assert from 'node:assert/strict'

import {
  QuarantinedUpdateActionResponseSchema,
  QuarantinedUpdateDetailResponseSchema,
  QuarantinedUpdateListResponseSchema,
  makeDeviceId,
  makeMessageId,
  makeSha256Hex,
  makeYDocId,
  type DocId,
} from '@kuroflare/core'
import * as v from 'valibot'
import { test } from 'vitest'

import type { QuarantinedUpdateRecord } from '../quarantine'
import {
  buildQuarantinedUpdateDetailResponse,
  buildQuarantinedUpdateListResponse,
  decideQuarantineConfirmation,
  planQuarantinedUpdateActionHttp,
  quarantineConfirmationSubject,
} from './quarantine'

const docId: DocId = { kind: 'file', ydocId: makeYDocId('doc-a') }
const record: QuarantinedUpdateRecord = {
  id: 'quarantine-a',
  docId,
  messageId: makeMessageId('message-a'),
  deviceId: makeDeviceId('device-a'),
  reason: 'yjs-apply-failed',
  updateSha256: makeSha256Hex('a'.repeat(64)),
  updateBytesLength: 32,
  createdAt: 100,
}

test('quarantine HTTP builders produce protocol-guarded list and detail responses', () => {
  const list = buildQuarantinedUpdateListResponse([record])
  assert.equal(v.is(QuarantinedUpdateListResponseSchema, list), true)
  const firstEntry = list.entries[0]
  if (!firstEntry) {
    throw new Error('Expected first entry to exist')
  }
  assert.equal('updateBytesBase64' in firstEntry, false)

  const detail = buildQuarantinedUpdateDetailResponse(record, 'AQID')
  assert.equal(v.is(QuarantinedUpdateDetailResponseSchema, detail), true)
  assert.equal(detail.updateBytesBase64, 'AQID')
})

test('quarantine confirmation binds token to action, row, and expiry', () => {
  assert.deepEqual(
    decideQuarantineConfirmation({
      action: 'discard',
      quarantineId: record.id,
      now: 100,
      evidence: {
        subject: quarantineConfirmationSubject('discard', record.id),
        expiresAt: 200,
        tokenHashMatches: true,
      },
    }),
    { valid: true },
  )

  assert.deepEqual(
    decideQuarantineConfirmation({
      action: 'discard',
      quarantineId: record.id,
      now: 100,
      evidence: {
        subject: quarantineConfirmationSubject('force-apply', record.id),
        expiresAt: 200,
        tokenHashMatches: true,
      },
    }),
    { valid: false, reason: 'subject-mismatch' },
  )

  assert.deepEqual(
    decideQuarantineConfirmation({
      action: 'discard',
      quarantineId: record.id,
      now: 200,
      evidence: {
        subject: quarantineConfirmationSubject('discard', record.id),
        expiresAt: 200,
        tokenHashMatches: true,
      },
    }),
    { valid: false, reason: 'token-expired' },
  )
})

test('quarantine action HTTP plan assembles discard response effects', () => {
  const plan = planQuarantinedUpdateActionHttp({
    request: { action: 'discard', confirmationToken: 'confirm-token' },
    record,
    now: 150,
    confirmation: {
      subject: quarantineConfirmationSubject('discard', record.id),
      expiresAt: 200,
      tokenHashMatches: true,
    },
    latestSeq: undefined,
    yClientId: undefined,
    yjsApplySucceeded: undefined,
    metaSchemaValid: undefined,
  })

  assert.equal(plan.action, 'respond')
  if (plan.action === 'respond') {
    assert.equal(plan.adminDecision.action, 'discard')
    assert.equal(v.is(QuarantinedUpdateActionResponseSchema, plan.response), true)
    assert.deepEqual(plan.response.effects, [
      { kind: 'quarantine-discard', count: 1, detail: record.id },
    ])
  }
})

test('quarantine action HTTP plan assembles force apply response effects', () => {
  const plan = planQuarantinedUpdateActionHttp({
    request: { action: 'force-apply', confirmationToken: 'confirm-token' },
    record,
    now: 150,
    confirmation: {
      subject: quarantineConfirmationSubject('force-apply', record.id),
      expiresAt: 200,
      tokenHashMatches: true,
    },
    latestSeq: 10,
    yClientId: 42,
    yjsApplySucceeded: true,
    metaSchemaValid: true,
  })

  assert.equal(plan.action, 'respond')
  if (plan.action === 'respond') {
    assert.equal(plan.adminDecision.action, 'force-apply')
    assert.equal(v.is(QuarantinedUpdateActionResponseSchema, plan.response), true)
    assert.deepEqual(plan.response.effects, [
      { kind: 'quarantine-force-apply', count: 1, detail: 'seq=11' },
    ])
  }
})

test('quarantine action HTTP plan rejects invalid confirmation and revalidation', () => {
  assert.deepEqual(
    planQuarantinedUpdateActionHttp({
      request: { action: 'discard', confirmationToken: 'confirm-token' },
      record,
      now: 150,
      confirmation: undefined,
      latestSeq: undefined,
      yClientId: undefined,
      yjsApplySucceeded: undefined,
      metaSchemaValid: undefined,
    }),
    { action: 'reject', reason: 'missing-token' },
  )

  assert.deepEqual(
    planQuarantinedUpdateActionHttp({
      request: { action: 'force-apply', confirmationToken: 'confirm-token' },
      record,
      now: 150,
      confirmation: {
        subject: quarantineConfirmationSubject('force-apply', record.id),
        expiresAt: 200,
        tokenHashMatches: true,
      },
      latestSeq: 10,
      yClientId: 42,
      yjsApplySucceeded: true,
      metaSchemaValid: false,
    }),
    { action: 'reject', reason: 'revalidation-failed' },
  )
})
