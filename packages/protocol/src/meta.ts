import * as v from 'valibot'

import { DeviceIdSchema, FileIdSchema, YDocIdSchema } from './ids.js'

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
