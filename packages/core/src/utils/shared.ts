import * as v from 'valibot'

export const NonNegativeSafeIntegerSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0))

export const PositiveSafeIntegerSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1))

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** Base64-encoded string, allows empty input. */
export const Base64Schema = v.pipe(v.string(), v.regex(BASE64_PATTERN, 'Invalid base64'))

/** Base64-encoded string that must be non-empty. */
export const NonEmptyBase64Schema = v.pipe(
  v.string(),
  v.minLength(1),
  v.regex(BASE64_PATTERN, 'Invalid base64'),
)

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return v.is(NonNegativeSafeIntegerSchema, value)
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return v.is(PositiveSafeIntegerSchema, value)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
