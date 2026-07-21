import * as v from 'valibot'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export const KuroflareIdSchema = v.pipe(
  v.string(),
  v.regex(ID_PATTERN, 'Invalid Kuroflare ID format'),
)

export const VaultIdSchema = v.pipe(KuroflareIdSchema, v.brand('VaultId'))
export type VaultId = v.InferInput<typeof VaultIdSchema>

export const DeviceIdSchema = v.pipe(KuroflareIdSchema, v.brand('DeviceId'))
export type DeviceId = v.InferInput<typeof DeviceIdSchema>

export const MessageIdSchema = v.pipe(KuroflareIdSchema, v.brand('MessageId'))
export type MessageId = v.InferInput<typeof MessageIdSchema>

export const FileIdSchema = v.pipe(KuroflareIdSchema, v.brand('FileId'))
export type FileId = v.InferInput<typeof FileIdSchema>

export const YDocIdSchema = v.pipe(KuroflareIdSchema, v.brand('YDocId'))
export type YDocId = v.InferInput<typeof YDocIdSchema>

export const MetaDocIdSchema = v.object({ kind: v.literal('meta') })
export const FileDocIdSchema = v.object({ kind: v.literal('file'), ydocId: YDocIdSchema })
export const DocIdSchema = v.variant('kind', [MetaDocIdSchema, FileDocIdSchema])

export type DocId = v.InferInput<typeof DocIdSchema>

export function makeVaultId(value: string): VaultId {
  return v.parse(VaultIdSchema, value)
}

export function makeDeviceId(value: string): DeviceId {
  return v.parse(DeviceIdSchema, value)
}

export function makeMessageId(value: string): MessageId {
  return v.parse(MessageIdSchema, value)
}

export function makeFileId(value: string): FileId {
  return v.parse(FileIdSchema, value)
}

export function makeYDocId(value: string): YDocId {
  return v.parse(YDocIdSchema, value)
}
