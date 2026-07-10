import {
  applySyncRuntimeShellCommands,
  executeRunnableSyncRuntimeShellEffects,
  planSyncRuntimeNoNetworkEffectPump,
  type SyncRuntimeShellCommand,
  type SyncRuntimeShellEffectExecutor,
  type SyncRuntimeShellState,
  type SyncRuntimeStartupStepEffectPort,
} from '../../engine/actuation'
import type {
  SyncRuntimeSetupExchangeRuntimeEffect,
  SyncRuntimeStartupStepRuntimeEffect,
} from './types'
import { runtimeDriverFailureReason } from './utils'

export async function pumpLocalEffects(input: {
  readonly shell: SyncRuntimeShellState
  readonly executor: SyncRuntimeShellEffectExecutor
  readonly maxLocalEffects?: number | undefined
}): Promise<{
  readonly shell: SyncRuntimeShellState
  readonly executedLocalEffectCount: number
}> {
  const pumpPlan = planSyncRuntimeNoNetworkEffectPump({
    state: input.shell,
    maxEffects: input.maxLocalEffects,
  })
  if (pumpPlan.executableEffectCount === 0) {
    return { shell: input.shell, executedLocalEffectCount: 0 }
  }
  const executed = await executeRunnableSyncRuntimeShellEffects({
    state: input.shell,
    executor: input.executor,
    maxEffects: pumpPlan.executableEffectCount,
  })
  return {
    shell: executed.state,
    executedLocalEffectCount: pumpPlan.executableEffectCount,
  }
}

export function nextSetupExchangeRuntimeEffect(
  shell: SyncRuntimeShellState,
): SyncRuntimeSetupExchangeRuntimeEffect | undefined {
  const effect = shell.runnableEffects[0]
  if (effect?.kind === 'run-sync-startup-effect' && effect.effect.kind === 'run-setup-exchange') {
    return { kind: 'run-sync-startup-effect', effect: effect.effect }
  }
  return undefined
}

export async function pumpStartupStepEffects(input: {
  readonly shell: SyncRuntimeShellState
  readonly startupStep: SyncRuntimeStartupStepEffectPort
  readonly maxStartupSteps?: number | undefined
}): Promise<{
  readonly shell: SyncRuntimeShellState
  readonly executedStartupStepCount: number
}> {
  const maxStartupSteps = input.maxStartupSteps ?? Number.POSITIVE_INFINITY
  if (
    maxStartupSteps !== Number.POSITIVE_INFINITY &&
    (!Number.isSafeInteger(maxStartupSteps) || maxStartupSteps < 0)
  ) {
    throw new Error('maxStartupSteps must be a non-negative safe integer')
  }

  let shell = input.shell
  let executedStartupStepCount = 0
  while (executedStartupStepCount < maxStartupSteps) {
    const effect = nextStartupStepRuntimeEffect(shell)
    if (effect === undefined) {
      break
    }
    try {
      await input.startupStep.run(effect.effect)
    } catch (error: unknown) {
      const command: SyncRuntimeShellCommand = {
        kind: 'fail-runtime-effect',
        effect,
        reason: runtimeDriverFailureReason('startup-step', error),
      }
      shell = applySyncRuntimeShellCommands(shell, [command])
      break
    }

    const command: SyncRuntimeShellCommand = { kind: 'ack-runtime-effect', effect }
    shell = applySyncRuntimeShellCommands(shell, [command])
    executedStartupStepCount += 1
  }

  return { shell, executedStartupStepCount }
}

export function nextStartupStepRuntimeEffect(
  shell: SyncRuntimeShellState,
): SyncRuntimeStartupStepRuntimeEffect | undefined {
  const effect = shell.runnableEffects[0]
  if (effect?.kind === 'run-sync-startup-effect' && effect.effect.kind === 'run-startup-step') {
    return { kind: 'run-sync-startup-effect', effect: effect.effect }
  }
  return undefined
}
