import { type LocalStoreDriverCommitPlan } from '../../store/driver'
import {
  type LocalStoreIndexedDbReadOperation,
  type LocalStoreIndexedDbWriteOperation,
} from '../../store/indexeddb'

/** Successful local-store driver commit produced by outbox worker persistence planning. */
export type SuccessfulLocalStoreDriverCommitPlan = Extract<
  LocalStoreDriverCommitPlan,
  { readonly ok: true }
>

/** Failed local-store driver commit produced by outbox worker persistence planning. */
export type FailedLocalStoreDriverCommitPlan = Extract<
  LocalStoreDriverCommitPlan,
  { readonly ok: false }
>

/** Concrete IndexedDB reads emitted by outbox worker persistence planning. */
export type OutboxWorkerIndexedDbReadOperation = LocalStoreIndexedDbReadOperation

/** Concrete IndexedDB writes emitted by outbox worker persistence planning. */
export type OutboxWorkerIndexedDbWriteOperation = LocalStoreIndexedDbWriteOperation
