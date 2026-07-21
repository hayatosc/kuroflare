import {
  CURRENT_PROTOCOL_VERSION,
  DISTRIBUTION_TEMPLATE_PROTOCOL_VERSION,
  MIN_SUPPORTED_PROTOCOL_VERSION,
  ProductVersionSchema,
  PRODUCT_VERSION,
  ReleaseChannelSchema,
  parseChannelPointer,
  parseReleaseManifest,
  type ChannelPointer,
  type ReleaseManifest,
} from '@kuroflare/core'
import * as v from 'valibot'

import type {
  DurableObjectStateBinding,
  UpdateCoordinatorOutcome,
  UpdateCoordinatorRequest,
  UpdateCoordinatorState,
  WorkerEnv,
} from './types'

/** The one fixed Durable Object name used by every Worker installation. */
export const UPDATE_COORDINATOR_ID_NAME = 'kuroflare-update-coordinator-v1'

/** Internal request path accepted by the UpdateCoordinator Durable Object. */
export const UPDATE_COORDINATOR_REQUEST_PATH = '/internal/update-request'

/** Namespaced storage key for the coordinator's single JSON state value. */
export const UPDATE_COORDINATOR_STATE_KEY = 'kuroflare:update-coordinator:v1:state'

/** Only these immutable public metadata origins are contacted by the coordinator. */
export const CHANNEL_POINTER_BASE_URL =
  'https://raw.githubusercontent.com/hayatosc/kuroflare/main/distribution/channels'
export const RELEASE_BASE_URL = 'https://github.com/hayatosc/kuroflare/releases/download'
export const RELEASE_ASSET_HOST = 'release-assets.githubusercontent.com'

export const UPDATE_METADATA_MAX_BYTES = 1024 * 1024
export const UPDATE_FETCH_TIMEOUT_MS = 15_000
export const UPDATE_MAX_RETRIES = 3
export const UPDATE_INITIAL_RETRY_DELAY_MS = 60_000
export const UPDATE_MAX_RETRY_DELAY_MS = 60 * 60 * 1_000
export const UPDATE_BUILD_OBSERVATION_TIMEOUT_MS = 30 * 60 * 1_000

const RANDOM_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const BUILD_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Pinned to GitHub's current release-asset CDN redirect path shape. This fails closed
// (safe) if GitHub changes the format, but a GitHub-side change would then break the
// single allowed redirect until this pattern is revised; revisit if release fetches start
// failing at the redirect step.
const RELEASE_ASSET_PATH_PATTERN = /^\/github-production-release-asset\/[1-9]\d*\/[0-9A-Fa-f-]+$/
const MAX_BUILD_UUID_LENGTH = 128

const RandomUuidSchema = v.pipe(v.string(), v.regex(RANDOM_UUID_PATTERN))
const BuildUuidSchema = v.pipe(v.string(), v.regex(BUILD_UUID_PATTERN))
const AlreadyExistsResultSchema = v.object({
  success: v.literal(true),
  result: v.object({ already_exists: v.literal(true) }),
})
const RequestSchema = v.object({
  requestedAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
})
const HookBuildUuidResponseSchema = v.object({
  success: v.literal(true),
  result: v.object({
    build_uuid: v.pipe(v.string(), v.maxLength(MAX_BUILD_UUID_LENGTH), v.regex(BUILD_UUID_PATTERN)),
  }),
})
const UpdateCoordinatorStateSchema = v.strictObject({
  lastRequestedAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  requestCount: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  installationId: v.optional(RandomUuidSchema),
  lastCheckedAt: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
  lastOutcome: v.optional(
    v.picklist([
      'disabled',
      'checked',
      'paused',
      'no-newer-version',
      'blocked-source-version',
      'rollout-excluded',
      'incompatible-protocol',
      'channel-mismatch',
      'invalid-metadata',
      'fetch-failed',
      'triggered',
      'already-triggered',
      'backoff',
      'retry-ceiling',
      'hook-failed',
      'updated',
    ]),
  ),
  lastTargetVersion: v.optional(ProductVersionSchema),
  lastTriggeredVersion: v.optional(ProductVersionSchema),
  lastBuildUuid: v.optional(BuildUuidSchema),
  triggeredAt: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
  failureCount: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
  nextRetryAt: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
  lastObservedRunningVersion: v.optional(ProductVersionSchema),
  triggerReservationId: v.optional(RandomUuidSchema),
})

