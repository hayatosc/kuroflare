import { isMetaFile } from '@kuroflare/core'

import type { KuroflareInvalidMetaIsolationDetail, KuroflareRepairLogEntry } from '../../main-types'

const DEFAULT_INVALID_META_JSON_LIMIT = 4_000

export type InvalidMetaIsolationPlan =
  | { readonly action: 'ignored-kind' }
  | { readonly action: 'stale' }
  | {
      readonly action: 'isolate'
      readonly detail: KuroflareInvalidMetaIsolationDetail
    }

/**
 * Plans the settings-panel isolation detail for an invalid meta repair entry.
 *
 * @param input Repair entry, raw meta map value, and display bounds.
 * @returns Whether the entry should be ignored, treated as stale, or shown as isolated detail.
 */
export function planInvalidMetaIsolationDetail(input: {
  readonly entry: KuroflareRepairLogEntry
  readonly current: unknown
  readonly inspectedAt: number
  readonly jsonLimit?: number | undefined
}): InvalidMetaIsolationPlan {
  if (input.entry.kind !== 'invalid-meta') {
    return { action: 'ignored-kind' }
  }
  if (input.current === undefined || isMetaFile(input.current, input.entry.fileId)) {
    return { action: 'stale' }
  }

  const raw = stringifyInvalidMetaValue(input.current)
  const jsonLimit = input.jsonLimit ?? DEFAULT_INVALID_META_JSON_LIMIT
  const truncated = raw.length > jsonLimit
  return {
    action: 'isolate',
    detail: {
      fileId: input.entry.fileId,
      reason: input.entry.reason,
      inspectedAt: input.inspectedAt,
      rawJson: truncated ? raw.slice(0, jsonLimit) : raw,
      truncated,
    },
  }
}

function stringifyInvalidMetaValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch (error) {
    if (error instanceof Error) {
      return `[unserializable invalid meta: ${error.message}]`
    }
    return '[unserializable invalid meta]'
  }
}
