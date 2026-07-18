import type {
  DurableObjectStateBinding,
  DurableObjectStorageBinding,
  R2BucketBinding,
  R2ListOptionsBinding,
  R2MultipartUploadBinding,
  R2ObjectBodyBinding,
  R2ObjectsBinding,
  R2UploadedPartBinding,
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

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key)
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

/** In-memory R2 multipart upload session backing `FakeR2Bucket`. */
export class FakeR2MultipartUpload implements R2MultipartUploadBinding {
  constructor(
    private readonly bucket: FakeR2Bucket,
    private readonly key: string,
    readonly uploadId: string,
  ) {}

  async uploadPart(partNumber: number, value: Uint8Array): Promise<R2UploadedPartBinding> {
    return this.bucket.recordUploadedPart(this.uploadId, partNumber, value)
  }

  async complete(uploadedParts: readonly R2UploadedPartBinding[]): Promise<void> {
    this.bucket.completeMultipartUpload(this.key, this.uploadId, uploadedParts)
  }

  async abort(): Promise<void> {
    this.bucket.abortMultipartUpload(this.uploadId)
  }
}

export class FakeR2Bucket implements R2BucketBinding {
  readonly gets: string[] = []
  readonly heads: string[] = []
  readonly lists: string[] = []
  readonly puts: string[] = []
  readonly deletes: string[] = []
  beforeGet: ((key: string) => void | Promise<void>) | undefined
  beforePut: ((key: string, value: Uint8Array) => void | Promise<void>) | undefined
  listOverride:
    | ((options: R2ListOptionsBinding) => R2ObjectsBinding | Promise<R2ObjectsBinding>)
    | undefined
  listPageSize: number | undefined
  private readonly values = new Map<string, Uint8Array>()
  private readonly multipartUploads = new Map<string, Map<number, Uint8Array>>()
  private nextMultipartUploadId = 1

  set(key: string, bytes: Uint8Array): void {
    this.values.set(key, bytes)
  }

  async get(key: string): Promise<R2ObjectBodyBinding | null> {
    this.gets.push(key)
    await this.beforeGet?.(key)
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
    if (this.listOverride !== undefined) return this.listOverride(options)
    const keys = [...this.values.keys()].filter((key) => key.startsWith(options.prefix)).sort()
    const start = options.cursor === undefined ? 0 : Number(options.cursor)
    if (!Number.isSafeInteger(start) || start < 0 || start > keys.length) {
      throw new Error('invalid-list-cursor')
    }
    const pageSize =
      this.listPageSize === undefined ||
      !Number.isSafeInteger(this.listPageSize) ||
      this.listPageSize <= 0
        ? keys.length
        : this.listPageSize
    const end = Math.min(start + pageSize, keys.length)
    return {
      objects: keys.slice(start, end).map((key) => ({ key })),
      truncated: end < keys.length,
      ...(end < keys.length ? { cursor: String(end) } : {}),
    }
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.puts.push(key)
    await this.beforePut?.(key, value)
    this.values.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.deletes.push(key)
    this.values.delete(key)
  }

  async createMultipartUpload(key: string): Promise<R2MultipartUploadBinding> {
    const uploadId = `fake-upload-${this.nextMultipartUploadId}`
    this.nextMultipartUploadId += 1
    this.multipartUploads.set(uploadId, new Map())
    return new FakeR2MultipartUpload(this, key, uploadId)
  }

  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUploadBinding {
    return new FakeR2MultipartUpload(this, key, uploadId)
  }

  recordUploadedPart(
    uploadId: string,
    partNumber: number,
    value: Uint8Array,
  ): R2UploadedPartBinding {
    const parts = this.multipartUploads.get(uploadId)
    if (parts === undefined) throw new Error(`unknown multipart upload: ${uploadId}`)
    parts.set(partNumber, value)
    return { partNumber, etag: `etag-${uploadId}-${partNumber}` }
  }

  completeMultipartUpload(
    key: string,
    uploadId: string,
    uploadedParts: readonly R2UploadedPartBinding[],
  ): void {
    const parts = this.multipartUploads.get(uploadId)
    if (parts === undefined) throw new Error(`unknown multipart upload: ${uploadId}`)
    const orderedParts = [...uploadedParts].sort((left, right) => left.partNumber - right.partNumber)
    const partBytes: Uint8Array[] = []
    let totalLength = 0
    for (const part of orderedParts) {
      const bytes = parts.get(part.partNumber)
      if (bytes === undefined) throw new Error(`missing uploaded part: ${part.partNumber}`)
      partBytes.push(bytes)
      totalLength += bytes.byteLength
    }
    const combined = new Uint8Array(totalLength)
    let offset = 0
    for (const bytes of partBytes) {
      combined.set(bytes, offset)
      offset += bytes.byteLength
    }
    this.set(key, combined)
    this.multipartUploads.delete(uploadId)
  }

  abortMultipartUpload(uploadId: string): void {
    if (!this.multipartUploads.has(uploadId)) throw new Error(`unknown multipart upload: ${uploadId}`)
    this.multipartUploads.delete(uploadId)
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

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key)
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
      snapshotHealthEvents: [...this.sql.snapshotHealthEvents],
      setupTokens: new Map(this.sql.setupTokens),
      refreshTokens: new Map(this.sql.refreshTokens),
      blobMultipartUploads: new Map(this.sql.blobMultipartUploads),
      blobMultipartParts: new Map(this.sql.blobMultipartParts),
      devices: new Map(this.sql.devices),
      migrationVersions: new Set(this.sql.migrationVersions),
      messageDedupColumns: new Set(this.sql.messageDedupColumns),
      tableColumns: new Map(this.sql.tableColumns),
      tableRowCounts: new Map(this.sql.tableRowCounts),
      tableRows: new Map(this.sql.tableRows),
      tableColumnDetails: new Map(this.sql.tableColumnDetails),
      tableIndexes: new Map(this.sql.tableIndexes),
      tableForeignKeys: new Map(this.sql.tableForeignKeys),
    }
  }

  private restoreSql(snapshot: RecordingSqlSnapshot): void {
    replaceMap(this.sql.docs, snapshot.docs)
    replaceMap(this.sql.opLog, snapshot.opLog)
    replaceMap(this.sql.messageDedup, snapshot.messageDedup)
    replaceMap(this.sql.quarantines, snapshot.quarantines)
    replaceMap(this.sql.checkpointRuns, snapshot.checkpointRuns)
    this.sql.snapshotHealthEvents.splice(
      0,
      this.sql.snapshotHealthEvents.length,
      ...snapshot.snapshotHealthEvents,
    )
    replaceMap(this.sql.setupTokens, snapshot.setupTokens)
    replaceMap(this.sql.refreshTokens, snapshot.refreshTokens)
    replaceMap(this.sql.blobMultipartUploads, snapshot.blobMultipartUploads)
    replaceMap(this.sql.blobMultipartParts, snapshot.blobMultipartParts)
    replaceMap(this.sql.devices, snapshot.devices)
    replaceSet(this.sql.migrationVersions, snapshot.migrationVersions)
    replaceSet(this.sql.messageDedupColumns, snapshot.messageDedupColumns)
    replaceMap(this.sql.tableColumns, snapshot.tableColumns)
    replaceMap(this.sql.tableRowCounts, snapshot.tableRowCounts)
    replaceMap(this.sql.tableRows, snapshot.tableRows)
    replaceMap(this.sql.tableColumnDetails, snapshot.tableColumnDetails)
    replaceMap(this.sql.tableIndexes, snapshot.tableIndexes)
    replaceMap(this.sql.tableForeignKeys, snapshot.tableForeignKeys)
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
