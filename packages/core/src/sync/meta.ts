import * as v from 'valibot'

import { DeviceIdSchema, FileIdSchema, YDocIdSchema } from '../utils/ids'

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/
const FORBIDDEN_PATH_SEGMENTS = new Set(['', '.', '..'])

export const Sha256HexSchema = v.pipe(
  v.string(),
  v.regex(SHA256_HEX_PATTERN, 'Invalid SHA-256 hex digest'),
  v.brand('Sha256Hex'),
)

export type Sha256Hex = v.InferInput<typeof Sha256HexSchema>

export const VaultRelativePathSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.check((val) => {
    if (val.includes('\0') || val.includes('\\') || val.startsWith('/')) return false
    if (val.startsWith('.obsidian/') || val === '.obsidian') return false
    const segments = val.split('/')
    return segments.every((segment) => !FORBIDDEN_PATH_SEGMENTS.has(segment))
  }, 'Invalid vault relative path'),
)

export const TimestampSchema = v.pipe(v.number(), v.integer(), v.minValue(0))

export const MetaFileBaseSchema = v.object({
  schemaVersion: v.literal(1),
  fileId: FileIdSchema,
  path: VaultRelativePathSchema,
  canonicalPath: v.string(),
  createdAt: TimestampSchema,
  createdBy: DeviceIdSchema,
  contentUpdatedAt: TimestampSchema,
  contentUpdatedBy: DeviceIdSchema,
  updatedAt: TimestampSchema,
  updatedBy: DeviceIdSchema,
  mtime: TimestampSchema,
})

export const DeletedMetaFileSchema = v.object({
  deleted: v.literal(true),
  deletedAt: TimestampSchema,
  deletedBy: DeviceIdSchema,
})

export const ActiveMetaFileSchema = v.object({
  deleted: v.literal(false),
})

export const TextMetaFileSpecificSchema = v.object({
  type: v.literal('text'),
  ydocId: YDocIdSchema,
  blobManifestHash: v.optional(v.never()),
  blobChunks: v.optional(v.never()),
})

export const BinaryMetaFileSpecificSchema = v.object({
  type: v.literal('binary'),
  blobManifestHash: Sha256HexSchema,
  blobChunks: v.pipe(v.array(Sha256HexSchema), v.minLength(1)),
  ydocId: v.optional(v.never()),
})

export const TextMetaFileSchema = v.intersect([
  MetaFileBaseSchema,
  v.union([DeletedMetaFileSchema, ActiveMetaFileSchema]),
  TextMetaFileSpecificSchema,
])

export const BinaryMetaFileSchema = v.intersect([
  MetaFileBaseSchema,
  v.union([DeletedMetaFileSchema, ActiveMetaFileSchema]),
  BinaryMetaFileSpecificSchema,
])

export const MetaFileSchema = v.pipe(
  v.union([TextMetaFileSchema, BinaryMetaFileSchema]),
  v.check(
    (val) => val.canonicalPath === canonicalizeVaultPath(val.path),
    'Canonical path mismatch',
  ),
)

export type TextMetaFile = v.InferInput<typeof TextMetaFileSchema>
export type BinaryMetaFile = v.InferInput<typeof BinaryMetaFileSchema>
export type MetaFile = v.InferInput<typeof MetaFileSchema>

/** Immutable identity group for a schema-version 2 metadata entry. */
export const MetaIdentitySchema = v.strictObject({
  schemaVersion: v.literal(2),
  fileId: FileIdSchema,
  type: v.union([v.literal('text'), v.literal('binary')]),
  ydocId: v.optional(YDocIdSchema),
  createdAt: TimestampSchema,
  createdBy: DeviceIdSchema,
})

/** Location group kept atomic so path and its canonical form cannot diverge. */
export const MetaLocationSchema = v.pipe(
  v.strictObject({
    path: VaultRelativePathSchema,
    canonicalPath: v.string(),
    updatedAt: TimestampSchema,
    updatedBy: DeviceIdSchema,
    mtime: TimestampSchema,
  }),
  v.check(
    (value) => value.canonicalPath === canonicalizeVaultPath(value.path),
    'Canonical path mismatch',
  ),
)

const TextMetaContentSchema = v.strictObject({
  contentUpdatedAt: TimestampSchema,
  contentUpdatedBy: DeviceIdSchema,
  blobManifestHash: v.optional(v.never()),
  blobChunks: v.optional(v.never()),
})

const BinaryMetaContentSchema = v.strictObject({
  contentUpdatedAt: TimestampSchema,
  contentUpdatedBy: DeviceIdSchema,
  blobManifestHash: Sha256HexSchema,
  blobChunks: v.pipe(v.array(Sha256HexSchema), v.minLength(1)),
})

