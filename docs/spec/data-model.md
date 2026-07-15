# データモデル

[← 設計書トップ](../../spec.md)

## 1. ファイル ID

各ファイルに**衝突耐性のある opaque ID**（fileId、生成は UUID v4）を付与する。
パス文字列をキーにしない。
リネームが「削除 + 作成」に化けて事故るのを防ぐ、最重要のポイントである。

`FileIdSchema` は UUID 形式を要求しない汎用 ID パターンで検証する。
生成箇所は `crypto.randomUUID()` に統一するが、これは呼び出し規約であって trust boundary の保証ではない。
conflict rename（[sync-model.md](sync-model.md) §6）は fileId の先頭 8 文字を suffix に使うため、低エントロピー ID が混入すると suffix が衝突しやすくなるが、その場合も `-2, -3...` の採番が一意性を担保する。

## 2. Meta YDoc (file tree)

The metadata document is a root `Y.Map` keyed by the stable `fileId`. Each root value is
an integrated child `Y.Map` with four independently mergeable plain-object groups:

```
fileId -> Y.Map {
  identity: {
    schemaVersion: 2
    fileId: string
    type: "text" | "binary"
    ydocId?: string       // required for text
    createdAt: number
    createdBy: string
  }
  location: {
    path: string
    canonicalPath: string
    updatedAt: number
    updatedBy: string
    mtime: number
  }
  content: {
    contentUpdatedAt: number
    contentUpdatedBy: string
    blobManifestHash?: string // required for binary
    blobChunks?: string[]     // required for binary
  }
  deletion: {
    deleted: boolean
    deletedAt?: number
    deletedBy?: string
    deletedContentVersion?: {
      kind: "text"
      stateVectorBase64: string
      contentSha256: string
    } | {
      kind: "binary"
      blobManifestHash: string
    }
  }
}
```

`path` and `canonicalPath` are one location group, and the binary manifest hash and
chunk list are one content group. A rename therefore cannot erase a concurrent binary
publication, and a tombstone cannot remove the location or content evidence. Identity
is immutable after creation. Downstream planners use a validated normalized `MetaFile`
view; they never write that flattened view back to the root map.

Validation is strict (`core/src/sync/meta.ts`): file IDs must match the root key,
paths must be vault-relative, canonical paths must equal `canonicalizeVaultPath(path)`,
text entries require `ydocId` and forbid blob fields, binary entries require a valid
manifest hash and at least one chunk and forbid `ydocId`, and an active entry cannot
carry deletion evidence. A v2 deleted entry requires a witness whose `kind` matches
the identity type. Legacy v1 deleted entries remain read-only for manual recovery
regardless of whether an optional witness-shaped field is present. A deleted entry
remains a tombstone; its body YDoc or blob manifest is not removed
([sync-model.md](sync-model.md) §4).
Grouped v2 tombstones written before the DR-006 witness contract are invalid and
remain read-only; this release does not add a v3 compatibility path.

Version-1 flat entries remain readable through the normalized decoder, but are
read-only. After Hello grants metadata write access, a local document containing
only valid v1 entries is merged with the authoritative latest server snapshot while
both are still v1, migrated to fresh grouped child maps, and committed through a
latest-sequence snapshot-import CAS. A stale CAS retry rebuilds from the newly fetched
authoritative snapshot while it is still v1. If the authoritative snapshot is already
v2, it is adopted only when every local normalized entry is represented unchanged;
otherwise the local document is retained and downgraded to read-only for explicit
repair. Metadata writes remain disabled until this transition succeeds.
Unknown versions, mixed v1/v2 documents, detached child maps, invalid groups, and
identity changes fail closed. A client that does not advertise `metadata-schema-v2`
may continue file-YDoc synchronization, but metadata writes are rejected without
acknowledgement, broadcast, SQL, or R2 mutation. Snapshot imports must carry explicit
`metadataSchemaVersion: 2` evidence.

When a non-empty remote v2 snapshot diverges from local metadata, the client keeps
the local IndexedDB/Yjs state, switches metadata to read-only, and displays a
manual-repair notice. Invalid local values are recorded for inspection without
rewriting them; an explicit discard requires write access and the exact confirmation
phrase, then synchronizes the resulting metadata document as a whole.

Metadata updates already persisted in the local outbox are schema-gated as well. A
flat-v1 metadata update or metadata reference update is never sent after the local
write gate opens; when conversion cannot preserve its dependency history, the row is
paused with `metadata-schema-v2-migration-required` for manual repair while file and
blob work continues.

## 3. 本文 YDoc（テキスト）

**ファイルごとに別 YDoc**（= 別の論理ルーム）を持ち、ファイルツリー用に 1 つのメタ YDoc を置く。
各 `.md` を `Y.Text` にマッピングする。

粒度をファイル単位にする理由は、巨大 Vault を 1 ドキュメントにすると起動と差分計算が重くなるからである。
ファイル単位なら開いているファイルだけをアクティブ同期し、他は遅延ロードでき、スナップショットの粒度も細かくできる。

ファイル間の操作はこの粒度で場合分けできる。