const EMPTY_STATE: UpdateCoordinatorState = {
  lastRequestedAt: 0,
  requestCount: 0,
}

/** Durable Object that owns one installation-wide update decision and trigger. */
export class UpdateCoordinator {
  constructor(
    private readonly state: DurableObjectStateBinding,
    readonly env: WorkerEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== UPDATE_COORDINATOR_REQUEST_PATH) {
      return jsonError('request/invalid', 'unknown-update-coordinator-path', 404)
    }
    if (request.method !== 'POST') {
      return jsonError('request/invalid', 'expected-post-update-coordinator-request', 405)
    }

    const payload = await parseRequest(request)
    if (payload === undefined) {
      return jsonError('request/invalid', 'invalid-update-coordinator-request', 400)
    }

    // Keep the old heartbeat-only behavior for unconfigured local shells. A real
    // deployed build always has a channel and enters the update state machine.
    if (this.env.KUROFLARE_RELEASE_CHANNEL === undefined) {
      const nextState = await this.persistHeartbeat(payload)
      return Response.json(nextState)
    }

    // A missing optional secret is an ordinary disabled installation. Do not
    // fetch release metadata or reserve a target when no trigger is possible.
    if (this.env.DEPLOY_HOOK_URL === undefined || this.env.DEPLOY_HOOK_URL.length === 0) {
      const nextState = await this.persistDisabled(payload.requestedAt)
      return Response.json(nextState)
    }

    const checked = await this.checkAndReserve(payload.requestedAt)
    if (checked.kind === 'reserved') {
      const hookResult = await this.triggerHook()
      await this.finishTrigger(
        payload.requestedAt,
        checked.targetVersion,
        checked.reservationId,
        hookResult,
      )
    }

