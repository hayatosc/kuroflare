# データモデル

[← 設計書トップ](../../spec.md)

## 1. ファイル ID

各ファイルに**衝突耐性のある opaque ID**（fileId、生成は UUID v4）を付与する。
パス文字列をキーにしない。
リネームが「削除 + 作成」に化けて事故るのを防ぐ、最重要のポイントである。

`FileIdSchema` は UUID 形式を要求しない汎用 ID パターンで検証する。
生成箇所は `crypto.randomUUID()` に統一するが、これは呼び出し規約であって trust boundary の保証ではない。
conflict rename（[sync-model.md](sync-model.md) §6）は fileId の先頭 8 文字を suffix に使うため、低エントロピー ID が混入すると suffix が衝突しやすくなるが、その場合も `-2, -3...` の採番が一意性を担保する。

## 2. メタ YDoc（ファイルツリー）

Yjs の `Y.Map` で全ファイルのメタデータを管理し、DO で収束させる。

```
fileId → {
  schemaVersion: 1
  path:       string        // 現在のパス。リネームはこのフィールド更新
  canonicalPath: string     // §5 の正規化。衝突検出用
  type:       "text" | "binary"
  ydocId?:    string        // type=text のとき、本文 YDoc の識別子
  blobManifestHash?: string // type=binary のとき、manifest の content hash
  blobChunks?: string[]     // type=binary の fast path。manifest と一致必須
  deleted:    boolean       // 削除は tombstone（即物理削除しない）
  deletedAt?: number
  deletedBy?: string
  createdAt / createdBy / contentUpdatedAt / contentUpdatedBy
  updatedAt / updatedBy     // updatedBy は deviceId
  mtime:      number
}
```

正規化した `MetaFile` 型は `type` を判別子とする discriminated union で、text entry は blob 系フィールドを持てず、binary entry は `ydocId` を持てない。

検証規則（`core/src/sync/meta.ts` の schema guard）:

| 対象           | 規則                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------- |
| fileId         | branded `FileId`。YMap key と値の両方が一致する場合だけ valid                                      |
| path           | Vault 相対のみ。絶対パス、`\`、NUL、`.` / `..` segment、`.obsidian` 配下を拒否                     |
| canonicalPath  | `canonicalizeVaultPath(path)` と一致必須。手入力値を信用しない                                     |
| text entry     | `ydocId` 必須。blob 系フィールドを持てば拒否                                                       |
| binary entry   | lowercase SHA-256 hex の `blobManifestHash` と 1 個以上の `blobChunks` 必須。`ydocId` を持てば拒否 |
| 削除メタデータ | `deleted=false` で `deletedAt` / `deletedBy` を持てば拒否                                          |

`deleted=true` でも本文 YDoc / blob manifest は即消さない（[sync-model.md](sync-model.md) §4）。
schema validation に失敗した meta update は quarantine し（[server.md](server.md) §3）、通常の materialize へ進めない。

**schemaVersion の移行**：現状 `1` 固定で、version 2 以降を受け付ける経路が無い。
version を導入する場合は次の 2 点を先に決めておく。

- 旧 client は未知の `schemaVersion` を持つ entry を quarantine ではなく read-only 扱いにする。書き込み対象からは外すが、同期対象からは外さず、削除も上書きもしない。
- 新フィールドの追加は同一 version 内で optional として行う。bump は不変条件（必須フィールドの増減、型の意味変更）が変わる時だけに限る。

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
