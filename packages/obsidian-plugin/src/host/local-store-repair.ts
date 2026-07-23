import {
  LocalOutboxRepairEvidenceRequestSchema,
  LocalOutboxRepairEvidenceResponseSchema,
  makeVaultId,
} from '@kuroflare/core'
import * as v from 'valibot'

import { createWorkerClient } from '../sync/api-client'
import {
  createBrowserLocalStoreIndexedDbFactoryPort,
  createLocalStoreIndexedDbDatabasePort,
  commitLocalStoreIndexedDbDatabaseTransaction,
  readLocalStoreIndexedDbSchemaEvidence,
} from '../sync/store/indexeddb'
import {
  buildLocalStoreRepairExport,
  planLocalStoreRepair,
  planLocalStoreRepairImport,
  planLocalStoreRepairImportResume,
  planLocalStoreRepairImportResumeTransaction,
  readLocalStoreRepairExportFile,
  writeLocalStoreRepairExportFile,
} from '../sync/store/repair'
import {
  LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
  localStoreIndexedDbName,
  planLocalStoreIndexedDbOpen,
} from '../sync/store/schema'
import type { LocalStoreOutboxRecord } from '../sync/store/store'
import { requireSetupMetadata } from './auth'
import { isLocalStoreOutboxRecord, isStagedRepairImportRecord } from './guards'
import { waitForIndexedDbRequest, waitForIndexedDbTransaction } from './helpers'
import { runExclusiveLocalStoreRepair } from './local-store-coordination'
import { scheduleOutboxWorkerTick } from './outbox/tick'
import type KuroflareSpikePlugin from './plugin'
import { rebuildLocalStoreDatabase } from './store'

function repairImportEvidence(records: Awaited<ReturnType<typeof readRepairOutbox>>['records']) {
  const durableMessages = records.flatMap((record) => {
    if (
      record.status !== 'done' ||
      record.docId === undefined ||
      record.messageId === undefined ||
      record.durableSeq === undefined ||
      !Number.isSafeInteger(record.durableSeq) ||
      record.durableSeq < 0
    ) {
      return []
    }
    return [{ docId: record.docId, messageId: record.messageId, durableSeq: record.durableSeq }]
  })
  const quarantinedMessages = records.flatMap((record) => {
    if (
      record.reason !== 'server-quarantine' ||
      record.docId === undefined ||
      record.messageId === undefined ||
      record.updateSha256 === undefined
    ) {
      return []
    }
    return [{ docId: record.docId, messageId: record.messageId, updateSha256: record.updateSha256 }]
  })
  return { durableMessages, quarantinedMessages }
}

async function readRepairOutbox(dbName: string) {
  const db = await waitForIndexedDbRequest(indexedDB.open(dbName))
  try {
    if (!db.objectStoreNames.contains('outbox')) return { records: [], rawValues: [], rawCount: 0 }
    const transaction = db.transaction('outbox', 'readonly')
    const values: unknown[] = await waitForIndexedDbRequest(
      transaction.objectStore('outbox').getAll(),
    )
    await waitForIndexedDbTransaction(transaction)
    return {
      records: values.filter(isLocalStoreOutboxRecord),
      rawValues: values,
      rawCount: values.length,
    }
  } finally {
    db.close()
  }
}

async function readHealthyRepairState(plugin: KuroflareSpikePlugin) {
  const setup = requireSetupMetadata(plugin)
  const vaultId = makeVaultId(setup.vaultId)
  const evidence = await readLocalStoreIndexedDbSchemaEvidence({
    dbName: localStoreIndexedDbName(vaultId),
    indexedDb: createBrowserLocalStoreIndexedDbFactoryPort(indexedDB),
  })
  if (!evidence.ok) throw new Error(`local-store-evidence:${evidence.reason}`)
  const openPlan = planLocalStoreIndexedDbOpen({ vaultId, ...evidence.evidence })
  if (!openPlan.ok || openPlan.decision.action !== 'open') {
    throw new Error('local-store-repair-requires-healthy-store')
  }
  return { setup, vaultId, evidence: evidence.evidence }
}

