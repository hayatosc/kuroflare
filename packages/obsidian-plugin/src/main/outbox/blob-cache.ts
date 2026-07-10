import { makeSha256Hex } from '@kuroflare/core'
import { TFolder } from 'obsidian'

import { type LocalStoreOutboxRecord } from '../../sync/store/store'
import { sha256Hex } from '../auth'
import { arrayBufferFromBytes } from '../helpers'
import type KuroflareSpikePlugin from '../plugin'

export async function readBlobCacheBytes(
  plugin: KuroflareSpikePlugin,
  key: string,
  expectedSha256: NonNullable<LocalStoreOutboxRecord['blobSha256']>,
  expectedSize: number,
): Promise<Uint8Array | undefined> {
  try {
    const bytes = new Uint8Array(await plugin.app.vault.adapter.readBinary(key))
    return (await blobBytesMatch(plugin, bytes, expectedSha256, expectedSize)) ? bytes : undefined
  } catch {
    return undefined
  }
}

export async function writeBlobCacheBytes(
  plugin: KuroflareSpikePlugin,
  key: string,
  bytes: Uint8Array,
): Promise<void> {
  await ensureAdapterParentFolders(plugin, key)
  await plugin.app.vault.adapter.writeBinary(key, arrayBufferFromBytes(bytes))
}

export async function ensureAdapterParentFolders(
  plugin: KuroflareSpikePlugin,
  path: string,
): Promise<void> {
  const segments = path.split('/').slice(0, -1)
  let current = ''
  for (const segment of segments) {
    current = current.length === 0 ? segment : `${current}/${segment}`
    if (!(await plugin.app.vault.adapter.exists(current))) {
      try {
        await plugin.app.vault.adapter.mkdir(current)
      } catch (error: unknown) {
        if (!(await plugin.app.vault.adapter.exists(current))) {
          throw error
        }
      }
    }
  }
}

export async function ensureVaultParentFolders(
  plugin: KuroflareSpikePlugin,
  path: string,
): Promise<boolean> {
  const segments = path.split('/').slice(0, -1)
  let current = ''
  for (const segment of segments) {
    current = current.length === 0 ? segment : `${current}/${segment}`
    const existing = plugin.app.vault.getAbstractFileByPath(current)
    if (existing instanceof TFolder) {
      continue
    }
    if (existing !== null) {
      return false
    }
    if (await plugin.app.vault.adapter.exists(current)) {
      continue
    }
    try {
      await plugin.app.vault.adapter.mkdir(current)
    } catch {
      if (!(await plugin.app.vault.adapter.exists(current))) {
        return false
      }
    }
  }
  return true
}

export async function blobBytesMatch(
  plugin: KuroflareSpikePlugin,
  bytes: Uint8Array,
  expectedSha256: NonNullable<LocalStoreOutboxRecord['blobSha256']>,
  expectedSize: number,
): Promise<boolean> {
  return (
    bytes.byteLength === expectedSize &&
    makeSha256Hex(await sha256Hex(plugin, bytes)) === expectedSha256
  )
}
