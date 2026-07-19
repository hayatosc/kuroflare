import { decodeMetaValue, type MetaFile, type MetadataAccess } from '@kuroflare/core'

import {
  type MetadataReconcilePort,
  type MetadataReconcileWriteContext,
} from '../metadata/evidence'
import type { MetadataMaterializationPort } from '../metadata/materialize'
import {
  canDiscardInvalidMetaRepairEntry,
  planInvalidMetaIsolationDetail,
} from '../sync/obsidian/meta-quarantine'
import {
  planPathConflictAutoResolve,
  planRemoteMaterializeBlockedAutoResolve,
} from '../sync/obsidian/repair-actions'
import type { KuroflareInvalidMetaIsolationDetail, KuroflareRepairLogEntry } from '../types'
import { REPAIR_DEVICE, REPAIR_ORIGIN } from './constants'
import { metaMap, readMetaFile, updateMetaFile } from './meta'

export interface RepairCommandsPort {
  readonly captureContext: () => MetadataReconcileWriteContext | undefined
  readonly contextStillStable: (context: MetadataReconcileWriteContext) => boolean
  readonly metadataWritesEnabled: () => boolean
  readonly metadataReconcileTransitionPending: () => boolean
  readonly metadataMaterializationPort: () => MetadataMaterializationPort
  readonly metadataReconcilePort: () => MetadataReconcilePort
  readonly getMetaValue: (fileId: string) => unknown
  readonly getMetaEntry: (fileId: string) => MetaFile | undefined
  readonly getMetadataAccess: () => MetadataAccess
  readonly isPathAvailable: (path: string) => boolean
  readonly materializeMetaRenames: (port: MetadataMaterializationPort) => Promise<boolean>
  readonly reconcileAndMaterializeMeta: (
    reconcile: MetadataReconcilePort,
    materialize: MetadataMaterializationPort,
  ) => Promise<void>
  readonly requestMissingRemoteTextFile: (
    value: Extract<MetaFile, { readonly type: 'text'; readonly deleted: false }>,
  ) => Promise<boolean>
  readonly enqueueMissingRemoteBinaryDownloads: (
    reconcile: MetadataReconcilePort,
    materialize: MetadataMaterializationPort,
    reason: string,
  ) => Promise<ReadonlySet<string>>
  readonly websocketReadyState: () => number
  readonly openWorkerWebSocket: () => Promise<void>
  readonly waitForOutboundUpdates: (timeoutMs: number) => Promise<void>
  readonly removeRepairLogEntry: (
    entryId: string,
    context: MetadataReconcileWriteContext,
  ) => Promise<boolean>
  readonly notify: (message: string) => void
  readonly getInvalidMetaIsolationDetail: () => KuroflareInvalidMetaIsolationDetail | null
  readonly setInvalidMetaIsolationDetail: (
    detail: KuroflareInvalidMetaIsolationDetail | null,
  ) => void
}

export async function clearRepairLogEntry(
  entry: KuroflareRepairLogEntry,
  port: RepairCommandsPort,
): Promise<void> {
  const context = port.captureContext()
  if (context === undefined) return
  if (await port.removeRepairLogEntry(entry.id, context)) {
    port.notify(`Kuroflare repair: cleared ${entry.kind}`)
  }
}

export async function retryPathConflictRepairEntry(
  entry: KuroflareRepairLogEntry,
  port: RepairCommandsPort,
): Promise<void> {
  if (entry.kind !== 'path-conflict' && entry.kind !== 'portable-path') return
  if (!port.metadataWritesEnabled()) return
  if (port.metadataReconcileTransitionPending()) return
  const context = port.captureContext()
  if (context === undefined) return
  if (!(await port.materializeMetaRenames(port.metadataMaterializationPort()))) return
  if (port.websocketReadyState() !== WebSocket.OPEN) {
    await port.openWorkerWebSocket()
  }
  // The rename has already synced incrementally through metaDoc's update listener.
  // Waiting for the existing outbound queue avoids resending a full Y.Doc update,
  // which would re-emit historical deletes and can be quarantined by the server.
  await port.waitForOutboundUpdates(120_000)
  await port.removeRepairLogEntry(entry.id, context)
}

export async function retryKeepDeletedRepairEntry(
  entry: KuroflareRepairLogEntry,
  port: RepairCommandsPort,
): Promise<void> {
  if (entry.kind !== 'delete-vs-edit' || entry.reason !== 'missing-binary-content') return
  if (!port.metadataWritesEnabled()) return
  const context = port.captureContext()
  if (context === undefined) return

  const current = port.getMetaEntry(entry.fileId)
  if (current === undefined || !current.deleted || current.type !== 'binary') {
    await port.removeRepairLogEntry(entry.id, context)
    return
  }

  await port.reconcileAndMaterializeMeta(
    port.metadataReconcilePort(),
    port.metadataMaterializationPort(),
  )
  const reconciled = port.getMetaEntry(entry.fileId)
  if (reconciled === undefined || reconciled.deleted) return
  await port.removeRepairLogEntry(entry.id, context)
}

