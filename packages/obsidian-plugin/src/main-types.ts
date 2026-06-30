import type { SetupExchangeResponse, DocId } from '@kuroflare/core'
import type { IndexeddbPersistence } from 'y-indexeddb'
import type * as Y from 'yjs'

export interface KuroflareSettings {
  readonly endpoint: string
  readonly setupVaultId: string
  readonly setupToken: string
  readonly requestedDeviceName: string
  readonly setupBootstrapMode: 'new-vault' | 'join-existing'
  readonly setupResponse?: SetupExchangeResponse | undefined
  readonly accessToken?: string | undefined
  readonly refreshToken?: string | undefined
}

export type FileDocId = Extract<DocId, { readonly kind: 'file' }>

export interface LoadedTextDoc {
  readonly docId: FileDocId
  readonly doc: Y.Doc
  readonly text: Y.Text
  persistence: IndexeddbPersistence | null
}
