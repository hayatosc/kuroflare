/**
 * Checks whether a local blob-cache key is constrained to the plugin blob cache namespace.
 *
 * @param key Persisted cache key from an outbox row.
 * @returns True when the key is a safe vault-relative blob-cache path.
 */
export function isSafeLocalBlobCacheKey(key: string): boolean {
  return (
    key.startsWith('blob-cache/') &&
    key.length > 'blob-cache/'.length &&
    isSafeVaultRelativePath(key)
  )
}

/**
 * Checks whether a persisted path is a normalized vault-relative path.
 *
 * @param path Path persisted in local-store state.
 * @returns True when the path cannot escape the vault through absolute or parent segments.
 */
export function isSafeVaultRelativePath(path: string): boolean {
  if (path.length === 0 || path.includes('\0') || path.includes('\\')) {
    return false
  }
  if (path.startsWith('/')) {
    return false
  }
  return path
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

export function normalizeHttpEndpoint(endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint)
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username !== '' ||
      url.password !== '' ||
      url.hash !== ''
    ) {
      return undefined
    }
    url.pathname = '/'
    url.search = ''
    return url.toString()
  } catch {
    return undefined
  }
}
