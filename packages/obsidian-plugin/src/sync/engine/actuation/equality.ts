import { type LocalStoreIndexedDbOpenEffect } from '../../store/schema'
import { type SyncEngineStartupEffect } from '../engine'
import { type SyncRuntimeStartupEffect } from '../startup'

export function runtimeStartupEffectIsHead(
  effects: readonly SyncRuntimeStartupEffect[],
  target: SyncRuntimeStartupEffect,
): boolean {
  const head = effects[0]
  return head !== undefined && runtimeStartupEffectsEqual(head, target)
}

export function runtimeEffectStartsBackgroundQueues(effect: SyncRuntimeStartupEffect): boolean {
  return (
    effect.kind === 'run-sync-startup-effect' &&
    effect.effect.kind === 'run-startup-step' &&
    effect.effect.step === 'resume-background-queues'
  )
}

export function runtimeEffectFailureReason(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message
  }
  if (typeof error === 'string' && error.length > 0) {
    return error
  }
  return 'startup-effect-failed'
}

function runtimeStartupEffectsEqual(
  left: SyncRuntimeStartupEffect,
  right: SyncRuntimeStartupEffect,
): boolean {
  if (left.kind !== right.kind) {
    return false
  }
  switch (left.kind) {
    case 'run-local-store-open-effect':
      if (right.kind !== 'run-local-store-open-effect') {
        return false
      }
      return localStoreOpenEffectsEqual(left.effect, right.effect)
    case 'run-sync-startup-effect':
      if (right.kind !== 'run-sync-startup-effect') {
        return false
      }
      return syncStartupEffectsEqual(left.effect, right.effect)
    case 'rerun-startup-after-local-store-rebuild':
      if (right.kind !== 'rerun-startup-after-local-store-rebuild') {
        return false
      }
      return left.vaultId === right.vaultId && left.dbName === right.dbName
    case 'report-local-store-schema-evidence-failure':
      if (right.kind !== 'report-local-store-schema-evidence-failure') {
        return false
      }
      return left.reason === right.reason
  }
}

function localStoreOpenEffectsEqual(
  left: LocalStoreIndexedDbOpenEffect,
  right: LocalStoreIndexedDbOpenEffect,
): boolean {
  if (left.kind !== right.kind) {
    return false
  }
  switch (left.kind) {
    case 'open-database':
      if (right.kind !== 'open-database') {
        return false
      }
      return (
        left.mode === right.mode &&
        left.dbName === right.dbName &&
        left.version === right.version &&
        stringListsEqual(left.createStores, right.createStores)
      )
    case 'delete-database':
    case 'hold-degraded':
    case 'reject-open':
      if (right.kind !== left.kind) {
        return false
      }
      return left.dbName === right.dbName && left.reason === right.reason
  }
}

function syncStartupEffectsEqual(
  left: SyncEngineStartupEffect,
  right: SyncEngineStartupEffect,
): boolean {
  if (left.kind !== right.kind) {
    return false
  }
  switch (left.kind) {
    case 'run-setup-exchange':
    case 'enter-auth-blocked':
    case 'enter-degraded':
    case 'reject-startup':
      if (right.kind !== left.kind) {
        return false
      }
      return left.reason === right.reason
    case 'run-startup-step':
      if (right.kind !== 'run-startup-step') {
        return false
      }
      return (
        left.vaultId === right.vaultId && left.step === right.step && left.phase === right.phase
      )
  }
}

function stringListsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