export async function resolvePathConflictRepairEntry(
  entry: KuroflareRepairLogEntry,
  port: RepairCommandsPort,
): Promise<void> {
  if (entry.kind !== 'path-conflict' && entry.kind !== 'portable-path') return
  if (!port.metadataWritesEnabled()) return
  if (port.metadataReconcileTransitionPending()) return
  const context = port.captureContext()
  if (context === undefined) return
  if (!port.contextStillStable(context)) return
  const current = port.getMetaEntry(entry.fileId)
  const plan = planPathConflictAutoResolve({
    entry,
    current,
    isPathAvailable: port.isPathAvailable,
  })
  if (plan.action === 'rename-meta-path') {
    if (!port.contextStillStable(context)) return
    const contextMeta = metaMap({ metaDoc: context.metaDoc })
    context.metaDoc.transact(() => {
      const value = readMetaFile(contextMeta, entry.fileId)
      if (value === undefined) return
      updateMetaFile(contextMeta, {
        ...value,
        path: plan.toPath,
        canonicalPath: plan.toCanonicalPath,
        updatedAt: Date.now(),
        updatedBy: REPAIR_DEVICE,
      })
    }, REPAIR_ORIGIN)
    if (!port.contextStillStable(context)) return
    if (!(await port.materializeMetaRenames(port.metadataMaterializationPort()))) return
  }
  await port.removeRepairLogEntry(entry.id, context)
}

export async function retryRemoteMaterializeBlockedRepairEntry(
  entry: KuroflareRepairLogEntry,
  port: RepairCommandsPort,
): Promise<void> {
  if (entry.kind !== 'remote-materialize-blocked') return
  const context = port.captureContext()
  if (context === undefined) return
  const current = port.getMetaEntry(entry.fileId)
  if (current === undefined || current.deleted) {
    await port.removeRepairLogEntry(entry.id, context)
    return
  }
  if (current.type === 'text') {
    if (!(await port.requestMissingRemoteTextFile(current))) return
  } else {
    const completedFileIds = await port.enqueueMissingRemoteBinaryDownloads(
      port.metadataReconcilePort(),
      port.metadataMaterializationPort(),
      'repair:remote-materialize-retry',
    )
    if (!completedFileIds.has(current.fileId)) return
  }
  await port.removeRepairLogEntry(entry.id, context)
}

export async function resolveRemoteMaterializeBlockedRepairEntry(
  entry: KuroflareRepairLogEntry,
  port: RepairCommandsPort,
): Promise<void> {
  if (entry.kind !== 'remote-materialize-blocked') return
  if (!port.metadataWritesEnabled()) return
  if (port.metadataReconcileTransitionPending()) return
  const context = port.captureContext()
  if (context === undefined) return
  if (!port.contextStillStable(context)) return
  const current = port.getMetaEntry(entry.fileId)
  const plan = planRemoteMaterializeBlockedAutoResolve({
    entry,
    current,
    isPathAvailable: port.isPathAvailable,
  })
  if (
    plan.action === 'rename-meta-path' &&
    current !== undefined &&
    !current.deleted &&
    current.type === 'text'
  ) {
    if (!port.contextStillStable(context)) return
    const contextMeta = metaMap({ metaDoc: context.metaDoc })
    context.metaDoc.transact(() => {
      const value = readMetaFile(contextMeta, entry.fileId)
      if (value === undefined) return
      updateMetaFile(contextMeta, {
        ...value,
        path: plan.toPath,
        canonicalPath: plan.toCanonicalPath,
        updatedAt: Date.now(),
        updatedBy: REPAIR_DEVICE,
      })
    }, REPAIR_ORIGIN)
    if (!port.contextStillStable(context)) return
    const updated = readMetaFile(contextMeta, entry.fileId)
    if (updated !== undefined && !updated.deleted && updated.type === 'text') {
      if (!(await port.requestMissingRemoteTextFile(updated))) return
    }
  } else {
    return
  }
  await port.removeRepairLogEntry(entry.id, context)
}

export async function inspectInvalidMetaRepairEntry(
  entry: KuroflareRepairLogEntry,
  port: RepairCommandsPort,
): Promise<void> {
  if (entry.kind !== 'invalid-meta') return
  const plan = planInvalidMetaIsolationDetail({
    entry,
    current: port.getMetaValue(entry.fileId),
    inspectedAt: Date.now(),
  })
  if (plan.action === 'isolate') {
    port.setInvalidMetaIsolationDetail(plan.detail)
  }
}

export async function discardInvalidMetaRepairEntry(
  entry: KuroflareRepairLogEntry,
  confirmation: string,
  port: RepairCommandsPort,
): Promise<void> {
  if (entry.kind !== 'invalid-meta') return
  const context = port.captureContext()
  if (context === undefined) return
  const current = port.getMetaValue(entry.fileId)
  if (
    !canDiscardInvalidMetaRepairEntry({
      metadataAccess: port.getMetadataAccess(),
      fileId: entry.fileId,
      current,
      confirmation,
    })
  ) {
    return
  }
  const decoded = decodeMetaValue(current, entry.fileId)
  if (current === undefined || decoded.disposition !== 'invalid') {
    clearInvalidMetaIsolationDetail(entry, port)
    await port.removeRepairLogEntry(entry.id, context)
    return
  }
  if (!port.contextStillStable(context)) return
  const contextMeta = metaMap({ metaDoc: context.metaDoc })
  context.metaDoc.transact(() => {
    contextMeta.delete(entry.fileId)
  }, REPAIR_ORIGIN)
  if (!port.contextStillStable(context)) return
  clearInvalidMetaIsolationDetail(entry, port)
  await port.removeRepairLogEntry(entry.id, context)
}

function clearInvalidMetaIsolationDetail(
  entry: KuroflareRepairLogEntry,
  port: RepairCommandsPort,
): void {
  if (port.getInvalidMetaIsolationDetail()?.fileId === entry.fileId) {
    port.setInvalidMetaIsolationDetail(null)
  }
}