/** Content group with binary manifest and chunk references kept as one object. */
export const MetaContentSchema = v.union([TextMetaContentSchema, BinaryMetaContentSchema])

/** Tombstone group. A live entry cannot carry deletion evidence. */
export const MetaDeletionSchema = v.union([
  v.strictObject({
    deleted: v.literal(false),
    deletedAt: v.optional(v.never()),
    deletedBy: v.optional(v.never()),
  }),
  v.strictObject({
    deleted: v.literal(true),
    deletedAt: TimestampSchema,
    deletedBy: DeviceIdSchema,
  }),
])

/** Grouped schema-version 2 entry before it is decoded to the normalized MetaFile view. */
export const MetaGroupedEntrySchema = v.pipe(
  v.strictObject({
    identity: MetaIdentitySchema,
    location: MetaLocationSchema,
    content: MetaContentSchema,
    deletion: MetaDeletionSchema,
  }),
  v.check((value) => {
    if (value.identity.type === 'text') {
      return (
        value.identity.ydocId !== undefined &&
        value.content.blobManifestHash === undefined &&
        value.content.blobChunks === undefined
      )
    }
    return (
      value.identity.ydocId === undefined &&
      value.content.blobManifestHash !== undefined &&
      value.content.blobChunks !== undefined
    )
  }, 'Identity and content type mismatch'),
)

export type MetaIdentity = v.InferInput<typeof MetaIdentitySchema>
export type MetaLocation = v.InferInput<typeof MetaLocationSchema>
export type MetaContent = v.InferInput<typeof MetaContentSchema>
export type MetaDeletion = v.InferInput<typeof MetaDeletionSchema>
export type MetaGroupedEntry = v.InferInput<typeof MetaGroupedEntrySchema>

export type MetaValueDisposition = 'supported-v2' | 'legacy-v1' | 'unsupported' | 'invalid'

export interface DecodedMetaValue {
  readonly disposition: MetaValueDisposition
  readonly fileId: string | undefined
  readonly metaFile: MetaFile | undefined
  readonly grouped: MetaGroupedEntry | undefined
  readonly reason?: string
}

/** Converts a grouped entry to the normalized legacy-shaped view used by planners and materializers. */
export function metaFileFromGroupedEntry(value: MetaGroupedEntry): MetaFile {
  const { identity, location, content, deletion } = value
  const common = {
    schemaVersion: 1 as const,
    fileId: identity.fileId,
    path: location.path,
    canonicalPath: location.canonicalPath,
    createdAt: identity.createdAt,
    createdBy: identity.createdBy,
    contentUpdatedAt: content.contentUpdatedAt,
    contentUpdatedBy: content.contentUpdatedBy,
    updatedAt: location.updatedAt,
    updatedBy: location.updatedBy,
    mtime: location.mtime,
    ...(deletion.deleted
      ? { deleted: true as const, deletedAt: deletion.deletedAt, deletedBy: deletion.deletedBy }
      : { deleted: false as const }),
  }
  if (
    identity.type === 'text' &&
    identity.ydocId !== undefined &&
    content.blobManifestHash === undefined
  ) {
    return { ...common, type: 'text', ydocId: identity.ydocId }
  }
  if (
    identity.type === 'binary' &&
    content.blobManifestHash !== undefined &&
    content.blobChunks !== undefined
  ) {
    return {
      ...common,
      type: 'binary',
      blobManifestHash: content.blobManifestHash,
      blobChunks: content.blobChunks,
    }
  }
  throw new Error('invalid-grouped-entry')
}

/** Builds fresh plain group objects for insertion into a new nested Y.Map. */
export function groupedEntryFromMetaFile(value: MetaFile): MetaGroupedEntry {
  const identity = {
    schemaVersion: 2 as const,
    fileId: value.fileId,
    type: value.type,
    ...(value.ydocId === undefined ? {} : { ydocId: value.ydocId }),
    createdAt: value.createdAt,
    createdBy: value.createdBy,
  }
  const location = {
    path: value.path,
    canonicalPath: value.canonicalPath,
    updatedAt: value.updatedAt,
    updatedBy: value.updatedBy,
    mtime: value.mtime,
  }
  const deletion = value.deleted
    ? { deleted: true as const, deletedAt: value.deletedAt, deletedBy: value.deletedBy }
    : { deleted: false as const }
  const content =
    value.type === 'text'
      ? { contentUpdatedAt: value.contentUpdatedAt, contentUpdatedBy: value.contentUpdatedBy }
      : {
          contentUpdatedAt: value.contentUpdatedAt,
          contentUpdatedBy: value.contentUpdatedBy,
          blobManifestHash: value.blobManifestHash,
          blobChunks: value.blobChunks,
        }
  return v.parse(MetaGroupedEntrySchema, { identity, location, content, deletion })
}

