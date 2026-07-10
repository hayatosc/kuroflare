import {
  type OutboxResumeDecisionInput,
  type OutboxResumeDecision,
  type OutboxSchedulerItem,
  type OutboxResumeEvent,
  type OutboxResumePatch,
} from '../types'

/**
 * Decides whether a paused outbox item may return to pending after a resume event.
 */
export function decideOutboxResume(input: OutboxResumeDecisionInput): OutboxResumeDecision {
  if (input.status !== 'paused') {
    return { action: 'wait', reason: 'not-paused' }
  }
  if (input.resumeOn === undefined) {
    return { action: 'wait', reason: 'missing-resume-condition' }
  }
  if (input.event !== 'manual' && input.event !== input.resumeOn) {
    return { action: 'wait', reason: 'resume-condition-not-met' }
  }
  return { action: 'resume', status: 'pending', nextAttemptAt: undefined }
}

/**
 * Plans paused item resume patches for events observed since the previous scheduler tick.
 */
export function planOutboxResumePatches(
  items: readonly OutboxSchedulerItem[],
  events: readonly OutboxResumeEvent[],
): readonly OutboxResumePatch[] {
  if (events.length === 0) {
    return []
  }

  const patches: OutboxResumePatch[] = []
  for (const item of items) {
    for (const event of events) {
      const decision = decideOutboxResume({
        status: item.status,
        resumeOn: item.resumeOn,
        event,
      })
      if (decision.action === 'resume') {
        patches.push({
          id: item.id,
          status: decision.status,
          nextAttemptAt: decision.nextAttemptAt,
        })
        break
      }
    }
  }
  return patches
}
