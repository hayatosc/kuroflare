import { decodeMetaValue, type MetaRepair } from '@kuroflare/core'

import type { KuroflareRepairLogEntry } from '../main-types'
import { REPAIR_DEVICE, REPAIR_ORIGIN } from '../main/constants'
import { mergeRepairLogEntries } from '../main/helpers'
import { metadataWritesEnabled } from '../main/meta'
import { reconcileMetaDoc } from '../sync/meta/reconcile'
import {
  enqueueMissingRemoteBinaryDownloads,
  findRestorableBinaryFileIdsForReconcile,
} from './metadata-binary-restore'
import {
  materializeMetaDeletes,
  materializeMetaRenames,
  type MetadataMaterializationPort,
} from './metadata-materialization'
import {
  captureReconcileContext,
  reconcileContextIdentityStillStable,
  reconcileContextStillStable,
  type MetadataReconcilePort,
  type ReconcileContext,
} from './metadata-reconcile-context'
import {
  collectTextDeletionEvidenceForReconcile,
  textDeletionEvidenceStillStable,
} from './metadata-text-evidence'

export type {
  MetadataReconcileBinaryPort,
  MetadataReconcileContextPort,
  MetadataReconcilePort,
  MetadataReconcileTextPort,
  MetadataReconcileWriteContext,
  ReconcileContext,
} from './metadata-reconcile-context'
export {
  enqueueMissingRemoteBinaryDownloads,
  findRestorableBinaryFileIdsForReconcile,
} from './metadata-binary-restore'
export {
  clearTextDeletionEvidenceRequest,
  findTextDeletionEvidenceForReconcile,
  scheduleTextDeletionEvidenceRetry,
} from './metadata-text-evidence'

/** Runs metadata repair followed by safe Vault reconciliation/materialization. */
export async function reconcileAndMaterializeMeta(
  reconcile: MetadataReconcilePort,
  materialize: MetadataMaterializationPort,
): Promise<void> {
  if (!reconcile.canSendNetwork()) return
  if (!(await reconcileMetaWithEvidence(reconcile, 0))) return
  if (!(await materializeMetaRenames(materialize))) return
  if (!materializeMetaDeletes(materialize)) return
  await enqueueMissingRemoteBinaryDownloads(reconcile, materialize, 'meta-reconcile')
}

async function reconcileMetaWithEvidence(
  reconcile: MetadataReconcilePort,
  attempt: number,
): Promise<boolean> {
  const context = captureReconcileContext(reconcile)
  if (context === undefined) return false
  if (
    metadataWritesEnabled({
      metadataAccess: reconcile.getMetadataAccess(),
      metaDoc: reconcile.getMetaDoc(),
    })
  ) {
    const textResult = await collectTextDeletionEvidenceForReconcile(reconcile, context)
    if (
      textResult.unstable ||
      !textDeletionEvidenceStillStable(reconcile, textResult) ||
      !reconcileContextStillStable(reconcile, context)
    ) {
      return await retryReconcileAfterEvidenceInstability(reconcile, attempt, context)
    }
    const restorableBinaryFileIds = await findRestorableBinaryFileIdsForReconcile(reconcile)
    const currentMetaDoc = reconcile.getMetaDoc()
    if (
      textResult.unstable ||
      !textDeletionEvidenceStillStable(reconcile, textResult) ||
      !reconcileContextStillStable(reconcile, context)
    ) {
      return await retryReconcileAfterEvidenceInstability(reconcile, attempt, context)
    } else if (
      metadataWritesEnabled({
        metadataAccess: reconcile.getMetadataAccess(),
        metaDoc: currentMetaDoc,
      })
    ) {
      const reconciled = reconcileMetaDoc(currentMetaDoc.getMap<unknown>('meta'), {
        updatedAt: Date.now(),
        updatedBy: REPAIR_DEVICE,
        restorableBinaryFileIds,
        textDeletionEvidence: textResult.evidence,
        origin: REPAIR_ORIGIN,
      })
      if (
        !(await recordMetaRepairLog(
          reconcile,
          reconciled.repairs,
          reconciled.invalidFileIds,
          context,
        )) ||
        !(await clearResolvedDeleteDeferrals(reconcile, reconciled.repairs, context))
      ) {
        return false
      }
      return reconcileContextIdentityStillStable(reconcile, context)
    }
  } else if (reconcile.getMetadataAccess() === 'read-write') {
    const invalidFileIds: string[] = []
    for (const [fileId, value] of reconcile.getMetaDoc().getMap<unknown>('meta').entries()) {
      if (decodeMetaValue(value, fileId).disposition === 'invalid') invalidFileIds.push(fileId)
    }
    if (!(await recordMetaRepairLog(reconcile, [], invalidFileIds, context))) return false
    return reconcileContextStillStable(reconcile, context)
  }
  return reconcileContextIdentityStillStable(reconcile, context)
}