    const current = await this.readState()
    return Response.json(current)
  }

  private async persistHeartbeat(
    payload: UpdateCoordinatorRequest,
  ): Promise<UpdateCoordinatorState> {
    return this.state.storage.transaction(async () => {
      const current = await this.readStateInTransaction()
      if (current.requestCount === Number.MAX_SAFE_INTEGER) {
        throw new Error('update-coordinator-request-count-overflow')
      }
      const updated: UpdateCoordinatorState = {
        lastRequestedAt: payload.requestedAt,
        requestCount: current.requestCount + 1,
      }
      await this.state.storage.put(UPDATE_COORDINATOR_STATE_KEY, updated)
      return updated
    })
  }

  private async persistDisabled(requestedAt: number): Promise<UpdateCoordinatorState> {
    return this.state.storage.transaction(async () => {
      const current = await this.readStateInTransaction()
      if (current.requestCount === Number.MAX_SAFE_INTEGER) {
        throw new Error('update-coordinator-request-count-overflow')
      }
      const updated = omitUndefined({
        ...current,
        installationId: current.installationId ?? crypto.randomUUID(),
        lastRequestedAt: requestedAt,
        requestCount: current.requestCount + 1,
        lastCheckedAt: requestedAt,
        lastOutcome: 'disabled' as const,
        triggerReservationId: undefined,
      })
      await this.state.storage.put(UPDATE_COORDINATOR_STATE_KEY, updated)
      return updated
    })
  }

  private async checkAndReserve(
    requestedAt: number,
  ): Promise<
    { kind: 'reserved'; targetVersion: string; reservationId: string } | { kind: 'checked' }
  > {
    const metadata = await fetchUpdateMetadata(this.env)
    return this.state.storage.transaction(async () => {
      const current = await this.readStateInTransaction()
      if (requestedAt < current.lastRequestedAt) return { kind: 'checked' }
      if (current.requestCount === Number.MAX_SAFE_INTEGER) {
        throw new Error('update-coordinator-request-count-overflow')
      }

      const installationId = current.installationId ?? crypto.randomUUID()
      const requestedState = {
        ...current,
        installationId,
        lastRequestedAt: requestedAt,
        requestCount: current.requestCount + 1,
        lastCheckedAt: requestedAt,
      }

      const observedTriggeredUpdate =
        requestedState.lastTriggeredVersion !== undefined &&
        compareSemVer(PRODUCT_VERSION, requestedState.lastTriggeredVersion) >= 0
      const base: UpdateCoordinatorState = observedTriggeredUpdate
        ? {
            ...requestedState,
            lastObservedRunningVersion: PRODUCT_VERSION,
            lastOutcome: 'updated',
            failureCount: 0,
            nextRetryAt: undefined,
            triggerReservationId: undefined,
          }
        : requestedState

      if (
        observedTriggeredUpdate &&
        (metadata.kind !== 'ready' ||
          compareSemVer(metadata.pointer.productVersion, PRODUCT_VERSION) <= 0)
      ) {
        await this.putState(base)
        return { kind: 'checked' }
      }

      if (metadata.kind === 'ready') {
        const currentTarget = newerVersion(current.lastTargetVersion, current.lastTriggeredVersion)
        if (
          currentTarget !== undefined &&
          compareSemVer(metadata.pointer.productVersion, currentTarget) < 0
        ) {
          if (observedTriggeredUpdate) await this.putState(base)
          return { kind: 'checked' }
        }
      }

      if (metadata.kind === 'disabled') {
        await this.putState({ ...base, lastOutcome: 'disabled' })
        return { kind: 'checked' }
      }
      if (metadata.kind === 'error') {
        await this.putState({ ...base, lastOutcome: metadata.outcome })
        return { kind: 'checked' }
      }

      const decision = await decideUpdate(base, metadata.pointer, metadata.manifest)
      if (decision.kind !== 'eligible') {
        await this.putState({ ...base, lastOutcome: decision.outcome })
        return { kind: 'checked' }
      }

      const target = decision.targetVersion
      if (base.lastTriggeredVersion !== undefined) {
        if (base.lastTriggeredVersion === target && base.triggeredAt !== undefined) {
          if (base.failureCount !== undefined && base.failureCount >= UPDATE_MAX_RETRIES) {
            await this.putState({ ...base, lastOutcome: 'retry-ceiling' })
          } else if (base.nextRetryAt !== undefined && requestedAt < base.nextRetryAt) {
            await this.putState({ ...base, lastOutcome: 'backoff' })
          } else if (
            (base.lastOutcome === 'triggered' || base.lastOutcome === 'already-triggered') &&
            base.triggeredAt !== undefined &&
            requestedAt < safeTimestampAdd(base.triggeredAt, UPDATE_BUILD_OBSERVATION_TIMEOUT_MS)
          ) {
            await this.putState({ ...base, lastOutcome: 'already-triggered' })
          } else {
            // The observation window for a previously accepted trigger has expired and
            // the Worker is still running the old version (otherwise the
            // `observedTriggeredUpdate` reconciliation above would have cleared the
            // trigger before we ever reached an eligible decision). Treat that as a
            // failed build attempt so the retry ceiling is actually reachable. A prior
            // hook-call failure was already counted by `finishTrigger`, so only an
            // accepted-but-unobserved trigger increments here to avoid double counting.
            const priorHookAccepted =
              base.lastOutcome === 'triggered' || base.lastOutcome === 'already-triggered'
            const failureCount = priorHookAccepted
              ? (base.failureCount ?? 0) + 1
              : (base.failureCount ?? 0)
            if (failureCount >= UPDATE_MAX_RETRIES) {
              await this.putState({
                ...base,
                failureCount,
                nextRetryAt: undefined,
                lastOutcome: 'retry-ceiling',
              })
              return { kind: 'checked' }
            }
            const reservationId = crypto.randomUUID()
            await this.putState({
              ...base,
              lastTargetVersion: target,
              lastTriggeredVersion: target,
              triggeredAt: requestedAt,
              failureCount,
              nextRetryAt: priorHookAccepted
                ? safeTimestampAdd(requestedAt, retryDelayMs(failureCount))
                : base.nextRetryAt,
              lastOutcome: 'triggered',
              triggerReservationId: reservationId,
            })
            return { kind: 'reserved', targetVersion: target, reservationId }
          }
          return { kind: 'checked' }
        }
      }

      const reservationId = crypto.randomUUID()
      await this.putState({
        ...base,
        lastTargetVersion: target,
        lastTriggeredVersion: target,
        triggeredAt: requestedAt,
        failureCount: 0,
        nextRetryAt: undefined,
        lastOutcome: 'triggered',
        triggerReservationId: reservationId,
      })
      return { kind: 'reserved', targetVersion: target, reservationId }
    })
  }

  private async triggerHook(): Promise<HookResult> {
    const hookUrl = this.env.DEPLOY_HOOK_URL
    if (hookUrl === undefined || hookUrl.length === 0) return { kind: 'disabled' }
    let parsed: URL
    try {
      parsed = new URL(hookUrl)
    } catch {
      return { kind: 'failed' }
    }
    if (parsed.protocol !== 'https:') return { kind: 'failed' }

    try {
      const response = await fetchJsonResponse(
        parsed.toString(),
        { method: 'POST', redirect: 'error' },
        UPDATE_METADATA_MAX_BYTES,
      )
      if (response.status !== 200) return { kind: 'failed' }
      const body = response.body
      const buildUuid = parseHookBuildUuid(body)
      if (buildUuid === undefined) return { kind: 'failed' }
      if (isAlreadyExistsResult(body)) return { kind: 'already-triggered', buildUuid }
      return { kind: 'triggered', buildUuid }
    } catch {
      return { kind: 'failed' }
    }
  }

  private async finishTrigger(
    requestedAt: number,
    targetVersion: string,
    reservationId: string,
    result: HookResult,
  ): Promise<void> {
    await this.state.storage.transaction(async () => {
      const current = await this.readStateInTransaction()
      if (
        current.triggerReservationId !== reservationId ||
        current.lastTriggeredVersion !== targetVersion ||
        current.triggeredAt !== requestedAt
      ) {
        return
      }
      if (result.kind === 'disabled') {
        await this.putState({
          ...current,
          lastOutcome: 'disabled',
          triggerReservationId: undefined,
        })
        return
      }
      // A hook that was merely accepted (`triggered` / `already-triggered`) is NOT a
      // successful update: the Workers Build may still fail so the Worker never runs the
      // new version. The failure counter is therefore preserved here and only cleared by
      // the `observedTriggeredUpdate` reconciliation in `checkAndReserve` once the Worker
      // is actually running the target version. Clearing it on hook acceptance let a
      // build that always fails re-trigger every cron cycle forever without ever reaching
      // the retry ceiling.
      if (result.kind === 'triggered') {
        await this.putState({
          ...current,
          lastTargetVersion: targetVersion,
          lastTriggeredVersion: targetVersion,
          triggeredAt: requestedAt,
          lastBuildUuid: result.buildUuid,
          lastOutcome: 'triggered',
          triggerReservationId: undefined,
        })
        return
      }
      if (result.kind === 'already-triggered') {
        await this.putState({
          ...current,
          lastTargetVersion: targetVersion,
          lastTriggeredVersion: targetVersion,
          triggeredAt: requestedAt,
          lastBuildUuid: result.buildUuid,
          lastOutcome: 'already-triggered',
          triggerReservationId: undefined,
        })
        return
      }

      const failureCount = (current.failureCount ?? 0) + 1
      const retryCeiling = failureCount >= UPDATE_MAX_RETRIES
      const delay = retryDelayMs(failureCount)
      await this.putState({
        ...current,
        lastOutcome: retryCeiling ? 'retry-ceiling' : 'hook-failed',
        failureCount,
        nextRetryAt: retryCeiling ? undefined : safeTimestampAdd(requestedAt, delay),
        triggerReservationId: undefined,
      })
    })
  }

  private async readState(): Promise<UpdateCoordinatorState> {
    const current = await this.state.storage.get<unknown>(UPDATE_COORDINATOR_STATE_KEY)
    if (current !== undefined && !isUpdateCoordinatorState(current)) {
      throw new Error('invalid-persisted-update-coordinator-state')
    }
    return current === undefined ? EMPTY_STATE : current
  }

  private async readStateInTransaction(): Promise<UpdateCoordinatorState> {
    const current = await this.state.storage.get<unknown>(UPDATE_COORDINATOR_STATE_KEY)
    if (current !== undefined && !isUpdateCoordinatorState(current)) {
      throw new Error('invalid-persisted-update-coordinator-state')
    }
    return current === undefined ? EMPTY_STATE : current
  }

  private async putState(state: UpdateCoordinatorState): Promise<void> {
    await this.state.storage.put(UPDATE_COORDINATOR_STATE_KEY, omitUndefined(state))
  }
}

