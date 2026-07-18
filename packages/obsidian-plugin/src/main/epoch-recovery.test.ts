import { assert, describe, test } from 'vitest'
import * as Y from 'yjs'

import {
  buildRecoveryCandidate,
  classifyDocumentEpoch,
  completeDocumentEpochRecovery,
  createReadyDocumentEpoch,
  createRecoveringDocumentEpoch,
  createYDocFromSnapshot,
  type DocumentRecoveryLifecycleStage,
  isDocumentEpochRecord,
  probeIndexedDbProvider,
  recoverDocumentEpoch,
  recoverDocumentEpochLifecycle,
} from './epoch-recovery'

const metaDoc = { kind: 'meta' } as const

function updateForText(value: string): Uint8Array {
  const doc = new Y.Doc()
  doc.getText('text').insert(0, value)
  const update = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return update
}

function dependentTextUpdates(): { readonly parent: Uint8Array; readonly child: Uint8Array } {
  const doc = new Y.Doc()
  const text = doc.getText('text')
  const beforeParent = Y.encodeStateVector(doc)
  text.insert(0, 'parent')
  const parent = Y.encodeStateAsUpdate(doc, beforeParent)
  const beforeChild = Y.encodeStateVector(doc)
  text.insert(6, '-child')
  const child = Y.encodeStateAsUpdate(doc, beforeChild)
  doc.destroy()
  return { parent, child }
}

