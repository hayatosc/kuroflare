import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'

import {
  acquireObsidianE2ELock,
  isSameLinuxProcessIdentity,
  requireObsidianVaultPath,
  requireSafeObsidianVaultPath,
  selectUniqueObsidianRootProcess,
} from './obsidian-utils.ts'
import { packageDir } from './types.ts'
import { readNormalizedMetaEntry, setMetaEntry } from './yjs.ts'

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

describe('selectUniqueObsidianRootProcess', () => {
  const expected = {
    executablePath: '/opt/obsidian/obsidian',
    argv: ['obsidian-app', '/tmp/kuroflare-obsidian-cli-smoke'],
    uid: 1000,
    startTime: '100',
  } as const

  it('selects only an exact same-command, same-vault process', () => {
    const selected = selectUniqueObsidianRootProcess(
      [
        {
          pid: 10,
          uid: 1000,
          argv: expected.argv,
          executablePath: expected.executablePath,
          state: 'S',
          startTime: expected.startTime,
        },
        {
          pid: 11,
          uid: 1000,
          argv: ['obsidian-app', '/tmp/other-vault'],
          executablePath: expected.executablePath,
          state: 'S',
          startTime: '101',
        },
        {
          pid: 12,
          uid: 1000,
          argv: expected.argv,
          executablePath: '/opt/other/obsidian',
          state: 'S',
          startTime: '102',
        },
      ],
      expected,
    )

    expect(selected.pid).toBe(10)
  })

  it('fails closed when no exact process matches', () => {
    expect(() =>
      selectUniqueObsidianRootProcess(
        [
          {
            pid: 10,
            uid: 1001,
            argv: expected.argv,
            executablePath: expected.executablePath,
            state: 'S',
            startTime: expected.startTime,
          },
        ],
        expected,
      ),
    ).toThrow('found 0')
  })

  it('fails closed when exact process matching is ambiguous', () => {
    const snapshot = {
      pid: 10,
      uid: expected.uid,
      argv: expected.argv,
      executablePath: expected.executablePath,
      state: 'S',
      startTime: expected.startTime,
    } as const
    expect(() =>
      selectUniqueObsidianRootProcess([snapshot, { ...snapshot, pid: 11 }], expected),
    ).toThrow('found 2')
  })

  it('does not select a zombie process', () => {
    expect(() =>
      selectUniqueObsidianRootProcess(
        [
          {
            pid: 10,
            uid: expected.uid,
            argv: expected.argv,
            executablePath: expected.executablePath,
            state: 'Z',
            startTime: expected.startTime,
          },
        ],
        expected,
      ),
    ).toThrow('found 0')
  })
})

describe('isSameLinuxProcessIdentity', () => {
  const snapshot = {
    pid: 10,
    uid: 1000,
    argv: ['obsidian-app', '/tmp/kuroflare-obsidian-cli-smoke'],
    executablePath: '/opt/obsidian/obsidian',
    state: 'S',
    startTime: '100',
  } as const

  it('accepts an unchanged process identity and rejects starttime reuse', () => {
    expect(isSameLinuxProcessIdentity(snapshot, snapshot)).toBe(true)
    expect(isSameLinuxProcessIdentity(snapshot, { ...snapshot, startTime: '101' })).toBe(false)
    expect(isSameLinuxProcessIdentity(snapshot, null)).toBe(false)
  })
})

describe('readNormalizedMetaEntry', () => {
  it('decodes grouped text and binary entries into the normalized view', () => {
    const doc = new Y.Doc()
    const textEntry = {
      fileId: 'grouped-text',
      path: 'grouped-text.md',
      canonicalPath: 'grouped-text.md',
      type: 'text',
      ydocId: 'grouped-text-doc',
      deleted: false,
      createdAt: 1,
      createdBy: 'test-device',
      contentUpdatedAt: 2,
      contentUpdatedBy: 'test-device',
      updatedAt: 3,
      updatedBy: 'test-device',
      mtime: 3,
    } as const
    const binaryEntry = {
      fileId: 'grouped-binary',
      path: 'grouped-binary.bin',
      canonicalPath: 'grouped-binary.bin',
      type: 'binary',
      blobManifestHash: 'a'.repeat(64),
      blobChunks: ['b'.repeat(64)],
      deleted: false,
      createdAt: 1,
      createdBy: 'test-device',
      contentUpdatedAt: 2,
      contentUpdatedBy: 'test-device',
      updatedAt: 3,
      updatedBy: 'test-device',
      mtime: 3,
    } as const

    try {
      setMetaEntry(doc, textEntry)
      setMetaEntry(doc, binaryEntry)

      expect(readNormalizedMetaEntry(doc, textEntry.fileId)).toMatchObject(textEntry)
      expect(readNormalizedMetaEntry(doc, binaryEntry.fileId)).toMatchObject(binaryEntry)
    } finally {
      doc.destroy()
    }
  })
})