type HookResult =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'already-triggered'; readonly buildUuid?: string }
  | { readonly kind: 'triggered'; readonly buildUuid: string }

type MetadataResult =
  | { readonly kind: 'disabled' }
  | {
      readonly kind: 'error'
      readonly outcome: 'channel-mismatch' | 'invalid-metadata' | 'fetch-failed'
    }
  | { readonly kind: 'ready'; readonly pointer: ChannelPointer; readonly manifest: ReleaseManifest }

async function fetchUpdateMetadata(env: WorkerEnv): Promise<MetadataResult> {
  const channel = env.KUROFLARE_RELEASE_CHANNEL
  if (!v.is(ReleaseChannelSchema, channel)) return { kind: 'error', outcome: 'channel-mismatch' }
  const pointerUrl = `${CHANNEL_POINTER_BASE_URL}/${channel}.json`
  try {
    const pointerBody = await fetchJson(pointerUrl)
    const pointer = parseChannelPointer(pointerBody)
    if (pointer.channel !== channel) return { kind: 'error', outcome: 'channel-mismatch' }
    if (pointer.paused || compareSemVer(pointer.productVersion, PRODUCT_VERSION) <= 0) {
      return { kind: 'ready', pointer, manifest: makeSkippedManifest(pointer.productVersion) }
    }

    const manifestBody = await fetchReleaseManifestJson(
      `${RELEASE_BASE_URL}/${encodeURIComponent(pointer.productVersion)}/worker-release.json`,
    )
    const manifest = parseReleaseManifest(manifestBody)
    if (compareSemVer(manifest.productVersion, pointer.productVersion) !== 0) {
      return { kind: 'error', outcome: 'invalid-metadata' }
    }
    return { kind: 'ready', pointer, manifest }
  } catch (error) {
    if (error instanceof RemoteDataError) return { kind: 'error', outcome: 'invalid-metadata' }
    if (error instanceof RemoteFetchError) return { kind: 'error', outcome: 'fetch-failed' }
    return { kind: 'error', outcome: 'invalid-metadata' }
  }
}

