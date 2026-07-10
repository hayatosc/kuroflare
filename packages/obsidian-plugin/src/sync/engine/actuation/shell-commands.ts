import { type SyncRuntimeShellCommand } from '../actuation.types'
import { type SyncEngineStartupEffect } from '../engine'
import { type SyncRuntimeStartupEffect } from '../startup'

export function shellCommandsForRuntimeEffect(
  effect: SyncRuntimeStartupEffect,
): readonly SyncRuntimeShellCommand[] {
  switch (effect.kind) {
    case 'run-sync-startup-effect':
      return shellCommandsForSyncEffect(effect.effect)
    case 'run-local-store-open-effect':
      return [{ kind: 'run-runtime-effect', effect }]
    case 'rerun-startup-after-local-store-rebuild':
      return [
        { kind: 'stop-background-queues', reason: 'local-store-rebuild' },
        { kind: 'set-status', status: 'rebuild-local-store', reason: effect.dbName },
        { kind: 'run-runtime-effect', effect },
      ]
    case 'report-local-store-schema-evidence-failure':
      return [
        { kind: 'stop-background-queues', reason: 'local-store-blocked' },
        { kind: 'set-status', status: 'local-store-blocked', reason: effect.reason },
        { kind: 'show-repair-entry', entry: 'local-store-schema', reason: effect.reason },
        { kind: 'show-notice', notice: 'local-store-blocked' },
      ]
  }
}

function shellCommandsForSyncEffect(
  effect: SyncEngineStartupEffect,
): readonly SyncRuntimeShellCommand[] {
  switch (effect.kind) {
    case 'enter-auth-blocked':
      return [
        { kind: 'stop-background-queues', reason: 'auth-blocked' },
        { kind: 'set-status', status: 'auth-blocked', reason: effect.reason },
        {
          kind: 'show-repair-entry',
          entry: effect.reason,
          reason: effect.reason,
        },
        { kind: 'show-notice', notice: effect.reason },
      ]
    case 'enter-degraded':
      return [
        { kind: 'stop-background-queues', reason: 'degraded' },
        { kind: 'set-status', status: 'degraded', reason: effect.reason },
        { kind: 'show-notice', notice: 'startup-degraded' },
      ]
    case 'reject-startup':
      return [
        { kind: 'stop-background-queues', reason: 'rejected' },
        { kind: 'set-status', status: 'rejected', reason: effect.reason },
        { kind: 'show-repair-entry', entry: 'startup-rejected', reason: effect.reason },
        { kind: 'show-notice', notice: 'startup-rejected' },
      ]
    case 'run-setup-exchange':
      return [
        { kind: 'set-status', status: 'setup-required', reason: effect.reason },
        { kind: 'show-notice', notice: 'setup-required' },
        { kind: 'run-runtime-effect', effect: { kind: 'run-sync-startup-effect', effect } },
      ]
    case 'run-startup-step':
      if (effect.step === 'resume-background-queues') {
        return [
          { kind: 'clear-repair-entries', reason: 'startup-progress' },
          { kind: 'set-status', status: 'starting', reason: effect.phase },
          { kind: 'run-runtime-effect', effect: { kind: 'run-sync-startup-effect', effect } },
        ]
      }
      return [
        { kind: 'clear-repair-entries', reason: 'startup-progress' },
        { kind: 'set-status', status: 'starting', reason: effect.phase },
        { kind: 'run-runtime-effect', effect: { kind: 'run-sync-startup-effect', effect } },
      ]
  }
}
