import { assert, test } from 'vitest'
import * as Y from 'yjs'

import { createFreshMetaDocForVaultSwitch } from './meta-namespace'

test('vault namespace switch starts with a fresh Y.Doc and no prior vault structs', () => {
  const vaultADoc = new Y.Doc()
  vaultADoc.getMap('meta').set('vault-a-file', { path: 'A.md' })

  const vaultBDoc = createFreshMetaDocForVaultSwitch(vaultADoc)

  assert.equal(vaultBDoc.getMap('meta').has('vault-a-file'), false)
  vaultBDoc.getMap('meta').set('vault-b-file', { path: 'B.md' })
  assert.equal(vaultBDoc.getMap('meta').has('vault-a-file'), false)
  assert.equal(vaultBDoc.getMap('meta').has('vault-b-file'), true)
  vaultBDoc.destroy()
})
