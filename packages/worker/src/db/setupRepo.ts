import { type Kysely, sql } from 'kysely'
import type { Database } from './types'

export interface SetupTokenRow {
  readonly vaultId: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly consumedAt: number | null
}

export async function upsertSetupToken(
  db: Kysely<Database>,
  tokenHash: string,
  vaultId: string,
  issuedAt: number,
  expiresAt: number,
): Promise<void> {
  await db
    .insertInto('setup_tokens')
    .values({
      token_hash: tokenHash,
      vault_id: vaultId,
      issued_at: issuedAt,
      expires_at: expiresAt,
      consumed_at: null,
    })
    .onConflict((oc) =>
      oc.column('token_hash').doUpdateSet({
        vault_id: sql`excluded.vault_id`,
        issued_at: sql`excluded.issued_at`,
        expires_at: sql`excluded.expires_at`,
        consumed_at: null,
      }),
    )
    .execute()
}

export async function getSetupToken(
  db: Kysely<Database>,
  tokenHash: string,
): Promise<SetupTokenRow | undefined> {
  return db
    .selectFrom('setup_tokens')
    .select((eb) => [
      eb.ref('vault_id').as('vaultId'),
      eb.ref('issued_at').as('issuedAt'),
      eb.ref('expires_at').as('expiresAt'),
      eb.ref('consumed_at').as('consumedAt'),
    ])
    .where('token_hash', '=', tokenHash)
    .executeTakeFirst()
}

export async function consumeSetupToken(
  db: Kysely<Database>,
  tokenHash: string,
  consumedAt: number,
): Promise<void> {
  await db
    .updateTable('setup_tokens')
    .set({ consumed_at: consumedAt })
    .where('token_hash', '=', tokenHash)
    .execute()
}
