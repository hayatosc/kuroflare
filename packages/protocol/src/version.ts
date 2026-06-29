import * as v from 'valibot'

export const CURRENT_PROTOCOL_VERSION = 1
export const MIN_SUPPORTED_PROTOCOL_VERSION = 1

export const ProtocolVersionSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(MIN_SUPPORTED_PROTOCOL_VERSION),
  v.maxValue(CURRENT_PROTOCOL_VERSION),
)
