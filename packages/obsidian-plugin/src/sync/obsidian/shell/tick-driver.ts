import {
  applySyncRuntimeShellCommands,
  executeRunnableSyncRuntimeShellEffects,
  planSyncRuntimeNoNetworkEffectPump,
  planSyncRuntimeStartupActuation,
  type SyncRuntimeShellState,
} from '../../engine/actuation'
import {
  applySyncRuntimeSetupExchangeShellReplan,
  type SyncRuntimeSetupExchangeShellReplan,
} from '../../engine/replan'
import {
  planSyncRuntimeStartupFromSchemaEvidence,
  type SyncRuntimeLocalStateEvidencePlan,
  type SyncRuntimeStartupFromSchemaEvidenceInput,
  type SyncRuntimeStartupPlan,
} from '../../engine/startup'
import { planSyncRuntimeObsidianPresentation } from '../../obsidian/presentation'
import type {
  SyncRuntimeObsidianShellDriverSetupExchangeTickInput,
  SyncRuntimeObsidianShellDriverStartupStepTickInput,
  SyncRuntimeObsidianShellDriverState,
  SyncRuntimeObsidianShellDriverTickInput,
  SyncRuntimeObsidianShellDriverTickResult,
  SyncRuntimeObsidianShellDriverTransportTickInput,
  SyncRuntimeObsidianShellEvidencePort,
} from '../shell.types'
import { nextSetupExchangeRuntimeEffect, pumpLocalEffects, pumpStartupStepEffects } from './pump'
import { INITIAL_SYNC_RUNTIME_OBSIDIAN_SHELL_DRIVER_STATE } from './state'
import {
  remainingLocalEffectLimit,
  runtimeDriverFailureReason,
  shellCommandsForEvidenceFailure,
  startupReplanCurrentFromEvidenceInput,
} from './utils'

export async function runSyncRuntimeObsidianShellDriverTick(
  input: SyncRuntimeObsidianShellDriverTickInput,
): Promise<SyncRuntimeObsidianShellDriverTickResult> {
  const previous = input.state ?? INITIAL_SYNC_RUNTIME_OBSIDIAN_SHELL_DRIVER_STATE
  const planned = await planShellWhenIdle(previous, input.evidence)
  let shell = planned.shell

  const pumpPlan = planSyncRuntimeNoNetworkEffectPump({
    state: shell,
    maxEffects: input.maxLocalEffects,
  })
  if (pumpPlan.executableEffectCount > 0) {
    const executed = await executeRunnableSyncRuntimeShellEffects({
      state: shell,
      executor: input.executor,
      maxEffects: pumpPlan.executableEffectCount,
    })
    shell = executed.state
  }
  const deferredEffect =
    pumpPlan.executableEffectCount > 0
      ? planSyncRuntimeNoNetworkEffectPump({ state: shell }).deferredEffect
      : pumpPlan.deferredEffect

  const presentation = planSyncRuntimeObsidianPresentation({
    state: shell,
    previous: previous.presentation,
  })

  return {
    state: {
      shell,
      presentation: presentation.nextSnapshot,
      startupPlan: planned.startupPlan,
      startupInput: planned.startupInput ?? previous.startupInput,
    },
    startupPlan: planned.startupPlan,
    presentation,
    deferredEffect,
    executedLocalEffectCount: pumpPlan.executableEffectCount,
    executedStartupStepCount: 0,
    setupExchangeReplan: undefined,
    evidenceFailure: planned.evidenceFailure,
  }
}