function makeSkippedManifest(productVersion: string): ReleaseManifest {
  // This object is never used by an eligible decision; the cast keeps the early
  // paused/no-newer path from making an unnecessary second network request.
  return { productVersion } as ReleaseManifest
}

async function decideUpdate(
  state: UpdateCoordinatorState,
  pointer: ChannelPointer,
  manifest: ReleaseManifest,
): Promise<
  | { readonly kind: 'eligible'; readonly targetVersion: string }
  | { readonly kind: 'ineligible'; readonly outcome: UpdateCoordinatorOutcome }
> {
  if (pointer.paused) return { kind: 'ineligible', outcome: 'paused' }
  if (compareSemVer(pointer.productVersion, PRODUCT_VERSION) <= 0) {
    return { kind: 'ineligible', outcome: 'no-newer-version' }
  }
  if (
    pointer.blockedSourceVersions.some((version) => compareSemVer(version, PRODUCT_VERSION) === 0)
  ) {
    return { kind: 'ineligible', outcome: 'blocked-source-version' }
  }
  if (manifest.automaticUpdate !== true) return { kind: 'ineligible', outcome: 'invalid-metadata' }
  if (
    manifest.requiredTemplateProtocolVersion !== DISTRIBUTION_TEMPLATE_PROTOCOL_VERSION ||
    manifest.minimumProtocolVersion > CURRENT_PROTOCOL_VERSION ||
    manifest.protocolVersion < MIN_SUPPORTED_PROTOCOL_VERSION
  ) {
    return { kind: 'ineligible', outcome: 'incompatible-protocol' }
  }
  // Plugin compatibility is deliberately not a runtime gate here. The Worker cannot
  // enumerate the versions of installed (including dormant) Plugins, so it cannot
  // decide plugin compatibility from live state. The distribution contract instead
  // proves backward compatibility at release-gate time: `automaticUpdate === true`
  // is published only for releases compatible with every Plugin in the supported
  // range, and the Plugin self-checks `minimumPluginVersion` from `GET /version`.
  // A previous gate comparing the manifest's `minimumPluginVersion` against this
  // Worker's own `MINIMUM_PLUGIN_VERSION` (an alias of the running `PRODUCT_VERSION`)
  // rejected every legitimate upgrade, because a release's `minimumPluginVersion`
  // tracks its own (newer) product version.
  if (
    state.installationId === undefined ||
    !(await isInRollout(state.installationId, manifest.rolloutSalt, pointer.rolloutPercentage))
  ) {
    return { kind: 'ineligible', outcome: 'rollout-excluded' }
  }
  return { kind: 'eligible', targetVersion: manifest.productVersion }
}

