import type { DocId } from '@kuroflare/core'
import type { IndexeddbPersistence } from 'y-indexeddb'
import type * as Y from 'yjs'

import type { LocalSetupMetadata } from './sync/engine/setup'

export interface KuroflareSettings {
  readonly endpoint: string
  readonly setupVaultId: string
  readonly setupToken: string
  readonly requestedDeviceName: string
  readonly setupBootstrapMode?: 'new-vault' | 'join-existing' | undefined
  readonly setupMetadata?: LocalSetupMetadata | undefined
  readonly repairLog?: readonly KuroflareRepairLogEntry[] | undefined
  readonly localRepairExport?: KuroflareLocalRepairExportMetadata | undefined
}

export interface KuroflareRepairLogEntry {
  readonly id: string
  readonly kind: 'path-conflict' | 'delete-vs-edit' | 'invalid-meta' | 'remote-materialize-blocked'
  readonly fileId: string
  readonly path?: string | undefined
  readonly reason: string
  readonly createdAt: number
}

export interface KuroflareInvalidMetaIsolationDetail {
  readonly fileId: string
  readonly reason: string
  readonly inspectedAt: number
  readonly rawJson: string
  readonly truncated: boolean
}

export interface KuroflareBinaryRestoreCheckDetail {
  readonly fileId: string
  readonly path: string
  readonly checkedAt: number
  readonly reason:
    | 'setup-missing'
    | 'access-token-missing'
    | 'manifest-unavailable'
    | 'head-unavailable'
    | 'chunk-missing'
    | 'chunk-size-unknown'
    | 'chunk-size-mismatch'
}

export interface KuroflareLocalRepairExportMetadata {
  readonly path: string
  readonly exportedAt: number
  readonly pendingOutboxCount: number
}

export type FileDocId = Extract<DocId, { readonly kind: 'file' }>

export interface LoadedTextDoc {
  readonly docId: FileDocId
  readonly doc: Y.Doc
  readonly text: Y.Text
  persistence: IndexeddbPersistence | null
}
