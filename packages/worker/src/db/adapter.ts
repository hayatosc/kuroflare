import {
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type Kysely,
  type QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from 'kysely'

import type { DurableObjectSqlStorageBinding } from '../runtime'

class DurableObjectSqlConnection implements DatabaseConnection {
  constructor(private readonly sql: DurableObjectSqlStorageBinding) {}

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    return this.#rawQuery(compiledQuery)
  }

  async *streamQuery<R>(compiledQuery: CompiledQuery): AsyncIterableIterator<QueryResult<R>> {
    yield await this.executeQuery<R>(compiledQuery)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async #rawQuery(compiledQuery: CompiledQuery): Promise<QueryResult<any>> {
    const rows = [...this.sql.exec(compiledQuery.sql, ...compiledQuery.parameters)]
    return { rows }
  }
}

class DurableObjectSqlDriver implements Driver {
  private connection: DurableObjectSqlConnection | undefined

  constructor(private readonly sql: DurableObjectSqlStorageBinding) {}

  async acquireConnection(): Promise<DatabaseConnection> {
    if (this.connection === undefined) {
      this.connection = new DurableObjectSqlConnection(this.sql)
    }
    return this.connection
  }

  async beginTransaction(_connection: DatabaseConnection): Promise<void> {
    // Durable Object SQL transactions must go through state.storage.transaction().
  }

  async commitTransaction(_connection: DatabaseConnection): Promise<void> {}

  async rollbackTransaction(_connection: DatabaseConnection): Promise<void> {}

  async releaseConnection(_connection: DatabaseConnection): Promise<void> {}

  async destroy(): Promise<void> {
    this.connection = undefined
  }

  async init(): Promise<void> {}
}

export class DurableObjectSqlDialect implements Dialect {
  readonly #driver: DurableObjectSqlDriver

  constructor(sql: DurableObjectSqlStorageBinding) {
    this.#driver = new DurableObjectSqlDriver(sql)
  }

  createDriver(): Driver {
    return this.#driver
  }

  createQueryCompiler(): SqliteQueryCompiler {
    return new SqliteQueryCompiler()
  }

  createAdapter(): SqliteAdapter {
    return new SqliteAdapter()
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createIntrospector(db: Kysely<any>): SqliteIntrospector {
    return new SqliteIntrospector(db)
  }
}
