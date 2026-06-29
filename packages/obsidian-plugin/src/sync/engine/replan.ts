import { type ClientStartupIntent } from '@kuroflare/core'
import { type SetupBootstrapMode } from '@kuroflare/core'

import {
  applySyncRuntimeShellCommands,
  planSyncRuntimeStartupActuation,
  type SyncRuntimeShellCommand,
  type SyncRuntimeShellState,
  type SyncRuntimeSetupExchangeReplanRequest,
  type SyncRuntimeStartupActuationPlan,
} from '../engine/actuation'
import {
  planSyncRuntimeStartup,
  type SyncRuntimeStartupInput,
  type SyncRuntimeStartupPlan,
} from '../engine/startup'

/** Input for replanning startup after setup exchange returned credentials. */
export interface SyncRuntimeSetupExchangeStartupReplanInput {
  readonly request: SyncRuntimeSetupExchangeReplanRequest
  readonly current: Omit<SyncRuntimeStartupInput, 'setupResponse' | 'expectedBootstrapMode'>
  readonly expectedBootstrapMode?: SetupBootstrapMode | undefined
}

/** Startup and actuation plans produced after setup exchange. */
export interface SyncRuntimeSetupExchangeStartupReplan {
  readonly intent: ClientStartupIntent
  readonly startup: SyncRuntimeStartupPlan
  readonly actuation: SyncRuntimeStartupActuationPlan
}

/** Input for applying setup exchange replan to the shell state. */
export interface SyncRuntimeSetupExchangeShellReplanInput extends SyncRuntimeSetupExchangeStartupReplanInput {
  readonly state: SyncRuntimeShellState
}

/** Shell state transition produced by setup exchange replan. */
export interface SyncRuntimeSetupExchangeShellReplan {
  readonly replan: SyncRuntimeSetupExchangeStartupReplan
  readonly commands: readonly SyncRuntimeShellCommand[]
  readonly state: SyncRuntimeShellState
}

/**
 * Replans startup from a completed setup exchange response.
 *
 * @param input Setup exchange response plus the current local/schema evidence.
 * @returns Runtime startup and actuation plans that continue through setup persistence.
 */
export function planSyncRuntimeStartupAfterSetupExchange(
  input: SyncRuntimeSetupExchangeStartupReplanInput,
): SyncRuntimeSetupExchangeStartupReplan {
  const intent = setupReplanIntent({
    currentIntent: input.current.intent,
    bootstrapMode: input.request.response.bootstrapMode,
  })
  const startup = planSyncRuntimeStartup({
    ...input.current,
    intent,
    setupResponse: input.request.response,
    expectedBootstrapMode: input.expectedBootstrapMode ?? input.request.response.bootstrapMode,
  })
  return {
    intent,
    startup,
    actuation: planSyncRuntimeStartupActuation({ plan: startup }),
  }
}

/**
 * Applies setup exchange replan to the plugin shell state.
 *
 * The completed setup exchange runtime effect is acknowledged first, then stale runnable and
 * failed-effect state is dropped before the newly planned startup commands are applied.
 *
 * @param input Shell state, setup exchange response, and current startup evidence.
 * @returns Replan evidence, emitted commands, and the next shell state.
 */
export function applySyncRuntimeSetupExchangeShellReplan(
  input: SyncRuntimeSetupExchangeShellReplanInput,
): SyncRuntimeSetupExchangeShellReplan {
  const replan = planSyncRuntimeStartupAfterSetupExchange(input)
  const ackCommand: SyncRuntimeShellCommand = {
    kind: 'ack-runtime-effect',
    effect: { kind: 'run-sync-startup-effect', effect: input.request.effect },
  }
  const acknowledged = applySyncRuntimeShellCommands(input.state, [ackCommand])
  const resetState: SyncRuntimeShellState = {
    ...acknowledged,
    runnableEffects: [],
    lastFailedEffect: undefined,
    repairEntries: acknowledged.repairEntries.filter((entry) => entry.entry !== 'startup-rejected'),
  }
  const commands = [ackCommand, ...replan.actuation.commands]
  return {
    replan,
    commands,
    state: applySyncRuntimeShellCommands(resetState, replan.actuation.commands),
  }
}

function setupReplanIntent(input: {
  readonly currentIntent: ClientStartupIntent
  readonly bootstrapMode: SetupBootstrapMode
}): ClientStartupIntent {
  switch (input.currentIntent) {
    case 'setup-new-vault':
    case 'join-existing-vault':
      return input.currentIntent
    case 'reconnect':
      return input.bootstrapMode === 'new-vault' ? 'setup-new-vault' : 'join-existing-vault'
  }
}