export async function runSyncRuntimeObsidianShellDriverSetupExchangeTick(
  input: SyncRuntimeObsidianShellDriverSetupExchangeTickInput,
): Promise<SyncRuntimeObsidianShellDriverTickResult> {
  const previous = input.state ?? INITIAL_SYNC_RUNTIME_OBSIDIAN_SHELL_DRIVER_STATE
  const planned = await planShellWhenIdle(previous, input.evidence)
  let shell = planned.shell
  const startupInput = planned.startupInput ?? previous.startupInput
  let startupPlan = planned.startupPlan
  let executedLocalEffectCount = 0

  const beforeSetup = await pumpLocalEffects({
    shell,
    executor: input.executor,
    maxLocalEffects: input.maxLocalEffects,
  })
  shell = beforeSetup.shell
  executedLocalEffectCount += beforeSetup.executedLocalEffectCount

  let setupExchangeReplan: SyncRuntimeSetupExchangeShellReplan | undefined
  if (planned.evidenceFailure === undefined) {
    const setupRuntimeEffect = nextSetupExchangeRuntimeEffect(shell)
    if (setupRuntimeEffect !== undefined) {
      try {
        const completed = await input.setupExchange.run(setupRuntimeEffect.effect)
        if (startupInput === undefined) {
          throw new Error('setup-exchange-startup-input-missing')
        }
        setupExchangeReplan = applySyncRuntimeSetupExchangeShellReplan({
          state: shell,
          request: completed,
          current: startupReplanCurrentFromEvidenceInput(startupInput),
          expectedBootstrapMode: startupInput.expectedBootstrapMode,
        })
        shell = setupExchangeReplan.state
        startupPlan = setupExchangeReplan.replan.startup
      } catch (error: unknown) {
        shell = applySyncRuntimeShellCommands(shell, [
          {
            kind: 'fail-runtime-effect',
            effect: setupRuntimeEffect,
            reason: runtimeDriverFailureReason('setup-exchange', error),
          },
        ])
      }
    }
  }

  const afterSetup = await pumpLocalEffects({
    shell,
    executor: input.executor,
    maxLocalEffects:
      input.maxLocalEffects === undefined
        ? undefined
        : Math.max(0, input.maxLocalEffects - executedLocalEffectCount),
  })
  shell = afterSetup.shell
  executedLocalEffectCount += afterSetup.executedLocalEffectCount

  const deferredEffect = planSyncRuntimeNoNetworkEffectPump({ state: shell }).deferredEffect
  const presentation = planSyncRuntimeObsidianPresentation({
    state: shell,
    previous: previous.presentation,
  })

  return {
    state: {
      shell,
      presentation: presentation.nextSnapshot,
      startupPlan,
      startupInput,
    },
    startupPlan,
    presentation,
    deferredEffect,
    executedLocalEffectCount,
    executedStartupStepCount: 0,
    setupExchangeReplan,
    evidenceFailure: planned.evidenceFailure,
  }
}

export async function runSyncRuntimeObsidianShellDriverStartupStepTick(
  input: SyncRuntimeObsidianShellDriverStartupStepTickInput,
): Promise<SyncRuntimeObsidianShellDriverTickResult> {
  const previous = input.state ?? INITIAL_SYNC_RUNTIME_OBSIDIAN_SHELL_DRIVER_STATE
  const planned = await planShellWhenIdle(previous, input.evidence)
  let shell = planned.shell
  let executedLocalEffectCount = 0
  let executedStartupStepCount = 0

  const local = await pumpLocalEffects({
    shell,
    executor: input.executor,
    maxLocalEffects: input.maxLocalEffects,
  })
  shell = local.shell
  executedLocalEffectCount += local.executedLocalEffectCount

  if (planned.evidenceFailure === undefined) {
    const startupSteps = await pumpStartupStepEffects({
      shell,
      startupStep: input.startupStep,
      maxStartupSteps: input.maxStartupSteps,
    })
    shell = startupSteps.shell
    executedStartupStepCount = startupSteps.executedStartupStepCount
  }

  const deferredEffect = planSyncRuntimeNoNetworkEffectPump({ state: shell }).deferredEffect
  const presentation = planSyncRuntimeObsidianPresentation({
    state: shell,
    previous: previous.presentation,
  })

  return {
    state: {
      shell,
      presentation: presentation.nextSnapshot,
      startupPlan: planned.startupPlan,
      startupInput: planned.startupInput ?? previous.startupInput,
    },
    startupPlan: planned.startupPlan,
    presentation,
    deferredEffect,
    executedLocalEffectCount,
    executedStartupStepCount,
    setupExchangeReplan: undefined,
    evidenceFailure: planned.evidenceFailure,
  }
}

