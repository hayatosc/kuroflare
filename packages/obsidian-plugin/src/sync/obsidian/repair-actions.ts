import { canonicalizeVaultPath, isMetaFile, type FileId, type MetaFile } from '@kuroflare/core'

import type { KuroflareRepairLogEntry } from '../../types'

export interface RemoteMaterializeBlockedRepairPorts {
  readonly getMetaEntry: (fileId: string) => unknown
  readonly requestMissingRemoteTextFile: (
    entry: Extract<MetaFile, { readonly type: 'text'; readonly deleted: false }>,
  ) => Promise<boolean>
  readonly enqueueMissingRemoteBinaryDownloads: (reason: string) => Promise<ReadonlySet<FileId>>
  readonly removeRepairLogEntry: (entryId: string) => Promise<void>
  readonly showNotice: (message: string) => void
}

export interface RemoteMaterializeBlockedAutoResolveInput {
  readonly entry: KuroflareRepairLogEntry
  readonly current: unknown
  readonly isPathAvailable: (path: string) => boolean
  readonly maxAttempts?: number | undefined
}

export type RemoteMaterializeBlockedAutoResolvePlan =
  | { readonly action: 'ignored-kind' }
  | { readonly action: 'unsupported-reason'; readonly reason: string }
  | { readonly action: 'stale' }
  | { readonly action: 'unsupported-meta-type'; readonly type: string }
  | { readonly action: 'no-path-available' }
  | {
      readonly action: 'rename-meta-path'
      readonly fromPath: string
      readonly toPath: string
      readonly toCanonicalPath: string
    }

export interface PathConflictAutoResolveInput {
  readonly entry: KuroflareRepairLogEntry
  readonly current: unknown
  readonly isPathAvailable: (path: string) => boolean
  readonly maxAttempts?: number | undefined
}

export type PathConflictAutoResolvePlan =
  | { readonly action: 'ignored-kind' }
  | { readonly action: 'stale' }
  | { readonly action: 'no-path-available' }
  | {
      readonly action: 'rename-meta-path'
      readonly fromPath: string
      readonly toPath: string
      readonly toCanonicalPath: string
    }

/**
 * Plans a safe automatic path move for a blocked remote text materialization.
 *
 * @param input Repair entry, current meta value, and a path-availability predicate.
 * @returns A concrete meta-path rename plan or a non-mutating reason.
 */
export function planRemoteMaterializeBlockedAutoResolve(
  input: RemoteMaterializeBlockedAutoResolveInput,
): RemoteMaterializeBlockedAutoResolvePlan {
  if (input.entry.kind !== 'remote-materialize-blocked') {
    return { action: 'ignored-kind' }
  }
  if (input.entry.reason !== 'path-collision' && input.entry.reason !== 'parent-collision') {
    return { action: 'unsupported-reason', reason: input.entry.reason }
  }
  if (!isMetaFile(input.current, input.entry.fileId) || input.current.deleted) {
    return { action: 'stale' }
  }
  if (input.current.type !== 'text') {
    return { action: 'unsupported-meta-type', type: input.current.type }
  }

  const maxAttempts = input.maxAttempts ?? 100
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const candidate = conflictPath(input.current.path, input.current.fileId, attempt)
    if (input.isPathAvailable(candidate)) {
      return {
        action: 'rename-meta-path',
        fromPath: input.current.path,
        toPath: candidate,
        toCanonicalPath: canonicalizeVaultPath(candidate),
      }
    }
  }

  return { action: 'no-path-available' }
}

/**
 * Plans a safe alternate meta path for a failed path materialization.
 *
 * Also covers `portable-path` entries (DR-011): both kinds are a plain meta-path rename that
 * can collide locally, and both resolve through the same conflict-suffix mechanism.
 *
 * @param input Repair entry, current meta value, and a path-availability predicate.
 * @returns A concrete meta-path rename plan or a non-mutating reason.
 */
export function planPathConflictAutoResolve(
  input: PathConflictAutoResolveInput,
): PathConflictAutoResolvePlan {
  if (input.entry.kind !== 'path-conflict' && input.entry.kind !== 'portable-path') {
    return { action: 'ignored-kind' }
  }
  if (!isMetaFile(input.current, input.entry.fileId) || input.current.deleted) {
    return { action: 'stale' }
  }

  const maxAttempts = input.maxAttempts ?? 100
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const candidate = conflictPath(input.current.path, input.current.fileId, attempt)
    if (input.isPathAvailable(candidate)) {
      return {
        action: 'rename-meta-path',
        fromPath: input.current.path,
        toPath: candidate,
        toCanonicalPath: canonicalizeVaultPath(candidate),
      }
    }
  }

  return { action: 'no-path-available' }
}

/**
 * Retries a persistent remote materialize repair entry using explicit ports.
 *
 * @param entry Repair log entry selected by the user.
 * @param ports Runtime operations needed to inspect meta, enqueue work, update settings, and notify.
 * @returns The action that was taken for test and adapter observability.
 */
export async function retryRemoteMaterializeBlockedRepairEntryWithPorts(
  entry: KuroflareRepairLogEntry,
  ports: RemoteMaterializeBlockedRepairPorts,
): Promise<
  | 'ignored-kind'
  | 'cleared-stale'
  | 'queued-text'
  | 'queued-binary'
  | 'skipped-text'
  | 'skipped-binary'
> {
  if (entry.kind !== 'remote-materialize-blocked') {
    ports.showNotice('Kuroflare repair: only remote materialize entries can be retried here')
    return 'ignored-kind'
  }

  const current = ports.getMetaEntry(entry.fileId)
  if (!isMetaFile(current, entry.fileId) || current.deleted) {
    await ports.removeRepairLogEntry(entry.id)
    ports.showNotice('Kuroflare repair: stale remote materialize entry cleared')
    return 'cleared-stale'
  }

  if (current.type === 'text') {
    const requested = await ports.requestMissingRemoteTextFile(current)
    if (!requested) {
      ports.showNotice('Kuroflare repair: remote materialize retry skipped (stale or blocked)')
      return 'skipped-text'
    }
    await ports.removeRepairLogEntry(entry.id)
    ports.showNotice(`Kuroflare repair: remote materialize retry queued (${current.path})`)
    return 'queued-text'
  }

  const completedFileIds = await ports.enqueueMissingRemoteBinaryDownloads(
    'repair:remote-materialize-retry',
  )
  if (!completedFileIds.has(current.fileId)) {
    ports.showNotice('Kuroflare repair: remote binary materialize retry skipped or blocked')
    return 'skipped-binary'
  }
  await ports.removeRepairLogEntry(entry.id)
  ports.showNotice(`Kuroflare repair: remote materialize retry queued (${current.path})`)
  return 'queued-binary'
}

function conflictPath(path: string, fileId: string, attempt: number): string {
  const marker = attempt === 1 ? ` (conflict ${fileId})` : ` (conflict ${fileId}-${attempt})`
  const slashIndex = path.lastIndexOf('/')
  const directory = slashIndex === -1 ? '' : path.slice(0, slashIndex + 1)
  const filename = slashIndex === -1 ? path : path.slice(slashIndex + 1)
  const dotIndex = filename.lastIndexOf('.')
  if (dotIndex <= 0) {
    return `${directory}${filename}${marker}`
  }
  return `${directory}${filename.slice(0, dotIndex)}${marker}${filename.slice(dotIndex)}`
}
