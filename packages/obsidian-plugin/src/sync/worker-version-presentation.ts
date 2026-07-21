import {
  CURRENT_PROTOCOL_VERSION,
  MIN_SUPPORTED_PROTOCOL_VERSION,
  type WorkerVersionResponse,
} from '@kuroflare/core'

import type { WorkerVersionFetchResult } from './worker-version'

export interface WorkerCompatibilityResult {
  readonly compatible: boolean
  readonly reason: string
}

export interface WorkerVersionPresentation {
  readonly state: 'loading' | 'available' | 'unavailable'
  readonly statusText: string
  readonly rows: readonly WorkerVersionPresentationRow[]
}

export interface WorkerVersionPresentationRow {
  readonly label: string
  readonly value: string
}

/** Compares the Worker protocol and minimum plugin version with this plugin. */
export function assessWorkerCompatibility(
  pluginVersion: string,
  worker: WorkerVersionResponse,
): WorkerCompatibilityResult {
  const reasons: string[] = []
  const protocolCompatible =
    worker.minimumProtocolVersion <= CURRENT_PROTOCOL_VERSION &&
    MIN_SUPPORTED_PROTOCOL_VERSION <= worker.protocolVersion &&
    Math.max(MIN_SUPPORTED_PROTOCOL_VERSION, worker.minimumProtocolVersion) <=
      Math.min(CURRENT_PROTOCOL_VERSION, worker.protocolVersion)
  if (!protocolCompatible) {
    reasons.push(
      `protocol ${worker.protocolVersion} (plugin supports ${MIN_SUPPORTED_PROTOCOL_VERSION}-${CURRENT_PROTOCOL_VERSION})`,
    )
  }

  const pluginCompatible = compareVersions(pluginVersion, worker.minimumPluginVersion) >= 0
  if (!pluginCompatible) {
    reasons.push(`requires plugin ${worker.minimumPluginVersion} or newer`)
  }

  return {
    compatible: reasons.length === 0,
    reason: reasons.length === 0 ? 'Compatible' : `Incompatible: ${reasons.join('; ')}`,
  }
}

/** Converts a probe result into stable, text-only settings presentation data. */
export function planWorkerVersionPresentation(input: {
  readonly pluginVersion: string
  readonly result: { readonly state: 'loading' } | WorkerVersionFetchResult
}): WorkerVersionPresentation {
  const pluginRow = { label: 'Plugin version', value: input.pluginVersion }
  if ('state' in input.result) {
    return {
      state: 'loading',
      statusText: 'Checking Worker version…',
      rows: [pluginRow],
    }
  }

  if (!input.result.ok) {
    return {
      state: 'unavailable',
      statusText: unavailableStatusText(input.result),
      rows: [pluginRow],
    }
  }

  const compatibility = assessWorkerCompatibility(input.pluginVersion, input.result.value)
  return {
    state: 'available',
    statusText: 'Worker version information available.',
    rows: [
      pluginRow,
      { label: 'Worker product version', value: input.result.value.productVersion },
      { label: 'Release channel', value: input.result.value.channel },
      { label: 'Build commit', value: input.result.value.buildCommit },
      { label: 'Deployment version ID', value: input.result.value.deploymentVersionId },
      { label: 'Compatibility', value: compatibility.reason },
    ],
  }
}

function unavailableStatusText(
  result: Extract<WorkerVersionFetchResult, { readonly ok: false }>,
): string {
  if (result.reason === 'http') {
    return `Worker version unavailable (HTTP ${result.status ?? 'error'}).`
  }
  if (result.reason === 'invalid-response') {
    return 'Worker version unavailable (invalid response).'
  }
  return 'Worker version unavailable (network error).'
}

function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left)
  const rightParts = parseVersion(right)
  if (leftParts === undefined || rightParts === undefined) return Number.NaN
  for (const index of [0, 1, 2] as const) {
    const difference = compareNumericIdentifiers(
      leftParts.numbers[index],
      rightParts.numbers[index],
    )
    if (difference !== 0) return difference
  }
  if (leftParts.prerelease === undefined && rightParts.prerelease === undefined) return 0
  if (leftParts.prerelease === undefined) return 1
  if (rightParts.prerelease === undefined) return -1
  for (
    let index = 0;
    index < Math.max(leftParts.prerelease.length, rightParts.prerelease.length);
    index += 1
  ) {
    const leftIdentifier = leftParts.prerelease[index]
    const rightIdentifier = rightParts.prerelease[index]
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1
    if (leftIdentifier === rightIdentifier) continue
    const leftNumeric = /^0$|^[1-9][0-9]*$/.test(leftIdentifier)
    const rightNumeric = /^0$|^[1-9][0-9]*$/.test(rightIdentifier)
    if (leftNumeric && rightNumeric) {
      return compareNumericIdentifiers(leftIdentifier, rightIdentifier)
    }
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return leftIdentifier < rightIdentifier ? -1 : 1
  }
  return 0
}

function parseVersion(value: string):
  | {
      readonly numbers: readonly [string, string, string]
      readonly prerelease: readonly string[] | undefined
    }
  | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value)
  if (match === null) return undefined
  const major = match[1]
  const minor = match[2]
  const patch = match[3]
  if (major === undefined || minor === undefined || patch === undefined) return undefined
  if ([major, minor, patch].some((identifier) => /^0\d+$/.test(identifier))) return undefined
  const prerelease = match[4]?.split('.')
  if (prerelease?.some((identifier) => identifier.length === 0)) return undefined
  if (prerelease?.some((identifier) => /^0\d+$/.test(identifier))) return undefined
  return { numbers: [major, minor, patch], prerelease }
}

function compareNumericIdentifiers(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  if (left === right) return 0
  return left < right ? -1 : 1
}
