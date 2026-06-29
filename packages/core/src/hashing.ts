/**
 * Encodes bytes as lowercase hexadecimal.
 *
 * @param bytes - Bytes to encode.
 * @returns Lowercase hex string.
 */
export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Hashes arbitrary bytes with SHA-256.
 *
 * @param bytes - Bytes to hash.
 * @returns Stable SHA-256 hash encoded as lowercase hexadecimal.
 */
export async function hashBytesSha256(bytes: Uint8Array): Promise<string> {
  const digestInput = Uint8Array.from(bytes)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', digestInput.buffer)
  return bytesToHex(new Uint8Array(digest))
}