async function fetchRepairImportEvidence(
  plugin: KuroflareSpikePlugin,
  records: readonly LocalStoreOutboxRecord[],
) {
  if (!plugin.startupSideEffectGate.canSendNetwork()) {
    throw new Error('repair-resume-network-not-allowed')
  }
  const setup = requireSetupMetadata(plugin)
  const request = {
    items: records.filter(isStagedRepairImportRecord).map((record) => ({
      docId: record.docId,
      messageId: record.messageId,
      updateSha256: record.updateSha256,
    })),
  }
  const requestResult = v.safeParse(LocalOutboxRepairEvidenceRequestSchema, request)
  if (!requestResult.success) throw new Error('repair-resume-evidence-request-invalid')
  const accessToken = await plugin.readAccessToken(setup)
  if (accessToken === undefined) throw new Error('repair-resume-token-missing')
  const response = await createWorkerClient(setup.endpoint, accessToken).repair[
    'local-outbox'
  ].evidence.$post({ json: requestResult.output })
  if (!response.ok) throw new Error(`repair-resume-evidence-http:${response.status}`)
  const responseResult = v.safeParse(
    LocalOutboxRepairEvidenceResponseSchema,
    await response.json().catch(() => undefined),
  )
  if (!responseResult.success) throw new Error('repair-resume-evidence-response-invalid')
  return responseResult.output
}

async function ensureParentDirectories(plugin: KuroflareSpikePlugin, path: string): Promise<void> {
  const parts = path.split('/').slice(0, -1)
  let current = ''
  for (const part of parts) {
    current = current.length === 0 ? part : `${current}/${part}`
    if (!(await plugin.app.vault.adapter.exists(current))) {
      await plugin.app.vault.adapter.mkdir(current)
    }
  }
}

async function readDegradedRepairEvidence(plugin: KuroflareSpikePlugin) {
  const setup = requireSetupMetadata(plugin)
  const vaultId = makeVaultId(setup.vaultId)
  const evidence = await readLocalStoreIndexedDbSchemaEvidence({
    dbName: localStoreIndexedDbName(vaultId),
    indexedDb: createBrowserLocalStoreIndexedDbFactoryPort(indexedDB),
  })
  if (!evidence.ok) throw new Error(`local-store-evidence:${evidence.reason}`)
  const openPlan = planLocalStoreIndexedDbOpen({ vaultId, ...evidence.evidence })
  if (openPlan.startupGate !== 'degraded') throw new Error('local-store-not-degraded')
  return { setup, vaultId, evidence: evidence.evidence, schemaDecision: openPlan.decision }
}

/** Exports validated local outbox records without mutating IndexedDB. */
export async function exportLocalStoreRepair(plugin: KuroflareSpikePlugin): Promise<string> {
  return runExclusiveLocalStoreRepair(plugin, () => exportLocalStoreRepairUnlocked(plugin))
}

async function exportLocalStoreRepairUnlocked(plugin: KuroflareSpikePlugin): Promise<string> {
  const state = await readDegradedRepairEvidence(plugin)
  if (!state.evidence.presentStores.includes('outbox')) {
    throw new Error('repair-export-outbox-unavailable')
  }
  const now = Date.now()
  const outbox = await readRepairOutbox(localStoreIndexedDbName(state.vaultId))
  if (
    outbox.rawCount !== state.evidence.pendingOutboxCount ||
    outbox.records.length !== outbox.rawCount
  ) {
    throw new Error('repair-export-outbox-validation-incomplete')
  }
  const plan = planLocalStoreRepair({
    vaultId: state.vaultId,
    schemaDecision: state.schemaDecision,
    request: 'export-pending-outbox',
    pendingOutboxCount: outbox.records.length,
    exportCompleted: false,
    discardConfirmed: false,
    now,
  })
  if (!plan.ok || plan.action !== 'export-pending-outbox') throw new Error('repair-export-rejected')
  const effect = plan.effects.find((candidate) => candidate.kind === 'write-repair-export')
  if (effect === undefined || state.evidence.currentVersion === undefined) {
    throw new Error('repair-export-evidence-missing')
  }
  const exportPlan = buildLocalStoreRepairExport({
    exportedAt: now,
    vaultId: state.vaultId,
    deviceId: state.setup.deviceId,
    metadata: {
      localStoreVersion: state.evidence.currentVersion,
      targetStoreVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
      degradedReason: state.schemaDecision.reason,
    },
    outboxRecords: outbox.records,
  })
  if (!exportPlan.ok) throw new Error(`repair-export-build:${exportPlan.reason}`)
  await ensureParentDirectories(plugin, effect.path)
  await writeLocalStoreRepairExportFile({
    adapter: plugin.app.vault.adapter,
    path: effect.path,
    exportFile: exportPlan.exportFile,
  })
  await plugin.updateSettings({
    localRepairExport: {
      path: effect.path,
      exportedAt: now,
      pendingOutboxCount: outbox.records.length,
    },
  })
  return effect.path
}

