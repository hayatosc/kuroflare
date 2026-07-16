/**
 * Minimal local-only Yjs awareness implementation.
 *
 * `y-codemirror.next`'s `yCollab` binding expects an object shaped like
 * `y-protocols/awareness`'s `Awareness` (`doc.clientID`, `getLocalState`,
 * `setLocalStateField`, `getStates`, `on`/`off("change")`). `y-protocols` is
 * not an installed dependency, and there is no wire transport yet to
 * broadcast state to peers (see docs/spec/operations.md §4), so this only
 * tracks the local client's own state (e.g. cursor position) well enough to
 * satisfy that surface. Remote presence rendering starts working once a
 * provider/transport ships and feeds remote states into an equivalent object.
 *
 * The local state starts as an empty object rather than `null`: y-codemirror.next
 * only starts writing the local cursor position once a local state already
 * exists (see y-remote-selections.js), so this seeds one without adding any
 * user-identifying fields (name, color, ...) until a real provider needs them.
 */

type AwarenessState = Record<string, unknown>

interface AwarenessChange {
  readonly added: readonly number[]
  readonly updated: readonly number[]
  readonly removed: readonly number[]
}

// deliberate: only the "change" event is implemented, since that is the only
// event y-codemirror.next's remote-selections plugin listens for locally.
type AwarenessChangeListener = (change: AwarenessChange) => void

let nextLocalClientId = 1

export class LocalAwareness {
  readonly doc: { readonly clientID: number }
  private localState: AwarenessState | null = null
  private readonly states = new Map<number, AwarenessState>()
  private readonly changeListeners = new Set<AwarenessChangeListener>()

  constructor() {
    this.doc = { clientID: nextLocalClientId++ }
    this.setLocalState({})
  }

  getLocalState(): AwarenessState | null {
    return this.localState
  }

  setLocalState(state: AwarenessState | null): void {
    const hadState = this.states.has(this.doc.clientID)
    this.localState = state
    if (state === null) {
      this.states.delete(this.doc.clientID)
      if (hadState) {
        this.emitChange({ added: [], updated: [], removed: [this.doc.clientID] })
      }
      return
    }
    this.states.set(this.doc.clientID, state)
    this.emitChange(
      hadState
        ? { added: [], updated: [this.doc.clientID], removed: [] }
        : { added: [this.doc.clientID], updated: [], removed: [] },
    )
  }

  setLocalStateField(field: string, value: unknown): void {
    this.setLocalState({ ...(this.localState ?? {}), [field]: value })
  }

  getStates(): ReadonlyMap<number, AwarenessState> {
    return this.states
  }

  on(event: 'change', listener: AwarenessChangeListener): void {
    if (event === 'change') this.changeListeners.add(listener)
  }

  off(event: 'change', listener: AwarenessChangeListener): void {
    if (event === 'change') this.changeListeners.delete(listener)
  }

  private emitChange(change: AwarenessChange): void {
    for (const listener of this.changeListeners) listener(change)
  }
}
