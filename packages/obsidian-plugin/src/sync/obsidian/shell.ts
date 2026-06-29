import {
  planSyncRuntimeObsidianPresentation,
  type SyncRuntimeObsidianPresentationPlan,
  type SyncRuntimeObsidianPresentationSnapshot,
} from '../obsidian/presentation'
import {
  applySyncRuntimeSetupExchangeShellReplan,
  type SyncRuntimeSetupExchangeShellReplan,
} from '../engine/replan'
import {
  applySyncRuntimeShellCommands,
  executeRunnableSyncRuntimeShellEffects,
  INITIAL_SYNC_RUNTIME_SHELL_STATE,
  planSyncRuntimeNoNetworkEffectPump,
  planSyncRuntimeStartupActuation,
  type SyncRuntimeDeferredStartupEffect,
  type SyncRuntimeShellCommand,
  type SyncRuntimeShellEffectExecutor,
  type SyncRuntimeShellState,
  type SyncRuntimeSetupExchangePort,
  type SyncRuntimeStartupStepEffectPort,
} from '../engine/actuation'
import {
  planSyncRuntimeStartupFromSchemaEvidence,
  type SyncRuntimeLocalStateEvidencePlan,
  type SyncRuntimeStartupEffect,
  type SyncRuntimeStartupInput,
  type SyncRuntimeStartupFromSchemaEvidenceInput,
  type SyncRuntimeStartupPlan,
} from '../engine/startup'
import { type SyncEngineStartupEffect } from '../engine/engine'

import type {
  SyncRuntimeObsidianShellEvidenceReadResult,
  SyncRuntimeObsidianShellEvidencePort,
  SyncRuntimeObsidianShellDriverState,
  SyncRuntimeObsidianShellDriverTickInput,
  SyncRuntimeObsidianShellDriverSetupExchangeTickInput,
  SyncRuntimeObsidianShellDriverStartupStepTickInput,
  SyncRuntimeObsidianShellDriverTransportTickInput,
  SyncRuntimeObsidianShellDriverTickResult,
} from '../obsidian/shell.types'

export type {
  SyncRuntimeObsidianShellEvidenceReadResult,
  SyncRuntimeObsidianShellEvidencePort,
  SyncRuntimeObsidianShellDriverState,
  SyncRuntimeObsidianShellDriverTickInput,
  SyncRuntimeObsidianShellDriverSetupExchangeTickInput,
  SyncRuntimeObsidianShellDriverStartupStepTickInput,
  SyncRuntimeObsidianShellDriverTransportTickInput,
  SyncRuntimeObsidianShellDriverTickResult,
}

type SyncRuntimeSetupExchangeRuntimeEffect = Extract<
  SyncRuntimeStartupEffect,
  { readonly kind: 'run-sync-startup-effect' }
 > & {
  readonly effect: Extract<SyncEngineStartupEffect, { readonly kind: 'run-setup-exchange' }>
}

type SyncRuntimeStartupStepRuntimeEffect = Extract<
  SyncRuntimeStartupEffect,
  { readonly kind: 'run-sync-startup-effect' }
 > & {
  readonly effect: Extract<SyncEngineStartupEffect, { readonly kind: 'run-startup-step' }>
}

/** Initial durable state for the Obsidian shell startup driver. */
export const INITIAL_SYNC_RUNTIME_OBSIDIAN_SHELL_DRIVER_STATE: SyncRuntimeObsidianShellDriverState =
  {
    shell: INITIAL_SYNC_RUNTIME_SHELL_STATE,
    presentation: { shownNoticeCount: 0 },
    startupPlan: undefined,
    startupInput: undefined,
  }

/**
 * Runs one no-network startup tick for the Obsidian plugin shell.
 */
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

/**
 * Runs one startup tick that can execute setup exchange and immediately replan the shell.
 */
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

/**
 * Runs one startup tick that can execute accepted startup steps after local-store gating.
 */
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

/**
 * Runs one startup tick with setup exchange, local-store gate, and startup step transports wired.
 */
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

async function pumpLocalEffects(input: {
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

function nextSetupExchangeRuntimeEffect(
  shell: SyncRuntimeShellState,
): SyncRuntimeSetupExchangeRuntimeEffect | undefined {
  const effect = shell.runnableEffects[0]
  if (effect?.kind === 'run-sync-startup-effect' && effect.effect.kind === 'run-setup-exchange') {
    return { kind: 'run-sync-startup-effect', effect: effect.effect }
  }
  return undefined
}

async function pumpStartupStepEffects(input: {
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

function nextStartupStepRuntimeEffect(
  shell: SyncRuntimeShellState,
): SyncRuntimeStartupStepRuntimeEffect | undefined {
  const effect = shell.runnableEffects[0]
  if (effect?.kind === 'run-sync-startup-effect' && effect.effect.kind === 'run-startup-step') {
    return { kind: 'run-sync-startup-effect', effect: effect.effect }
  }
  return undefined
}

function startupReplanCurrentFromEvidenceInput(
  input: SyncRuntimeStartupFromSchemaEvidenceInput,
): Omit<SyncRuntimeStartupInput, 'setupResponse' | 'expectedBootstrapMode'> {
  const localStore = input.localStoreEvidence?.ok
    ? {
        dbExists: input.localStoreEvidence.evidence.dbExists,
        currentVersion: input.localStoreEvidence.evidence.currentVersion,
        presentStores: input.localStoreEvidence.evidence.presentStores,
        pendingOutboxCount: input.localStoreEvidence.evidence.pendingOutboxCount,
      }
    : undefined

  return {
    intent: input.intent,
    local: input.local,
    localStore,
  }
}

function remainingLocalEffectLimit(
  maxLocalEffects: number | undefined,
  executedLocalEffectCount: number,
): number | undefined {
  return maxLocalEffects === undefined
    ? undefined
    : Math.max(0, maxLocalEffects - executedLocalEffectCount)
}

function runtimeDriverFailureReason(
  phase: 'setup-exchange' | 'startup-step',
  _error: unknown,
): string {
  return phase === 'setup-exchange' ? 'setup-exchange-failed' : 'startup-step-failed'
}

function shellCommandsForEvidenceFailure(
  failure: Extract<SyncRuntimeLocalStateEvidencePlan, { readonly ok: false }>,
) {
  switch (failure.reason) {
    case 'local-store-schema-evidence-failure':
      return [
        { kind: 'stop-background-queues', reason: 'local-store-blocked' },
        {
          kind: 'set-status',
          status: 'local-store-blocked',
          reason: failure.localStoreReason ?? failure.reason,
        },
        {
          kind: 'show-repair-entry',
          entry: 'local-store-schema',
          reason: failure.localStoreReason ?? failure.reason,
        },
        { kind: 'show-notice', notice: 'local-store-blocked' },
      ] as const
    case 'invalid-local-metadata':
    case 'invalid-supported-schema-version':
      return [
        { kind: 'stop-background-queues', reason: 'rejected' },
        {
          kind: 'set-status',
          status: 'rejected',
          reason: failure.metadataReason ?? failure.reason,
        },
        {
          kind: 'show-repair-entry',
          entry: 'startup-rejected',
          reason: failure.metadataReason ?? failure.reason,
        },
        { kind: 'show-notice', notice: 'startup-rejected' },
      ] as const
  }
}
