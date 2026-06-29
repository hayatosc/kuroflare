import * as v from 'valibot'

import { BinaryFrameHeaderSchema, type BinaryFrameHeader } from '../sync/messages'
import { CURRENT_PROTOCOL_VERSION } from '../utils/version'

const MAGIC_K = 0x4b
const MAGIC_F = 0x46
const ENVELOPE_HEADER_BYTES = 8
const MAX_HEADER_BYTES = 16 * 1024

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export interface BinaryFrame {
  /** Parsed and validated JSON metadata for the Yjs update payload. */
  readonly header: BinaryFrameHeader
  /** Raw Yjs update bytes carried by the WebSocket binary frame. */
  readonly payload: Uint8Array
}

export function encodeBinaryFrame(header: unknown, payload: Uint8Array): Uint8Array {
  if (!v.is(BinaryFrameHeaderSchema, header)) {
    throw new Error('Invalid binary frame header')
  }

  const headerBytes = textEncoder.encode(JSON.stringify(header))
  if (headerBytes.byteLength > MAX_HEADER_BYTES) {
    throw new Error(`Binary frame header exceeds ${MAX_HEADER_BYTES} bytes`)
  }

  const frame = new Uint8Array(ENVELOPE_HEADER_BYTES + headerBytes.byteLength + payload.byteLength)
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  frame[0] = MAGIC_K
  frame[1] = MAGIC_F
  view.setUint16(2, CURRENT_PROTOCOL_VERSION, false)
  view.setUint32(4, headerBytes.byteLength, false)
  frame.set(headerBytes, ENVELOPE_HEADER_BYTES)
  frame.set(payload, ENVELOPE_HEADER_BYTES + headerBytes.byteLength)
  return frame
}

export function decodeBinaryFrame(frame: Uint8Array): BinaryFrame | null {
  if (frame.byteLength < ENVELOPE_HEADER_BYTES) {
    return null
  }
  if (frame[0] !== MAGIC_K || frame[1] !== MAGIC_F) {
    return null
  }

  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  const protocolVersion = view.getUint16(2, false)
  if (protocolVersion !== CURRENT_PROTOCOL_VERSION) {
    return null
  }

  const headerLength = view.getUint32(4, false)
  if (headerLength === 0 || headerLength > MAX_HEADER_BYTES) {
    return null
  }
  const payloadOffset = ENVELOPE_HEADER_BYTES + headerLength
  if (payloadOffset > frame.byteLength) {
    return null
  }

  const headerBytes = frame.subarray(ENVELOPE_HEADER_BYTES, payloadOffset)
  const payload = frame.slice(payloadOffset)

  try {
    const header = JSON.parse(textDecoder.decode(headerBytes))
    const result = v.safeParse(BinaryFrameHeaderSchema, header)
    return result.success ? { header: result.output, payload } : null
  } catch {
    return null
  }
}
