import {
  type SyncRuntimeDeferredStartupEffect,
  type SyncRuntimeNoNetworkEffectPumpInput,
  type SyncRuntimeNoNetworkEffectPumpPlan,
  type SyncRuntimeStartupActuationInput,
  type SyncRuntimeStartupActuationPlan,
} from '../actuation.types'
import { type SyncRuntimeStartupEffect } from '../startup'
import { shellCommandsForRuntimeEffect } from './shell-commands'

/**
 * Converts startup runtime effects into commands for the Obsidian plugin shell.
 */
export function planSyncRuntimeStartupActuation(
  input: SyncRuntimeStartupActuationInput,
): SyncRuntimeStartupActuationPlan {
  return {
    commands: input.plan.effects.flatMap((effect) => shellCommandsForRuntimeEffect(effect)),
  }
}

/**
 * Plans how far a no-network Obsidian shell may pump startup effects.
 */
export function planSyncRuntimeNoNetworkEffectPump(
  input: SyncRuntimeNoNetworkEffectPumpInput,
): SyncRuntimeNoNetworkEffectPumpPlan {
  const maxEffects = input.maxEffects ?? Number.POSITIVE_INFINITY
  if (
    maxEffects !== Number.POSITIVE_INFINITY &&
    (!Number.isSafeInteger(maxEffects) || maxEffects < 0)
  ) {
    throw new Error('maxEffects must be a non-negative safe integer')
  }

  let executableEffectCount = 0
  while (executableEffectCount < maxEffects) {
    const effect = input.state.runnableEffects[executableEffectCount]
    if (effect === undefined) {
      return { executableEffectCount, deferredEffect: undefined }
    }
    const deferredEffect = deferredNoNetworkEffect(effect)
    if (deferredEffect !== undefined) {
      return { executableEffectCount, deferredEffect }
    }
    executableEffectCount += 1
  }

  const nextEffect = input.state.runnableEffects[executableEffectCount]
  return {
    executableEffectCount,
    deferredEffect: nextEffect === undefined ? undefined : deferredNoNetworkEffect(nextEffect),
  }
}

function deferredNoNetworkEffect(
  effect: SyncRuntimeStartupEffect,
): SyncRuntimeDeferredStartupEffect | undefined {
  switch (effect.kind) {
    case 'run-local-store-open-effect':
    case 'rerun-startup-after-local-store-rebuild':
      return undefined
    case 'report-local-store-schema-evidence-failure':
      return undefined
    case 'run-sync-startup-effect':
      if (effect.effect.kind === 'run-setup-exchange') {
        return { effect, reason: 'setup-exchange-transport-unimplemented' }
      }
      if (effect.effect.kind === 'run-startup-step') {
        return { effect, reason: 'startup-step-port-unimplemented' }
      }
      return undefined
  }
}