function isMapLike(
  value: unknown,
): value is { readonly entries: () => Iterable<[unknown, unknown]> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'entries' in value &&
    typeof (value as { entries?: unknown }).entries === 'function'
  )
}

function isDetachedMap(value: unknown): boolean {
  if (!isMapLike(value) || !('doc' in value)) return true
  return (value as { readonly doc?: unknown }).doc == null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Decodes one root value and preserves a four-way disposition for compatibility handling. */
export function decodeMetaValue(value: unknown, expectedFileId?: string): DecodedMetaValue {
  if (isMapLike(value)) {
    if (isDetachedMap(value)) {
      return {
        disposition: 'invalid',
        fileId: expectedFileId,
        metaFile: undefined,
        grouped: undefined,
        reason: 'detached-grouped-entry',
      }
    }
    const entries = Object.fromEntries(value.entries())
    if (!isRecord(entries) || Object.keys(entries).length !== 4) {
      return {
        disposition: 'invalid',
        fileId: expectedFileId,
        metaFile: undefined,
        grouped: undefined,
      }
    }
    if (Object.values(entries).some((group) => isMapLike(group))) {
      return {
        disposition: 'invalid',
        fileId: expectedFileId,
        metaFile: undefined,
        grouped: undefined,
        reason: 'group-values-must-be-plain-objects',
      }
    }
    const parsed = v.safeParse(MetaGroupedEntrySchema, entries)
    if (!parsed.success) {
      const identity = isRecord(entries.identity) ? entries.identity : undefined
      const version = identity?.schemaVersion
      return {
        disposition: version !== undefined && version !== 2 ? 'unsupported' : 'invalid',
        fileId: expectedFileId,
        metaFile: undefined,
        grouped: undefined,
        reason: 'invalid-grouped-entry',
      }
    }
    if (expectedFileId !== undefined && parsed.output.identity.fileId !== expectedFileId) {
      return {
        disposition: 'invalid',
        fileId: parsed.output.identity.fileId,
        metaFile: undefined,
        grouped: undefined,
        reason: 'file-id-mismatch',
      }
    }
    return {
      disposition: 'supported-v2',
      fileId: parsed.output.identity.fileId,
      grouped: parsed.output,
      metaFile: metaFileFromGroupedEntry(parsed.output),
    }
  }

  if (v.is(MetaFileSchema, value)) {
    if (expectedFileId !== undefined && value.fileId !== expectedFileId) {
      return {
        disposition: 'invalid',
        fileId: value.fileId,
        metaFile: undefined,
        grouped: undefined,
      }
    }
    return { disposition: 'legacy-v1', fileId: value.fileId, metaFile: value, grouped: undefined }
  }

  const version = isRecord(value) ? value.schemaVersion : undefined
  if (typeof version === 'number' && version !== 1) {
    return {
      disposition: 'unsupported',
      fileId: expectedFileId,
      metaFile: undefined,
      grouped: undefined,
    }
  }
  return { disposition: 'invalid', fileId: expectedFileId, metaFile: undefined, grouped: undefined }
}

/**
 * Checks a meta YMap value and verifies that its key matches the embedded file ID.
 *
 * @param value Candidate value read from the meta YDoc map.
 * @param expectedFileId File ID from the YMap key that addressed the value.
 * @returns True when the value is a valid meta file for the expected key.
 */
export function isMetaFile(
  value: unknown,
  expectedFileId: v.InferInput<typeof FileIdSchema>,
): value is MetaFile {
  // Keep this guard's historical contract: callers may safely narrow only a plain v1 object.
  // Grouped Y.Map roots must be decoded explicitly because the runtime value is not MetaFile-shaped.
  if (isMapLike(value)) return false
  return v.is(MetaFileSchema, value) && value.fileId === expectedFileId
}

/**
 * Canonicalizes a vault path for deterministic path conflict detection.
 *
 * @param path Vault-relative path.
 * @returns NFC-normalized lower-case path with repeated separators collapsed.
 */
export function canonicalizeVaultPath(path: string): string {
  return path.normalize('NFC').replace(/\/+/g, '/').toLowerCase()
}

/**
 * Parses a SHA-256 hex digest into the protocol branded type.
 *
 * @param value Candidate lower-case hexadecimal digest.
 * @returns Guarded SHA-256 digest.
 * @throws When the value is not exactly 64 lower-case hexadecimal characters.
 */
export function makeSha256Hex(value: string): Sha256Hex {
  return v.parse(Sha256HexSchema, value)
}
