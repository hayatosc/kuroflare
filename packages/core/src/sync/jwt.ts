import * as v from 'valibot'

import { DeviceTokenClaimsSchema, type DeviceTokenClaims } from '../sync/schemas'

const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Input for signing worker-issued device access-token claims. */
export interface SignHs256DeviceTokenInput {
  readonly claims: DeviceTokenClaims
  readonly secret: string
}

/** Input for verifying worker-issued device access tokens. */
export interface VerifyHs256DeviceTokenInput {
  readonly token: string
  readonly secret: string
}

/**
 * Signs device token claims as an HS256 JWT.
 *
 * @param input Guarded claims and shared HMAC secret.
 * @returns Compact JWT string suitable for device access tokens.
 * @throws When the secret is empty or the claims fail the device-token claims guard.
 */
export async function signHs256DeviceToken(input: SignHs256DeviceTokenInput): Promise<string> {
  if (input.secret.length === 0) {
    throw new Error('empty-device-token-secret')
  }
  if (!v.is(DeviceTokenClaimsSchema, input.claims)) {
    throw new Error('invalid-device-token-claims')
  }

  const encodedHeader = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
  )
  const encodedPayload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(input.claims)))
  const signature = await signHs256(`${encodedHeader}.${encodedPayload}`, input.secret)
  return `${encodedHeader}.${encodedPayload}.${encodeBase64Url(signature)}`
}

/**
 * Verifies an HS256 device access token and returns guarded claims.
 *
 * @param input Compact JWT and shared HMAC secret.
 * @returns Device token claims when header, signature, and payload validate; otherwise undefined.
 */
export async function verifyHs256DeviceToken(
  input: VerifyHs256DeviceTokenInput,
): Promise<DeviceTokenClaims | undefined> {
  if (input.secret.length === 0) {
    return undefined
  }

  const parts = input.token.split('.')
  if (parts.length !== 3) {
    return undefined
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts
  if (
    encodedHeader === undefined ||
    encodedPayload === undefined ||
    encodedSignature === undefined
  ) {
    return undefined
  }

  const header = decodeBase64UrlJson(encodedHeader)
  if (!isRecord(header) || header.alg !== 'HS256' || header.typ !== 'JWT') {
    return undefined
  }

  const expectedSignature = await signHs256(`${encodedHeader}.${encodedPayload}`, input.secret)
  const actualSignature = decodeBase64Url(encodedSignature)
  if (actualSignature === undefined || !timingSafeEqual(expectedSignature, actualSignature)) {
    return undefined
  }

  const payload = decodeBase64UrlJson(encodedPayload)
  return v.is(DeviceTokenClaimsSchema, payload) ? payload : undefined
}

async function signHs256(data: string, secret: string): Promise<Uint8Array> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
  return new Uint8Array(signature)
}

function encodeBase64Url(value: Uint8Array): string {
  return encodeBase64(value).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function decodeBase64UrlJson(value: string): unknown {
  const bytes = decodeBase64Url(value)
  if (bytes === undefined) {
    return undefined
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    return undefined
  }
}

function decodeBase64Url(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    return undefined
  }
  if (value.length % 4 === 1) {
    return undefined
  }
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=')
  const decoded = decodeBase64(padded)
  if (decoded === undefined || encodeBase64Url(decoded) !== value) {
    return undefined
  }
  return decoded
}

function encodeBase64(value: Uint8Array): string {
  let encoded = ''
  for (let index = 0; index < value.byteLength; index += 3) {
    const first = value[index]
    if (first === undefined) {
      return encoded
    }
    const second = value[index + 1]
    const third = value[index + 2]
    const triple = (first << 16) | ((second ?? 0) << 8) | (third ?? 0)
    encoded += charAtBase64Index((triple >> 18) & 0x3f)
    encoded += charAtBase64Index((triple >> 12) & 0x3f)
    encoded += second === undefined ? '=' : charAtBase64Index((triple >> 6) & 0x3f)
    encoded += third === undefined ? '=' : charAtBase64Index(triple & 0x3f)
  }
  return encoded
}

function decodeBase64(value: string): Uint8Array | undefined {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return undefined
  }
  const firstPadding = value.indexOf('=')
  if (firstPadding !== -1 && !/^=+$/.test(value.slice(firstPadding))) {
    return undefined
  }

  const paddingLength = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const decodedLength = Math.floor((value.length * 3) / 4) - paddingLength
  const decoded = new Uint8Array(decodedLength)
  let offset = 0

  for (let index = 0; index < value.length; index += 4) {
    const first = decodeBase64Character(value.charAt(index))
    const second = decodeBase64Character(value.charAt(index + 1))
    const third =
      value.charAt(index + 2) === '=' ? 0 : decodeBase64Character(value.charAt(index + 2))
    const fourth =
      value.charAt(index + 3) === '=' ? 0 : decodeBase64Character(value.charAt(index + 3))
    if (
      first === undefined ||
      second === undefined ||
      third === undefined ||
      fourth === undefined
    ) {
      return undefined
    }

    const triple = (first << 18) | (second << 12) | (third << 6) | fourth
    if (offset < decodedLength) {
      decoded[offset] = (triple >> 16) & 0xff
      offset += 1
    }
    if (offset < decodedLength) {
      decoded[offset] = (triple >> 8) & 0xff
      offset += 1
    }
    if (offset < decodedLength) {
      decoded[offset] = triple & 0xff
      offset += 1
    }
  }

  return decoded
}

function charAtBase64Index(index: number): string {
  return base64Alphabet.charAt(index)
}

function decodeBase64Character(value: string): number | undefined {
  const index = base64Alphabet.indexOf(value)
  return index === -1 ? undefined : index
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
