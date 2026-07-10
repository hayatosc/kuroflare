import { type SyncRuntimeShellCommand, type SyncRuntimeShellState } from '../actuation.types'
import { runtimeEffectStartsBackgroundQueues, runtimeStartupEffectIsHead } from './equality'

/** Initial shell state before startup actuation commands are applied. */
export const INITIAL_SYNC_RUNTIME_SHELL_STATE: SyncRuntimeShellState = {
  status: undefined,
  statusReason: undefined,
  backgroundQueues: 'stopped',
  backgroundQueueStopReason: 'startup-not-ready',
  repairEntries: [],
  notices: [],
  runnableEffects: [],
  completedEffects: [],
  lastFailedEffect: undefined,
}

export function applySyncRuntimeShellCommand(
  state: SyncRuntimeShellState,
  command: SyncRuntimeShellCommand,
): SyncRuntimeShellState {
  switch (command.kind) {
    case 'set-status':
      return {
        ...state,
        status: command.status,
        statusReason: command.reason,
      }
    case 'stop-background-queues':
      return {
        ...state,
        backgroundQueues: 'stopped',
        backgroundQueueStopReason: command.reason,
      }
    case 'show-repair-entry':
      return {
        ...state,
        repairEntries: [
          ...state.repairEntries.filter((entry) => entry.entry !== command.entry),
          { entry: command.entry, reason: command.reason },
        ],
      }
    case 'clear-repair-entries':
      return {
        ...state,
        repairEntries: [],
        backgroundQueueStopReason:
          state.backgroundQueues === 'stopped'
            ? 'startup-not-ready'
            : state.backgroundQueueStopReason,
      }
    case 'show-notice':
      return {
        ...state,
        notices: [...state.notices, command.notice],
      }
    case 'run-runtime-effect':
      return {
        ...state,
        runnableEffects: [...state.runnableEffects, command.effect],
      }
    case 'ack-runtime-effect':
      if (!runtimeStartupEffectIsHead(state.runnableEffects, command.effect)) {
        return state
      }
      return {
        ...state,
        runnableEffects: state.runnableEffects.slice(1),
        completedEffects: [...state.completedEffects, command.effect],
        backgroundQueues: runtimeEffectStartsBackgroundQueues(command.effect)
          ? 'running'
          : state.backgroundQueues,
        backgroundQueueStopReason: runtimeEffectStartsBackgroundQueues(command.effect)
          ? undefined
          : state.backgroundQueueStopReason,
      }
    case 'fail-runtime-effect':
      if (!runtimeStartupEffectIsHead(state.runnableEffects, command.effect)) {
        return state
      }
      return {
        ...state,
        status: 'rejected',
        statusReason: command.reason,
        backgroundQueues: 'stopped',
        backgroundQueueStopReason: 'rejected',
        repairEntries: [
          ...state.repairEntries.filter((entry) => entry.entry !== 'startup-rejected'),
          { entry: 'startup-rejected', reason: command.reason },
        ],
        notices: [...state.notices, 'startup-rejected'],
        runnableEffects: state.runnableEffects.slice(1),
        lastFailedEffect: { effect: command.effect, reason: command.reason },
      }
    case 'retry-last-failed-effect':
      if (state.lastFailedEffect === undefined) {
        return state
      }
      return {
        ...state,
        status: 'starting',
        statusReason: command.reason,
        repairEntries: state.repairEntries.filter((entry) => entry.entry !== 'startup-rejected'),
        runnableEffects: [state.lastFailedEffect.effect, ...state.runnableEffects],
        lastFailedEffect: undefined,
      }
  }
}
