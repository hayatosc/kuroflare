import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { requireObsidianVaultPath } from './obsidian-utils.ts'
import { packageDir } from './types.ts'

describe('requireObsidianVaultPath', () => {
  it.each(['', 'Vault not found.'])('rejects a missing active vault: %j', (value) => {
    expect(() => requireObsidianVaultPath(value)).toThrow(
      'Obsidian CLI did not return an active vault path.',
    )
  })

  it('rejects a relative path', () => {
    expect(() => requireObsidianVaultPath('relative/vault')).toThrow(
      'Obsidian CLI returned a relative vault path',
    )
  })

  it('rejects a path that does not exist', () => {
    expect(() => requireObsidianVaultPath(join(packageDir, '__missing-vault__'))).toThrow(
      'Obsidian CLI returned a vault path that is not an existing directory',
    )
  })

  it('rejects a regular file', () => {
    expect(() => requireObsidianVaultPath(join(packageDir, 'package.json'))).toThrow(
      'Obsidian CLI returned a vault path that is not an existing directory',
    )
  })

  it('accepts an existing absolute directory', () => {
    expect(requireObsidianVaultPath(packageDir)).toBe(packageDir)
  })
})
