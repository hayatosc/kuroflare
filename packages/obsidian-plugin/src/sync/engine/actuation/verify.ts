import { type LocalSetupPersistRuntimePlan } from '../persist'

export function setupPersistFailureReason(
  result: Extract<LocalSetupPersistRuntimePlan, { readonly ok: false }>,
): string {
  if (result.phase === 'plan') {
    return `setup-persist-plan:${result.setupPlan.reason}`
  }
  return `setup-persist-${result.phase}`
}
