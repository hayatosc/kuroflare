import {
  type SyncRuntimeShellCommand,
  type SyncRuntimeShellEffectExecutionInput,
  type SyncRuntimeShellEffectExecutionResult,
  type SyncRuntimeShellEffectExecutor,
  type SyncRuntimeShellState,
  type SyncRuntimeStartupEffectExecutorPorts,
} from '../actuation.types'
import { type SyncEngineStartupEffect } from '../engine'
import { type SyncRuntimeStartupEffect } from '../startup'
import { runtimeEffectFailureReason } from './equality'
import { applySyncRuntimeShellCommand } from './state'

/**
 * Executes runnable startup effects in queue order and feeds ACK/FAIL commands back into shell state.
 */
export async function executeRunnableSyncRuntimeShellEffects(
  input: SyncRuntimeShellEffectExecutionInput,
): Promise<SyncRuntimeShellEffectExecutionResult> {
  const maxEffects = input.maxEffects ?? Number.POSITIVE_INFINITY
  if (
    maxEffects !== Number.POSITIVE_INFINITY &&
    (!Number.isSafeInteger(maxEffects) || maxEffects < 0)
  ) {
    throw new Error('maxEffects must be a non-negative safe integer')
  }

  let state = input.state
  const commands: SyncRuntimeShellCommand[] = []
  const executedEffects: SyncRuntimeStartupEffect[] = []
  while (executedEffects.length < maxEffects) {
    const effect = state.runnableEffects[0]
    if (effect === undefined) {
      break
    }

    executedEffects.push(effect)
    try {
      await input.executor.run(effect)
    } catch (error: unknown) {
      const command: SyncRuntimeShellCommand = {
        kind: 'fail-runtime-effect',
        effect,
        reason: runtimeEffectFailureReason(error),
      }
      commands.push(command)
      state = applySyncRuntimeShellCommands(state, [command])
      break
    }

    const command: SyncRuntimeShellCommand = { kind: 'ack-runtime-effect', effect }
    commands.push(command)
    state = applySyncRuntimeShellCommands(state, [command])
  }

  return { state, commands, executedEffects }
}

export function applySyncRuntimeShellCommands(
  state: SyncRuntimeShellState,
  commands: readonly SyncRuntimeShellCommand[],
): SyncRuntimeShellState {
  let next = state
  for (const command of commands) {
    next = applySyncRuntimeShellCommand(next, command)
  }
  return next
}

/**
 * Creates the default startup effect executor used by the Obsidian shell.
 */
export function createSyncRuntimeStartupEffectExecutor(
  ports: SyncRuntimeStartupEffectExecutorPorts,
): SyncRuntimeShellEffectExecutor {
  return {
    async run(effect) {
      switch (effect.kind) {
        case 'run-local-store-open-effect':
          await ports.localStore.runOpenEffect(effect.effect)
          return
        case 'run-sync-startup-effect':
          await runSyncStartupEffect(ports, effect.effect)
          return
        case 'rerun-startup-after-local-store-rebuild':
          await ports.localStoreRebuild.rerunStartup(effect)
          return
        case 'report-local-store-schema-evidence-failure':
          throw new Error(`Non-runnable startup effect: ${effect.kind}`)
      }
    },
  }
}

async function runSyncStartupEffect(
  ports: SyncRuntimeStartupEffectExecutorPorts,
  effect: SyncEngineStartupEffect,
): Promise<void> {
  switch (effect.kind) {
    case 'run-setup-exchange':
      await ports.setupExchange.run(effect)
      return
    case 'run-startup-step':
      await ports.startupStep.run(effect)
      return
    case 'enter-auth-blocked':
    case 'enter-degraded':
    case 'reject-startup':
      throw new Error(`Non-runnable sync startup effect: ${effect.kind}`)
  }
}