describe('document epoch recovery', () => {
  test('probes databases without opening a missing provider', async () => {
    let openCount = 0
    const result = await probeIndexedDbProvider(
      {
        databases: async () => [{ name: 'other', version: 1 }],
      },
      'kuroflare-file:missing',
    )

    assert.deepEqual(result, {
      ok: true,
      status: 'absent',
      dbName: 'kuroflare-file:missing',
    })
    assert.equal(openCount, 0)
  })

  test('fails closed for unavailable or malformed directory evidence', async () => {
    assert.equal((await probeIndexedDbProvider({}, 'kuroflare-meta:vault')).ok, false)
    assert.equal(
      (await probeIndexedDbProvider({ databases: async () => [{ name: '', version: 1 }] }, 'x'))
        .status,
      'malformed',
    )
  })

  test('classifies initial, new, and lost providers conservatively', async () => {
    const initial = classifyDocumentEpoch({
      provider: { ok: true, status: 'present', dbName: 'kuroflare-meta:vault' },
      hasLocalYDoc: false,
      hasPendingOutbox: false,
    })
    assert.deepEqual(initial, { action: 'establish-initial-epoch' })
    const fresh = classifyDocumentEpoch({
      provider: { ok: true, status: 'absent', dbName: 'kuroflare-file:new' },
      hasLocalYDoc: false,
      hasPendingOutbox: false,
    })
    assert.deepEqual(fresh, { action: 'create-new-provider' })
    const epoch = createReadyDocumentEpoch({
      docId: metaDoc,
      providerDbName: 'kuroflare-meta:vault',
      now: 1,
      epochId: 'epoch-1',
    })
    assert.deepEqual(
      classifyDocumentEpoch({
        provider: { ok: true, status: 'absent', dbName: epoch.providerDbName },
        epoch,
        hasLocalYDoc: false,
        hasPendingOutbox: true,
      }),
      { action: 'recover', reason: 'provider-loss' },
    )
    assert.equal(isDocumentEpochRecord(epoch), true)
    assert.deepEqual(
      classifyDocumentEpoch({
        provider: {
          ok: false,
          status: 'unavailable',
          dbName: epoch.providerDbName,
          reason: 'unavailable',
        },
        epoch,
        hasLocalYDoc: true,
        hasPendingOutbox: true,
      }),
      { action: 'blocked', reason: 'provider-probe-failed' },
    )
    assert.deepEqual(
      classifyDocumentEpoch({
        provider: { ok: true, status: 'absent', dbName: 'kuroflare-file:fresh' },
        hasLocalYDoc: false,
        hasPendingOutbox: false,
      }),
      { action: 'create-new-provider' },
    )
  })

  test('merges authoritative, local base, and pending updates', async () => {
    const result = await buildRecoveryCandidate({
      docId: metaDoc,
      remoteUpdateBytes: updateForText('remote'),
      localBaseUpdateBytes: updateForText(' local'),
      pendingUpdates: [
        {
          id: 'outbox-1',
          docId: metaDoc,
          status: 'paused',
          updateBytes: updateForText(' pending'),
        },
      ],
    })
    assert.equal(result.ok, true)
    if (result.ok) {
      const doc = new Y.Doc()
      Y.applyUpdate(doc, result.candidate.updateBytes)
      assert.equal(doc.getText('text').toJSON().includes('remote'), true)
      assert.deepEqual(result.candidate.includedOutboxIds, ['outbox-1'])
      doc.destroy()
    }
  })

  test('keeps malformed or wrong-document outbox rows blocked', async () => {
    const malformed = await buildRecoveryCandidate({
      docId: metaDoc,
      pendingUpdates: [
        {
          id: 'bad',
          docId: metaDoc,
          status: 'pending',
          updateBytes: new Uint8Array([0xff]),
        },
      ],
    })
    assert.equal(malformed.ok, false)
    if (!malformed.ok) assert.equal(malformed.reason, 'malformed-pending-update')
    const wrongDoc = await buildRecoveryCandidate({
      docId: metaDoc,
      pendingUpdates: [
        {
          id: 'wrong',
          docId: { kind: 'file', ydocId: 'file-1' },
          status: 'pending',
          updateBytes: updateForText('wrong'),
        },
      ],
    })
    assert.equal(wrongDoc.ok, false)
    if (!wrongDoc.ok) assert.equal(wrongDoc.reason, 'invalid-outbox-row')
  })

  test('orders reverse child/parent rows and rejects dependency cycles', async () => {
    const parent = updateForText('parent')
    const child = updateForText('child')
    const ordered = await buildRecoveryCandidate({
      docId: metaDoc,
      pendingUpdates: [
        {
          id: 'child',
          docId: metaDoc,
          status: 'pending',
          updateBytes: child,
          dependsOn: ['parent'],
        },
        { id: 'parent', docId: metaDoc, status: 'pending', updateBytes: parent },
      ],
    })
    assert.equal(ordered.ok, true)
    if (ordered.ok) assert.deepEqual(ordered.candidate.includedOutboxIds, ['parent', 'child'])
    const cycle = await buildRecoveryCandidate({
      docId: metaDoc,
      pendingUpdates: [
        { id: 'a', docId: metaDoc, status: 'pending', updateBytes: parent, dependsOn: ['b'] },
        { id: 'b', docId: metaDoc, status: 'pending', updateBytes: child, dependsOn: ['a'] },
      ],
    })
    assert.equal(cycle.ok, false)
    if (!cycle.ok) assert.equal(cycle.reason, 'outbox-dependency-cycle')
    const missing = await buildRecoveryCandidate({
      docId: metaDoc,
      pendingUpdates: [
        { id: 'a', docId: metaDoc, status: 'pending', updateBytes: parent, dependsOn: ['missing'] },
      ],
    })
    assert.equal(missing.ok, false)
    if (!missing.ok) assert.equal(missing.reason, 'outbox-dependency-missing')
  })

  test('orders causally dependent Yjs updates and blocks unresolved pending structs', async () => {
    const updates = dependentTextUpdates()
    const ordered = await buildRecoveryCandidate({
      docId: metaDoc,
      pendingUpdates: [
        {
          id: 'child',
          docId: metaDoc,
          status: 'pending',
          updateBytes: updates.child,
          dependsOn: ['parent'],
        },
        { id: 'parent', docId: metaDoc, status: 'pending', updateBytes: updates.parent },
      ],
    })
    assert.equal(ordered.ok, true)
    if (ordered.ok) {
      assert.deepEqual(ordered.candidate.includedOutboxIds, ['parent', 'child'])
      const doc = new Y.Doc()
      Y.applyUpdate(doc, ordered.candidate.updateBytes)
      assert.equal(doc.getText('text').toJSON(), 'parent-child')
      doc.destroy()
    }
    const unresolved = await buildRecoveryCandidate({
      docId: metaDoc,
      pendingUpdates: [
        { id: 'child', docId: metaDoc, status: 'pending', updateBytes: updates.child },
      ],
    })
    assert.equal(unresolved.ok, false)
    if (!unresolved.ok) assert.equal(unresolved.reason, 'unresolved-pending-update')
  })

  test('does not create an existing epoch from a remote 404 with no local source', async () => {
    const result = await recoverDocumentEpoch({
      docId: metaDoc,
      pendingUpdates: [],
      snapshots: {
        fetchLatest: async () => ({ kind: 'not-found' as const }),
        importSnapshot: async () => ({ ok: true as const, snapshotSeq: 1 }),
      },
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'remote-not-found-existing-document')
  })

  test('rebuilds after a bounded CAS conflict', async () => {
    let attempts = 0
    const result = await recoverDocumentEpoch({
      docId: metaDoc,
      localBaseUpdateBytes: updateForText('existing-local-base'),
      pendingUpdates: [],
      snapshots: {
        fetchLatest: async () => ({ kind: 'not-found' as const }),
        importSnapshot: async () => {
          attempts += 1
          return attempts === 1
            ? { ok: false as const, status: 409 as const }
            : { ok: true as const, snapshotSeq: 1 }
        },
      },
    })
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.attempts, 2)
  })

  test('restarts safely after each pre-commit crash boundary', async () => {
    const pending = {
      id: 'outbox-crash',
      docId: metaDoc,
      status: 'pending' as const,
      updateBytes: updateForText('pending'),
    }
    let remoteUpdate: Uint8Array | undefined
    let importCount = 0
    const run = async (crashAt?: 'candidate-built' | 'remote-imported') => {
      let crashed = false
      const result = await recoverDocumentEpoch({
        docId: metaDoc,
        localBaseUpdateBytes: updateForText('local'),
        pendingUpdates: [pending],
        snapshots: {
          fetchLatest: async () =>
            remoteUpdate === undefined
              ? { kind: 'not-found' as const }
              : { kind: 'found' as const, updateBytes: remoteUpdate, manifestSeq: 1 },
          importSnapshot: async ({ updateBytes }) => {
            importCount += 1
            remoteUpdate = updateBytes
            return { ok: true as const, snapshotSeq: importCount }
          },
        },
        onStage: (stage) => {
          if (stage === crashAt && !crashed) {
            crashed = true
            throw new Error(`crash:${stage}`)
          }
        },
      })
      return { result, crashed }
    }

    await expectCrash(() => run('candidate-built'), 'candidate-built')
    const afterCandidateCrash = await run()
    assert.equal(afterCandidateCrash.result.ok, true)
    if (afterCandidateCrash.result.ok) {
      assert.deepEqual(afterCandidateCrash.result.candidate.includedOutboxIds, ['outbox-crash'])
    }

    await expectCrash(() => run('remote-imported'), 'remote-imported')
    const afterImportCrash = await run()
    assert.equal(afterImportCrash.result.ok, true)
    if (afterImportCrash.result.ok) {
      assert.deepEqual(afterImportCrash.result.candidate.includedOutboxIds, ['outbox-crash'])
    }
    assert.equal(importCount >= 3, true)
  })

  test('restarts the provider lifecycle from every hydration boundary without losing the outbox row', async () => {
    const crashStages: readonly DocumentRecoveryLifecycleStage[] = [
      'remote-imported',
      'provider-created',
      'provider-applied',
      'provider-synced',
      'before-atomic-commit',
      'after-atomic-commit',
    ]
    for (const crashStage of crashStages) {
      const pending = updateForText(`pending-${crashStage}`)
      const localBase = updateForText(`local-${crashStage}`)
      let epoch = createReadyDocumentEpoch({
        docId: metaDoc,
        providerDbName: `kuroflare-meta:${crashStage}`,
        now: 1,
        epochId: `previous-${crashStage}`,
      })
      let providerExists = false
      let providerUpdate: Uint8Array | undefined
      let providerDoc: Y.Doc | undefined
      let providerActor: number | undefined
      let remoteUpdate: Uint8Array | undefined
      let remoteSeq = 0
      let outboxStatus: 'pending' | 'done' = 'pending'
      let providerCreates = 0
      let providerApplies = 0
      let providerSyncs = 0
      let commits = 0
      const recoveryEpochIds: string[] = []

      const run = async (crash: DocumentRecoveryLifecycleStage | undefined) => {
        const classification = classifyDocumentEpoch({
          provider: {
            ok: true,
            status: providerExists ? 'present' : 'absent',
            dbName: epoch.providerDbName,
          },
          epoch,
          hasLocalYDoc: true,
          hasPendingOutbox: outboxStatus === 'pending',
        })
        if (classification.action === 'create-new-provider') {
          if (providerExists) {
            const persistedUpdate = providerUpdate
            providerDoc?.destroy()
            providerDoc = new Y.Doc()
            providerActor = providerDoc.clientID
            if (persistedUpdate !== undefined) Y.applyUpdate(providerDoc, persistedUpdate)
          } else {
            providerExists = true
            providerUpdate = undefined
          }
          return
        }
        if (classification.action !== 'recover') return
        if (epoch.status === 'recovering' && providerExists) {
          providerDoc?.destroy()
          providerDoc = undefined
          providerExists = false
          providerUpdate = undefined
        }
        epoch = createRecoveringDocumentEpoch({
          docId: metaDoc,
          providerDbName: epoch.providerDbName,
          now: Date.now(),
          previous: epoch,
          reason: 'provider-loss',
        })
        recoveryEpochIds.push(epoch.epochId)
        await recoverDocumentEpochLifecycle({
          docId: metaDoc,
          localBaseUpdateBytes: localBase,
          pendingUpdates: [
            {
              id: `outbox-${crashStage}`,
              docId: metaDoc,
              status: 'pending',
              updateBytes: pending,
            },
          ],
          recoveringEpoch: epoch,
          snapshots: {
            fetchLatest: async () =>
              remoteUpdate === undefined
                ? { kind: 'not-found' as const }
                : { kind: 'found' as const, updateBytes: remoteUpdate, manifestSeq: remoteSeq },
            importSnapshot: async ({ updateBytes }) => {
              remoteUpdate = updateBytes
              remoteSeq += 1
              return { ok: true as const, snapshotSeq: remoteSeq }
            },
          },
          hydrateProvider: {
            create: async () => {
              providerCreates += 1
              providerDoc = new Y.Doc()
              providerActor = providerDoc.clientID
              providerExists = true
              providerUpdate = undefined
            },
            apply: async (candidate) => {
              providerApplies += 1
              if (providerDoc === undefined) throw new Error('provider-doc-missing')
              Y.applyUpdate(providerDoc, candidate.updateBytes)
              providerUpdate = candidate.updateBytes
            },
            whenSynced: async () => {
              providerSyncs += 1
              if (providerUpdate === undefined) throw new Error('provider-update-missing')
            },
          },
          commit: async ({ readyEpoch, candidate }) => {
            commits += 1
            epoch = readyEpoch
            providerUpdate = candidate.updateBytes
            outboxStatus = 'done'
          },
          onLifecycleStage: (stage) => {
            if (stage === crash) throw new Error(`crash:${stage}`)
          },
        })
      }

      await expectCrash(() => run(crashStage), crashStage)
      assert.equal(outboxStatus, crashStage === 'after-atomic-commit' ? 'done' : 'pending')
      assert.equal(epoch.status, crashStage === 'after-atomic-commit' ? 'ready' : 'recovering')
      const providerAfterCrash = providerExists
      const updateAfterCrash = providerUpdate
      const actorAfterCrash = providerActor
      await run(undefined)
      assert.equal(outboxStatus, 'done')
      assert.equal(epoch.status, 'ready')
      assert.equal(providerExists, true)
      assert.equal(providerActor !== undefined, true)
      assert.equal(commits, 1)
      assert.equal(providerUpdate instanceof Uint8Array, true)
      if (providerUpdate !== undefined && remoteUpdate !== undefined) {
        assert.deepEqual(Array.from(providerUpdate), Array.from(remoteUpdate))
      }
      if (providerAfterCrash && updateAfterCrash !== undefined) {
        assert.notEqual(updateAfterCrash.byteLength, 0)
      }
      const expectedCreates =
        crashStage === 'remote-imported' || crashStage === 'after-atomic-commit' ? 1 : 2
      assert.equal(providerCreates, expectedCreates)
      assert.equal(recoveryEpochIds.length, crashStage === 'after-atomic-commit' ? 1 : 2)
      if (recoveryEpochIds.length === 2) {
        assert.notEqual(recoveryEpochIds[0], recoveryEpochIds[1])
      }
      if (crashStage === 'after-atomic-commit') {
        assert.notEqual(providerActor, actorAfterCrash)
      } else if (actorAfterCrash !== undefined) {
        assert.notEqual(providerActor, actorAfterCrash)
      }
      assert.equal(providerApplies >= 1, true)
      assert.equal(providerSyncs >= 1, true)
      assert.equal(remoteSeq, crashStage === 'after-atomic-commit' ? 1 : 2)
      providerDoc?.destroy()
    }
  })

  test('ready epoch completion is repeatable without changing the candidate or row set', async () => {
    const recovering = createRecoveringDocumentEpoch({
      docId: metaDoc,
      providerDbName: 'kuroflare-meta:vault',
      now: 1,
      reason: 'provider-loss',
    })
    const updateBytes = updateForText('durable')
    const first = await completeDocumentEpochRecovery({
      recovering,
      now: 2,
      updateBytes,
      remoteCursorSeq: 4,
    })
    const second = await completeDocumentEpochRecovery({
      recovering,
      now: 2,
      updateBytes,
      remoteCursorSeq: 4,
    })
    assert.deepEqual(second, first)
    assert.equal(first.status, 'ready')
  })

  test('recovery epoch receives a fresh identity before remote mutation', () => {
    const recovering = createRecoveringDocumentEpoch({
      docId: metaDoc,
      providerDbName: 'kuroflare-meta:vault',
      now: 10,
      previous: createReadyDocumentEpoch({
        docId: metaDoc,
        providerDbName: 'kuroflare-meta:vault',
        now: 1,
        epochId: 'lost-epoch',
      }),
      reason: 'provider-loss',
    })
    assert.notEqual(recovering.epochId, 'lost-epoch')
    assert.equal(recovering.status, 'recovering')
  })
})

async function expectCrash(run: () => Promise<unknown>, stage: string): Promise<void> {
  try {
    await run()
  } catch (error: unknown) {
    assert.equal(error instanceof Error ? error.message : String(error), `crash:${stage}`)
    return
  }
  throw new Error(`expected crash:${stage}`)
}

test('full snapshot replacement does not retain stale Y.Doc structs', () => {
  const staleDoc = new Y.Doc()
  staleDoc.getMap('meta').set('stale-file', { path: 'stale.md' })

  const snapshotDoc = new Y.Doc()
  snapshotDoc.getMap('meta').set('remote-file', { path: 'remote.md' })
  const snapshot = Y.encodeStateAsUpdate(snapshotDoc)
  const replaced = createYDocFromSnapshot(snapshot, 'worker')

  assert.equal(replaced.getMap('meta').has('stale-file'), false)
  assert.deepEqual(replaced.getMap('meta').get('remote-file'), { path: 'remote.md' })
  assert.equal(staleDoc.getMap('meta').has('stale-file'), true)
})
