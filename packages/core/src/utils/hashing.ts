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

/** Constant-time byte comparison; used to compare HMAC signatures and shared secrets. */
export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false
  }
  let mismatch = 0
  for (let index = 0; index < left.byteLength; index += 1) {
    const leftByte = left[index]
    const rightByte = right[index]
    if (leftByte === undefined || rightByte === undefined) {
      return false
    }
    mismatch |= leftByte ^ rightByte
  }
  return mismatch === 0
}