export async function runSyncRuntimeObsidianShellDriverTransportTick(
  input: SyncRuntimeObsidianShellDriverTransportTickInput,
): Promise<SyncRuntimeObsidianShellDriverTickResult> {
  const previous = input.state ?? INITIAL_SYNC_RUNTIME_OBSIDIAN_SHELL_DRIVER_STATE
  const planned = await planShellWhenIdle(previous, input.evidence)
  let shell = planned.shell
  const startupInput = planned.startupInput ?? previous.startupInput
  let startupPlan = planned.startupPlan
  let executedLocalEffectCount = 0
  let executedStartupStepCount = 0
  let setupExchangeReplan: SyncRuntimeSetupExchangeShellReplan | undefined

  const beforeSetup = await pumpLocalEffects({
    shell,
    executor: input.executor,
    maxLocalEffects: remainingLocalEffectLimit(input.maxLocalEffects, executedLocalEffectCount),
  })
  shell = beforeSetup.shell
  executedLocalEffectCount += beforeSetup.executedLocalEffectCount

  if (planned.evidenceFailure === undefined) {
    const setupRuntimeEffect = nextSetupExchangeRuntimeEffect(shell)
    if (setupRuntimeEffect !== undefined) {
      try {
        const completed = await input.setupExchange.run(setupRuntimeEffect.effect)
        if (startupInput === undefined) {
          throw new Error('setup-exchange-startup-input-missing')
        }
        setupExchangeReplan = applySyncRuntimeSetupExchangeShellReplan({
          state: shell,
          request: completed,
          current: startupReplanCurrentFromEvidenceInput(startupInput),
          expectedBootstrapMode: startupInput.expectedBootstrapMode,
        })
        shell = setupExchangeReplan.state
        startupPlan = setupExchangeReplan.replan.startup
      } catch (error: unknown) {
        shell = applySyncRuntimeShellCommands(shell, [
          {
            kind: 'fail-runtime-effect',
            effect: setupRuntimeEffect,
            reason: runtimeDriverFailureReason('setup-exchange', error),
          },
        ])
      }
    }
  }

  const afterSetup = await pumpLocalEffects({
    shell,
    executor: input.executor,
    maxLocalEffects: remainingLocalEffectLimit(input.maxLocalEffects, executedLocalEffectCount),
  })
  shell = afterSetup.shell
  executedLocalEffectCount += afterSetup.executedLocalEffectCount

  if (planned.evidenceFailure === undefined) {
    const startupSteps = await pumpStartupStepEffects({
      shell,
      startupStep: input.startupStep,
      maxStartupSteps: input.maxStartupSteps,
    })
    shell = startupSteps.shell
    executedStartupStepCount = startupSteps.executedStartupStepCount
  }

  const deferredEffect = planSyncRuntimeNoNetworkEffectPump({ state: shell }).deferredEffect
  const presentation = planSyncRuntimeObsidianPresentation({
    state: shell,
    previous: previous.presentation,
  })

  return {
    state: {
      shell,
      presentation: presentation.nextSnapshot,
      startupPlan,
      startupInput,
    },
    startupPlan,
    presentation,
    deferredEffect,
    executedLocalEffectCount,
    executedStartupStepCount,
    setupExchangeReplan,
    evidenceFailure: planned.evidenceFailure,
  }
}

async function planShellWhenIdle(
  state: SyncRuntimeObsidianShellDriverState,
  evidence: SyncRuntimeObsidianShellEvidencePort,
): Promise<{
  readonly shell: SyncRuntimeShellState
  readonly startupPlan: SyncRuntimeStartupPlan | undefined
  readonly startupInput: SyncRuntimeStartupFromSchemaEvidenceInput | undefined
  readonly evidenceFailure:
    | Extract<SyncRuntimeLocalStateEvidencePlan, { readonly ok: false }>
    | undefined
}> {
  if (state.shell.status !== undefined || state.shell.runnableEffects.length > 0) {
    if (state.startupPlan !== undefined) {
      return {
        shell: state.shell,
        startupPlan: state.startupPlan,
        startupInput: state.startupInput,
        evidenceFailure: undefined,
      }
    }
    const read = await evidence.readStartupInput()
    if (!read.ok) {
      return {
        shell: applySyncRuntimeShellCommands(
          state.shell,
          shellCommandsForEvidenceFailure(read.localState),
        ),
        startupPlan: undefined,
        startupInput: undefined,
        evidenceFailure: read.localState,
      }
    }
    return {
      shell: state.shell,
      startupPlan: planSyncRuntimeStartupFromSchemaEvidence(read.startupInput),
      startupInput: read.startupInput,
      evidenceFailure: undefined,
    }
  }

  const read = await evidence.readStartupInput()
  if (!read.ok) {
    return {
      shell: applySyncRuntimeShellCommands(
        state.shell,
        shellCommandsForEvidenceFailure(read.localState),
      ),
      startupPlan: undefined,
      startupInput: undefined,
      evidenceFailure: read.localState,
    }
  }

  const startupPlan = planSyncRuntimeStartupFromSchemaEvidence(read.startupInput)
  return {
    shell: applySyncRuntimeShellCommands(
      state.shell,
      planSyncRuntimeStartupActuation({ plan: startupPlan }).commands,
    ),
    startupPlan,
    startupInput: read.startupInput,
    evidenceFailure: undefined,
  }
}
