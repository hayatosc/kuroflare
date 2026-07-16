import { assert, test } from 'vitest'

import { LocalAwareness } from './awareness'

test('local state starts as an empty object and updates through setLocalStateField', () => {
  const awareness = new LocalAwareness()
  assert.deepEqual(awareness.getLocalState(), {})

  awareness.setLocalStateField('cursor', { anchor: 1, head: 1 })
  assert.deepEqual(awareness.getLocalState(), { cursor: { anchor: 1, head: 1 } })
  assert.deepEqual(awareness.getStates().get(awareness.doc.clientID), {
    cursor: { anchor: 1, head: 1 },
  })

  awareness.setLocalStateField('cursor', null)
  assert.deepEqual(awareness.getLocalState(), { cursor: null })
})

test('setLocalState(null) removes the local client from getStates', () => {
  const awareness = new LocalAwareness()
  assert.equal(awareness.getStates().size, 1)

  awareness.setLocalState(null)
  assert.equal(awareness.getStates().size, 0)
  assert.equal(awareness.getLocalState(), null)
})

test('change listeners observe updated and removed transitions', () => {
  const awareness = new LocalAwareness()
  const events: unknown[] = []
  const listener = (change: unknown): void => {
    events.push(change)
  }
  awareness.on('change', listener)

  awareness.setLocalState({ cursor: { anchor: 0, head: 0 } })
  awareness.setLocalState(null)

  assert.deepEqual(events, [
    { added: [], updated: [awareness.doc.clientID], removed: [] },
    { added: [], updated: [], removed: [awareness.doc.clientID] },
  ])

  awareness.off('change', listener)
  awareness.setLocalState({ cursor: null })
  assert.equal(events.length, 2)
})

test('each instance gets a distinct clientID', () => {
  const a = new LocalAwareness()
  const b = new LocalAwareness()
  assert.notEqual(a.doc.clientID, b.doc.clientID)
})
