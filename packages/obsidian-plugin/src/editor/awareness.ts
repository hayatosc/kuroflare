/**
 * Local Yjs-shaped awareness, broadcast to peers over the sync WebSocket
 * (see docs/spec/protocol.md §1 `awareness-update`).
 *
 * `y-codemirror.next`'s `yCollab` binding expects an object shaped like
 * `y-protocols/awareness`'s `Awareness` (`doc.clientID`, `getLocalState`,
 * `setLocalStateField`, `getStates`, `on`/`off("change")`). `y-protocols` is
 * not an installed dependency, so this implements just enough of that surface:
 * `setLocalState*` tracks this client's own presence, and `applyRemoteState`
 * feeds in the peer state received over the wire (see
 * `main/sync-websocket.ts`), both funneled through the same `states` map and
 * `change` event `y-codemirror.next`'s remote-selections plugin renders from.
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

// Real Yjs clientIDs are random 32-bit ints so independent devices don't collide
// (see Y.Doc's own `generateNewClientId`). A per-process incrementing counter
// would always start at 1, guaranteeing a collision with every other device's
// first awareness instance once state is broadcast, so seed it randomly and
// only increment from there to keep same-process instances distinct too.
let nextLocalClientId = Math.floor(Math.random() * 0xffffffff)

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

  /**
   * Applies a peer's awareness state received over the sync WebSocket.
   *
   * Ignores updates that claim this instance's own `clientID`: those can only be a
   * stale self-broadcast, and must never overwrite the true local state.
   *
   * @param clientId Remote Yjs client id the state belongs to.
   * @param state Remote presence state, or `null` when the peer left.
   */
  applyRemoteState(clientId: number, state: AwarenessState | null): void {
    if (clientId === this.doc.clientID) return
    const hadState = this.states.has(clientId)
    if (state === null) {
      if (!hadState) return
      this.states.delete(clientId)
      this.emitChange({ added: [], updated: [], removed: [clientId] })
      return
    }
    this.states.set(clientId, state)
    this.emitChange(
      hadState
        ? { added: [], updated: [clientId], removed: [] }
        : { added: [clientId], updated: [], removed: [] },
    )
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
