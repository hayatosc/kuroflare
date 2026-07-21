import { Notice } from 'obsidian'
import * as Y from 'yjs'

import { createWorkerClient } from '../sync/api-client'
import { readAccessToken, requireSetupMetadata } from './auth'
import { META_SYNC_DOC_ID } from './constants'
import { accessTokenSecretKeyForSetup, encodeBase64, safeLogError } from './helpers'
import {
  hasLegacyDeletedTombstones,
  metaDocLegacyOnly,
  metaDocWritable,
  migrateLegacyMetaDoc,
  shouldAdoptRemoteMetadata,
  shouldPrepareMetadataMigration,
} from './meta'
import type KuroflareSpikePlugin from './plugin'
import { fetchLatestSnapshotPayload } from './snapshot'
import { replaceMetaDoc } from './vault'

/** Performs the legacy-to-v2 transition through the snapshot-import CAS endpoint. */
export async function prepareMetadataAfterHello(plugin: KuroflareSpikePlugin): Promise<void> {
  const context = plugin.captureVaultOperationContext()
  const migrationMetaDoc = plugin.metaDoc
  if (context === undefined) return
  const isCurrent = () =>
    plugin.vaultOperationStillCurrent(context) && plugin.metaDoc === migrationMetaDoc
  if (plugin.metadataAccess !== 'read-write') return
  const root = plugin.metaDoc.getMap<unknown>('meta')
  if (root.size === 0) return
  if (metaDocWritable(plugin.metaDoc)) {
    plugin.metadataMigrationPending = false
    return
  }
  if (hasLegacyDeletedTombstones(plugin.metaDoc)) {
    plugin.metadataMigrationPending = false
    plugin.metadataAccess = 'read-only'
    new Notice(
      'Kuroflare metadata: legacy deleted entries require manual recovery; metadata writes are paused.',
    )
    return
  }
  const localUpdate = Y.encodeStateAsUpdate(plugin.metaDoc)
  let latest: Awaited<ReturnType<typeof fetchLatestSnapshotPayload>> = null
  let manualRepairRequired = false
  try {
    latest = await fetchLatestSnapshotPayload(
      plugin,
      META_SYNC_DOC_ID,
      'metadata-migration',
      isCurrent,
    )
    if (!isCurrent()) return
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const candidate = new Y.Doc()
      try {
        if (latest !== null) {
          Y.applyUpdate(candidate, latest.verifiedBytes.updateBytes)
          const candidateRoot = candidate.getMap<unknown>('meta')
          if (shouldAdoptRemoteMetadata(plugin.metaDoc, candidate)) {
            plugin.metadataMigrationPending = false
            await replaceMetaDoc(plugin, latest.verifiedBytes.updateBytes, isCurrent)
            return
          }
          if (candidateRoot.size > 0 && !metaDocLegacyOnly(candidate)) {
            manualRepairRequired = true
            break
          }
        }
        const baseStateVector = Y.encodeStateVector(candidate)
        Y.applyUpdate(candidate, localUpdate)
        if (!migrateLegacyMetaDoc(candidate)) break
        const migrationUpdate = Y.encodeStateAsUpdate(candidate, baseStateVector)
        const setup = requireSetupMetadata(plugin)
        const accessToken = await readAccessToken(plugin, accessTokenSecretKeyForSetup(setup))
        if (!isCurrent()) return
        if (accessToken === undefined) break
        const workerClient = createWorkerClient(setup.endpoint, accessToken)
        const response = await workerClient.vaults[':vaultId'].meta.snapshot.$put({
          param: { vaultId: setup.vaultId },
          json: {
            updateBytesBase64: encodeBase64(migrationUpdate),
            ...(latest !== null && latest.response.manifestSeq > 0
              ? { latestSeq: latest.response.manifestSeq }
              : {}),
            metadataSchemaVersion: 2,
          },
        })
        if (!isCurrent()) return
        if (response.ok) {
          plugin.metadataMigrationPending = false
          await replaceMetaDoc(plugin, Y.encodeStateAsUpdate(candidate), isCurrent)
          return
        }
        if (response.status !== 409) break
        latest = await fetchLatestSnapshotPayload(
          plugin,
          META_SYNC_DOC_ID,
          'metadata-migration-retry',
          isCurrent,
        )
        if (!isCurrent()) return
      } finally {
        candidate.destroy()
      }
    }
  } catch (error: unknown) {
    if (!isCurrent()) return
    console.warn('[kuroflare] metadata migration CAS failed', { error: safeLogError(error) })
  }
  if (!isCurrent()) return
  plugin.metadataMigrationPending = false
  plugin.metadataAccess = 'read-only'
  if (manualRepairRequired) {
    new Notice(
      'Kuroflare metadata: local metadata differs from remote v2; local data was preserved. Manual repair is required.',
    )
  }
}

/** Starts at most one deferred metadata migration and exposes its completion to startup. */
export function startMetadataMigrationAfterHello(plugin: KuroflareSpikePlugin): Promise<void> {
  if (
    plugin.metadataMigrationPending &&
    plugin.metaDoc.getMap<unknown>('meta').size > 0 &&
    metaDocWritable(plugin.metaDoc)
  ) {
    plugin.metadataMigrationPending = false
  }
  if (
    !shouldPrepareMetadataMigration({
      metadataAccess: plugin.metadataAccess,
      migrationPending: plugin.metadataMigrationPending,
      metaDoc: plugin.metaDoc,
    })
  ) {
    return Promise.resolve()
  }
  const inFlight = plugin.metadataMigrationPromise
  if (inFlight !== null) return inFlight
  const migration = prepareMetadataAfterHello(plugin)
  const tracked = migration.finally(() => {
    if (plugin.metadataMigrationPromise === tracked) plugin.metadataMigrationPromise = null
  })
  plugin.metadataMigrationPromise = tracked
  return tracked
}
