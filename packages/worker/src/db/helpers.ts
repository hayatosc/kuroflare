export function firstSqlRow<T extends Record<string, unknown>>(rows: Iterable<T>): T | undefined {
  for (const row of rows) {
    return row
  }
  return undefined
}

export function nullToUndefined(value: unknown): unknown {
  return value === null ? undefined : value
}

export function readSqlUpdateBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) {
    return value
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }
  return undefined
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (!(bytes.buffer instanceof ArrayBuffer)) {
    throw new Error('Expected ArrayBuffer backing store')
  }
  return bytes.buffer
}
