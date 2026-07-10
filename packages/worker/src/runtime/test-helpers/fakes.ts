import type {
  DurableObjectStateBinding,
  DurableObjectStorageBinding,
  R2BucketBinding,
  R2ListOptionsBinding,
  R2ObjectBodyBinding,
  R2ObjectsBinding,
  RuntimeWebSocket,
} from '..'
import { RecordingSqlStorage, type RecordingSqlSnapshot } from './sql-storage'

export class FakeSocket implements RuntimeWebSocket {
  readonly sent: Array<string | ArrayBuffer> = []
  accepted = false
  closed = false
  closeCode: number | undefined
  closeReason: string | undefined
  private attachment: unknown

  accept(): void {
    this.accepted = true
  }

  send(message: string | ArrayBuffer): void {
    this.sent.push(message)
  }

  close(code?: number, reason?: string): void {
    this.closed = true
    this.closeCode = code
    this.closeReason = reason
  }

  serializeAttachment(attachment: unknown): void {
    this.attachment = attachment
  }

  deserializeAttachment(): unknown {
    return this.attachment
  }
}

export class FakeWebSocketPair {
  readonly 0 = new FakeSocket()
  readonly 1 = new FakeSocket()
}

export class FakeUpgradeResponse {
  readonly status: number
  readonly webSocket: RuntimeWebSocket | undefined

  constructor(_body: BodyInit | null, init?: ResponseInit & { webSocket?: RuntimeWebSocket }) {
    this.status = init?.status ?? 200
    this.webSocket = init?.webSocket
  }
}

export class MemoryStorage implements DurableObjectStorageBinding {
  readonly alarms: Array<number | Date> = []
  private readonly values = new Map<string, unknown>()

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value)
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarms.push(scheduledTime)
  }

  async transaction<T>(closure: () => T | Promise<T>): Promise<T> {
    return closure()
  }
}

export class FakeR2Object implements R2ObjectBodyBinding {
  constructor(private readonly bytes: Uint8Array) {}

  async arrayBuffer(): Promise<ArrayBuffer> {
    const buffer = new ArrayBuffer(this.bytes.byteLength)
    new Uint8Array(buffer).set(this.bytes)
    return buffer
  }
}

export class FakeR2Bucket implements R2BucketBinding {
  readonly gets: string[] = []
  readonly heads: string[] = []
  readonly lists: string[] = []
  readonly puts: string[] = []
  readonly deletes: string[] = []
  private readonly values = new Map<string, Uint8Array>()

  set(key: string, bytes: Uint8Array): void {
    this.values.set(key, bytes)
  }

  async get(key: string): Promise<R2ObjectBodyBinding | null> {
    this.gets.push(key)
    const bytes = this.values.get(key)
    return bytes === undefined ? null : new FakeR2Object(bytes)
  }

  async head(key: string): Promise<{ readonly size: number } | null> {
    this.heads.push(key)
    const bytes = this.values.get(key)
    return bytes === undefined ? null : { size: bytes.byteLength }
  }

  async list(options: R2ListOptionsBinding): Promise<R2ObjectsBinding> {
    this.lists.push(options.prefix)
    return {
      objects: [...this.values.keys()]
        .filter((key) => key.startsWith(options.prefix))
        .map((key) => ({ key })),
    }
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.puts.push(key)
    this.values.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.deletes.push(key)
    this.values.delete(key)
  }
}

export class SqlOnlyStorage implements DurableObjectStorageBinding {
  readonly sql = new RecordingSqlStorage()
  readonly alarms: Array<number | Date> = []
  private readonly values = new Map<string, unknown>()

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value)
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarms.push(scheduledTime)
  }

  async transaction<T>(closure: () => T | Promise<T>): Promise<T> {
    const snapshot = this.snapshotSql()
    this.sql.queries.push('transaction begin')
    try {
      const result = await closure()
      this.sql.queries.push('transaction commit')
      return result
    } catch (error) {
      this.restoreSql(snapshot)
      this.sql.queries.push('transaction rollback')
      throw error
    }
  }

  private snapshotSql(): RecordingSqlSnapshot {
    return {
      docs: new Map(this.sql.docs),
      opLog: new Map(this.sql.opLog),
      messageDedup: new Map(this.sql.messageDedup),
      quarantines: new Map(this.sql.quarantines),
      checkpointRuns: new Map(this.sql.checkpointRuns),
      setupTokens: new Map(this.sql.setupTokens),
      refreshTokens: new Map(this.sql.refreshTokens),
      devices: new Map(this.sql.devices),
      migrationVersions: new Set(this.sql.migrationVersions),
    }
  }

  private restoreSql(snapshot: RecordingSqlSnapshot): void {
    replaceMap(this.sql.docs, snapshot.docs)
    replaceMap(this.sql.opLog, snapshot.opLog)
    replaceMap(this.sql.messageDedup, snapshot.messageDedup)
    replaceMap(this.sql.quarantines, snapshot.quarantines)
    replaceMap(this.sql.checkpointRuns, snapshot.checkpointRuns)
    replaceMap(this.sql.setupTokens, snapshot.setupTokens)
    replaceMap(this.sql.refreshTokens, snapshot.refreshTokens)
    replaceMap(this.sql.devices, snapshot.devices)
    replaceSet(this.sql.migrationVersions, snapshot.migrationVersions)
  }
}

export function replaceMap<K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>): void {
  target.clear()
  for (const [key, value] of source) {
    target.set(key, value)
  }
}

export function replaceSet<T>(target: Set<T>, source: ReadonlySet<T>): void {
  target.clear()
  for (const value of source) {
    target.add(value)
  }
}

export class FakeState implements DurableObjectStateBinding {
  readonly accepted: RuntimeWebSocket[] = []

  constructor(readonly storage: DurableObjectStorageBinding = new MemoryStorage()) {}

  acceptWebSocket(webSocket: RuntimeWebSocket): void {
    webSocket.accept?.()
    this.accepted.push(webSocket)
  }

  getWebSockets(): readonly RuntimeWebSocket[] {
    return this.accepted
  }
}
