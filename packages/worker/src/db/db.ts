import { Kysely } from 'kysely'
import type { DurableObjectSqlStorageBinding } from '../runtime'
import { DurableObjectSqlDialect } from './adapter'
import type { Database } from './types'

let cachedDb: Kysely<Database> | undefined
let cachedSql: DurableObjectSqlStorageBinding | undefined

export function createDb(sql: DurableObjectSqlStorageBinding): Kysely<Database> {
  if (sql === cachedSql && cachedDb !== undefined) {
    return cachedDb
  }
  const dialect = new DurableObjectSqlDialect(sql)
  const db = new Kysely<Database>({ dialect })
  cachedDb = db
  cachedSql = sql
  return db
}
