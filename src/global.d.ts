import {
  type ClientAuthMetadata as _ClientAuthMetadata,
  type DeviceId as _DeviceId,
  type DocId as _DocId,
  type FileId as _FileId,
  type LocalStoreOutboxRecord as _LocalStoreOutboxRecord,
  type MessageId as _MessageId,
} from '@kuroflare/core'
import type { TFile as _TFile } from 'obsidian'

import type { BinaryMetaFile as _BinaryMetaFile } from '../packages/core/src/local-store/materialize'
import type { LocalOutboxRepairEvidenceResponse as _LocalOutboxRepairEvidenceResponse } from '../packages/core/src/local-store/repair'
import type { BlobManifest as _BlobManifest } from '../packages/core/src/sync/blob'
import type {
  SyncRequest as _SyncRequest,
  SyncUpdate as _SyncUpdate,
} from '../packages/core/src/sync/frame'
import type { LatestSnapshotPayload as _LatestSnapshotPayload } from '../packages/core/src/sync/snapshot'
import type {
  Ack as _Ack,
  FileDocId as _FileDocId,
  KuroflareBinaryRestoreCheckDetail as _KuroflareBinaryRestoreCheckDetail,
  KuroflareInvalidMetaIsolationDetail as _KuroflareInvalidMetaIsolationDetail,
  LoadedTextDoc as _LoadedTextDoc,
  NeedFullSnapshot as _NeedFullSnapshot,
} from '../packages/obsidian-plugin/src/main-types'
import type { LocalSetupMetadata as _LocalSetupMetadata } from '../packages/obsidian-plugin/src/sync/engine/setup'

declare global {
  type DeviceId = _DeviceId
  type FileId = _FileId
  type ClientAuthMetadata = _ClientAuthMetadata
  type DocId = _DocId
  type MessageId = _MessageId
  type LocalSetupMetadata = _LocalSetupMetadata
  type FileDocId = _FileDocId
  type TFile = _TFile
  type LocalStoreOutboxRecord = _LocalStoreOutboxRecord

  type Ack = _Ack
  type NeedFullSnapshot = _NeedFullSnapshot
  type LatestSnapshotPayload = _LatestSnapshotPayload
  type LocalOutboxRepairEvidenceResponse = _LocalOutboxRepairEvidenceResponse
  type BinaryMetaFile = _BinaryMetaFile
  type BlobManifest = _BlobManifest
  type KuroflareInvalidMetaIsolationDetail = _KuroflareInvalidMetaIsolationDetail
  type KuroflareBinaryRestoreCheckDetail = _KuroflareBinaryRestoreCheckDetail
  type SyncUpdate = _SyncUpdate
  type SyncRequest = _SyncRequest
  type LoadedTextDoc = _LoadedTextDoc
}

export {}
