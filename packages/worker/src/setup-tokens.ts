import type { VaultId } from '@kuroflare/protocol'
import * as v from 'valibot'

/** Setup token row loaded from Durable Object storage after token-hash lookup. */
export interface SetupTokenEntry {
  readonly vaultId: VaultId
  readonly issuedAt: number
  readonly expiresAt: number
  readonly consumedAt: number | undefined
}

/** Input for consuming a one-time setup token. */
export interface SetupTokenConsumeDecisionInput {
  readonly token: SetupTokenEntry | undefined
  readonly requestedVaultId: VaultId
  readonly now: number
}

/** Setup token consumption decision before the caller writes consumedAt. */
export type SetupTokenConsumeDecision =
  | { readonly action: 'consume'; readonly consumedAt: number; readonly token: SetupTokenEntry }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'unknown-token'
        | 'vault-mismatch'
        | 'token-not-yet-valid'
        | 'token-expired'
        | 'token-already-consumed'
        | 'invalid-time'
        | 'invalid-token-window'
    }

/**
 * Decides whether a setup token can be consumed for setup exchange.
 *
 * @param input Token row found by hash, requested vault, and current time.
 * @returns A one-time consumption action, or a stable rejection reason.
 */
export function decideSetupTokenConsume(
  input: SetupTokenConsumeDecisionInput,
): SetupTokenConsumeDecision {
  if (!v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), input.now)) {
    return { action: 'reject', reason: 'invalid-time' }
  }

  if (!input.token) {
    return { action: 'reject', reason: 'unknown-token' }
  }

  if (
    !v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), input.token.issuedAt) ||
    !v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), input.token.expiresAt) ||
    input.token.expiresAt <= input.token.issuedAt
  ) {
    return { action: 'reject', reason: 'invalid-token-window' }
  }

  if (input.token.vaultId !== input.requestedVaultId) {
    return { action: 'reject', reason: 'vault-mismatch' }
  }

  if (input.now < input.token.issuedAt) {
    return { action: 'reject', reason: 'token-not-yet-valid' }
  }

  if (input.now >= input.token.expiresAt) {
    return { action: 'reject', reason: 'token-expired' }
  }

  if (input.token.consumedAt !== undefined) {
    return { action: 'reject', reason: 'token-already-consumed' }
  }

  return { action: 'consume', consumedAt: input.now, token: input.token }
}
