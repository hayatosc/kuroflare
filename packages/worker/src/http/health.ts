import {
  CURRENT_PROTOCOL_VERSION,
  type HealthCheck,
  type HealthResponse,
} from '@kuroflare/core'

import type { SchemaMigrationDecision } from '../db/migrations'

/** Subsystem evidence used to build the public health response. */
export interface WorkerHealthDecisionInput {
  readonly durableObjectAvailable: boolean
  readonly sqliteAvailable: boolean
  readonly r2Available: boolean
  readonly migrationDecision: SchemaMigrationDecision
  readonly checkedAt: number
}

/** Evidence owned by one Durable Object before accepting sync traffic for its vault. */
export interface DurableObjectSyncAdmissionInput {
  readonly sqliteAvailable: boolean
  readonly migrationDecision: SchemaMigrationDecision
}

/** Durable Object-local sync admission decision. */
export type DurableObjectSyncAdmissionDecision =
  | { readonly action: 'accept' }
  | { readonly action: 'reject'; readonly reason: 'sqlite-unavailable' | 'schema-not-ready' }

/**
 * Builds the public health response from subsystem evidence.
 *
 * @param input Runtime availability evidence and schema migration state.
 * @returns A health response suitable for GET /health.
 */
export function decideWorkerHealth(input: WorkerHealthDecisionInput): HealthResponse {
  const checks: HealthCheck[] = [
    makeCheck('worker', true),
    makeCheck('durable-object', input.durableObjectAvailable),
    makeCheck('sqlite', input.sqliteAvailable),
    makeCheck('r2', input.r2Available),
    migrationHealthCheck(input.migrationDecision),
  ]

  return {
    status: checks.every((check) => check.status === 'ok') ? 'ok' : 'degraded',
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    checkedAt: input.checkedAt,
    checks,
  }
}

/**
 * Returns true when the public health response says durable op append can proceed.
 *
 * @param health Public health response built from current runtime evidence.
 * @returns Whether durable sync traffic can proceed. R2 degradation does not block op append.
 */
export function healthAcceptsSync(health: HealthResponse): boolean {
  return (
    checkIsOk(health, 'durable-object') &&
    checkIsOk(health, 'sqlite') &&
    checkIsOk(health, 'migrations')
  )
}

/**
 * Returns true when checkpoint and snapshot work can use R2.
 *
 * @param health Public health response built from current runtime evidence.
 * @returns Whether R2-dependent checkpoint work should proceed.
 */
export function healthAcceptsCheckpoint(health: HealthResponse): boolean {
  return healthAcceptsSync(health) && checkIsOk(health, 'r2')
}

/**
 * Decides whether a vault Durable Object may accept sync traffic.
 *
 * @param input Durable Object-local SQLite and migration evidence.
 * @returns A local sync admission decision. This is the authority for WS/op append.
 */
export function decideDurableObjectSyncAdmission(
  input: DurableObjectSyncAdmissionInput,
): DurableObjectSyncAdmissionDecision {
  if (!input.sqliteAvailable) {
    return { action: 'reject', reason: 'sqlite-unavailable' }
  }

  if (input.migrationDecision.action !== 'ready') {
    return { action: 'reject', reason: 'schema-not-ready' }
  }

  return { action: 'accept' }
}

function makeCheck(name: HealthCheck['name'], healthy: boolean): HealthCheck {
  return healthy ? { name, status: 'ok' } : { name, status: 'degraded' }
}

function migrationHealthCheck(decision: SchemaMigrationDecision): HealthCheck {
  switch (decision.action) {
    case 'ready':
      return { name: 'migrations', status: 'ok' }
    case 'apply-migrations':
      return {
        name: 'migrations',
        status: 'degraded',
        detail: `pending:${decision.fromVersion}->${decision.toVersion}`,
      }
    case 'degraded':
      return {
        name: 'migrations',
        status: 'degraded',
        detail: decision.reason,
      }
  }
}

function checkIsOk(health: HealthResponse, name: HealthCheck['name']): boolean {
  return health.checks.some((check) => check.name === name && check.status === 'ok')
}