/** Stages validated Y-update rows from a repair export as paused outbox records. */
export async function stageLocalStoreRepairImport(
  plugin: KuroflareSpikePlugin,
  path: string,
): Promise<number> {
  return runExclusiveLocalStoreRepair(plugin, () =>
    stageLocalStoreRepairImportUnlocked(plugin, path),
  )
}

async function stageLocalStoreRepairImportUnlocked(
  plugin: KuroflareSpikePlugin,
  path: string,
): Promise<number> {
  if (path.trim().length === 0) throw new Error('repair-import-path-missing')
  const read = await readLocalStoreRepairExportFile({ adapter: plugin.app.vault.adapter, path })
  if (!read.ok) throw new Error(`repair-import-read:${read.reason}`)
  const state = await readHealthyRepairState(plugin)
  const db = await plugin.openLocalStoreDatabase(state.setup.vaultId)
  const current = await readRepairOutbox(localStoreIndexedDbName(state.vaultId))
  if (
    current.rawCount !== state.evidence.pendingOutboxCount ||
    current.records.length !== current.rawCount
  ) {
    throw new Error('repair-import-outbox-validation-incomplete')
  }
  const localEvidence = repairImportEvidence(current.records)
  const plan = planLocalStoreRepairImport({
    exportFile: read.exportFile,
    vaultId: state.vaultId,
    deviceId: state.setup.deviceId,
    existingOutboxIds: current.records.map((record) => record.id),
    ...localEvidence,
  })
  if (!plan.ok) throw new Error(`repair-import-rejected:${plan.reason}`)
  const operations = plan.effects.map((effect) => ({
    kind: 'put-outbox' as const,
    put: { record: effect.record },
  }))
  const committed = await commitLocalStoreIndexedDbDatabaseTransaction({
    database: createLocalStoreIndexedDbDatabasePort(db),
    operations,
  })
  if (!committed.ok) throw new Error(`repair-import-commit:${committed.reason}`)
  return operations.length
}

/** Resumes only records previously staged by the validated repair-import path. */
export async function resumeLocalStoreRepairImports(plugin: KuroflareSpikePlugin): Promise<number> {
  return runExclusiveLocalStoreRepair(plugin, () => resumeLocalStoreRepairImportsUnlocked(plugin))
}

async function resumeLocalStoreRepairImportsUnlocked(
  plugin: KuroflareSpikePlugin,
): Promise<number> {
  const state = await readHealthyRepairState(plugin)
  const db = await plugin.openLocalStoreDatabase(state.setup.vaultId)
  const current = await readRepairOutbox(localStoreIndexedDbName(state.vaultId))
  if (
    current.rawCount !== state.evidence.pendingOutboxCount ||
    current.records.length !== current.rawCount
  ) {
    throw new Error('repair-resume-outbox-validation-incomplete')
  }
  const serverEvidence = await fetchRepairImportEvidence(plugin, current.records)
  const operations = current.records.flatMap((record) => {
    if (!isStagedRepairImportRecord(record)) return []
    const plan = planLocalStoreRepairImportResume({
      record,
      userConfirmed: true,
      ...serverEvidence,
    })
    return plan.ok && plan.action === 'resume'
      ? planLocalStoreRepairImportResumeTransaction(plan)
      : []
  })
  const committed = await commitLocalStoreIndexedDbDatabaseTransaction({
    database: createLocalStoreIndexedDbDatabasePort(db),
    operations,
  })
  if (!committed.ok) throw new Error(`repair-resume-commit:${committed.reason}`)
  if (operations.length > 0) scheduleOutboxWorkerTick(plugin, 0, 'repair-import-resume')
  return operations.length
}