async function isInRollout(
  installationId: string,
  rolloutSalt: string,
  rolloutPercentage: number,
): Promise<boolean> {
  try {
    const input = new TextEncoder().encode(`${installationId}:${rolloutSalt}`)
    const digest = await crypto.subtle.digest('SHA-256', input)
    const bytes = new Uint8Array(digest)
    const bucket = ((bytes[0] ?? 0) * 256 + (bytes[1] ?? 0)) % 100
    return bucket < rolloutPercentage
  } catch {
    return false
  }
}

/** Compare two validated semantic versions according to SemVer 2.0.0. */
export function compareSemVer(left: string, right: string): number {
  const parse = (value: string) => {
    const plusIndex = value.indexOf('+')
    const buildless = plusIndex === -1 ? value : value.slice(0, plusIndex)
    const hyphenIndex = buildless.indexOf('-')
    const core = hyphenIndex === -1 ? buildless : buildless.slice(0, hyphenIndex)
    const prerelease = hyphenIndex === -1 ? undefined : buildless.slice(hyphenIndex + 1)
    const [major = '0', minor = '0', patch = '0'] = core.split('.')
    return { major, minor, patch, prerelease: prerelease?.split('.') ?? [] }
  }
  const a = parse(left)
  const b = parse(right)
  for (const [leftPart, rightPart] of [
    [a.major, b.major],
    [a.minor, b.minor],
    [a.patch, b.patch],
  ] as const) {
    const comparison = compareNumericIdentifier(leftPart, rightPart)
    if (comparison !== 0) return comparison
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0
    return a.prerelease.length === 0 ? 1 : -1
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftPart = a.prerelease[index]
    const rightPart = b.prerelease[index]
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1
    if (leftPart === rightPart) continue
    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) return compareNumericIdentifier(leftPart, rightPart)
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

function newerVersion(left: string | undefined, right: string | undefined): string | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  return compareSemVer(left, right) >= 0 ? left : right
}

function compareNumericIdentifier(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+(?=\d)/, '')
  const normalizedRight = right.replace(/^0+(?=\d)/, '')
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length < normalizedRight.length ? -1 : 1
  }
  if (normalizedLeft === normalizedRight) return 0
  return normalizedLeft < normalizedRight ? -1 : 1
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetchJsonResponse(
    url,
    { method: 'GET', redirect: 'error' },
    UPDATE_METADATA_MAX_BYTES,
  )
  if (response.status !== 200) throw new RemoteFetchError()
  return response.body
}