- **ファイル丸ごとの移動やリネーム**：完全にクリーン。メタ YMap の `fileId → path` 書き換えだけで済む。
- **段落を別ファイルへカット & ペースト**：2 つの独立 op になり CRDT の単一トランザクション保証の外に出る。並行編集と重なると重複しうるが、消失ではなく重複であり、片方消せば直る。「迷ったら両方残す」に一致するので特別な機構は設けない。

## 4. バイナリ（CDC チャンクと manifest）

ファイル内容を content-defined chunking で分割し、各チャンクを R2 に保存する。
ファイルは「チャンクハッシュのリスト」（§2 の `blobChunks`）として表現する。
チャンクは**不変**で、一度書かれたら中身が変わらない。
大ファイルの 1 箇所変更で変わったチャンクだけを転送でき、ファイル間でも共通チャンクを自動共有できる。

`blobChunks` だけでは復旧時の検証情報が薄いので、binary file には manifest を持たせる。

```
type BlobManifest = {
  version: 1;
  fileId: string;
  contentSha256: string;
  size: number;
  chunks: Array<{ sha256: string; offset: number; size: number }>;
  createdBy: string;
  createdAt: number;
};
```

manifest の検証規則:

| 対象            | 規則                                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fileId          | branded `FileId`。meta 側と一致させる                                                                                                                                                 |
| hash            | `contentSha256` と各 chunk `sha256` は lowercase SHA-256 hex のみ                                                                                                                     |
| chunks          | `offset=0` から隙間なく並び、size は正の safe integer、合計が manifest `size` と一致。`size=0` は `chunks=[]` のみ                                                                    |
| canonical bytes | field order `version,fileId,contentSha256,size,chunks,createdBy,createdAt`（chunk は `sha256,offset,size`）、whitespace なしの UTF-8 JSON。`blobManifestHash` はこの bytes の SHA-256 |
| meta との一致   | `blobManifestMatchesMetaFile` が fileId と `blobChunks` fast path の一致を確認。hash と body の一致は body bytes を持つ側（Worker / plugin）が検証                                    |

メタ YDoc には `blobManifestHash`（完全性検証と将来拡張）と `blobChunks`（materialize の fast path）の両方を置く。

R2 オブジェクトの命名:

```
vaults/<vaultId>/blobs/<chunk_sha256>
vaults/<vaultId>/blob-manifests/<manifest_sha256>.json
```

blob と manifest の key には vault prefix を必ず含める。
content-addressed hash は object 同一性の検証には使うが、authorization boundary には使わない。
cross-vault dedup を R2 key で直接やると、hash を知っている別 vault が plaintext blob を読めてしまうため、初期実装では vault 間 dedup は捨てる。
manifest は content-addressed で不変化し、メタ YDoc は hash を参照するだけにして manifest 本文を Yjs に入れない。

CDC パラメータの初期値: 平均 256 KiB、最小 64 KiB、最大 1 MiB。8 MiB 未満のファイルは固定 1 chunk でもよい。
Obsidian の添付は画像や PDF が多く、極端な差分効率より実装の単純さと R2 request 数を優先する。

chunking パラメータの変更は wire 互換を壊さない。
manifest が chunk の offset / size / sha256 を明示列挙する自己記述形式なので、読み込み側はパラメータを知らずに再組み立てでき、新旧の chunk は同じ bucket に混在してよい。
ただし境界が変わると既存 chunk との重複排除が効かなくなるため、既定値の変更は storage コスト増を伴う運用判断として扱う。

> 実装ノート: 現行 chunker（`core/src/sync/manifest.ts` の `chunkBytes`）は累積 hash 境界の MVP 用決定論的実装で、FastCDC のような rolling hash ではない（前方挿入に弱い）。検証形式は FastCDC へ差し替え可能な境界に閉じ込めてある。

## 5. path 正規化

- path separator は `/`。
- `.obsidian`、`.trash`、`.git`、plugin cache は default ignore。
- 大文字小文字の衝突条件は OS で違うため、`canonicalPath` を conflict detection に使い、実表示 path は保持する。

`canonicalizeVaultPath(path)` の定義:

1. Unicode の **NFC 正規化**。macOS は NFD でパスを返すため、これを前提にしないと端末間で同一ファイルの canonicalPath が食い違う。
2. 連続する `/` を 1 個に圧縮。
3. locale 非依存の `toLowerCase()`（Turkish `I` 問題を避けるため locale-aware 変換は使わない）。

trailing slash、パス長上限、Windows 予約語（`CON`, `NUL` 等）は正規化規則ではなく materialize 時に OS 別に検証する。
検証不能な path は conflict copy と同じ退避（別名で書き込み、repair log に記録）に倒す。

## 6. Local document epochs

The local-store `metadata` object store carries one epoch record per logical meta/file
document; no schema-version bump is required. An epoch record is independent from the
periodic whole-YDoc base and contains `docId`, provider database name, opaque epoch ID,
`recovering`/`ready` status, timestamps, base hash/state-vector evidence, and remote
cursor evidence. Epoch IDs are generated afresh for each recovery and are not sent on
the wire or used as authenticated authorship.

Provider loss is classified from non-creating directory evidence plus local YDoc/outbox
evidence. Recovery preserves every retained pending/paused/in-flight update row, merges
it idempotently with the authoritative remote snapshot and local base, and marks only
the exact included rows complete in the final atomic local-store transaction. Missing or
malformed dependency evidence blocks the affected document rather than dropping data.