/** Rebuilds only a currently degraded store after exact export or discard confirmation. */
export async function rebuildDegradedLocalStore(
  plugin: KuroflareSpikePlugin,
  confirmation: string,
  rebuildConfirmation: string,
  discardConfirmation: string,
): Promise<void> {
  return runExclusiveLocalStoreRepair(plugin, () =>
    rebuildDegradedLocalStoreUnlocked(
      plugin,
      confirmation,
      rebuildConfirmation,
      discardConfirmation,
    ),
  )
}

async function rebuildDegradedLocalStoreUnlocked(
  plugin: KuroflareSpikePlugin,
  confirmation: string,
  rebuildConfirmation: string,
  discardConfirmation: string,
): Promise<void> {
  if (confirmation !== rebuildConfirmation && confirmation !== discardConfirmation) {
    throw new Error('repair-rebuild-confirmation-required')
  }
  if (plugin.outboxWorkerCompletionPromise !== null) {
    throw new Error('local-store-repair-operation-in-progress')
  }
  const state = await readDegradedRepairEvidence(plugin)
  const currentOutbox = await readRepairOutbox(localStoreIndexedDbName(state.vaultId))
  const discardConfirmed = confirmation === discardConfirmation
  if (!discardConfirmed && currentOutbox.rawCount !== state.evidence.pendingOutboxCount) {
    throw new Error('repair-rebuild-rejected')
  }
  let exportCompleted = false
  const exportMetadata = plugin.kuroflareSettings.localRepairExport
  if (confirmation === rebuildConfirmation && exportMetadata !== undefined) {
    const exportRead = await readLocalStoreRepairExportFile({
      adapter: plugin.app.vault.adapter,
      path: exportMetadata.path,
    })
    const currentExport = exportRead.ok
      ? buildLocalStoreRepairExport({
          exportedAt: exportRead.exportFile.exportedAt,
          vaultId: state.vaultId,
          deviceId: state.setup.deviceId,
          metadata: exportRead.exportFile.metadata,
          outboxRecords: currentOutbox.records,
        })
      : undefined
    exportCompleted =
      exportRead.ok &&
      currentExport?.ok === true &&
      JSON.stringify(currentExport.exportFile) === JSON.stringify(exportRead.exportFile) &&
      exportRead.exportFile.vaultId === state.vaultId &&
      exportRead.exportFile.exportedAt === exportMetadata.exportedAt &&
      currentOutbox.records.length === currentOutbox.rawCount &&
      state.evidence.pendingOutboxCount === currentOutbox.rawCount &&
      exportMetadata.pendingOutboxCount === currentOutbox.rawCount
  }
  const plan = planLocalStoreRepair({
    vaultId: state.vaultId,
    schemaDecision: state.schemaDecision,
    request: discardConfirmed ? 'discard-and-rebuild' : 'rebuild-after-export',
    pendingOutboxCount: state.evidence.pendingOutboxCount,
    exportCompleted,
    discardConfirmed,
    now: Date.now(),
  })
  if (!plan.ok || plan.action !== 'rebuild') throw new Error('repair-rebuild-rejected')

  const finalState = await readDegradedRepairEvidence(plugin)
  const finalOutbox = await readRepairOutbox(localStoreIndexedDbName(finalState.vaultId))
  if (
    JSON.stringify(finalState.evidence) !== JSON.stringify(state.evidence) ||
    (!discardConfirmed && finalOutbox.rawCount !== finalState.evidence.pendingOutboxCount) ||
    finalOutbox.rawCount !== currentOutbox.rawCount ||
    JSON.stringify(finalOutbox.rawValues) !== JSON.stringify(currentOutbox.rawValues)
  ) {
    throw new Error('repair-rebuild-evidence-changed')
  }

  plugin.startupSideEffectGate.setPermission('blocked')
  plugin.workerWebSocketSession.close(1000, 'local-store-repair')
  if (plugin.outboxWorkerRetryTimeout !== null) {
    window.clearTimeout(plugin.outboxWorkerRetryTimeout)
    plugin.outboxWorkerRetryTimeout = null
  }
  await rebuildLocalStoreDatabase(plugin, state.vaultId)
  await plugin.updateSettings({ localRepairExport: undefined })
  plugin.syncRuntime?.lifecycle.requestReplan()
  await plugin.syncRuntime?.lifecycle.runStartupTick()
}