async function fetchReleaseManifestJson(url: string): Promise<unknown> {
  const response = await fetchJsonResponse(
    url,
    { method: 'GET', redirect: 'manual' },
    UPDATE_METADATA_MAX_BYTES,
    true,
  )
  if (response.status !== 200) throw new RemoteFetchError()
  return response.body
}

async function fetchJsonResponse(
  url: string,
  init: RequestInit,
  maxBytes: number,
  allowReleaseAssetRedirect = false,
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort()
      reject(new RemoteFetchError())
    }, UPDATE_FETCH_TIMEOUT_MS)
  })
  try {
    return await Promise.race([
      (async () => {
        let response = await fetch(url, { ...init, signal: controller.signal })
        if (allowReleaseAssetRedirect && response.status === 302) {
          const location = response.headers.get('location')
          if (location === null) throw new RemoteFetchError()
          const target = parseReleaseAssetRedirect(location)
          response = await fetch(target, {
            ...init,
            redirect: 'manual',
            signal: controller.signal,
          })
          if (response.status >= 300 && response.status < 400) throw new RemoteFetchError()
        }
        if (response.status !== 200) return { status: response.status, body: undefined }
        const contentLength = response.headers.get('content-length')
        if (
          contentLength !== null &&
          (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)
        ) {
          throw new RemoteFetchError()
        }
        return { status: response.status, body: await readJson(response, maxBytes) }
      })(),
      timeoutPromise,
    ])
  } catch (error) {
    if (error instanceof RemoteDataError) throw error
    throw new RemoteFetchError()
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

function parseReleaseAssetRedirect(location: string): string {
  if (!location.startsWith(`https://${RELEASE_ASSET_HOST}/`)) throw new RemoteFetchError()
  let target: URL
  try {
    target = new URL(location)
  } catch {
    throw new RemoteFetchError()
  }
  if (
    target.protocol !== 'https:' ||
    target.hostname !== RELEASE_ASSET_HOST ||
    target.username !== '' ||
    target.password !== '' ||
    target.port !== '' ||
    target.hash !== '' ||
    !RELEASE_ASSET_PATH_PATTERN.test(target.pathname)
  ) {
    throw new RemoteFetchError()
  }
  return target.href
}

async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  const bytes = await readResponseBytes(response, maxBytes)
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new RemoteDataError()
  }
}

async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) throw new RemoteFetchError()
    return bytes
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new RemoteFetchError()
      }
      chunks.push(next.value)
    }
  } catch {
    throw new RemoteFetchError()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function parseHookBuildUuid(value: unknown): string | undefined {
  const parsed = v.safeParse(HookBuildUuidResponseSchema, value)
  return parsed.success ? parsed.output.result.build_uuid : undefined
}

function isAlreadyExistsResult(value: unknown): boolean {
  return v.is(AlreadyExistsResultSchema, value)
}

function isUpdateCoordinatorState(value: unknown): value is UpdateCoordinatorState {
  return v.is(UpdateCoordinatorStateSchema, value)
}

function safeTimestampAdd(timestamp: number, delay: number): number {
  return timestamp > Number.MAX_SAFE_INTEGER - delay ? Number.MAX_SAFE_INTEGER : timestamp + delay
}

/** Exponential backoff delay for the Nth (1-based) failed trigger attempt. */
function retryDelayMs(failureCount: number): number {
  return Math.min(
    UPDATE_MAX_RETRY_DELAY_MS,
    UPDATE_INITIAL_RETRY_DELAY_MS * 2 ** Math.max(0, failureCount - 1),
  )
}

function omitUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T
}

class RemoteFetchError extends Error {}
class RemoteDataError extends Error {}

async function parseRequest(request: Request): Promise<UpdateCoordinatorRequest | undefined> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return undefined
  }
  const parsed = v.safeParse(RequestSchema, body)
  return parsed.success ? parsed.output : undefined
}

function jsonError(code: string, detail: string, status: number): Response {
  return Response.json({ code, detail }, { status })
}
