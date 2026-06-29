import * as v from 'valibot'

import { ProtocolVersionSchema } from './version.js'

export const HealthStatusSchema = v.union([v.literal('ok'), v.literal('degraded')])
export type HealthStatus = v.InferInput<typeof HealthStatusSchema>

export const HealthCheckNameSchema = v.union([
  v.literal('worker'),
  v.literal('durable-object'),
  v.literal('sqlite'),
  v.literal('r2'),
  v.literal('migrations'),
])
export type HealthCheckName = v.InferInput<typeof HealthCheckNameSchema>

const MAX_HEALTH_DETAIL_LENGTH = 512
const NonNegativeSafeIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(0))

export const HealthCheckSchema = v.object({
  name: HealthCheckNameSchema,
  status: HealthStatusSchema,
  detail: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_HEALTH_DETAIL_LENGTH))),
})
export type HealthCheck = v.InferInput<typeof HealthCheckSchema>

export const HealthResponseSchema = v.pipe(
  v.object({
    status: HealthStatusSchema,
    protocolVersion: ProtocolVersionSchema,
    checkedAt: NonNegativeSafeIntegerSchema,
    checks: v.pipe(
      v.array(HealthCheckSchema),
      v.minLength(1),
      v.maxLength(5),
      v.check(
        (arr) => new Set(arr.map((c) => c.name)).size === arr.length,
        'Duplicate check names',
      ),
    ),
  }),
  v.check(
    (val) => val.status === 'degraded' || val.checks.every((c) => c.status === 'ok'),
    'Status mismatch',
  ),
)
export type HealthResponse = v.InferInput<typeof HealthResponseSchema>
