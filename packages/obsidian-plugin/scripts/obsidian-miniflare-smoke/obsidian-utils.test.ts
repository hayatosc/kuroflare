import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  acquireObsidianE2ELock,
  requireObsidianVaultPath,
  requireSafeObsidianVaultPath,
} from './obsidian-utils.ts'
import { packageDir } from './types.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

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

describe('requireSafeObsidianVaultPath', () => {
  it('accepts the exact configured e2e vault path', () => {
    vi.stubEnv('KUROFLARE_E2E_OBSIDIAN_VAULT_PATH', packageDir)

    expect(requireSafeObsidianVaultPath(packageDir)).toBe(packageDir)
  })

  it('rejects an active vault outside the configured e2e path', () => {
    vi.stubEnv('KUROFLARE_E2E_OBSIDIAN_VAULT_PATH', packageDir)

    expect(() => requireSafeObsidianVaultPath(tmpdir())).toThrow(
      'Refusing to mutate active Obsidian vault',
    )
  })

  it('rejects a configured path that resolves through a symlink', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kuroflare-e2e-guard-'))
    const link = join(directory, 'vault-link')
    symlinkSync(packageDir, link, 'dir')
    vi.stubEnv('KUROFLARE_E2E_OBSIDIAN_VAULT_PATH', link)

    try {
      expect(() => requireSafeObsidianVaultPath(link)).toThrow(
        'Refusing to mutate active Obsidian vault',
      )
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })
})

describe('acquireObsidianE2ELock', () => {
  it('refuses concurrent ownership and permits reuse after release', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kuroflare-e2e-lock-'))
    vi.stubEnv('KUROFLARE_E2E_OBSIDIAN_VAULT_PATH', directory)
    const release = acquireObsidianE2ELock(directory)

    try {
      expect(() => acquireObsidianE2ELock(directory)).toThrow(
        'Obsidian e2e vault is already in use',
      )
      release()
      const releaseAgain = acquireObsidianE2ELock(directory)
      releaseAgain()
    } finally {
      release()
      rmSync(directory, { force: true, recursive: true })
    }
  })
})
