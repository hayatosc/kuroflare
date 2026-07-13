/** Startup permission levels for local and network side effects. */
export type StartupSideEffectPermission = 'allowed' | 'local-only' | 'blocked'

/** Permission gate for side effects that must wait for startup evidence. */
export interface StartupSideEffectGate {
  readonly allowed: boolean
  readonly replayingPersistence: boolean
  readonly permission: StartupSideEffectPermission
  setAllowed(allowed: boolean): void
  setPermission(permission: StartupSideEffectPermission): void
  beginPersistenceReplay(): void
  endPersistenceReplay(): void
  canRun(): boolean
  canSendNetwork(): boolean
}

/** Creates a gate that starts closed until the shell has trusted startup evidence. */
export function createStartupSideEffectGate(): StartupSideEffectGate {
  let permission: StartupSideEffectPermission = 'blocked'
  let replayingPersistence = false

  return {
    get allowed() {
      return permission === 'allowed'
    },
    get replayingPersistence() {
      return replayingPersistence
    },
    get permission() {
      return permission
    },
    setAllowed(next) {
      permission = next ? 'allowed' : 'blocked'
    },
    setPermission(next) {
      permission = next
    },
    beginPersistenceReplay() {
      replayingPersistence = true
    },
    endPersistenceReplay() {
      replayingPersistence = false
    },
    canRun() {
      return permission !== 'blocked' && !replayingPersistence
    },
    canSendNetwork() {
      return permission === 'allowed' && !replayingPersistence
    },
  }
}