async function retryReconcileAfterEvidenceInstability(
  reconcile: MetadataReconcilePort,
  attempt: number,
  context: ReconcileContext,
): Promise<boolean> {
  if (!reconcileContextIdentityStillStable(reconcile, context)) {
    reconcile.scheduleReconcileRetry?.()
    return false
  }
  if (attempt === 0) {
    return await reconcileMetaWithEvidence(reconcile, 1)
  }
  reconcile.scheduleReconcileRetry?.()
  return false
}

async function clearResolvedDeleteDeferrals(
  reconcile: MetadataReconcilePort,
  repairs: readonly MetaRepair[],
  context: ReconcileContext,
): Promise<boolean> {
  const pending = new Set(
    repairs
      .filter(
        (repair): repair is Extract<MetaRepair, { action: 'defer-deletion' }> =>
          'action' in repair && repair.action === 'defer-deletion',
      )
      .map((repair) => repair.fileId),
  )
  const current = reconcile.getSettings().repairLog ?? []
  const deferredReasons = new Set([
    'legacy-deletion-tombstone',
    'deletion-evidence-unavailable',
    'deletion-base-not-dominated',
    'invalid-deletion-evidence',
  ])
  const next = current.filter(
    (entry) =>
      !(
        entry.kind === 'delete-vs-edit' &&
        deferredReasons.has(entry.reason) &&
        !pending.has(entry.fileId)
      ),
  )
  if (next.length === current.length) return reconcileContextIdentityStillStable(reconcile, context)
  if (!reconcileContextIdentityStillStable(reconcile, context)) return false
  const written = await reconcile.updateSettings(
    (latest) => ({
      repairLog: (latest.repairLog ?? []).filter(
        (entry) =>
          !(
            entry.kind === 'delete-vs-edit' &&
            deferredReasons.has(entry.reason) &&
            !pending.has(entry.fileId)
          ),
      ),
    }),
    context,
  )
  return written && reconcileContextIdentityStillStable(reconcile, context)
}

async function recordMetaRepairLog(
  reconcile: MetadataReconcilePort,
  repairs: readonly MetaRepair[],
  invalidFileIds: readonly string[],
  context: ReconcileContext,
): Promise<boolean> {
  if (repairs.length === 0 && invalidFileIds.length === 0) {
    return reconcileContextIdentityStillStable(reconcile, context)
  }
  const createdAt = Date.now()
  const entries: KuroflareRepairLogEntry[] = [
    ...repairs.map(
      (repair): KuroflareRepairLogEntry => ({
        id:
          'action' in repair
            ? `delete-vs-edit:${repair.fileId}:${repair.action}`
            : 'reason' in repair
              ? `portable-path:${repair.fileId}`
              : `path-conflict:${repair.fileId}`,
        kind:
          'action' in repair
            ? 'delete-vs-edit'
            : 'reason' in repair
              ? 'portable-path'
              : 'path-conflict',
        fileId: repair.fileId,
        path: 'toPath' in repair ? repair.toPath : undefined,
        reason:
          'action' in repair
            ? repair.action === 'keep-deleted'
              ? 'missing-binary-content'
              : repair.action === 'defer-deletion'
                ? repair.reason
                : 'concurrent-edit-after-delete'
            : 'reason' in repair
              ? repair.reason
              : 'path-conflict-renamed',
        createdAt,
      }),
    ),
    ...invalidFileIds.map(
      (fileId): KuroflareRepairLogEntry => ({
        id: `invalid-meta:${fileId}`,
        kind: 'invalid-meta',
        fileId,
        reason: 'meta-schema-invalid',
        createdAt,
      }),
    ),
  ]
  if (!reconcileContextIdentityStillStable(reconcile, context)) return false
  const written = await reconcile.updateSettings(
    (latest) => ({
      repairLog: mergeRepairLogEntries(latest.repairLog ?? [], entries),
    }),
    context,
  )
  return written && reconcileContextIdentityStillStable(reconcile, context)
}
