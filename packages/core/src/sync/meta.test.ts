import { assert, test } from 'vitest'

import { portablePath } from './meta'

test('portablePath leaves an already-portable path unchanged', () => {
  assert.deepEqual(portablePath('Notes/Idea.md'), { path: 'Notes/Idea.md', reason: undefined })
})

test('portablePath renames a Windows reserved device name', () => {
  assert.deepEqual(portablePath('Notes/CON.md'), {
    path: 'Notes/CON_.md',
    reason: 'windows-reserved-name',
  })
  assert.deepEqual(portablePath('con'), { path: 'con_', reason: 'windows-reserved-name' })
  assert.deepEqual(portablePath('LPT1'), { path: 'LPT1_', reason: 'windows-reserved-name' })
})

test('portablePath strips trailing spaces or periods before matching a reserved name', () => {
  assert.deepEqual(portablePath('CON .txt'), {
    path: 'CON_.txt',
    reason: 'windows-reserved-name',
  })
  assert.deepEqual(portablePath('nul  '), { path: 'nul_', reason: 'windows-reserved-name' })
})

test('portablePath replaces trailing spaces or periods', () => {
  assert.deepEqual(portablePath('notes '), { path: 'notes_', reason: 'trailing-space-or-dot' })
  assert.deepEqual(portablePath('notes.'), { path: 'notes_', reason: 'trailing-space-or-dot' })
})

test('portablePath replaces control and Windows-forbidden characters', () => {
  assert.deepEqual(portablePath('a<b>c:d"e|f?g*h.md'), {
    path: 'a_b_c_d_e_f_g_h.md',
    reason: 'forbidden-character',
  })
  const controlChar = String.fromCharCode(1)
  assert.deepEqual(portablePath(`a${controlChar}b.md`), {
    path: 'a_b.md',
    reason: 'forbidden-character',
  })
})

test('portablePath truncates an overlong segment while preserving the extension', () => {
  const longName = 'a'.repeat(300)
  const result = portablePath(`${longName}.md`)
  assert.equal(result.reason, 'segment-too-long')
  assert.equal(result.path, `${'a'.repeat(252)}.md`)
  assert.equal(new TextEncoder().encode(result.path).length, 255)
})

test('portablePath sanitizes every path segment independently', () => {
  assert.deepEqual(portablePath('CON/notes /aux.md'), {
    path: 'CON_/notes_/aux_.md',
    reason: 'windows-reserved-name',
  })
})

test('portablePath is idempotent: re-sanitizing an already-sanitized path is a no-op', () => {
  const vectors = [
    'Notes/CON.md',
    'CON .txt',
    'nul  ',
    'notes ',
    'notes.',
    'a<b>c:d"e|f?g*h.md',
    `${'a'.repeat(300)}.md`,
    'CON/notes /aux.md',
  ]
  for (const vector of vectors) {
    const once = portablePath(vector)
    const twice = portablePath(once.path)
    assert.deepEqual(twice, { path: once.path, reason: undefined }, `not idempotent: ${vector}`)
  }
})
