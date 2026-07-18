/** Startup permission levels for local and network side effects. */
export type StartupSideEffectPermission = 'allowed' | 'local-only' | 'blocked'

/** Permission gate for side effects that must wait for startup evidence. */
export interface StartupSideEffectGate {
  readonly allowed: boolean
  readonly replayingPersistence: boolean
  readonly recoveryInProgress: boolean
  readonly recoveryBlockReason: string | null
  readonly permission: StartupSideEffectPermission
  setAllowed(allowed: boolean): void
  setPermission(permission: StartupSideEffectPermission): void
  beginPersistenceReplay(): void
  endPersistenceReplay(): void
  beginRecovery(): void
  endRecovery(): void
  failRecovery(reason: string): void
  clearRecoveryBlock(): void
  canRun(): boolean
  canSendNetwork(): boolean
}

/** Creates a gate that starts closed until the shell has trusted startup evidence. */
export function createStartupSideEffectGate(): StartupSideEffectGate {
  let permission: StartupSideEffectPermission = 'blocked'
  let replayingPersistence = false
  let recoveryDepth = 0
  let permissionBeforeRecovery: StartupSideEffectPermission = 'blocked'
  let recoveryBlockReason: string | null = null

  return {
    get allowed() {
      return permission === 'allowed'
    },
    get replayingPersistence() {
      return replayingPersistence
    },
    get recoveryInProgress() {
      return recoveryDepth > 0
    },
    get recoveryBlockReason() {
      return recoveryBlockReason
    },
    get permission() {
      return permission
    },
    setAllowed(next) {
      if (recoveryDepth > 0 || recoveryBlockReason !== null) return
      permission = next ? 'allowed' : 'blocked'
    },
    setPermission(next) {
      if ((recoveryDepth > 0 || recoveryBlockReason !== null) && next !== 'blocked') return
      permission = next
    },
    beginPersistenceReplay() {
      replayingPersistence = true
    },
    endPersistenceReplay() {
      replayingPersistence = false
    },
    beginRecovery() {
      if (recoveryDepth === 0 && recoveryBlockReason === null) {
        permissionBeforeRecovery = permission
      }
      recoveryDepth += 1
      permission = 'blocked'
    },
    endRecovery() {
      if (recoveryDepth === 0) return
      recoveryDepth -= 1
      if (recoveryDepth === 0 && recoveryBlockReason === null) permission = permissionBeforeRecovery
    },
    failRecovery(reason) {
      if (typeof reason !== 'string' || reason.length === 0 || reason.length > 256) return
      recoveryBlockReason = reason
      recoveryDepth = 0
      permission = 'blocked'
    },
    clearRecoveryBlock() {
      recoveryBlockReason = null
      permission = recoveryDepth > 0 ? 'blocked' : permissionBeforeRecovery
    },
    canRun() {
      return permission !== 'blocked' && !replayingPersistence
    },
    canSendNetwork() {
      return permission === 'allowed' && !replayingPersistence
    },
  }
}
