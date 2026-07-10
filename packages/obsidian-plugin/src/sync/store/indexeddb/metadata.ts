import {
  LOCAL_AUTH_METADATA_KEY,
  LOCAL_SETUP_METADATA_KEY,
  planLocalSetupMetadataSnapshot,
  type LocalSetupMetadataSnapshotDecision,
} from '../../engine/setup'
import {
  type LocalStoreIndexedDbMetadataObjectStorePort,
  type LocalStoreIndexedDbMetadataSnapshotInput,
  type LocalStoreIndexedDbMetadataTransactionInput,
  type LocalStoreIndexedDbMetadataWriteOperation,
} from '../../store/ports'
import { waitForIndexedDbRequest, waitForIndexedDbTransaction } from './utils'

export async function applyLocalStoreIndexedDbMetadataWrites(
  store: LocalStoreIndexedDbMetadataObjectStorePort,
  writes: readonly LocalStoreIndexedDbMetadataWriteOperation[],
): Promise<void> {
  const requests = writes.map((write) => store.put(write.value, write.key))
  await Promise.all(requests.map((request) => waitForIndexedDbRequest(request)))
}

export async function readLocalStoreIndexedDbMetadataSnapshot(
  input: LocalStoreIndexedDbMetadataSnapshotInput,
): Promise<LocalSetupMetadataSnapshotDecision> {
  const transaction = input.database.openMetadataTransaction('readonly')
  const setupRequest = transaction.store.get(LOCAL_SETUP_METADATA_KEY)
  const authRequest = transaction.store.get(LOCAL_AUTH_METADATA_KEY)
  const [setup, auth] = await Promise.all([
    waitForIndexedDbRequest(setupRequest),
    waitForIndexedDbRequest(authRequest),
  ])
  await waitForIndexedDbTransaction(transaction.lifecycle)
  return planLocalSetupMetadataSnapshot({ setup, auth })
}

export async function commitLocalStoreIndexedDbMetadataTransaction(
  input: LocalStoreIndexedDbMetadataTransactionInput,
): Promise<void> {
  const transaction = input.database.openMetadataTransaction('readwrite')
  await applyLocalStoreIndexedDbMetadataWrites(transaction.store, input.writes)
  await waitForIndexedDbTransaction(transaction.lifecycle)
}
