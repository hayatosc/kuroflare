# Obsidian 同期プラグイン 設計書

Cloudflare エコシステムで完結する、CRDT ベースの Obsidian Vault 同期プラグイン。
remotely-save の「同期失敗 → ロールバック（データ消失）」を、**自己修復（self-healing）型同期**で原理的に置き換えることを目的とする。

---

## 0. 設計の前提と確定事項

| 項目           | 決定                                | 理由                                                                                                           |
| -------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| デプロイ形態   | 個人が自分でデプロイ                | 自分の複数端末での利用が主                                                                                     |
| E2EE           | **採用しない**                      | サーバー（DO）が plaintext の Yjs を読めることで、マージ・スナップショット生成・運用コマンドが大幅に単純化する |
| テキストマージ | **Yjs（真の文字単位 CRDT）を死守**  | 「同じ段落を同時編集しても壊れない」を自動で満たす。これが LiveSync 等に対する最大の差別化点                   |
| バイナリ       | content-defined chunking (CDC) + R2 | 大ファイルの差分転送と重複排除                                                                                 |
| 真実の所在     | **R2（source of truth）**           | DO はいつ揮発してもよい再構成可能なキャッシュとして扱う                                                        |

### 設計の根本思想

> **跨ぎ書き込みを原子化しようと頑張らない。**
> 原子化できない継ぎ目があることを認め、(1) 順序で部分失敗を無害な方向に倒し、(2) 操作を冪等にして何度でも再実行でき、(3) ハッシュ突合の reconciliation で起動時に必ず修復する。
> 完璧な「防止」ではなく **自己修復** を設計する。最悪でも「一瞬古い状態が見える → すぐ収束」に落とし、「データが消える」を起こさない。

---

## 1. アーキテクチャ全体像

```
クライアント（Obsidian Plugin）
  ├ アクティブファイル: CodeMirror6 ⇄ Yjs バインディング
  │     （エコーループは debounce + ハッシュゲートで遮断）
  ├ 非アクティブ: Vault watcher ⇄ Yjs（同上）
  ├ y-indexeddb: ローカル永続（state vector を保持 → 再起動後も差分同期）
  └ Vault API: ファイルツリー操作の検知・反映
       │
       │  WebSocket（Yjs update / awareness）
       │  HTTP（blob chunk upload/download, manifest 交換）
       ▼
Cloudflare Worker（Hono）
  ── 認証（JWT）/ ルーティング / presigned URL 発行
       │
       ├─▶ Durable Object: VaultRoom（vaultId 単位で 1 インスタンス）
       │      役割 = 「順序付き耐久 update ログ + スナップショット生成」
       │      ├ メモリ上に Yjs ドキュメント（揮発してよい）
       │      ├ WebSocket Hibernation で接続維持（アイドル時は課金抑制）
       │      ├ SQLite Storage（10GB/obj）に update ログ & メタデータ
       │      ├ 定期 + しきい値 + Hibernation 前に R2 へ checkpoint
       │      └ メタ YDoc（fileId ↔ path / blobChunks / tombstone）も収束
       │
       └─▶ R2（source of truth）
              ├ snapshots/<vaultId>/<fileId>/<seq>   … Yjs スナップショット
              └ blobs/<chunk_sha256>                 … CDC チャンク（重複排除）
```

### Cloudflare コンポーネントの役割

- **Worker (Hono)**: ステートレスな API 層。認証、ルーティング、R2 への presigned URL 発行。
- **Durable Object (VaultRoom)**: vaultId ごとに必ず 1 インスタンスへルーティングされる。これにより Yjs の「単一の収束点」を持てる。SQLite-backed DO は 10GB/obj で GA 済み。
- **R2**: 不変の最終真実。スナップショットとバイナリチャンクを保管。

> **DO は「マージ機」である必要はない。** Yjs の update は CRDT op（可換・冪等）なので、DO は update を順序付きで追記保存し、新規参加者へ流すだけでよい。実マージは各クライアントの `Y.applyUpdate` が行う（y-websocket の発想）。非 E2EE なので DO 自身も plaintext を読んでマージ・スナップショット生成ができ、運用コマンドが楽になる。

---

## 2. 二層構造：テキストとバイナリを同じ仕組みで同期しない

**最重要の設計判断。** 文字単位 CRDT は大きなバイナリに全く向かない。層を分ける。

| 対象                                       | 同期方式                                | 衝突解決                                         |
| ------------------------------------------ | --------------------------------------- | ------------------------------------------------ |
| `.md` 本文                                 | **Yjs (CRDT)** を DO で権威化           | 文字単位マージ（衝突しない）                     |
| 画像・PDF 等のバイナリ                     | **CDC チャンク + content-addressed R2** | ハッシュが同じなら衝突しない／違えば参照だけ LWW |
| ファイルツリー構造（パス・リネーム・削除） | **メタ YDoc（Y.Map）**                  | 安定 fileId ベースで管理                         |

remotely-save がロールバックで悩ましいのは「ファイル全体をまるごと転送し、タイムスタンプで後勝ち判定」しているため。これを **fileId ベース + 差分ベース** に変えるのが本設計の核心。

---

## 3. データモデル

### 3.1 ファイル ID（安定識別子）

- 各ファイルに **UUID（fileId）** を付与。`.obsidian` 配下に `fileId ↔ path` のマッピングを保持。
- パス文字列をキーにしない。**リネームが「削除+作成」に化けて事故るのを防ぐ**最重要ポイント。

### 3.2 メタ YDoc（ファイルツリー）

Yjs の `Y.Map` で全ファイルのメタデータを管理し、DO で収束させる。

```
fileId → {
  schemaVersion: 1
  path:       string        // 現在のパス。リネームはこのフィールド更新
  canonicalPath: string     // normalize + lower。衝突検出用
  type:       "text" | "binary"
  ydocId?:    string        // type=text のとき、本文 YDoc の識別子
  blobManifestHash?: string // type=binary のとき、blob-manifests/... の content hash
  blobChunks?: string[]     // type=binary の fast path。manifest と一致必須
  deleted:    boolean       // 削除は tombstone（即物理削除しない）
  deletedAt?: number
  deletedBy?: string
  createdAt:  number
  createdBy:  string
  contentUpdatedAt: number
  contentUpdatedBy: string
  updatedAt:  number
  updatedBy:  string        // deviceId
  mtime:      number
}
```

正規化した型:

```
type MetaFile =
  | {
      schemaVersion: 1;
      fileId: string;
      path: string;
      canonicalPath: string;
      type: "text";
      ydocId: string;
      blobManifestHash?: never;
      blobChunks?: never;
      deleted: boolean;
      deletedAt?: number;
      deletedBy?: string;
      createdAt: number;
      createdBy: string;
      contentUpdatedAt: number;
      contentUpdatedBy: string;
      updatedAt: number;
      updatedBy: string;
      mtime: number;
    }
  | {
      schemaVersion: 1;
      fileId: string;
      path: string;
      canonicalPath: string;
      type: "binary";
      ydocId?: never;
      blobManifestHash: string;
      blobChunks: string[];
      deleted: boolean;
      deletedAt?: number;
      deletedBy?: string;
      createdAt: number;
      createdBy: string;
      contentUpdatedAt: number;
      contentUpdatedBy: string;
      updatedAt: number;
      updatedBy: string;
      mtime: number;
    };
```

不変条件:

- `fileId` は YMap key と値の両方で一致する。
- `canonicalPath` は `path` から決定論的に計算し、手入力値を信用しない。
- `type="text"` は必ず `ydocId` を持ち、blob field を持たない。
- `type="binary"` は必ず `blobManifestHash` と `blobChunks` を持ち、`ydocId` を持たない。
- `deleted=true` でも本文 YDoc / blob manifest は即消さない。
- schema validation に失敗した meta update は quarantine し、通常 materialize へ進めない。

現在の `packages/protocol/src/meta.ts` 実装は、Worker と plugin が共有する最小 schema guard を持つ。

- `fileId` は branded `FileId` とし、YMap key と一致する場合だけ `isMetaFile(value, expectedFileId)` が true になる。
- `canonicalPath` は `canonicalizeVaultPath(path)` と一致必須。`path` は Vault 相対パスだけを許し、絶対パス、`\`、NUL、`.` / `..` segment、`.obsidian` 配下は拒否する。
- `type="text"` は `ydocId` が必須で、`blobManifestHash` / `blobChunks` を持つ entry は拒否する。
- `type="binary"` は lowercase SHA-256 hex の `blobManifestHash` と 1 個以上の `blobChunks` が必須で、`ydocId` を持つ entry は拒否する。
- `deleted=false` の entry が `deletedAt` / `deletedBy` を持つ場合は拒否する。`deleted=true` のときだけ削除メタデータを許す。

### 3.3 本文 YDoc（テキスト）

- **ファイルごとに別 YDoc**（= 別の論理ルーム）+ ファイルツリー用に 1 つのメタ YDoc。
- 理由: 巨大 Vault を 1 ドキュメントにすると起動・差分計算が重い。ファイル単位なら開いているファイルだけアクティブ同期し、他は遅延ロードできる。スナップショット粒度も細かくできる。
- 各 `.md` を `Y.Text` にマッピング。

### 3.4 バイナリ（CDC チャンク）

- ファイル内容を content-defined chunking で分割し、各チャンクを `vaults/<vaultId>/blobs/<chunk_sha256>` として R2 に保存。
- ファイルは「チャンクハッシュのリスト」として表現（3.2 の `blobChunks`）。
- 利点: (1) 大ファイルの 1 箇所変更で変わったチャンクだけ転送、(2) ファイル間でも共通チャンクを自動共有（重複排除）。
- チャンクは**不変**。一度書かれたら中身が変わらない。

現在の `packages/blob/src/manifest.ts` の `chunkBytes(bytes, options)` は MVP 用の deterministic content-defined chunker で、chunk 先頭からの累積 hash を境界判定に使う。
これは Rabin / Gear / FastCDC のような固定幅 window rolling hash ではないため、ファイル前方への挿入では後続境界が大きくずれ、理想的な CDC ほどの重複排除率は出ない。
ただし manifest / chunk hash / content hash 検証の形式は将来の FastCDC へ差し替え可能な形にしておき、MVP では「全体転送を避ける決定論的分割」と「chunk 不変性」を先に固定する。

---

## 4. バイナリ同期：本体は同期せず「参照」だけを Yjs に集約する

### 4.1 発想

R2 のチャンクは content-addressed = **不変**。**不変なものは「同期」する必要がない** —— ハッシュが一致すれば同じものだし、手元になければ取りに行くだけ。

同期すべきは「`fileId → このチャンク群`」という**参照**だけで、これをメタ YDoc に入れる。結果、ファイルツリー・テキスト・画像参照・削除がすべて Yjs の因果一貫性の下に乗り、「同期チャンネルが複数あって順序がバラける」問題が消える。

### 4.2 書き込み順序（厳守）

**必ず blob 本体が先、参照が後。**

```
画像を貼ったとき（クライアント）:
1. CDC でチャンク分割し、各チャンクの sha256 を計算
2. R2 に未存在のチャンクだけ PUT（HEAD で存在確認 → 重複排除）  ← 完了を待つ
3. 完了してから メタ YDoc に fileId → { blobChunks: [...] } を書く
```

逆順（参照を先に書く）にすると、他クライアントが「ハッシュはあるのに R2 に実体がない」状態を見る。これが典型的なズレ。順序を守れば、参照が見えた時点で blob は必ず R2 に存在する（R2 は同一キーの PUT-then-GET が強整合）。

### 4.3 読み込み側

```
メタ YDoc で新しい blobChunks を観測:
1. 各チャンクがローカルにあるか?
   - あれば組み立てて配置
   - なければ R2 から GET
2. GET した bytes の sha256 が chunk key と一致するか検証
   - 一致 → local cache に保存して組み立て
   - 不一致 → 破棄してリトライ。一定回数で degraded + repair log
3. 取得失敗 → リトライキューへ（チャンクは不変なので何度でも安全に再取得できる）
```

`packages/blob` の `assembleBlobBytes(manifest, chunksBySha256)` はこの読み込み側検証の共有実装。missing chunk、chunk size mismatch、chunk hash mismatch、content hash mismatch を区別して `BlobAssemblyError` で返す。Worker/plugin はこの error code を retry / degraded / repair log に変換する。

一瞬「参照は来たがダウンロード中」が生じるが、不変なので**必ず収束**する。「古いファイルで後勝ち上書き → ロールバック」は起きない（古いチャンクも消えずに残る）。

---

## 5. 削除の追従

### 5.1 基本：物理削除しない

削除はメタ YDoc の **tombstone**（`deleted: true`）で表現。Yjs の因果性で削除操作の順序が保たれ、他クライアントは確実に追従する。ローカルでは実ファイルを消す代わりに **`.trash` へ退避**（Obsidian 標準のゴミ箱と同じ発想）。誤同期で泣かない。

### 5.2 意味的衝突：「削除 vs 編集」

CRDT でも自動解決できない衝突。ポリシーで決める。

- delete は即時物理削除にしない。tombstone を立てるが本文 YDoc は保持。
- **並行（concurrent）な「削除 vs 編集」では編集を勝たせて復活**させ、ユーザーに通知する。
  「別端末で削除されましたが、編集があったため復元しました」
- 根拠: ノートは「消える事故」より「残る事故」の方が圧倒的にマシ。

### 5.3 blob チャンクの GC

参照されなくなったチャンクをいつ消すか → **当面は消さない**を強く推奨。

- 容量が問題になってから、参照カウント 0 かつ一定期間（例: 30 日）経過したものだけ GC。
- 「削除したけどやっぱり戻したい」が常に効く。R2 は安いので初期は溜める方が安全。

GC を実装する場合の不変条件:

- `gcRetentionWindow >= maxOfflineWindow` を満たす。想定最大オフライン期間より短い保持期間で chunk を消さない。
- tombstone GC と blob GC は同じ retention horizon を見る。メタ上は復活できるのに blob 実体だけ消えている状態を作らない。
- binary file の delete vs edit 復活時は、復活前に `blobChunks` / `blobManifestHash` が指す全 chunk の存在と hash を検証する。
- chunk が欠けている場合は自動復活させない。`deleted` のまま repair log に「実体 GC 済みのため復元不可」と出し、ユーザーに旧端末からの再アップロードまたは手動復元を促す。

復活判定:

```
binary delete vs edit:
  1. concurrent edit を検出
  2. manifest を取得
  3. 全 chunk HEAD + size/hash 検証
  4. 揃っている -> deleted=false に戻して復活
  5. 欠けている -> 復活させず repair event。参照だけの壊れたファイルを materialize しない
```

「参照は復活したが実体は GC 済み」という状態は、CRDT 収束では直せない。GC を入れるなら、復活前の実体検証までを同じ機能として実装する。

---

## 6. 起動時同期と オフライン → オンライン合流

### 6.1 核心：「どっちが正しいか決める」処理は要らない。マージするだけ

オフライン編集も特別扱いせず「クロックが古いだけの普通の操作」として合流する。これを可能にするのが Yjs の **state vector (SV)**。

SV は「どのクライアントの、どこまでの操作を持っているか」のコンパクトな目次（`clientID → 最大clock`）。中身の全文ではなく**目次だけ**を交換し、相手に足りない op だけを送る。

```
クライアント:  SV = { A: 152, B: 88 }
DO:           SV = { A: 152, B: 91, C: 30 }
→ DO は「クライアントに B:89-91 と C 全部が足りない」と計算 → その差分 op だけ送る
→ クライアントも自分が持つ DO に無い op を送る
→ 双方向で合流。全文転送ゼロ。
```

3 日オフラインでも、送るのは「相手が持っていない操作」だけ。タイムスタンプで勝敗を決めないので**両方の編集が残る**。これが remotely-save との決定的な差（差分マージなので「上書き」という概念自体が無い）。

### 6.2 起動シーケンス（UI をネットワークでブロックしない）

```
Phase 0: ローカルロード（オフラインでも完結）
  - y-indexeddb からメタ YDoc + 各ファイル YDoc を復元
  - この時点で Vault は完全に使える（local-first）
  - IndexedDB にはクロックも保存 = SV が再起動後も生きる（消すとフル再同期になる）

Phase 1: 接続 & メタ YDoc の収束
  - WebSocket で DO へ接続、メタ YDoc の SV を交換 → ファイルツリーが合流
  - 「どの fileId が存在し path/blobChunks/tombstone は何か」がここで一致

Phase 2: テキスト YDoc の収束（遅延）
  - 開いているファイルを最優先で SV 交換
  - 残りは裏でバッチ。巨大 Vault で全ファイル一斉同期しない

Phase 3: バイナリの収束
  - 合流後のメタ YDoc が指すチャンクと手元を突合
  - 無いものだけ R2 から GET、DO に無いものだけ PUT
```

**Phase 1 → 2 → 3 の順序が重要。** 先にファイルツリーを確定させてから中身を埋める。逆だと「どこに置くべきか分からない孤児 op」が生まれる。ただし CRDT 収束自体は自由に先行してよく、順序が縛るのは「ファイルシステムへの配置（materialize）のタイミング」だけ（収束と実体化の分離）。

---

## 7. Durable Object のライフサイクルとストレージ制御

### 7.1 DO は「ホットキャッシュ + 合流点」、真実は R2

DO には揮発性の異なる 2 つの記憶がある。

|                           | 揮発性                                          | 用途                                  |
| ------------------------- | ----------------------------------------------- | ------------------------------------- |
| メモリ上の YDoc           | 完全に揮発（Hibernation/再起動/再配置で消える） | 稼働中の高速アクセス                  |
| DO Storage (SQLite, 10GB) | 永続（明示削除しない限り残る）                  | DO ローカルの永続層・書き込みバッファ |

**不変条件:** 「R2 のスナップショット + それ以降の op」だけで、いつでも YDoc を完全復元できる。これさえ守れば DO はいつ蒸発しても安全。

### 7.2 三層ストレージモデル

```
メモリ(YDoc)  … 揮発OK。アクティブな間だけ存在
DO Storage    … ホットな差分ログ + 直近スナップショット（再構成可能なキャッシュ）
                ・update op を追記（128KiB/key 制限のためチャンク分割）
                ・溜まったら compact
R2            … 真実。ここから常に全再構成できる
```

### 7.3 ライフサイクル

**稼働中:** `client op → メモリ YDoc に適用 → 全 client へブロードキャスト → DO Storage に op 追記`。
op ごとに R2 へ書くと write 課金とレイテンシで死ぬ。DO Storage が書き込みバッファになる。

**checkpoint（setAlarm で定期 + op 数しきい値）:**

```
1. メモリ YDoc を Y.encodeStateAsUpdate でエンコード
2. R2 へ snapshots/<vaultId>/<fileId>/<seq> として書く
3. 書けたら、それ以前の DO Storage 上の op を削除（compact）
4. 古いスナップショットも世代管理（後述の不変条件に注意）
```

runtime は通常 append ごとに 30 秒後の alarm を入れるが、未 checkpoint op が 128 件以上になった場合は即時 alarm を入れる。alarm は通常 checkpoint の前に `checkpoint_runs` の `writing` / `r2-written` / `pointer-updated` を一段ずつ recovery し、R2 object 検証、pointer 前進、compact を再開する。

**Hibernation（全クライアント離脱）:** 眠る前に**必ず R2 へ flush**。

```
1. 強制 checkpoint（未 flush の op を R2 スナップショットへ）
2. R2 への書き込み完了を確認
3. その後で hibernate
```

眠る = メモリ YDoc が消える。flush を怠ると最後の N op が失われるため**必須**。

**コールドスタート（再接続）:**

```
1. メモリは空
2. R2 から最新スナップショットをロード → YDoc を構築
3. DO Storage に未 compact な op が残っていれば適用
4. client と SV 交換 → 通常運転
```

全 op 再生ではなく「スナップショット + 少数 op」で復元するので巨大 Vault でも速い。

### 7.4 rate limit 対策

DO には「同一オブジェクトへ 10 秒以内に過剰リクエストで overload エラー」がある。update はバッチ（debounce）してから送る。

### 7.5 DO 内の multi-doc ライフサイクル

`vaultId` ごとに DO は 1 つだが、その中に `meta` と多数の per-file YDoc が存在する。大 Vault の全 YDoc をメモリに載せ続ける設計にしない。

```
VaultRoom
  docs: LRUMap<docId, LoadedDoc>

LoadedDoc:
  ydoc
  docId
  dirtyUpperSeq
  loadedAt
  lastAccessedAt
  activeSocketCount
```

方針:

- `meta` YDoc は常駐優先。Vault 全体の materialize gate なので、最も頻繁に使う。
- file YDoc は lazy load。active file の同期要求、差分要求、checkpoint 対象になった時だけ R2 snapshot + residual op からロードする。
- `activeSocketCount == 0` かつ一定時間アクセスがない file YDoc は checkpoint 後に LRU eviction する。
- eviction 前に dirty doc は必ず snapshot へ flush する。flush 失敗時は eviction しない。
- メモリ圧迫時は「非 active file の dirty flush -> eviction」を優先し、それでも無理なら degraded にして新規 file doc load を拒否する。

これで DO は「vault の単一合流点」ではあるが、「vault 全文書を常時保持する巨大プロセス」ではなくなる。

---

## 8. 整合性がズレる「継ぎ目」と乗り越え方

ズレはすべて「2 つのストアを 1 トランザクションで更新できない継ぎ目」で起きる。共通の道具で当たる。

> **共通の道具**: ① 単調な永続化（内→外へ流し、外側が確定するまで内側を消さない）② 冪等・再実行可能 ③ 防がずに修復（決定論的 reconciliation）④ 収束と実体化の分離

### 継ぎ目 1: メモリ ↔ DO Storage ↔ R2

**checkpoint 中に op が来る（seq 境界）:** DO はシングルスレッド。`encodeStateAsUpdate` は同期処理なので、スナップショットとその state vector を**同じ同期ブロックで（await を挟まず）**撮る。順序は `snapshot → R2 確定 → compact` に固定。逆（compact 先）は厳禁。クラッシュが間に入っても残るのは冗長な op だけ（再生は冪等で無害）。

**Hibernation 前 flush 失敗:** DO Storage の op はまだ消していないので、コールドスタート時に「R2 の古いスナップ + DO Storage の未 compact op」を再生すれば正しい状態に戻る。flush 失敗は「次回再生する op が増える」だけで損失にならない。

### 継ぎ目 2: R2 blob ↔ Yjs 参照

- 参照あり・blob 無し（危険）: blob PUT 完了を待ってから参照を書くので原理的に起きない。
- blob あり・参照無し（無害）: 孤児 blob。後で GC。
- multipart upload 中断: **R2 の lifecycle rule で未完了 multipart を自動 abort**。

→ 「実体が確定するまでポインタを公開しない」の一点で閉じる。

### 継ぎ目 3: CRDT 状態 ↔ ローカルファイルシステム（最難所）

Yjs とファイルシステムを跨ぐトランザクションは無い。

**エコーループ（observe → ディスク書き込み → watcher 発火 → また Yjs へ）:** 二段構えで殺す。

- **ディスク書き込みの debounce**: キー入力ごとに書かず、1〜2 秒アイドル or ファイル close 時に YText → ディスク。
- **ハッシュゲート**: YText → ディスク書き込み時に期待ハッシュを記録。watcher 発火時にディスクハッシュが現在の YText ハッシュと一致したら no-op、違うときだけ「外部編集」として YText へ取り込む。イベントが重複・順序入れ替わりしても正しく動く。
- **materialize は compare-and-swap**: ディスクへ書く直前に必ず現在 disk hash を読み直す。`currentDiskHash == lastMaterialized.diskHash` の時だけ上書きしてよい。違う場合は watcher がまだ取り込んでいない外部編集があるので、上書きせず conflict copy へ退避し、その内容を先に YText へ取り込む。

**外部編集（git pull・別アプリ・クラッシュ復旧）:** 例外扱いせず「ディスクが勝手に変わった」を一級の入力として常時ハッシュ比較で取り込む。起動時の reconciliation も同じ経路。分類不能なら捨てずに conflict copy（`file (conflict 2026-06-05).md`）。

**孤児 op（本文 op は来たがメタツリーが path を知らない）:** 収束と実体化の分離。本文 YDoc は path を知らなくても収束してよい。**ファイルシステムへの配置だけ**をメタツリー解決に gate する。

### 継ぎ目 4: CRDT 収束結果 ↔ アプリ不変条件

CRDT は収束を保証するが「1 path = 1 fileId」等のアプリ不変条件は保証しない。

- **同一 path に別 fileId が 2 つ（並行新規作成）:** 収束後に検出し、全クライアントが**同じ決定論的修復**（例「fileId が大きい方を負けにして `idea (2).md` へリネーム」）。誰も調整せず全員が同じ結果に収束。
- **tombstone GC vs 長期オフライン:** §9.2 で扱う。

path conflict repair:

```
input: entries grouped by canonicalPath where deleted=false

for each group with length > 1:
  winner = minBy(entries, [createdAt, fileId])

  for loser in entries - winner sorted by fileId:
    loser.path = allocateSuffix(winner.path, loser.fileId)
    loser.canonicalPath = canonical(loser.path)
    loser.updatedAt = nowLogical
    loser.updatedBy = "repair"
    append repair-log event
```

現在の `packages/core/src/reconcile.ts` 実装は、この path conflict repair の決定部分を `planPathConflictRepairs(entries, updatedAt, updatedBy)` として共有する。`deleted=false` の entry だけを対象にし、winner は `[createdAt, fileId]` 昇順、loser は `fileId` 昇順で処理する。`fileId` や snapshot key の tie-break は `localeCompare` を使わず、JavaScript の `<` / `>` による code unit 順で固定する。rename 先は winner path の拡張子前に ` (conflict <shortFileId>)` を挿入し、既存 path とぶつかる場合は `-2`, `-3`... を付ける。

`allocateSuffix` は全端末で同じ結果にする。

```
foo.md
foo (conflict <shortFileId>).md
foo (conflict <shortFileId>-2).md
```

「誰が勝つか」はユーザーの意図ではなく、収束のための機械的規則。勝敗で内容を捨てない。負けた側は path が変わるだけで fileId と内容は残る。

delete vs edit repair:

```
if deleted=true and hasConcurrentEditAfterDelete(fileId):
  if type == "text":
    deleted=false
    append repair event "restored because concurrent edit exists"
  if type == "binary":
    verify manifest + chunks
    if complete:
      deleted=false
      append repair event
    else:
      keep deleted=true
      append repair event "cannot restore because blob chunks are missing"
```

現在の `packages/core/src/reconcile.ts` 実装は、この delete vs edit の決定部分を `planDeleteVsEditRepairs(entries, restorableBinaryFileIds, updatedAt, updatedBy)` として共有する。`deleted=true` かつ `deletedAt` が存在し、`contentUpdatedAt > deletedAt` の entry だけを concurrent edit とみなす。text は復活 plan を返し、binary は `restorableBinaryFileIds` に含まれる場合だけ復活 plan、含まれない場合は `keep-deleted` plan を返す。Worker/plugin は `keep-deleted` を repair log とユーザー通知に変換する。

repair plan の meta entry への適用は `applyMetaRepair(entry, repair)` に寄せる。path conflict は `path/canonicalPath/updatedAt/updatedBy` を更新し、delete-vs-edit restore は `deleted=false` に戻しつつ `deletedAt/deletedBy` を取り除く。`keep-deleted` は meta entry を変更しない。実際の YMap transaction と repair-log 追記は Worker/plugin 側が行うが、entry 更新内容はこの純粋関数で共有する。

`hasConcurrentEditAfterDelete` は device clock/state vector を使って「削除を観測していない編集」を見る。実装が難しい初期段階では、`deletedAt < lastContentUpdatedAt` かつ `updatedBy != deletedBy` を conservative な近似としてよい。迷ったら消さずに復活、ただし binary は実体が揃っている場合だけ復活。

---

## 9. Yjs を採用したことで重くなる 3 点と対策

### 9.1 CM6 バインディング（最大の実装リスク・最初に潰す）

Obsidian は内部で CodeMirror 6 を管理しており `y-codemirror.next` を挿すには
`registerEditorExtension` + `Compartment.reconfigure` で active editor ごとに binding を
差し替える必要がある。

**Compartment で束縛先を張り替える:**

```js
const yCompartment = new Compartment()
registerEditorExtension([yCompartment.of([])]) // 登録時は空

// file-open / active-leaf-change で:
const ytext = getOrCreateYText(fileId)
const view = leaf.view.editor.cm // 半公式アクセス（更新で壊れうる）
view.dispatch({
  effects: yCompartment.reconfigure(
    yCollab(ytext, awareness, { undoManager: false }), // spike は Obsidian undo 優先
  ),
})
```

`packages/obsidian-plugin/src/obsidian/editor-binding.ts` の `createYTextEditorExtension(ytext, awareness = null)` は awareness provider を後から注入できる API にしておく。provider 未実装時だけ `null` に縮退し、presence 実装が入ったら同じ binding surface へ接続する。

**file-open 時の真実の所在:** YText が真実。

- そのファイルの YText がこのクライアントで空（初見）→ ディスク内容で seed。
- 空でない → YText が勝つ。ディスクとハッシュ比較し、違えば YText 内容を反映（materialize）。
- y-indexeddb の `whenSynced` が解決する前に seed しない。ここを timeout で妥協すると、再起動後に古い disk 内容で復元前の YDoc を上書きしうる。

これで「開いた瞬間に古いディスク版がチラ見えして上書き」を防ぐ。

**active file への materialize 禁止:** CM6 binding が付いているファイルは、YText -> EditorView が唯一の反映経路。materializer が同じ path に `Vault.modify` すると、Obsidian の内部バッファ・watcher・YText が三つ巴になる。active leaf の fileId は materialize queue から除外し、閉じた時または inactive になった時だけ disk flush する。

active file がリモートで rename/delete された場合:

- rename: fileId は同じなので binding は維持し、Obsidian 側の path だけ安全なタイミングで更新する。
- delete: tombstone は立つが、active editor に未保存/未同期 edit があれば §5.2 の delete vs edit として復活させる。

> **着手順の最優先。** ハードコードした 1 ファイルで「CM6 ⇄ Yjs ⇄ ディスク」が反響せず往復する、それだけを最初に証明する。ここが動けば残りは設計通りに積める。

### 9.2 tombstone 蓄積と長期オフライン

`encodeStateAsUpdate(doc)` が返すのは **op 履歴ではなく現在状態を圧縮した update**。新規クライアントは全履歴を再生しない。つまり**スナップショット戦略がそのまま tombstone 対策**になる。Yjs の `gc:true`（デフォルト）も削除内容を回収するので基本は触らない。

長期オフラインの危険（古いスナップ/op-log を消した後、それより古い SV のクライアントが戻る）への解は不変条件 2 本:

> **最新のフルスナップショットは絶対に消さない。さらに論理破損から戻るため、§16.4 の retention window 内の旧スナップショットも保持する。op-log は compact してよいが、snapshot retention は別管理。**

どれだけ古いクライアントが戻っても、(1) 最新フルスナップショットを 1 つの update として受け取り `applyUpdate` でマージ、(2) 自分の未同期 op を DO へ送り返す、の 2 手で必ず合流。Yjs のマージは可換なので古い doc に最新フル状態を被せても壊れず収束する。「差分計算できず壊れる」が「差分は無理だがフルマージはできる」に格下げされる。

運用: SV が保持地平より古いクライアントを検出したら、差分同期でなく**フルスナップショットマージ経路**に落とす分岐を入れるだけ。

### 9.3 ドキュメント粒度とファイル間移動

per-file YDoc を維持。場合分け:

- **ファイル丸ごとの移動・リネーム** → 完全にクリーン。内容は動かず、メタ YMap の `fileId → path` 書き換えのみ。安定 fileId のおかげでリネームが「削除+作成」に化けない。
- **段落を別ファイルへカット&ペースト** → YDoc(A) の delete-range + YDoc(B) の insert という 2 つの独立 op。CRDT の単一トランザクション保証の外。移動中に他端末が A 側を編集すると重複しうるが、**消失ではなく重複**で、片方消せば直る。「迷ったら両方残す」に一致。レアケースなので特別な機構は不要。

---

## 10. その他の必須要素

### 10.1 手動エスケープハッチ（self-healing で治らない時の非常口・必須）

- **「この端末を真実に」**: ローカル YDoc から `encodeStateAsUpdate` でスナップ生成 → DO/R2 の最新を強制置換。
- **「リモートを真実に」**: ローカル破棄 → 最新スナップショットから再構築。
- **「再構築」**: R2 のスナップ + blob から全再生成。

DO が plaintext を扱えるので DO 側コマンドとして素直に実装できる。

### 10.2 conflict 解決 UI（CRDT 採用で大幅縮小）

テキスト本文の衝突は自動マージされ手動解決不要。残るのは意味的衝突（削除 vs 編集／同 path 別 fileId／移動重複）だけ。常時出るダイアログではなく、たまに出る小さな「自動修復しました」レビューパネルで足りる。

### 10.3 デバイス登録（Setup URI）

非 E2EE で配る鍵が無いので、エンドポイント + vaultId + 認証トークンだけ。個人デプロイなら環境変数 + 1 本の URI/QR で足りる。

### 10.4 モバイル / iOS

iOS は背面で WebSocket を維持できない。常時接続を前提にせず、**フォアグラウンド復帰時に必ず WS 再接続 + SV 再交換**を基本動作にする。

### 10.5 初回フルシンク

大 Vault の初回だけは別物として扱い、スナップショットからのブートストラップに進捗表示と再開可能性を付ける。

初回フルシンクは通常同期の WS/op_log 経路に流し込まない。vault あたり単一 DO はシングルスレッドなので、大量 file seed・checkpoint・R2 write・blob upload を同時に投げると、最初の利用時に overload しやすい。

初回専用モード:

- `.md` の seed は小さい Yjs op を大量に積むのではなく、file YDoc snapshot を直接 R2 に PUT し、per-doc pointer を作る。
- meta YDoc だけは DO を通すが、batch size と rate limit を厳しくする。
- binary blob は DO/WS を通さず、Worker HTTP か presigned/multipart で R2 へ直接 PUT する。
- `/blobs/head` はページングし、upload concurrency を固定上限（desktop 4、mobile 2 など）にする。
- DO に送るのは「この fileId の snapshot/pointer/blob manifest が揃った」という小さい meta 参照更新だけにする。
- 途中中断時は local outbox と R2 の既存 object を突合し、完了済み file/blob を飛ばして再開する。
- 初回 index 中の watcher event は即時同期せず、scan 完了後の差分 scan で吸収する。

これで DO は初回の巨大データ面を処理せず、制御面だけを順序付ける。

### 10.6 `.obsidian` 設定フォルダ

プラグイン設定・ワークスペースは端末固有なので、全同期は事故る。同期対象から除外 or 選択的同期（opt-in）にする。

### 10.7 認証とテナント分離

vaultId から DO の id を決定論的に導出し、JWT の claim と照合。

### 10.8 presence / awareness

Yjs Awareness で「今誰がどのファイルを開いているか」を出すと、同時編集の事故が UX レベルで減る。
MVP の editor binding は awareness を optional injection とし、transport/provider が未実装の間は remote selections なしで動く。provider 実装後は `createYTextEditorExtension` に awareness instance を渡し、`hello.capabilities` の `"awareness"` と一致させる。

### 10.9 大きいファイルのしきい値

数十 MB の添付は WebSocket ではなく R2 への直接 multipart upload（presigned URL）に回す。

---

## 11. 実装ロードマップ（リスクの高い順）

0. **実装前スパイク**（§22）。CM6 実エディタ binding と DO checkpoint/cold-start model test を先に通す。
1. **CM6 ⇄ Yjs ⇄ ディスクの単体疎通**（§9.1）。ハードコード 1 ファイルで反響しない往復を証明。**最優先。**
2. **1 ファイルのリアルタイム Yjs 同期を DO 上で**（既存の `y-durableobjects` 等で疎通確認）。
3. **clientID/device registry**（§16.1）。Yjs `clientID` の衝突拒否・再採番・full snapshot merge を先に固める。
4. **DO ライフサイクル**（§7、§16）。checkpoint・compact・snapshot retention・quarantine・Hibernation 前 flush・コールドスタート復元。
5. **起動時 reconciliation**（§6、state vector 交換）。
6. **メタ YDoc によるファイルツリー同期**（§3.2、リネーム・削除 tombstone）。
7. **初回フルシンク専用モード**（§10.5）。seed snapshot 直 PUT、blob direct upload、meta 参照更新。
8. **バイナリ CDC + R2**（§4）。
9. **整合性の継ぎ目の作り込み**（§8、特にハッシュゲート）。
10. **運用機能**（§10、エスケープハッチ・conflict UI・Setup URI・モバイル resync）。

### 11.1 MVP 縦切り

最初の実装は全機能を薄く広く作らない。次の縦切りで「この設計の一番危ない仮説」を先に検証する。

MVP-0: local editor loop

- 対象は固定の 1 Markdown file。
- Obsidian CM6 ⇄ Y.Text ⇄ disk materialize が往復する。
- active file には materialize しない。
- watcher echo は no-op。
- watcher を意図的に落としても materialize CAS が外部編集を消さない。
- y-indexeddb 再起動後に同じ YDoc が復元される。

MVP-1: one file remote sync

- Worker + 1 DO + 1 file YDoc。
- ClientHello で `deviceId/yClientId` registry を検証する。
- 2 クライアントが同じ段落を同時編集し、両方残る。
- DO restart 相当で R2 snapshot + residual op_log から復元する。
- update validation / quarantine の最小経路を持つ。

MVP-2: meta YDoc + path repair

- fileId/path/canonicalPath の meta schema を使う。
- rename が delete+create にならない。
- 同一 path 競合が deterministic rename に収束する。
- delete vs edit が text は復活、binary は chunk 検証後だけ復活する。

MVP-3: initial sync + binary

- bootstrap と join を分ける。
- join は remote meta を先に読んで fileId adopt する。
- binary は blob PUT 完了後に meta 参照を公開する。
- 初回 seed は WS/op_log に大量投入せず snapshot 直 PUT にする。
- 現在の e2e は、Worker/R2 に seed 済みの meta snapshot と file YDoc snapshot から、空の Obsidian vault に Markdown 本文を materialize できることを固定している。
- 現在の e2e は、binary chunk PUT、manifest PUT、meta 参照公開、Worker からの manifest/chunk 再取得と content hash 検証まで固定している。

### 11.2 コード確認後の残タスク

2026-06-30 時点の実装を確認した結果、設計の危険仮説は e2e でかなり潰せているが、まだ「製品として完成」ではない。残りは大きく、production runtime への接続、初回同期 API の一般化、binary/materialize の常用化、運用 UI の 4 群に分かれる。

P0: production startup pipeline を no-op から実処理へつなぐ。

- `packages/obsidian-plugin/src/main.ts` の `createStartupStepPort()` では `fetch-remote-meta-snapshot`、`apply-remote-meta-snapshot`、`adopt-local-files-after-remote-meta`、`enqueue-missing-downloads`、`load-indexeddb-ydocs`、`resume-background-queues` がまだ実質 no-op。`packages/core/src/startup.ts` と `packages/obsidian-plugin/src/sync/startup-actuation.ts` には step と port 境界があるので、`main.ts` の ad-hoc 実装をそこへ寄せる。
- `packages/obsidian-plugin/src/sync/obsidian-runtime-composition.ts` には unwired fail-fast port が残る。production composition root で local-store open/rebuild、startup step、outbox worker、WebSocket session を実 port へ接続する。
- `setup` persistence は `packages/obsidian-plugin/src/sync/setup-persist-runtime.ts` に SecretStorage + IndexedDB metadata の実行境界があるが、`main.ts` はまだ `setupResponse`、`accessToken`、`refreshToken` を `data.json` へ保存する簡易経路を持つ。token material は `data.json` から外し、SecretStorage と metadata store を source にする。
- `packages/obsidian-plugin/src/sync/websocket-runtime.ts` には subprotocol token、hello admission、session、inbound dispatcher があるが、`main.ts` は独自 `openWorkerWebSocket()` / query token 経路を使っている。runtime 側の WebSocket port を実際の plugin lifecycle に採用する。

P0: full snapshot の production 経路を完成させる。

- `packages/protocol/src/snapshot-http.ts` と `packages/obsidian-plugin/src/sync/snapshot-apply-runtime.ts` には latest snapshot response と local apply transaction があるが、`packages/worker/src/runtime.ts` には production `GET latest snapshot` route がなく、存在するのは e2e seed 用 `POST /__e2e/snapshot` だけ。`NeedFullSnapshot` を受けた client が HTTP で対象 doc の snapshot を取得できる route を追加する。
- `NeedFullSnapshot(reason="state-vector-too-old")` は Worker から返るが、plugin 側は `handleWorkerMessage()` で警告するだけ。`snapshot-apply-runtime.ts` を使い、active editor / pending outbox / doc mismatch / hash mismatch の gate を通して local YDoc、remote cursor、outbox release を同一 IndexedDB transaction に保存する。
- join-existing の e2e は meta/file snapshot seed から materialize できるが、現在は Worker の e2e seed API に依存している。通常の bootstrap/import flow で snapshot direct PUT、pointer 作成、meta 公開までできる CLI または plugin flow を作る。

P0: outbox worker を実 side effect runner として動かす。

- `packages/obsidian-plugin/src/sync/outbox-worker.ts`、`outbound-queue.ts`、`local-store.ts`、`local-store-driver.ts`、`local-store-indexeddb.ts` は lease、CAS、completion、IndexedDB transaction plan まで持つが、plugin lifecycle から scheduler tick を継続実行する runner がまだ接続されていない。
- `blob-put`、`blob-get`、`manifest-put`、`materialize`、`meta-ref-update` の side effect plan はある。実 runner は local blob cache read/write、HTTP fetch、Vault write、WebSocket send、completion classification、lease renew/release を順番に実行し、成功/失敗を local store transaction に戻す。
- `y-update` / `meta-ref-update` は server `Ack` で完了する。`packages/obsidian-plugin/src/sync/websocket-runtime.ts` の inbound dispatcher と outbox completion port を production local store に接続し、ad-hoc `sendDocUpdateToWorker()` 直送を outbox 経由へ寄せる。

P1: binary を e2e 専用から通常機能へ上げる。

- `packages/worker/src/runtime.ts` は `/blobs/head`、`/blobs/upload-url`、single PUT `/blobs/:sha256`、`/blob-manifests/:hash.json` を持つが、multipart は `blob-upload-url:multipart-unimplemented` で拒否する。大きい添付を扱うなら multipart create/part/complete/abort と R2 lifecycle を実装する。
- `packages/blob/src/manifest.ts` と `packages/core/src/outbox.ts` には CDC、manifest、binary upload/download outbox plan がある。Obsidian の vault watcher から binary create/modify/delete を検出し、chunk cache、manifest PUT、meta ref update、download materialize を通常 outbox に積む。
- 現在の binary e2e は remote peer が HTTP で PUT して meta を公開する形。Obsidian plugin 自身が binary file を upload/download/materialize する e2e を追加する。

P1: meta materialize の残りを埋める。

- `packages/obsidian-plugin/src/main.ts` は remote meta の text entry から欠損 Markdown を作れるが、親フォルダがない path はまだ扱わない。remote path の親フォルダ作成、既存 folder/file 衝突、invalid path quarantine を実装する。
- active file が remote で rename/delete された場合の UX は spec にあるが、`main.ts` は active binding 維持・安全な rename/delete materialize まで未接続。active editor を直接 `Vault.modify` しない制約を守ったまま、path 更新と tombstone 表示を実装する。
- `packages/obsidian-plugin/src/sync/meta-reconcile.ts` は delete-vs-edit repair を持つが、restorable binary set は production では未算出。binary manifest/chunk 検証を走らせ、復活可能な binary だけを restore する。
- `keep-deleted` や invalid meta entry は repair-log / UI に出す必要がある。今は repair 結果を返す境界はあるが、ユーザーが確認できる persistent repair log と panel はまだない。

P1: local store degraded / repair flow を UI へつなぐ。

- `packages/core/src/local-store.ts`、`packages/obsidian-plugin/src/sync/local-store-schema.ts`、`local-store-repair.ts` は schema gate、degraded、export、discard/rebuild、repair import staging を持つ。Obsidian settings/repair panel から export、discard、import、manual resume を実行できる UI が必要。
- IndexedDB directory API がない環境、schema too new、pending outbox あり rebuild などの状態を status bar と Notice だけでなく、誤操作しにくい repair panel に出す。
- repair export/import は token material を含めず、protocol guard を通った outbox evidence だけを扱うことを e2e で固定する。

P2: 運用・配布に必要な面を足す。

- `packages/worker/src/retention.ts` は snapshot retention plan を持つが、定期実行・監査ログ・削除失敗 retry が production path に薄い。checkpoint 後の retention cleanup と admin visibility を足す。
- quarantine admin は Worker HTTP にあるが、plugin 側の inspection / discard / force-apply UI がない。dangerous action は確認付きにする。
- auth refresh/revoke runtime はあるが、plugin lifecycle の foreground/resume、token expiry 前 refresh、revoked device の local shutdown に接続する。
- iOS/Android の foreground resume で必ず WS 再接続 + state vector 交換する。background 中は queue を無理に進めない。
- presence/awareness は WebSocket capability の型とテスト片があるだけで、editor binding には未接続。MVP 外なら残してよいが、実装するなら `createYTextEditorExtension` へ awareness injection する。
- 配布前に settings UI、Setup URI/QR、ログの secret redaction、migration/backward-incompatible policy、manual escape hatch（local truth / remote truth / rebuild）を整える。

MVP を越えるまでやらないこと:

- full conflict UI の作り込み
- tombstone/blob GC の実行
- mobile 最適化
- 複数 vault / multi-tenant UX
- marketplace 配布向け polish

Claude review の指摘に従い、MVP-0 後は純 decision の追加だけを続けず、MVP-1 の実ランタイム縦切りを優先する。`packages/worker/src/runtime.ts` はこの軌道修正の最小足場で、`/ws/:vaultId`、`POST /setup/exchange`、`POST /auth/refresh`、`POST /devices/:deviceId/revoke`、`GET /admin/quarantine[/<id>]` を `VAULT_ROOM` Durable Object に route し、`VaultRoom` は WebSocket upgrade と setup/auth/revoke/quarantine-inspect HTTP request を受ける。Worker entrypoint、Durable Object class、`wrangler.toml` の `VAULT_ROOM` / `SNAPSHOT_BUCKET` binding、node unit test による route/broadcast 検証を先に置いた。`POST /setup/exchange` は body guard 後に body の `vaultId` から DO へ route し、DO 側で setup token hash lookup、`decideSetupTokenConsume`、`decideSetupExchange`、`planSetupExchangeCredentials`、device row insert/reuse、refresh token hash insert、HS256 access JWT mint、`planSetupExchangeHttpResponse` まで通す。`POST /auth/refresh` も body guard 後に body の `vaultId` から DO へ route し、refresh token hash lookup、`decideDeviceTokenRefresh`、`planDeviceRefreshTokenRotation`、旧 refresh token revoke、新 refresh token hash insert、HS256 access JWT mint、`planDeviceTokenRefreshHttpResponse` まで通す。`POST /devices/:deviceId/revoke` は Bearer JWT の `aud` から DO へ route し、DO 側で同じ token を再検証して actor device を `decideAuthAdmission(sync:write)` に通し、target device を `decideRevokeDevice` / `planRevokeDeviceHttpResponse` に通して `devices.token_version/revoked_at/last_seen_at` を更新する。`GET /admin/quarantine` と `GET /admin/quarantine/:id` も Bearer JWT の `aud` から DO へ route し、DO 側で同じ token を再検証して actor device に `sync:write` がある場合だけ、`quarantined_updates` のlist/detailを返す。listはbytes本体を含まず、detailだけが `updateBytesBase64` を返す。さらに `DEVICE_TOKEN_SECRET` が設定された WS では upgrade の `Authorization: Bearer <jwt>` を socket attachment に紐づけ、JSON `hello` で HS256 署名検証、`DeviceTokenClaims` guard、`decideAuthAdmission(sync:read+sync:write)`、route vault と `devices` registry row の照合を通す。SQL registry があるのに `DEVICE_TOKEN_SECRET` が未設定なら fail-closed として `auth-reject:missing-secret` で拒否する。unknown/revoked/stale-token/scope不足 device を拒否し、registry と違う `yClientId` を名乗る既存 device を full-snapshot-required として通常同期から外し、accept 済み socket の `vaultId/deviceId/yClientId` を attachment に保存する。Hibernation 復帰後は `deserializeAttachment()` から session/token を復元し、インメモリ `Map<WebSocket,...>` だけに依存しない。後続の JSON `sync-request` / `sync-update` が hello と異なる `vaultId/deviceId` を名乗る場合も通常同期へ進めない。JSON `sync-update` は base64 decode / SHA-256 / doc 初回 access 時の R2 snapshot + SQL residual `op_log` replay / 空の temporary `Y.Doc` への `Y.applyUpdate` 構造 validation / `decideSyncUpdateQuarantine` / `decideSyncUpdateAppend` / DO SQLite への `op_log` append・`docs.latest_seq` 更新・`message_dedup` upsert / commit 後の authoritative `Y.Doc` apply / ack / peer broadcast まで通す。binary frame は任意 broadcast せず、`decodeBinaryFrame` の envelope/header guard 後に payload を同じ `sync-update` pipeline へ渡す。壊れた binary frame や hello 前 binary update は peer へ撒かず close する。JSON `sync-request` は client state vector を decode し、`docs.latest_seq/min_retained_seq/horizon_state_vector` を読んで active YDoc を hydrate してから、client が compact 済み horizon をカバーしていれば `Y.encodeStateAsUpdate(doc, clientStateVector)` の差分を `sync-update` として返す。差分が空、または server 側に doc が未作成なら何も送らず、client が horizon より古い場合は `NeedFullSnapshot(reason="state-vector-too-old")` を返す。通常同期、復元、隔離の永続化は DO SQLite 必須とし、`state.storage.sql` がない場合は sync request/update を `sync-storage-unavailable` で閉じる。DO storage の KV-like API は vaultId metadata と alarm 復元のためだけに使い、sync data の代替永続層にはしない。append が確定した場合だけ authoritative in-memory `Y.Doc` に update を適用し、duplicate ack や snapshot escape では doc を変えない。R2 復元では `/ws/:vaultId` から room の `vaultId` を保持し、`docs.latest_snapshot_key/latest_snapshot_seq` と `SNAPSHOT_BUCKET.list(prefix)` の immutable snapshot candidates を `chooseSnapshotForRestore` に渡す。pointer が missing/stale なら prefix list の最大 seq snapshot へ fallback し、選んだ snapshot object が欠ける/壊れる場合は hydrate failure として append/quarantine/sync-request 差分生成へ進まず socket を閉じる。`VaultRoom.checkpointDoc()` は active YDoc を `Y.encodeStateAsUpdate` で snapshot bytes にし、`checkpoint_runs: writing -> r2-written -> pointer-updated -> compacted`、R2 PUT、`docs.latest_snapshot_seq/latest_snapshot_key/latest_state_vector` 更新、`op_log.seq <= upperSeq` 削除、`docs.min_retained_seq/horizon_state_vector` 更新まで行う。通常 append 後は `storage.setAlarm(now + 30s)` でcheckpoint alarmを予約し、`alarm()` は `docs.latest_seq > latest_snapshot_seq` のdocを小バッチで読み、storageに保存した vaultId を復元して `checkpointDoc()` を実行する。これにより DO evict 後に alarm だけが起きても、op_logが無限成長する経路を減らせる。

これで「文字単位 CRDT」「消さない materialize」「R2/DO 復元」「fileId ベース meta」の 4 つを早期に証明する。

---

## 12. 既知のリスクと割り切り

| リスク                                   | 状態                    | 割り切り                                                        |
| ---------------------------------------- | ----------------------- | --------------------------------------------------------------- |
| `leaf.view.editor.cm` が非公式 API       | Obsidian 更新で壊れうる | 既存協調プラグインも踏む道。前例あり                            |
| 段落のファイル間移動の並行編集           | CRDT 保証外             | 最悪でも一過性の重複。消失はしない                              |
| tombstone / 古いクライアント             | §9.2 で緩和             | full snapshot merge 経路で「壊れる」を回避                      |
| 論理破損した checkpoint                  | §16.4 で緩和            | snapshot retention と quarantine で rollback 可能にする         |
| Yjs clientID 衝突                        | §16.1 で緩和            | device registry で検出し通常同期へ進めない                      |
| DO 単一障害点                            | 設計上の前提            | 真実は R2。DO は再構成可能なキャッシュ                          |
| 初回フルシンクの DO 過負荷               | §10.5 で緩和            | seed/blob データ面を DO に流さず、DO は制御面に寄せる           |
| materialize による未観測外部編集の上書き | §18.4 で緩和            | 書き込み直前 CAS と conflict copy で消さない                    |
| blob GC 後の binary 復活                 | §5.3 で緩和             | GC horizon と復活前 chunk 検証で壊れた参照を materialize しない |
| iOS バックグラウンド制限                 | OS 制約                 | フォアグラウンド復帰 resync で吸収                              |

---

## 13. プロジェクト構成

最初から monorepo にする。Obsidian 側と Worker 側で同じ型・メッセージ定義・Yjs 補助関数を共有するため。後から分けるより、最初に境界を切った方が同期プロトコルの破壊的変更を管理しやすい。

```
kuroflare/
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  biome.json または eslint/oxlint 設定
  vitest.config.ts

  packages/
    obsidian-plugin/
      manifest.json
      versions.json
      src/
        main.ts                 # Plugin entrypoint。DI と lifecycle のみ
        settings.ts             # Setup URI / token / ignore rules
        obsidian/
          editor-binding.ts      # CM6 <-> Y.Text
          vault-events.ts        # create/modify/rename/delete の入口
          materializer.ts        # YDoc -> Vault 反映
          hash-gate.ts           # echo loop 防止
          conflict-panel.ts      # 自動修復ログの UI
        sync/
          sync-engine.ts         # meta/file/blob sync の orchestration
          local-store.ts         # IndexedDB / plugin data / chunk cache
          local-store-schema.ts  # IndexedDB schema open/rebuild/degraded startup gate
          local-store-repair.ts  # degraded store export/rebuild/discard repair effects
          local-store-driver.ts  # IndexedDB transaction read set / commit adapter
          local-store-indexeddb.ts # browser indexedDB factory/probe + driver read/write plan -> IndexedDB adapter
          outbound-queue.ts      # 冪等 retry queue
          outbox-worker.ts       # scheduler/local-store/lease を side effect 開始へ繋ぐ pure orchestration
          obsidian-startup-settings.ts # data.json/setup UI -> startup intent / setup evidence
          obsidian-startup-evidence.ts # raw Obsidian evidence -> runtime startup input
          startup-actuation.ts   # startup plan -> shell state / effect pump / no-network defer
          obsidian-shell-presentation.ts # shell state -> status bar / Notice / repair panel 表示入力
          obsidian-shell-ui.ts # presentation plan -> status/Notice/repair UI port 適用
          obsidian-shell-driver.ts # evidence -> startup plan -> actuation -> local-only pump
          obsidian-shell-lifecycle.ts # driver state 保持 + transport tick + UI apply の lifecycle 境界
          websocket-runtime.ts # endpoint/token metadata -> WebSocket open + ClientHello startup step
        mobile/
          foreground-resume.ts   # iOS/Android の復帰時 resync

    worker/
      wrangler.toml
      src/
        runtime.ts              # Worker fetch entrypoint / VaultRoom DO shell
        snapshots.ts            # R2 snapshot key / manifest guard / restore candidate choice
        checkpoint.ts           # orphaned checkpoint run recovery decision
        retention.ts            # snapshot retention delete plan
        devices.ts              # setup exchange / device registry admission decision
        index.ts                 # Hono routes
        auth.ts                  # JWT / setup token
        durable-objects/
          vault-room.ts          # WS endpoint, SV exchange, op append
          checkpoint.ts          # snapshot / compact / cold start
          schema.ts              # SQLite DDL
        r2/
          blobs.ts               # chunk HEAD/PUT/GET, multipart
          snapshots.ts           # snapshot key 管理
        admin/
          repair.ts              # force-local / force-remote / rebuild

    model-tests/
      src/
        checkpoint-model.ts      # DO checkpoint/cold-start の実行可能な状態機械
        checkpoint-model.test.ts # deterministic random operation sequence

    core/
      src/
        text.ts                  # canonical text hash / minimal replacement
        ydoc.ts                  # encode/apply helpers
        reconcile.ts             # deterministic repair
        hashing.ts               # sha256 for text/binary/snapshot payloads
        clock.ts                 # monotonic client op ids

    protocol/
      src/
        ids.ts                   # vaultId, deviceId, messageId, ydocId, DocId
        messages.ts              # WS control message schema / binary header guard
        meta.ts                  # MetaFile schema
        errors.ts                # retryable/non-retryable 分類
        version.ts               # protocolVersion / minCompatible

    blob/
      src/
        cdc.ts                   # chunking
        manifest.ts              # chunk list, size, hash
        cache.ts                 # local blob cache policy

  tests/
    fixtures/
    integration/
      two-clients.spec.ts
      offline-merge.spec.ts
      binary-retry.spec.ts
      delete-vs-edit.spec.ts
```

### パッケージ責務

| package           | 依存してよいもの           | 依存してはいけないもの            | 責務                                     |
| ----------------- | -------------------------- | --------------------------------- | ---------------------------------------- |
| `protocol`        | なし、または `zod` 程度    | Obsidian / Cloudflare / DOM       | wire format と永続データ型               |
| `core`            | `protocol`, `yjs`          | Obsidian / Cloudflare             | Yjs 差分、修復、ハッシュ                 |
| `blob`            | `protocol`, `core`         | Obsidian / Cloudflare             | CDC と blob manifest                     |
| `worker`          | `protocol`, `core`, `blob` | Obsidian API                      | DO/R2/HTTP/WS                            |
| `obsidian-plugin` | 全 shared package          | Cloudflare Worker runtime 直接API | UI、Vault、IndexedDB、同期 orchestration |

この依存方向を守る。同期の知識が `obsidian-plugin` と `worker` に散るのは許すが、メッセージ型・メタデータ型・ハッシュ規則は `protocol/core/blob` に押し込める。

現在の `packages/obsidian-plugin` はまだ CM6/Yjs/disk behavior を検証する spike 段階だが、`src/main.ts` から sync runtime の純粋境界を分離しつつある。
`main.ts` は Plugin lifecycle、Obsidian command/event、Vault read/write、status/notice の concrete port に寄せ、`editor-binding.ts` は Obsidian MarkdownView から `EditorView` を取り出す adapter、`Y.Text` 用 CM6 extension、EditorView 全置換、Y.Text minimal replacement transaction を担当する。
`sync-engine.ts` は `packages/core` の `planClientStartup` を plugin-level effect 列に変換し、setup/local-scan/snapshot/local-store/websocket/outbox の coarse phase を付与する。
`startup-runtime.ts` は `sync-engine.ts` の startup effects と `local-store-schema.ts` の IndexedDB schema gate を合成し、metadata snapshot、schema probe、local meta YDoc 有無、local file 有無から `ClientStartupLocalState` を組み立てる。
壊れた metadata や schema probe failure は missing credentials として扱わず、startup planning 前に停止できる evidence failure とする。
`obsidian-startup-settings.ts` は Obsidian `data.json` や setup UI の raw settings から startup intent と setup exchange evidence を作る境界で、setup token material を failure state、Notice、log に混ぜない。
`obsidian-startup-evidence.ts` は settings reader と local storage/vault evidence reader を合成し、settings 由来の intent / expected bootstrap mode と local 由来の metadata/schema/YDoc/file evidence を一つの raw evidence にする。
`startup-actuation.ts` は startup plan を `SyncRuntimeShellState` と `run-runtime-effect` queue に変換し、local-store gate だけを network transport 未接続でも pump できるようにする。
`obsidian-shell-presentation.ts` は shell state から status bar text、未表示 Notice、repair panel entry、retry 可能性を導出し、UI handler が auth 状態や queue 起動可否を再判定しないための表示境界である。
`obsidian-shell-ui.ts` は presentation plan を status text、Notice、repair entries、retry enabled の concrete UI port に適用するだけの adapter で、status 文言や Notice drain は再判定しない。
`obsidian-shell-driver.ts` は evidence port、startup planner、actuation、local-store pump、setup exchange replan、startup step transport、presentation を 1 tick の driver state に束ねる。
`obsidian-shell-lifecycle.ts` は plugin lifecycle hook から呼ぶ stateful adapter で、driver state と presentation snapshot を保持し、driver transport tick の結果を `obsidian-shell-ui.ts` の UI port へ適用する。
同時に複数の startup tick が来ても同じ in-flight tick を返し、setup exchange、local-store gate、startup step、status/Notice 更新が Obsidian event の多重発火で二重実行されないようにする。
driver state は shell state、presentation snapshot、startup plan、replan 用 startup input を保持し、deferred effect が残っている間は Notice / runnable effect を増殖させない。
`setup-persist.ts` / `setup-persist-runtime.ts` は `persist-setup-response` step 用に SecretStorage 書き込み、metadata store put、metadata commit 失敗時の SecretStorage 補償を計画・実行する。
`auth-refresh-runtime.ts` は refresh attempt を HTTP port、access-token verifier、SecretStorage、metadata store に結線し、metadata commit 失敗時は上書き前の secret snapshot を restore する。
`snapshot-apply-runtime.ts` は latest snapshot response、decoded bytes、local safety evidence、current outbox snapshot から local YDoc 置換と cursor/state-vector patch、full-snapshot-required outbox release transaction をまとめる。
`outbound-queue.ts` は scheduler tick、auth refresh request、lease acquire/renew/release、ack/quarantine/failure completion を IndexedDB transaction 前提の plan に変換する。
`local-store.ts` / `local-store-driver.ts` / `local-store-indexeddb.ts` は ordered transaction operation、read set、commit validation、concrete IndexedDB read/write operation を分離し、runtime 側が store 名・key・値を再判断しないようにする。
`local-store-indexeddb.ts` は `createBrowserLocalStoreIndexedDbFactoryPort(indexedDB)` で browser/Electron の `IDBFactory` を schema open/delete と schema probe の共通 factory port に束ねる。
plugin composition root はこの factory port から local-store schema evidence、open/delete effect port、outbox transaction database port、metadata database port を組み立て、`main.ts` や lifecycle adapter が IndexedDB request/event の細部を扱わないようにする。
現在の `obsidian-runtime-composition.ts` は startup evidence reader、shell UI port、setup exchange port、startup step port、local-store effect port を `createSyncRuntimeObsidianShellLifecycle(input)` へ束ねる最小 composition root である。
未接続の side-effect family は fail-fast port にし、startup を成功扱いにせず `startup-step-failed` / `setup-exchange-failed` として shell state に残す。
`main.ts` は CM6/Yjs/disk spike を残したまま `Kuroflare sync: run startup tick` command からこの composition root を呼ぶ。
setup/settings UI と production local evidence reader がまだ無いため、onload でネットワーク startup tick は自動実行しない。
`websocket-runtime.ts` は trusted setup/auth metadata と SecretStorage の access token reader から browser-compatible WebSocket URL を組み立て、`open-websocket` step で socket open を待ち、`send-client-hello` step で `ClientHello` を送る。
Worker は registry/token/yClientId admission が通った場合だけ `hello-accepted` を返す。
plugin の `send-client-hello` step はこの `hello-accepted` の vaultId/deviceId/yClientId が local setup metadata と一致するまで完了しない。
hello 後に close/error した場合、または `hello-accepted` 以外や identity mismatch を受けた場合は startup step を fail し、`resume-background-queues` へ進めない。
Worker は browser から header を付けられない事情に合わせて `Sec-WebSocket-Protocol` token を受け付けるため、plugin runtime は `wss://<endpoint>/ws/<vaultId>` に `kuroflare.v1` と `kuroflare-token.<short-lived-token>` subprotocol を付けて接続する。
Worker は古い client / 手動検証用の互換経路として `access_token` query も受け付けるが、plugin は URL、snapshot、log、Notice に token を残さないため query token は使わない。
`createBrowserSyncRuntimeWebSocketFactory(WebSocket)` は browser/Electron の `WebSocket` constructor を runtime factory port に束ねる。
`createSyncRuntimeWebSocketSession()` は startup、outbox sender、inbound dispatcher が共有する active socket 境界で、`open-websocket` step は接続した socket をこの session に attach する。
outbox runner や state-vector request runner は startup step port の private closure から socket を取り出さず、session の `send` / `close` / `snapshot` だけを使う。
session は token material を持たず、socket 未接続または未 open の送信は `websocket-session-missing` / `websocket-session-not-open` として fail fast する。
`planSyncRuntimeWebSocketOutboxSend(input)` と `createSyncRuntimeWebSocketOutboxSendPort(input)` は leased `y-update` / `meta-ref-update` outbox record を `sync-update` control frame に直列化して active session へ送る。
この送信 port は `docId`、`messageId`、`updateBytesBase64` が欠けた outbox row を WebSocket I/O 前に拒否し、ack completion は server `Ack` / `NeedFullSnapshot` を受けた後だけ別 port で行う。
`parseSyncRuntimeWebSocketMessage(event)` は inbound `MessageEvent` の trust-boundary で、文字列 JSON だけを `parseControlMessage` に通し、binary payload や invalid control message を runtime decision に渡さない。
`attachSyncRuntimeWebSocketInboundMessageHandler(socket, handler)` と `createSyncRuntimeWebSocketStartupStepPort(..., onInboundMessage)` は socket の `onmessage` をこの parser に接続し、runtime 側には guarded control message か rejection reason だけを渡す。
`planSyncRuntimeWebSocketInboundRoute(input)` は parser 通過後の control message を、`ack` / `need-full-snapshot` は outbox completion、peer `sync-update` は local YDoc apply、peer `sync-request` は state-vector answer、invalid / vault mismatch / self broadcast / unexpected `hello` / startup admission 後に流れてきた `hello-accepted` は drop に分類する。
`ack` / `need-full-snapshot` は自端末の outbox side effect の完了証拠なので `deviceId` が local device と一致する場合だけ受け付け、peer device の ack は local outbox を触らず drop する。
`sync-update` / `sync-request` は peer からの同期入力なので local deviceId の self-broadcast は apply せず drop する。
`dispatchSyncRuntimeWebSocketInboundMessage(input)` は route 結果を `completeOutbox` / `applyRemoteUpdate` / `answerSyncRequest` / `drop` port のどれか一つに渡すだけにし、IndexedDB transaction、Yjs apply、state-vector diff 生成、metrics/logging の実 I/O は各 port 側へ閉じ込める。
composition root は `onInboundMessage` からこの dispatcher を呼び、UI / lifecycle / WebSocket adapter が outbox completion 条件や peer update 条件を再実装しないようにする。
`decodeSyncRuntimeWebSocketRemoteUpdate(message)` は peer `sync-update` の base64 update bytes を decode し、`updateSha256` が存在して実 bytes の SHA-256 と一致する場合だけ local apply 用 evidence を返す。
peer `sync-update` は server が append 後に確定した `durableSeq` を持つ。client -> server の outbound `sync-update` では未設定だが、Worker の peer broadcast と `sync-request` response は `durableSeq` を付与する。
`createSyncRuntimeWebSocketRemoteUpdateApplyPort(input)` はこの decode/hash/durableSeq 検証を通過した update だけを in-memory YDoc apply port に渡し、その apply 成功後に durable commit port へ cursor/update evidence を渡す。
`createSyncRuntimeWebSocketYjsRemoteUpdateApplyPort(input)` は loaded Y.Doc に `Y.applyUpdate` し、`Y.encodeStateAsUpdate` と `Y.encodeStateVector` から durable commit 用の compact YDoc state と state vector を返す。
`planSyncRuntimeWebSocketRemoteUpdateIndexedDbWriteTransaction(input)` / `createSyncRuntimeWebSocketRemoteUpdateIndexedDbCommitPort(input)` は apply 後の compact YDoc state を `meta-ydoc` / `file-ydocs` に、`durableSeq` と state vector を `remote-cursors` に同一 IndexedDB transaction で保存する。
invalid base64、missing update hash、missing durable seq、hash mismatch は YDoc と IndexedDB を触らず rejection observer だけに渡す。
`planSyncRuntimeWebSocketSyncRequestAnswer(input)` / `createSyncRuntimeWebSocketSyncRequestAnswerPort(input)` は peer `sync-request` の `stateVector` を decode し、loaded Y.Doc から `Y.encodeStateAsUpdate(doc, stateVector)` で差分 update を作り、local deviceId の outbound `sync-update` として active session に送る。
この返答 `sync-update` には `baseStateVector` と `updateSha256` を入れるが `durableSeq` は付けない。Worker が通常の inbound update として append し、その後 ack / peer broadcast に durableSeq を付ける。
stateVector が decode できない、または target Y.Doc が未ロードの場合は WebSocket I/O 前に rejection observer へ渡す。
`createSyncRuntimeWebSocketOutboxCompletionPort(input)` は `ack` / `need-full-snapshot` を current outbox / running lease snapshot に照合し、local `y-update` outbox record が 1 件だけ見つかる場合に限って `planOutboxWorkerAckCompletion` へ渡す。
`ack` は messageId と docId の両方で候補を絞り、`need-full-snapshot` は protocol message に messageId が無いため local record 側の messageId と docId を completion evidence として使う。
候補無し、候補複数、stale lease、owner mismatch、local-store commit validation failure は IndexedDB を変更せず、成功 plan だけを injected commit port に渡す。
この adapter は token を state snapshot に残さず、snapshot には redacted URL、hello、readyState だけを出す。
`local-store-schema.ts` / `local-store-repair.ts` は startup schema gate と degraded store repair flow を同期 side effect から分離する。
`outbox-worker.ts` は scheduler tick、local-store transaction、lease acquire CAS、IndexedDB operation plan をつなぐ pure orchestration で、side effect 開始や完了扱いは durable commit 成功後だけにする。
実 WebSocket、実 IndexedDB API 呼び出し、side effect 実行は次に plugin lifecycle へ繋ぐ concrete port として足していくが、ネットワーク/queue 実行は `src/sync/` 側へ置く。

`obsidian-shell-driver.ts` の setup transport 付き tick は、no-network tick と同じ shell state / presentation snapshot / startup plan に加えて、replan 用の直近 startup input を保持する。
queue 先頭が `run-setup-exchange` の場合だけ `SyncRuntimeSetupExchangePort` を実行し、port が戻り値として返す replan request を `applySyncRuntimeSetupExchangeShellReplan` に渡して同じ shell state に反映する。
driver は `snapshot().completed[index]` のような side-channel 相関を使わない。
成功時は setup response と直近 startup input から startup plan / runnable effect queue を差し替え、その後も local-store gate だけを pump できる。
HTTP failure、settings failure、replan request 欠落は setup token material を含まない `fail-runtime-effect` として shell に残し、WebSocket・snapshot・outbox は開始しない。
外部 port の `Error.message` は token や URL を含み得るため driver state / Notice / repair reason へ素通しせず、driver 内では `setup-exchange-failed` / `startup-step-failed` のような固定 reason code に正規化する。
no-network tick では従来どおり setup exchange / websocket / snapshot / outbox startup step を deferred として queue に残す。

`obsidian-shell-driver.ts` の startup step transport 付き tick は、同じ driver state から local-store gate を先に pump し、その後 queue 先頭から連続する `run-startup-step` だけを `SyncRuntimeStartupStepEffectPort` に渡す。各 step は port 成功後に `ack-runtime-effect` され、`resume-background-queues` の ACK で初めて background queues が running になる。途中の port failure は `fail-runtime-effect` として記録し、後続 step、WebSocket 後続処理、snapshot/outbox 起動を止める。queue 先頭がまだ `run-setup-exchange` の場合は startup step tick は何も実行しないため、setup exchange の成功 replan を必ず先行させる。

plugin lifecycle からは `createSyncRuntimeObsidianShellLifecycle(input).runStartupTick()` を基本入口にする。
この lifecycle adapter の内部だけが `runSyncRuntimeObsidianShellDriverTransportTick(input)` を呼び、no-network tick、setup transport 付き tick、startup step transport 付き tick をばらばらに呼ばせず、同じ driver state 上で `evidence read -> setup exchange -> setup response replan -> local-store gate -> startup steps -> presentation -> UI apply` の順に進める。
transport tick は evidence を 1 回だけ読み、local effect budget も tick 全体で共有し、presentation も最後に 1 回だけ計算する。
初回 setup が必要な vault では setup exchange の replan 後に local-store create/open を済ませ、その後 `persist-setup-response` などの startup step を実行する。
既存 vault では setup exchange が queue 先頭に無いので local-store gate 後に startup step へ直行する。
setup exchange failure、local-store failure、startup step failure はそれぞれ shell state の `fail-runtime-effect` / evidence failure に集約し、`main.ts` は順序、retry 判定、status/Notice drain を再実装しない。
`main.ts` が持つべき責務は Obsidian の concrete port 実装、lifecycle instance の生成、`onload` / foreground resume / settings change / retry command から `runStartupTick()` を呼ぶこと、`onunload` で timer や background queue を止めることだけにする。

`outbox-worker.ts` の成功 plan は、従来の next outbox records / next lease rows に加えて、実 IndexedDB transaction が読む key set、driver write、concrete IndexedDB read/write operation も持つ。scheduler persist、lease acquire、lease renew、full snapshot release、ack/quarantine/failure completion はすべて `local-store-driver.ts` の read set / commit / writes と `local-store-indexeddb.ts` の `get` / `put` / `delete` plan を通す。runtime 側は `planOutboxWorkerTickIndexedDbWriteTransactions(plan)` が返す `scheduler-persist -> lease-acquire...` の順序付き transaction、`planOutboxWorkerLeaseRenewalIndexedDbWriteTransaction(plan)` が返す `lease-renew` transaction、`planOutboxWorkerFullSnapshotReleaseIndexedDbWriteTransaction(plan)` が返す `full-snapshot-release` transaction、`planOutboxWorkerCompletionIndexedDbWriteTransaction(plan)` が返す item patch + lease release の `completion-persist` transaction を `commitLocalStoreIndexedDbConcreteWriteTransaction(input)` へ渡し、side effect 開始や完了扱いはその commit 成功後だけにする。

`planOutboxWorkerSideEffect(input)` は `start.id` と record id だけでなく `start.kind` と record kind も一致させる。kind mismatch は local store corruption または stale start evidence として I/O 前に拒否する。HTTP を使う `blob-put` / `blob-get` / `manifest-put` は current access token と endpoint を要求するが、active WebSocket に乗せる `meta-ref-update` と local disk I/O の `materialize` は HTTP endpoint を要求しない。blob cache に触る `blob-put` / `blob-get` / `materialize` は `localCacheKey` が `blob-cache/` namespace 内の normalized vault-relative path であることを検証し、absolute path、parent segment、空 segment、backslash、NUL を I/O 前に拒否する。`materialize` の `targetPath` も normalized vault-relative path に限定し、runner は永続 outbox row の文字列を OS path として直接信用しない。`manifest-put` は canonical blob manifest JSON を `PUT /blob-manifests/<manifest_hash>.json` へ送る計画を返し、runner は送信前に canonical bytes の hash が `blobManifestHash` と一致することを検証する。`meta-ref-update` は `docId/messageId/updateSha256/updateBytesBase64` を持つ meta YDoc `sync-update` を active WebSocket へ送る計画を返し、binary meta の fast path として `blobManifestHash` と manifest chunk hash list も plan に残す。

`blob-put` / `blob-get` / `manifest-put` / `materialize` は、runner が返した `success` / network / timeout / offline / HTTP status / local conflict / invalid payload evidence をまず `classifyOutboxWorkerSideEffectCompletionEvidence(input)` に通す。HTTP 401/403 は `auth`、408 は `timeout`、429 と 5xx は retryable API error、その他の非 2xx は non-retryable API error、local disk CAS mismatch は `local-conflict` へ正規化し、runner は retry/backoff/pause/dead-letter を直接判断しない。成功 evidence だけが `planOutboxWorkerSuccessCompletion(input)` に入り、`status="done"` patch と lease release を同じ local-store transaction に保存する。`y-update` と `meta-ref-update` は server Ack が durable op append の証拠なので、この success completion では閉じない。これらは従来通り `planOutboxWorkerAckCompletion(input)` で `Ack` または `NeedFullSnapshot` を処理し、stale lease / owner mismatch のときは item state を上書きしない。

`local-store-indexeddb.ts` は `local-store-driver.ts` の read set / writes を IndexedDB object store 操作へ写像する薄い adapter で、`outbox` store への `get` / `put`、`running-leases` store への `get` / `put` / `delete` の store 名・key・値を型付き plan として返す。実 IndexedDB 呼び出しはこの plan を順に実行するだけにし、どの store にどの key でアクセスするかを runtime 側で再判断しない。さらに schema startup effect の実行境界として `applyLocalStoreIndexedDbOpenEffect(input)` を持ち、`open-database` は `indexedDB.open(dbName, version)` の `upgradeneeded` 中だけ不足 store を `createObjectStore` し、`delete-database` は rebuild 前の `deleteDatabase` request を完了まで待つ。`LocalStoreIndexedDbTransactionPort` と `commitLocalStoreIndexedDbTransaction` は fake port / unit test 用の async 境界として残すが、実 IndexedDB database から入る `commitLocalStoreIndexedDbDatabaseTransaction` は `queueLocalStoreIndexedDbConcreteReads` で全 read request を同期発行し、最後の read success callback の中で local-store commit validation と write request queue まで済ませる。read result を `await` してから別 tick で `put/delete` しようとすると IndexedDB transaction が auto-commit / inactive 化し得るため、production runtime はこの queued transaction helper を使う。`commitLocalStoreIndexedDbDatabaseTransaction` は request 成功後さらに transaction `complete` まで待ってから成功を返す。`abort` / `error` は request が成功していても durable commit 失敗として reject し、side effect 完了扱いには進めない。テストでは fake IndexedDB factory / fake object store / fake transaction lifecycle を使い、schema open/delete、request boundary、`put` key、`delete` key、read/write log、read callback 内の write queue、complete 待ち、abort reject を固定する。

---

## 14. ローカル永続状態と Vault 内ファイル

### 14.1 Vault に置くもの

Vault 内に置く同期メタデータは最小化する。`.obsidian` は端末固有設定が多く同期対象から外す前提なので、プラグイン専用ディレクトリを切る。

```
.obsidian/plugins/kuroflare/data.json
  - endpoint
  - vaultId
  - deviceId
  - auth secret reference（可能なら SecretStorage 側の key。token 本体は保存しない）
  - ignore rules
  - sync mode flags

.obsidian/kuroflare/
  file-ids.json        # 初期導入・障害復旧用の path -> fileId キャッシュ
  repair-log.jsonl     # 自動修復イベント。UIで読めるようにする
```

`file-ids.json` は真実ではない。真実はメタ YDoc。ローカル起動を速くする cache として使い、メタ YDoc と食い違ったらメタ YDoc を勝たせる。

### 14.2 IndexedDB に置くもの

```
db: kuroflare:<vaultId>
  metadata               # schemaVersion, vaultId, deviceId, yClientId, endpoint, auth metadata
  meta-ydoc              # y-indexeddb が保持する meta YDoc またはその anchor
  file-ydocs             # <ydocId> -> per-file YDoc anchor
  remote-cursors         # docId -> 最後に durable ack された seq / stateVectorBase64
  last-materialized      # fileId/path -> diskHash, ydocHash, writeId
  outbox                 # 未送信 Yjs update / blob / materialize の永続 queue
  running-leases         # scheduler side effect の lease CAS 用
  blob-cache             # chunk_sha256 -> optional local chunk bytes / cache key
```

IndexedDB が壊れても Vault 本体と R2 から再構築できるようにする。逆に、Vault 本体が壊れても IndexedDB + R2 から materialize できるようにする。どちらも source of truth ではないが、片方が残れば復旧できる設計にする。

`outbox` record は kind 共通の status / dependsOn / retry metadata に加えて、side effect runner が I/O 前に検証できる evidence を持つ。blob 系では `fileId`、`blobSha256`、`blobManifestHash`、`blobManifest`、`materializeChunks`、`localCacheKey`、`blobSize`、materialize / download 系では `expectedHash`、`targetPath`、`lastMaterialized` を保存し、lease 取得後の runner が「どの local cache entry を、どの hash/size として、どの remote endpoint または Vault path に送るか」を outbox record だけから決められるようにする。`blob-put` は cache read evidence、`blob-get` は cache write evidence、`materialize` は manifest chunk cache read と disk CAS evidence として使う。これらが欠ける record は repair/import 由来であっても自動実行せず、failure completion または manual repair に回す。

upload 側では `manifest-put` が `blobManifestHash` と `blobManifest` を必須にし、`meta-ref-update` がそれに加えて `docId`、`messageId`、`updateSha256`、`updateBytesBase64` を必須にする。これにより「chunk upload は終わったが manifest/meta 更新の evidence が足りない」record を推測で補完せず、failure completion か repair panel に回せる。

local store schema は plugin bundle が `targetVersion` と `minimumReadableVersion` を持つ。起動時は IndexedDB schema gate の前に `local-store-indexeddb.ts` の `readLocalStoreIndexedDbSchemaEvidence(input)` で、存在有無、現在 version、存在する object store 名、pending outbox 件数を読む。この probe は `indexedDB.databases()` 相当の directory API で DB 存在を確認し、存在しない DB を `open()` して暗黙作成しない。既存 DB だけを version 指定なしで開き、known store 名だけを `presentStores` に写し、`outbox` store が存在する場合だけ readonly transaction で `count()` する。`outbox` store が欠けている DB は pending 0 と証明できないため、conservative に pending ありとして schema decision を degraded 側へ倒す。directory API が無い環境では missing DB を非破壊に証明できないので、sync startup は `database-directory-unavailable` として止め、ユーザーに Obsidian/Electron の IndexedDB 対応状況を示す。得られた evidence を `packages/core/src/local-store.ts` の `decideLocalStoreSchema(input)` に通す。

- DB が無ければ `create(targetVersion)` し、必要 store を全部作る。この時点で pending outbox があるという evidence は矛盾なので reject。
- `currentVersion == targetVersion` かつ required store が揃っていれば `open`。
- `minimumReadableVersion <= currentVersion < targetVersion` は `upgrade`。足りない store だけ versionchange transaction で作り、既存 outbox と cursor は保持する。
- `currentVersion < minimumReadableVersion` は古すぎて migration を信用しない。pending outbox が 0 なら local DB を捨てて remote snapshot / Vault scan から rebuild してよい。pending outbox が 1 件でもあるなら degraded にして repair panel へ出し、ユーザーが local edits を捨てるか export するまで自動 rebuild しない。
- `currentVersion > targetVersion` は新しい plugin が作った store の可能性があるので degraded。古い plugin で開いて書き換えない。
- required store が欠けているのに version が最新の場合は破損扱い。pending outbox が 0 なら rebuild、pending outbox が残るなら degraded。`outbox` store 欠落を「空 queue」とみなしてはいけない。

`decideLocalStoreSchema` の action は startup planner の前段 gate として扱う。plugin 側の `local-store-schema.ts` は `planLocalStoreIndexedDbOpen(input)` で core decision を vault ごとの DB 名 `kuroflare:<vaultId>` と IndexedDB effect list に変換する。`create/open/upgrade` は `startupGate="continue"` として `planClientStartup` へ進める。`rebuild` は `delete-database` と全 required store を作る `open-database(mode="create")` を返し、local YDoc/cursor/cache を初期化したうえで startup を `restore-local-meta-snapshot` または setup flow へ戻す。`degraded/reject` は `hold-degraded` / `reject-open` effect だけを返し、同期 side effect を開始せず、status bar と repair panel に出す。

local store degraded repair は「export してから rebuild」「明示 discard して rebuild」「何もしない」の 3 経路だけにする。pending outbox がある degraded store では、repair panel はまず outbox と metadata を `.obsidian/kuroflare/repair-exports/kuroflare-local-outbox-<timestamp>.json` に export できるようにする。plugin 側の `local-store-repair.ts` は `planLocalStoreRepair(input)` で core repair decision を `write-repair-export`、`delete-database` + `open-database(mode="create")`、`keep-degraded`、`reject-repair` の effect に変換する。`buildLocalStoreRepairExport(input)` は export effect が書く JSON payload を `protocol` の `LocalOutboxRepairExport` として組み立て、`isLocalOutboxRepairExport` / `isLocalOutboxRepairExportEntry` を通らない record は書き出し前に拒否する。`done` item、`createdAt` 欠落、不正な `retryCount`、不正 base64 の update body は export しない。`planLocalStoreRepairImport(input)` は guarded repair export と fresh durable/quarantine evidence を core の import decision に通し、安全な `y-update` だけを `stage-repair-import` effect に変換する。staged item は `paused` / `resumeOn="manual"` / `reason="imported-repair-export"` で local outbox に置き、ユーザー確認なしに再送しない。`planLocalStoreRepairImportStageTransaction(plan)` は stage effect を `put-outbox` operation に変換し、driver の read set で同じ outbox ID が既に存在しないことを確認してから insert する。`planLocalStoreRepairImportResume(input)` は staged item を再送前にもう一度 user confirmation、durable evidence、quarantine evidence に通し、確認済みかつ未 durable / 未 quarantine の時だけ `resume-repair-import` effect と pending patch を返す。`planLocalStoreRepairImportResumeTransaction(plan)` はこの effect を `repair-import-resume` patch に変換し、通常の local-store transaction / IndexedDB driver と同じ保存経路に流す。blob / materialize / dependency 付き item、server durable 済み、server quarantine 済み、local duplicate は skip evidence として残す。export が完了していない限り `rebuild-after-export` は拒否する。`discard-and-rebuild` は local 未送信 update を失うので、確認文言付きの明示 confirmation がある時だけ許可する。pending outbox が 0 の場合だけ、export/confirmation なしで rebuild してよい。

現在の `packages/core/src/local-store.ts` 実装は、この repair 境界を `decideLocalStoreRepair(input)` として持つ。`schemaDecision` が degraded でない時は repair action を開始しない。`export-pending-outbox` は deterministic な export 名と include flags だけを返し、実ファイル書き込みは plugin の Vault adapter が行う。`rebuild-after-export` は `exportCompleted=true`、`discard-and-rebuild` は `discardConfirmed=true` を要求する。これにより「壊れた IndexedDB を直すために、唯一残っている未送信 Yjs update を黙って消す」経路を閉じる。plugin 側の `packages/obsidian-plugin/src/sync/local-store.ts` は IndexedDB API を直接触る前段として、`outbound-queue.ts` の successful plan と repair import plan だけを受け取り、同一 transaction で適用する outbox put / outbox patch / lease CAS operation の ordered list を返す。さらに commit 直前の snapshot に対して `planLocalStoreTransactionCommit` を通し、outbox item 欠落、既存 ID への repair import insert、重複 put、lease CAS mismatch があれば item patch も lease release も適用しない。`applyLocalStoreOutboxPatch` が patch 種別ごとの永続 record 更新を一元化するため、実 driver はこの operation list / commit plan / patch application を IndexedDB transaction に写像するだけにし、Ack/quarantine/full snapshot/repair import resume の保存順序、CAS 条件、record field の更新規則を driver 側で再解釈しない。`packages/obsidian-plugin/src/sync/local-store-driver.ts` は operation list から `planLocalStoreDriverReadSet` で `outbox` と `running-leases` の key read set を導出し、`selectLocalStoreDriverSnapshot` で読み取った rows だけを transaction snapshot にする。selection は read set order を保ち、存在しない row は snapshot から省く。欠落 outbox item、既存 outbox item、missing/stale lease は次の `applyLocalStoreDriverCommit` が `missing-outbox-item` / `existing-outbox-item` / `lease-cas-mismatch` として拒否する。driver は同一 IndexedDB transaction でその rows を読み、`applyLocalStoreDriverCommit` に snapshot と operations を渡す。成功時は返された `writes` だけを同じ transaction 内で実行する。`put-outbox-record` は repair import の新規 staged row または patch 対象 row だけを書き戻し、`put-lease-row` は取得/延長した lease row だけを書き、`delete-lease-row` は完了/失敗/一時停止後の release 対象だけを消す。`applyLocalStoreDriverWrites` はこの write list を snapshot に replay する検証用境界で、`delete-lease-row` は現在 row が `expectedLease` と一致する場合だけ消す。`applyLocalStoreDriverTransaction` は read set 導出、selection、commit、write replay を 1 つにまとめた実行可能な手順書で、未読 row を保持した full store snapshot を返す。実 IndexedDB driver はこの pipeline と同じ順序で、同じ transaction 内に read / validation / write を置く。`packages/obsidian-plugin/src/sync/local-store-indexeddb.ts` はこの pipeline の read set / writes を `outbox` と `running-leases` object store の concrete `get` / `put` / `delete` plan に落とす。read set に必要 row が存在しない、または lease CAS が変わっていた場合は commit plan が失敗になり、driver は部分書き込みをしない。

repair export は将来の plugin / CLI / 手動調査で読めるよう、protocol package の guard が検証できる JSON に固定する。

```
{
  "format": "kuroflare-local-outbox-export",
  "formatVersion": 1,
  "exportedAt": 1700000000000,
  "vaultId": "...",
  "deviceId": "...",
  "metadata": {
    "localStoreVersion": 1,
    "targetStoreVersion": 3,
    "degradedReason": "store-version-too-old-with-pending-outbox"
  },
  "entries": [
    {
      "id": "outbox-...",
      "kind": "y-update",
      "status": "pending",
      "dependsOn": [],
      "createdAt": 1700000000000,
      "retryCount": 0,
      "docId": { "kind": "file", "ydocId": "..." },
      "messageId": "...",
      "updateSha256": "...",
      "updateBytesBase64": "..."
    }
  ]
}
```

`packages/protocol/src/local-repair.ts` は `isLocalOutboxRepairExport` / `isLocalOutboxRepairExportEntry` を持つ。format marker、version、vault/device ID、schema metadata、bounded entries、bounded dependency IDs、outbox kind/status、DocId/FileId/MessageId、SHA-256、base64 update bytes を unknown から検証する。export は import 用の権威ではなく「失われる前の未送信 evidence」なので、後から import する場合も必ず現在の remote cursor / messageId dedup / quarantine 状態と照合してから replay する。

repair export の import は即 replay ではなく、まず paused outbox item として staging する。`packages/core/src/local-store.ts` の `planLocalOutboxRepairImport(input)` は guarded export、現在の vault/device、既存 local outbox IDs、server 側で既に durable と分かっている `(docId,messageId)`、quarantine 中の `(docId,messageId,updateSha256?)` を受け取る。vault/device が違う export、重複 export ID、壊れた durable seq は file-level reject にする。entry 単位では、`y-update` 以外、`failed` / `blocked`、依存付き item、`docId/messageId/updateSha256/updateBytesBase64` が欠ける item、既存 outbox ID と衝突する item、既に durable な message、server quarantine と一致する message は staging しない。staging できる `y-update` も `status="paused"`, `reason="imported-repair-export"`, `resumeOn="manual"` として保存し、ユーザーが repair panel で内容・hash・server 状態を確認してから手動 resume する。

staged import の resume は通常の manual resume より強い gate を持つ。repair panel は resume 直前に server の durable evidence と quarantine list/detail を再取得し、`decideLocalOutboxRepairResume(input)` に渡す。ユーザー確認が無い場合、同じ `(docId,messageId)` が既に durable な場合、同じ `(docId,messageId,updateSha256?)` が quarantine 中の場合は pending に戻さない。通った場合だけ `status="pending"`, `nextAttemptAt=undefined`, `resumeReason="user-confirmed-repair-import"` を同一 IndexedDB transaction で保存し、その後は通常 outbox scheduler の dependency/concurrency/lease/ack gate を通る。staging から時間が経った export item を、古い server evidence のまま再送してはいけない。

blob upload/download、manifest PUT、materialize の export entry は初期 import では自動復元しない。local cache key が同じ端末上で有効か、blob が既に R2 にあるか、materialize base hash がまだ正しいかを export だけから証明できないため、rebuild 後の通常 scan/head/materialize planning で再生成する。依存付き outbox item も同じ理由で skip し、依存 graph を壊した部分復元をしない。

### 14.3 Obsidian Vault API の使い方

- テキスト読み込みは `cachedRead` ではなく、外部変更を拾う必要がある箇所では `read` を使う。
- 書き込みは `Vault.modify` / `Vault.create` / `Vault.rename` / `Vault.delete` 経由に寄せる。直接 filesystem adapter を触るのは、chunk cache など Vault 外/隠し領域だけ。
- `vault.on('create')` は起動時に大量発火しうるので、layout ready 前のイベントは初回 scan として扱い、通常 watcher と分ける。
- `registerEditorExtension` で CM6 extension を登録する。ただし active editor の `EditorView` 取得は Obsidian の公開 API だけで足りない可能性があるため、ここだけ adapter に閉じ込める。

---

## 15. Wire Protocol

### 15.1 WebSocket は Yjs と制御メッセージを分ける

Yjs update は binary frame、制御系は JSON frame にする。すべての frame に `protocolVersion`, `vaultId`, `docId`, `deviceId`, `messageId` を持たせ、再送を idempotent にする。

```
type DocId =
  | { kind: "meta" }
  | { kind: "file"; ydocId: string };

type ClientHello = {
  type: "hello";
  protocolVersion: number;
  vaultId: string;
  deviceId: string;
  yClientId: number;       // Yjs clientID。devices.y_client_id と一致必須
  capabilities: string[];  // "awareness", "binary-v1", ...
};

type SyncRequest = {
  type: "sync-request";
  messageId: string;
  docId: DocId;
  stateVector: string;     // base64 encoded Y.encodeStateVector
};

type SyncUpdate = {
  type: "sync-update";
  messageId: string;
  docId: DocId;
  update: string;          // base64。実装では binary frame へ逃がす
  updateSha256?: string;   // sender が載せた場合は payload hash と照合
  baseStateVector?: string;
};

type Ack = {
  type: "ack";
  messageId: string;
  docId: DocId;
  durableSeq: number;
};

type NeedFullSnapshot = {
  type: "need-full-snapshot";
  docId: DocId;
  reason: "state-vector-too-old" | "missing-log" | "protocol-upgrade" | "large-update-snapshot";
};
```

実装上は binary frame に JSON field をそのまま載せられないので、Yjs update は小さい binary envelope を付ける。

```
binary frame:
  magic:        2 bytes   "KF"
  version:      u16
  headerLength: u32
  headerJson:   utf8      { type, messageId, vaultId, docId, deviceId, updateSha256? }
  updateBytes:  bytes     Yjs update
```

Yjs update はそれ自体が冪等だが、transport の ack は必要。ack がない場合、クライアントは同じ update を再送する。DO は `messageId` の重複を短期キャッシュで無視してもよいし、単に `Y.applyUpdate` してもよい。永続 op log の重複だけは避けたいので、`messageId` unique 制約で弾く。

`Ack` は「DO の SQLite op_log にこの update が durable append 済みである」ことだけを意味する。client は ack の `vaultId`、`deviceId`、`docId`、`messageId` が pending outbox item と完全一致し、`durableSeq` がその doc で既知の durable seq より新しい場合だけ、その `y-update` item を `done` にできる。別 doc / 別 message / 別 device の ack を流用してはいけない。`NeedFullSnapshot` は ack ではなく、差分同期を続ける前に full snapshot 境界へ戻る要求として扱う。

現在の `packages/protocol` 実装は、この wire 境界の最小ランタイム検証を持つ。

- `vaultId` / `deviceId` / `messageId` / `ydocId` は branded string とし、`[A-Za-z0-9][A-Za-z0-9._:-]{0,127}` だけを受け付ける。
- `DocId` は `{ kind: "meta" }` と `{ kind: "file"; ydocId }` の discriminated union にする。path は wire protocol に載せない。
- JSON control message は `hello` / `hello-accepted` / `sync-request` / `sync-update` / `ack` / `need-full-snapshot` を `parseControlMessage` で unknown から検証する。
- JSON fallback の `stateVector` / `update` / `baseStateVector` は base64 文字列だけ受け付ける。`updateSha256` がある場合は SHA-256 hex として検証する。主経路は binary frame なので、JSON update は bootstrap/debug 用の逃げ道として扱う。
- binary frame は `encodeBinaryFrame` / `decodeBinaryFrame` で `KF` magic、u16 protocol version、u32 header length、JSON header、payload bytes を round-trip する。header は `BinaryFrameHeader` として control message と同じ ID/version/hash guard を通す。client から Worker へ送る binary frame は `durableSeq` を持たず、Worker は永続 append 後に header へ `durableSeq` を付けて再エンコードしてから peer へ broadcast する。
- `decodeBinaryFrame` は壊れた magic/version/header length/schema を `null` として拒否する。`updateSha256` が header / JSON message に存在する場合、Worker 側 quarantine pipeline が実 payload bytes の SHA-256 と照合し、ズレた update は `hash-mismatch` として隔離する。Yjs update 妥当性と meta schema は Worker 側で検証する。
- `VaultRoom` runtime は binary frame を任意 broadcast せず、`decodeBinaryFrame` が通った payload だけを既存の `sync-update` append/quarantine/ack pipeline に流す。hello 前 binary frame は `hello-required`、壊れた binary frame は `invalid-binary-frame` として close し、peer へは送らない。broadcast 先も hello 済みで `sessionStates` または hibernation attachment から session を復元できる socket だけに限定し、upgrade 済みだが hello 未完了の socket へ Yjs plaintext を送らない。binary broadcast は受信 frame をそのまま転送せず、append で確定した `durableSeq` 付き header と元 payload から新しい frame を作る。
- WebSocket upgrade の device access token は `Authorization: Bearer ...` を第一候補にする。ただし browser/WebView は WebSocket custom header を付けられないため、plugin runtime は `Sec-WebSocket-Protocol: kuroflare.v1, kuroflare-token.<jwt>` を使う。Worker runtime は WebSocket に限って `?access_token=<jwt>` query parameter も互換経路として受け付けるが、plugin は query token を使わない。HTTP endpoint は引き続き Authorization header を使う。
- `packages/worker/src/sync-request.ts` の `decideSyncRequest(input)` は、guard 済み `SyncRequest` と caller が読んだ doc retention/diff evidence から、`send-update` / `no-update` / `need-full-snapshot` / `reject` を決める。`stateVectorCoversHorizon=false` は `NeedFullSnapshot(reason="state-vector-too-old")`、snapshot+residual から diff source を復元できない場合は `NeedFullSnapshot(reason="missing-log")` にする。diff が空なら WebSocket へ空 update を送らず `no-update` にし、実 Yjs diff 生成と R2/SQLite I/O は caller 側に残す。
- `packages/worker/src/sync-update.ts` の `decideSyncUpdateQuarantine(input)` は、decoded update bytes の hash、Yjs apply 結果、meta schema validation 結果から append 前の隔離判定を行う。runtime は `SyncUpdate.updateSha256` / `BinaryFrameHeader.updateSha256` が存在する場合に `expectedUpdateSha256` として渡す。`hash-mismatch`、`yjs-apply-failed`、`meta-schema-invalid` は `quarantined_updates` row を返し、caller は op_log/docs/YDoc を更新せず、ack も返さない。quarantine row は repair/admin panel で inspect するための耐久 evidence であり、client 完了証拠ではない。
- `packages/worker/src/sync-update.ts` の `decideSyncUpdateAppend(input)` は、guard 済み `SyncUpdate` と decoded update evidence から `append-op` / `ack-duplicate` / `snapshot-escape` / `reject` を決める。既存 `(docId,messageId)` は `message_dedup.durable_seq` を証拠にし、新しい seq を採番せず既存 `durableSeq` で ack を再送する。新規 update は `latestSeq + 1` を割り当て、通常サイズなら `op_log` append と `docs.latest_seq` patch を同一 transaction へ渡す。`largeUpdateThresholdBytes` を超える場合は op_log に詰めず、snapshot escape として `NeedFullSnapshot(reason="large-update-snapshot")` 境界を返す。
- `packages/core/src/outbox.ts` の `decideOutboxAckCompletion(input)` は、guard 済み `Ack` / `NeedFullSnapshot` を local outbox item の完了証拠として採用できるかを判定する。`y-update` 以外の item、terminal / paused item、vault/device/doc/message mismatch、古い `durableSeq` は完了扱いにしない。`NeedFullSnapshot` は `done` にせず `paused(reason="full-snapshot-required", resumeOn="manual")` に落とし、snapshot fetch / local reset の別フローへ渡す。
- 同じ module の `decideOutboxQuarantinePause(input)` は、admin quarantine list/detail で見つかった `QuarantinedUpdateEntry` を outbound `y-update` item と照合し、device/doc/message と任意の update hash が一致した場合だけ `paused(reason="server-quarantine", resumeOn="manual", quarantineId)` に落とす。これは ack ではないので durable cursor を進めず、repair panel へのリンクだけを保存する。
- 同じ module の `planOutboxFullSnapshotRelease(input)` は、full snapshot apply 後に対象 doc の `paused(reason="full-snapshot-required")` な `y-update` item を `done(completedBy="full-snapshot-apply")` に閉じる。これは通常の resume ではない。古い差分を再送すると full snapshot loop に戻るため、snapshot apply transaction で terminal にする。
- `packages/core/src/snapshot.ts` の `decodeFullSnapshotBytesFromResponse(input)` は、guard 済み latest snapshot response の `updateBytesBase64` と `stateVector` を bytes に戻し、任意の size limit を確認し、`updateSha256` / `stateVectorSha256` と実 bytes の SHA-256 を照合する。`invalid-base64`、`snapshot-too-large`、`state-vector-too-large`、`hash-mismatch`、`state-vector-hash-mismatch` は区別して返し、caller は Yjs apply 前に止める。
- 同じ module の `makeFullSnapshotApplyInputFromResponse(input)` は、guard 済み `MetaLatestSnapshotResponse` / `DocLatestSnapshotResponse` と実 bytes の hash、local safety evidence を `decideFullSnapshotApply` の入力へ正規化する。meta response は `docId={kind:"meta"}` として扱い、file reset に meta response を流用した場合は後段で `doc-mismatch` になる。
- 同じ module の `decideFullSnapshotApply(input)` は、取得済み snapshot update を local YDoc に適用してよいかを判定する。要求した `docId` と snapshot の `docId` が一致し、HTTP metadata の `updateSha256` と実 bytes の hash が一致し、snapshot seq が local cursor より新しく、対象 doc に未送信 outbox がなく、active editor binding が外れている場合だけ apply できる。`apply` patch は `snapshotSeq` / `remoteCursorSeq` に加えて `stateVectorBase64` を返し、次回の SV exchange が古い state vector を送らないようにする。未送信 local update や active editor がある場合は overwrite せず待機する。
- `packages/core/src/local-store.ts` の `decideLocalStoreSchema(input)` は、plugin の IndexedDB を create/open/upgrade/rebuild/degraded/reject のどれにするかを決める。`currentVersion > targetVersion` は古い plugin で新しい store を壊さないため degraded、古すぎる store や required store 欠落は pending outbox が 0 の時だけ rebuild できる。pending outbox がある場合は local edit loss を避けるため degraded にし、repair/export flow へ渡す。同じ module の `decideLocalStoreRepair(input)` は degraded store の repair panel 操作を export / rebuild-after-export / discard-and-rebuild / keep-degraded に限定し、pending outbox がある rebuild は export 完了または discard confirmation なしでは許可しない。
- 同じ module の `planLocalOutboxRepairImport(input)` は local outbox repair export を安全な paused `y-update` 候補へ staging する。export は vault/device と一致し、export 内 ID が一意で、server evidence の durable seq が健全な場合だけ読む。staging 対象は依存なしの pending/retrying/paused `y-update` だけで、既に durable な message や quarantine 中の message は skip する。import 後も自動送信せず、manual resume と通常 outbox scheduler の dependency/concurrency/ack gate を通す。
- 同じ module の `decideLocalOutboxRepairResume(input)` は staged import item の手動 resume 直前 gate。`userConfirmed=true`、fresh durable evidence に同じ message が無い、fresh quarantine evidence に同じ update が無い場合だけ pending patch を返す。これは `decideOutboxResume(manual)` の前段であり、imported repair item を一括 manual resume で雑に流さないための追加確認にする。
- `packages/core/src/startup.ts` の `planClientStartup(input)` は、plugin 起動時の intent、local IndexedDB evidence、guard 済み `SetupExchangeResponse` から `bootstrap-new-vault` / `join-existing-vault` / `reconnect` / `restore-local-meta-snapshot` のどれに入るかを決める。new vault は local scan と meta 作成を先に進め、join existing は remote meta snapshot apply が終わるまで local file adoption をしない。reconnect は既存 device credentials と local meta YDoc が揃う時だけ ClientHello へ進み、schema が新しすぎる、vaultId が違う、setup intent と server bootstrapMode が食い違う場合は同期を始めない。

### 15.2 HTTP API

```
GET  /health
POST /setup/exchange              # setup URI の one-time token を device token に交換
POST /auth/refresh                # refresh token を短命 access token に交換
GET  /vaults/:vaultId/meta/latest # join/bootstrap 用 meta snapshot
GET  /vaults/:vaultId/files/:ydocId/latest # NeedFullSnapshot 用 file snapshot
POST /blobs/head                  # chunk hashes -> exists[]
POST /blobs/upload-url            # small PUT proxy URL or multipart init 情報
PUT  /blobs/:sha256?size=N        # 認証付き upload proxy。hash/size 検証後 R2 PUT
GET  /blobs/:sha256               # 認証付き download proxy。hash 検証後 bytes を返す
PUT  /blob-manifests/:sha256.json # canonical manifest JSON を hash 検証後 R2 PUT
GET  /blob-manifests/:sha256.json # canonical manifest JSON を hash 検証後返す
POST /devices/:deviceId/revoke    # 紛失端末の失効
POST /admin/gc                    # blob/tombstone GC の dry-run/execute
GET  /admin/quarantine            # quarantined update 一覧/詳細 inspect
POST /admin/quarantine/:id/discard
POST /admin/quarantine/:id/force-apply
POST /admin/force-local           # 手動エスケープハッチ
POST /admin/force-remote
POST /admin/rebuild
```

R2 の public URL を直接配るより、初期実装は Worker 経由で認証を一元化する。`/blobs/upload-url` の `single-put.url` は同一 Worker origin の `/blobs/:sha256?size=N` を返し、client は現在の device access token を Authorization header に付けて PUT する。response の `expiresAt` は client が upload-url を再取得するための advisory TTL であり、Worker proxy PUT の認可条件にはしない。署名なし query param は client が改ざんできるため、防御境界は device token scope、body size、Content-Length、streaming read limit、path の SHA-256、vault-scoped R2 key に置く。Worker は body size と SHA-256 が URL の `size` / `:sha256` と一致する場合だけ `vaults/<vaultId>/blobs/<sha256>` へ R2 PUT する。GET も R2 から読んだ bytes の SHA-256 を `:sha256` と照合してから返す。MVP は single PUT proxy のみで、16MiB 以上または `multipart=true` は `blob-upload-url:multipart-unimplemented` として拒否する。multipart/presigned は後続実装で接続する。個人用途なので、まずは単純さを優先する。

`/blobs/head` は数千 chunk を投げられるため、1 request の上限を決める（例: 512 hashes）。超える場合はクライアントがページングする。admin の `force-remote` / `rebuild` / `gc execute` は破壊的なので、dry-run と確認 token を必須にする。

Admin endpoint は共通 payload として `operation: "gc" | "force-local" | "force-remote" | "rebuild"` と `mode: "dry-run" | "execute"` を持つ。dry-run request は confirmation token を含めず、dry-run response が `confirmationToken` と planned `effects` を返す。execute request はその token を必須にし、execute response は token を返さず applied `effects` だけを返す。これにより古い token の誤送信や、dry-run を飛ばした destructive operation を protocol guard で拒否する。

`/devices/:deviceId/revoke` は idempotent にする。active device を revoke する時は registry の `tokenVersion` を少なくとも 1 つ進め、既存 JWT を `stale-token` として拒否できるようにする。すでに revoked の device へ同じ request が来た場合は `already-revoked` として現在の `revokedAt` / `tokenVersion` を返し、再度 version を進めない。

主要 payload:

```
POST /setup/exchange
request:
  { vaultId, setupToken, requestedDeviceName, existingDeviceId? }
setup issue response:
  { endpoint, vaultId, setupToken, setupUri, issuedAt, expiresAt }
response:
  {
    endpoint,
    vaultId,
    deviceId,
    yClientId,
    accessToken,
    refreshToken,
    tokenVersion,
    protocolVersion,
    bootstrapMode: "new-vault" | "join-existing"
  }

GET /vaults/:vaultId/meta/latest
response:
  {
    manifestSeq,
    snapshotKey,
    snapshotSeq,
    updateSha256,
    stateVectorSha256,
    stateVector,
    updateBytesBase64
  }

POST /blobs/head
request:
  { hashes: string[] } // max 512
response:
  { exists: Record<string, { found: boolean; size?: number }> }

POST /blobs/upload-url
request:
  { sha256, size, multipart?: boolean }
response:
  | { kind: "already-exists" }
  | { kind: "single-put"; url; headers; expiresAt }
  | { kind: "multipart"; uploadId; parts: Array<{ partNumber; url; headers }>; expiresAt } // protocol reserved; Worker MVP rejects multipart

PUT /blobs/:sha256?size=N
request body:
  raw bytes
response:
  { status: "stored", sha256, size }

PUT /blob-manifests/:sha256.json
request body:
  BlobManifest JSON
response:
  { status: "stored", sha256, size }

GET /blob-manifests/:sha256.json
response body:
  canonical BlobManifest JSON

GET /health
response:
  {
    status: "ok" | "degraded",
    protocolVersion,
    checkedAt,
    checks: Array<{
      name: "worker" | "durable-object" | "sqlite" | "r2" | "migrations",
      status: "ok" | "degraded",
      detail?: string
    }>
  }
```

`packages/protocol/src/health.ts` は `GET /health` response guard を持つ。`isHealthResponse` は supported `protocolVersion`、non-negative `checkedAt`、重複のない bounded check 配列、`status: "ok" | "degraded"` を検証する。top-level `status` が `ok` のときに degraded check が混じる response は拒否し、Worker/DO/SQLite/R2/migrations 以外の check 名は公開 protocol として受け付けない。

`/health` は人間と監視向けの概況であり、特定 vault の sync 受理可否の権威ではない。schema migration と SQLite は vault ごとの Durable Object 内にあるため、DO#A は ready、DO#B は migration pending という状態が普通に起きる。WS accept / op append の最終 gate は各 DO の startup check が持つ。R2 が degraded のときは public health は `degraded` を返すが、DO と SQLite と schema が ready なら durable op append は継続し、止めるのは checkpoint / snapshot / blob data plane に限定する。

`packages/protocol/src/setup.ts` はこの setup exchange payload の wire guard を持つ。`isSetupExchangeRequest` は `vaultId`、non-empty `setupToken`、non-empty `requestedDeviceName`、任意の `existingDeviceId` を unknown から検証する。`isSetupTokenIssueResponse` は endpoint、vaultId、setupToken、`kuroflare://setup?...` URI、`issuedAt < expiresAt` を検証し、URI 内の endpoint/vaultId/setupToken が response 本体と一致しないものを拒否する。`isSetupExchangeResponse` は endpoint、vault/device ID、正の `yClientId`、access token、refresh token、正の `tokenVersion`、supported `protocolVersion`、`bootstrapMode` を検証する。endpoint は http/https URL のみを許し、credential や fragment 付き URL は拒否する。

`packages/protocol/src/blob-http.ts` は blob data plane の HTTP payload guard を持つ。`isBlobHeadRequest` は SHA-256 hash 配列を unknown から検証し、1 request の上限を `MAX_BLOB_HEAD_HASHES = 512` に固定する。`isBlobHeadResponse` は hash key ごとの `{ found, size? }` を検証し、`found=false` では `size` を持たせない。`isBlobUploadUrlRequest` は upload 対象 hash、non-negative safe integer の size、任意の multipart flag を検証する。`isBlobUploadUrlResponse` は `already-exists` / `single-put` / `multipart` を discriminated union として検証し、upload URL は http/https かつ credential/fragment なし、headers は CR/LF を含まない文字列だけを許す。

`packages/worker/src/blob-http.ts` の `planBlobHeadHttpResponse(input)` は、guard 済み `/blobs/head` request と R2 HEAD evidence を照合し、requested hash それぞれにちょうど 1 件の evidence がある場合だけ response を組み立てる。request hash の重複、evidence の重複、未要求 hash の evidence、欠落 evidence、`found=false` なのに size がある row、負の size は reject する。これにより client の初回 full sync / binary retry は、R2 に存在すると証明できた chunk だけを skip し、不足 chunk だけ upload queue に残せる。

同じ module の `planBlobUploadUrlHttpResponse(input)` は、guard 済み `/blobs/upload-url` request、R2 HEAD evidence、upload policy、upload target 生成結果を照合し、既に同じ hash/size の object があれば `already-exists` を返す。未存在 object は `multipartThresholdBytes` と request の `multipart` flag で single PUT / multipart を選び、期限切れ target、欠けた upload target、非連番 multipart part、hash mismatch、存在済み object の size mismatch を拒否する。これにより大きな blob を誤って single PUT に流したり、期限切れ target を client に配ったり、同じ hash だが size evidence が矛盾する R2 object を upload 完了扱いにする経路を閉じる。Worker MVP の single PUT target は同一 Worker origin の proxy URL なので `expiresAt` は client retry 用の advisory であり、PUT handler 側の security gate には使わない。Worker MVP は multipart signer をまだ実装しないため、runtime では閾値以上または `multipart: true` の upload-url request を `multipart-unimplemented` として拒否する。protocol の multipart response 型は後続実装のための予約 contract として残す。

`VaultRoom` runtime は blob data plane を実 HTTP に結線する。`POST /blobs/head` は `blob:read` scope を要求し、R2 `head(vaults/<vaultId>/blobs/<sha256>)` の metadata だけで存在/size evidence を作り、blob 本体を読まずに `planBlobHeadHttpResponse` の response だけを返す。`POST /blobs/upload-url` は `blob:write` scope を要求し、未存在 small blob には Worker proxy の `PUT /blobs/:sha256?size=N` URL と advisory `expiresAt` を返す。`PUT /blobs/:sha256?size=N` は `blob:write` scope、`content-length`、streaming read の全部で single PUT 上限を守り、body size と SHA-256 を検証してから vault-scoped R2 key に保存する。`GET /blobs/:sha256` は vault-scoped R2 bytes の hash を再検証してから返す。`PUT /blob-manifests/:sha256.json` は `BlobManifestSchema` を通した JSON を `encodeBlobManifestJson` で canonical bytes に戻し、その SHA-256 が path hash と一致する時だけ `vaults/<vaultId>/blob-manifests/<sha256>.json` に保存する。`GET /blob-manifests/:sha256.json` は保存済み canonical bytes を再ハッシュして返す。いずれも device registry/tokenVersion を通るので、revoked/stale token は blob data plane でも拒否される。R2 key に vault prefix を入れるため、別 vault が同じ hash を知っていても token の vault 外 object は読めない。

`packages/protocol/src/snapshot-http.ts` は latest snapshot response guard を持つ。`isMetaLatestSnapshotResponse` は `GET /vaults/:vaultId/meta/latest` 用に `manifestSeq` / `snapshotSeq`、`snapshots/.../*.yupdate` 形式の `snapshotKey`、`updateSha256`、`stateVectorSha256`、base64 の `stateVector` / `updateBytesBase64` を検証する。`isDocLatestSnapshotResponse` は `NeedFullSnapshot` 後の doc 汎用 response 用で、同じ payload に `docId` を必須で含める。空 vault bootstrap を表現できるよう、この HTTP snapshot response では空 base64 文字列も許す。

`packages/protocol/src/local-repair.ts` は local repair export file guard を持つ。`isLocalOutboxRepairExport` は `format="kuroflare-local-outbox-export"`、`formatVersion=1`、vault/device ID、schema metadata、bounded outbox entries を検証する。entry は `y-update` / blob / materialize 系の kind、pending/retrying/paused/blocked/failed status、dependency IDs、retry metadata、任意の doc/file/message ID、hash、base64 update bytes を持てるが、unknown kind/status や壊れた base64 は拒否する。

`packages/protocol/src/admin-http.ts` は admin operation の request/response guard を持つ。`isAdminOperationRequest` は dry-run に confirmation token が混入していないこと、execute に non-empty confirmation token があることを検証する。`isAdminOperationResponse` は dry-run response が token を返し、execute response が token を返さないこと、effects の kind/count/detail が bounded であることを検証する。quarantine repair 用には `isQuarantinedUpdateEntry`、`isQuarantinedUpdateListResponse`、`isQuarantinedUpdateDetailResponse`、`isQuarantinedUpdateActionRequest`、`isQuarantinedUpdateActionResponse` を持つ。list entry は bytes 本体を含まず、detail だけが任意の `updateBytesBase64` を返せる。`discard` / `force-apply` request は confirmation token 必須で、response effect は `quarantine-discard` / `quarantine-force-apply` として通常 admin effect と区別する。

`packages/protocol/src/device-http.ts` は revoke device の request/response guard を持つ。`isRevokeDeviceRequest` は任意の non-empty reason だけを許し、`isRevokeDeviceResponse` は `deviceId`、`status: "revoked" | "already-revoked"`、non-negative `revokedAt`、正の `tokenVersion` を検証する。`packages/worker/src/devices.ts` の `decideRevokeDevice(input)` は unknown device / invalid timestamp を拒否し、active device では tokenVersion を bump、already revoked device では既存 revocation をそのまま返す。`packages/worker/src/device-http.ts` の `planRevokeDeviceHttpResponse(input)` は accepted revoke decision から protocol guard 済み response を作り、decision が reject の場合や response shape が壊れる場合は応答を拒否する。

`packages/protocol/src/auth.ts` は、署名検証後の JWT claims と token refresh HTTP payload を unknown から検証する guard を持つ。`isDeviceTokenClaims` は `iss: "kuroflare-worker"`、`aud` の vaultId、`sub` の deviceId、重複のない scope 配列、`iat < exp`、正の `tokenVersion` を要求する。scope は `"sync:read" | "sync:write" | "blob:read" | "blob:write"` に固定し、未知 scope はこの protocol version では拒否する。`isDeviceTokenRefreshRequest` は vault/device ID、opaque な non-empty refresh token、正の `previousTokenVersion` を検証する。`isDeviceTokenRefreshResponse` は non-empty access token、正の tokenVersion、non-negative expiry、supported protocolVersion、任意の rotated refresh token を検証する。refresh token の hash lookup、rotation、revocation 判定は Worker 側 decision が行い、protocol guard は wire shape だけを担当する。

HTTP response は retryable error を機械判定できるようにする。

```
type ApiError = {
  code:
    | "auth/revoked"
    | "auth/expired"
    | "protocol/upgrade-required"
    | "rate-limited"
    | "blob/hash-mismatch"
    | "snapshot/not-found"
    | "server/degraded";
  retryable: boolean;
  retryAfterMs?: number;
  detail?: string;
};
```

`packages/protocol/src/errors.ts` はこの `ApiError` 形式の guard と `isRetryableApiError` を持つ。`retryAfterMs` は数値だけを許し、unknown な `code` は retryable として扱わない。Worker はこの型を唯一の公開エラー形式に寄せ、Obsidian 側は `retryable` と `retryAfterMs` だけで backoff 判定できるようにする。

### 15.3 バージョン互換

`protocolVersion` は整数で、破壊的変更時だけ上げる。Worker は `minSupportedProtocolVersion` 未満のクライアントを拒否し、Obsidian 側には「プラグイン更新が必要」と出す。Yjs update 自体の互換性だけに頼らず、MetaFile schema の互換を明示管理する。

### 15.4 認証・デバイス登録・失効

個人デプロイでも、同期トークンの漏洩と古い端末の失効は最初から設計に入れる。E2EE しないため、token は vault の全 plaintext へのアクセス権そのもの。

Setup URI:

```
kuroflare://setup?
  endpoint=https%3A%2F%2Fsync.example.workers.dev&
  vaultId=...&
  setupToken=...
```

`setupToken` は one-time かつ短命（例: 10 分）。`POST /setup/exchange` で device token に交換し、以後 setup token は使えない。QR/URI を再利用可能にしない。

setup token は平文では保存せず、Worker/DO 側では token hash から row を引く。row には少なくとも `vault_id`、`issued_at`、`expires_at`、`consumed_at` を持たせる。exchange handler は request body guard の後、token hash lookup、setup token consume decision、device registry decision、device row write、access JWT mint、initial refresh token hash insert を 1 transaction で進める。token を consume してから device row / refresh token row 書き込みに失敗する状態を避けるため、`consumed_at` の更新、device 登録/再利用、refresh token hash insert は同じ transaction に入れる。

現在の `VaultRoom` runtime はこの handler を実HTTP経路に接続済みで、`POST /setup/exchange` を body の `vaultId` で DO へ route し、DO SQLite の `setup_tokens/devices/device_refresh_tokens` を更新して guarded `SetupExchangeResponse` を返す。`consumed_at` 更新、device row insert/reuse、refresh token hash insert は `begin immediate -> commit` の明示 transaction で閉じ、途中の SQL write が失敗した場合は `rollback` して credential response を返さない。

Device token:

```
JWT claims:
  iss: kuroflare-worker
  aud: vaultId
  sub: deviceId
  scope: ["sync:read", "sync:write", "blob:read", "blob:write"]
  iat, exp
  tokenVersion
```

Worker/DO は `vaultId` と JWT `aud` を必ず照合する。DO id は `vaultId` から導出するが、それだけを認可に使わない。

DO SQLite に device registry を持つ。

```sql
create table if not exists devices (
  device_id text primary key,
  y_client_id integer not null unique,
  token_version integer not null default 1,
  revoked_at integer,
  created_at integer not null,
  last_seen_at integer
);

create table if not exists device_refresh_tokens (
  token_hash text primary key,
  device_id text not null references devices(device_id),
  issued_at integer not null,
  expires_at integer not null,
  revoked_at integer
);

create index if not exists idx_device_refresh_tokens_device_expires
  on device_refresh_tokens (device_id, expires_at);
```

device token の `tokenVersion` が registry より古い、または `revoked_at` がある場合は拒否する。短命 JWT + refresh endpoint でもよいが、初期実装は長めの token と明示 revoke で足りる。token を `data.json` に平文保存しないため、Obsidian の SecretStorage が使える環境では優先する。

現在の `packages/worker/src/devices.ts` 実装は、setup exchange、client hello、device token refresh、device revoke の registry 判定を純粋 decision にしている。HTTP payload の形は `packages/protocol/src/setup.ts` / `auth.ts` / `device-http.ts` で先に検証し、その後 `decideSetupExchange(input)` が、既存 active device なら yClientId を再利用し、revoked device は拒否し、新規 device には未使用の yClientId を範囲内から払い出す。`planSetupExchangeCredentials(input)` は accepted setup decision、確定 deviceId、refresh token hash、発行時刻、有効期限から、setup response に使う deviceId/yClientId/tokenVersion と initial refresh token insert patch を返す。reuse-device なのに caller の deviceId が registry と違う、refresh token hash が空、期限が現在時刻以下、または setup decision が reject の場合は credential 発行を拒否する。`packages/worker/src/setup-http.ts` の `planSetupExchangeHttpResponse(input)` は accepted credential plan から署名対象の `DeviceTokenClaims` と `SetupExchangeResponse` を同時に組み立て、full sync/blob scope、`iat < exp`、protocol guard 済み response だけを返す。これにより handler は claims を署名した access token、opaque refresh token、refresh token hash insert patch、response body の identity/tokenVersion を同じ evidence から作る。`decideClientHelloRegistry(input)` は unknown/revoked/stale-token を拒否し、registry と異なる yClientId を名乗る既存 device は通常同期へ入れず `require-full-snapshot` に落とす。`VaultRoom` runtime は JSON `hello` で `devices` row を読み、この decision を使って unknown/revoked device と yClientId mismatch を接続時点で止める。SQL registry がある runtime では `DEVICE_TOKEN_SECRET` 未設定を fail-closed にし、upgrade 時の Bearer JWT を HS256 で検証して、guard 済み claims を `decideAuthAdmission` に渡して `aud/sub/scope/iat/exp/tokenVersion` と registry row を照合する。accept した socket には `vaultId/deviceId/yClientId` と Bearer token を attachment に保存し、Hibernation 復帰後も `deserializeAttachment()` から復元する。後続 message が別 identity を名乗る場合は `session-mismatch` で閉じる。`decideDeviceTokenRefresh(input)` は registry row、refresh token hash lookup evidence、`previousTokenVersion`、現在時刻を照合し、unknown/revoked device、missing/mismatched/revoked/expired/not-yet-valid refresh token、stale token、registry より未来の tokenVersion を拒否する。成功時は registry の現行 `tokenVersion` で短命 access token を mint し、refresh token は rotate する。`planDeviceRefreshTokenRotation(input)` は accepted refresh decision、旧 token hash、新 token hash、deviceId、発行時刻、有効期限から、旧 hash の `revoked_at` update と新 hash の insert patch を返す。旧 hash が空、新 hash が空、同じ hash、期限が現在時刻以下、または refresh decision が reject の場合は rotation を拒否する。`packages/worker/src/auth-refresh-http.ts` の `planDeviceTokenRefreshHttpResponse(input)` は accepted refresh decision と rotate plan から署名対象の `DeviceTokenClaims` と `DeviceTokenRefreshResponse` を同時に組み立て、full sync/blob scope、`iat < exp`、protocol guard 済み response だけを返す。runtime の `/auth/refresh` handler は refresh token hash lookup、JWT mint、旧 refresh token revoke、新 refresh token insert、response 組み立てを同じ transaction boundary に置き、rotation 永続化に失敗した場合は rollback して新 token を返さない。`decideRevokeDevice(input)` は active device の tokenVersion を bump し、already revoked device は idempotent に扱う。`packages/worker/src/device-http.ts` の `planRevokeDeviceHttpResponse(input)` は revoke decision から `revoked` / `already-revoked` response を組み立て、protocol guard を通らない response は返さない。runtime の `/devices/:deviceId/revoke` handler は entrypoint と DO の両方で Bearer JWT を検証し、actor に `sync:write` がある場合だけ target device を revoke する。JWT mint、refresh token hash insert/rotation、setup token 消費、DB write はこの decision の外側で transaction として適用する。

`packages/worker/src/auth.ts` の `decideAuthAdmission(input)` は、署名検証済み claims を route vault、現在時刻、required scope、device registry row に照合する。`aud` が route vault と違う token、`iat/exp` の範囲外 token、scope 不足、unknown device、claims `sub` と registry device の不一致、revoked device、registry より古い `tokenVersion` は通常処理へ進めない。これにより HTTP と WS の入口で同じ admission logic を使い、revocation と stale-token 判定を transport から分離する。

client 側で token を更新しただけでは outbox を再開しない。`packages/core/src/auth.ts` の `decideClientAuthRefresh(input)` は、署名検証済みの新 claims を local vaultId/deviceId、必要 scope、現在時刻、保存済み `previousTokenVersion` に照合する。vault/device mismatch、`iat/exp` 外、scope 不足、以前より小さい tokenVersion、壊れた previous tokenVersion は reject し、`auth-refresh` resume event を出さない。accept の場合だけ SecretStorage の token body を上書きし、`metadata` store の tokenVersion/expiry/refresh worker state を単一 IndexedDB transaction で更新する。SecretStorage と IndexedDB は同一 transaction ではないため、metadata commit に失敗した場合は refresh 前に読んだ secret snapshot へ rollback し、`emitResumeEvent="auth-refresh"` を scheduler に渡さない。これにより auth failure で paused になった durable queue を捨てず、かつ古い token・別 vault token・読み取り専用 token で再送しない。`ClientAuthMetadata` は local `metadata` store に置く auth subrecord で、deviceId、`authState: "active" | "revoked" | "reauth-required"`、tokenVersion、任意の accessTokenExpiresAt/revokedAt、refresh worker state、`refreshStartedAt`、retryCount、backoff 時の `nextAllowedRefreshAt`、SecretStorage の access/refresh token key 参照を持つ。`planClientAuthMetadataFromSetupResponse(input)` は guarded setup response、SecretStorage に保存済みの access/refresh token key 参照、署名検証済み access token の expiry から active metadata を作り、壊れた tokenVersion / expiry / key 参照は拒否する。`isClientAuthMetadata(value)` は IndexedDB から読んだ unknown をこの shape に狭め、壊れた tokenVersion / retry metadata / secret key 参照を拒否する。`decideClientDeviceRevoke(input)` は guarded `RevokeDeviceResponse` を local deviceId と保存済み tokenVersion に照合し、device mismatch、tokenVersion regression、壊れた revokedAt/tokenVersion を拒否する。accept の場合、`auth-revoke-runtime.ts` の `persistLocalDeviceRevoke(input)` は SecretStorage の access/refresh token を削除してから、secret key 参照を落とした `authState="revoked"`、revokedAt/tokenVersion、sync 停止 evidence を `metadata` store の単一 IndexedDB transaction で保存する。SecretStorage delete と IndexedDB metadata は同一 transaction ではないため、delete 失敗は stale secret cleanup failure として記録するが、revoked metadata は secret key 参照を持たないので後続 startup は残った secret を使用しない。pending outbox は消さず再認証 UI / repair UI に残す。`applyClientAuthMetadataRevokePatch(input)` は active metadata にだけ revoke patch を適用し、token secret key 参照と accessTokenExpiresAt を metadata から落とした revoked record を返す。

refresh HTTP attempt の結果も local metadata へ直接書かない。`decideClientAuthRefreshAttempt(input)` は、accepted token patch、retryable failure、permanent failure を分けて、refresh worker metadata への patch を返す。accepted の場合は `refreshState="idle"`、`retryCount=0`、tokenVersion/expiry、`emitResumeEvent="auth-refresh"` を同じ transaction で保存する。network / timeout / offline / retryable server error は `refreshState="backing-off"`、`retryCount+1`、`nextAllowedRefreshAt` に変換し、`retryAfterMs` があれば通常 schedule の下限として尊重する。revoked device、refresh token rejection、不正 response、再認証必須は `require-reauth` とし、outbox item は捨てずに auth UI へ誘導する。壊れた retry count、retry-after、accepted token metadata は reject し、古い token metadata や誤った resume event を保存しない。`applyClientAuthMetadataRefreshAttemptPatch(input)` は active な `ClientAuthMetadata` にだけ attempt decision を適用し、complete は tokenVersion/accessTokenExpiresAt と secret key 参照を保持したまま idle に戻し、backoff は `nextAllowedRefreshAt` を保存し、permanent failure は token secret key 参照を落とした `authState="reauth-required"` に遷移する。reject decision、revoked metadata、tokenVersion regression は metadata へ適用しない。

auth が必要な side effect を開始する直前にも token の残り寿命を gate する。`decideClientAuthStart(input)` は `tokenExpiresAt`、`refreshMarginMs`、任意の `estimatedDurationMs` を現在時刻と照合し、token が期限切れ、または `refreshMarginMs + estimatedDurationMs` 以内に期限切れになる場合は `refresh-first` を返す。この場合 plugin は outbox lease を取らず、blob upload/download / sync-control などの auth-protected side effect を開始せず、先に token refresh をスケジュールする。`estimatedDurationMs` は大きな blob と小さな blob を分けられるよう outbox item 単位で渡し、local-only の `materialize` は auth gate の対象にしない。これにより、長い blob 転送や WS/HTTP 書き込みを near-expiry token で開始して途中 auth failure に落ちる経路を減らす。

`packages/worker/src/setup-tokens.ts` の `decideSetupTokenConsume(input)` は、hash lookup 後の setup token row を requested vault と現在時刻に照合する。unknown token、vault mismatch、`issuedAt/expiresAt` の壊れた window、not-yet-valid、expired、already consumed は device registry へ進めない。成功時は `{ action: "consume", consumedAt }` を返し、caller が同一 transaction で `consumed_at` と device registry 更新を確定する。

---

## 16. Durable Object SQLite スキーマ

DO Storage は R2 に flush するまでの耐久バッファ。SQLite-backed DO を前提に、KV ではなく SQL table として管理する。

```sql
create table if not exists schema_migrations (
  version integer primary key,
  applied_at integer not null
);

create table if not exists setup_tokens (
  token_hash text primary key,
  vault_id text not null,
  issued_at integer not null,
  expires_at integer not null,
  consumed_at integer
);

create index if not exists idx_setup_tokens_vault_expires on setup_tokens (vault_id, expires_at);

create table if not exists devices (
  device_id text primary key,
  y_client_id integer not null unique,
  token_version integer not null default 1,
  revoked_at integer,
  created_at integer not null,
  last_seen_at integer
);

create table if not exists docs (
  doc_id text primary key,
  kind text not null,                 -- meta | file
  latest_seq integer not null default 0,
  latest_snapshot_seq integer not null default 0,
  latest_snapshot_key text,
  latest_state_vector blob,
  min_retained_seq integer not null default 0,
  horizon_state_vector blob,
  updated_at integer not null
);

create table if not exists op_log (
  doc_id text not null,
  seq integer not null,
  message_id text not null,
  device_id text not null,
  y_client_id integer not null,
  update_bytes blob not null,
  update_sha256 text not null,
  created_at integer not null,
  primary key (doc_id, seq),
  unique (doc_id, message_id)
);

create index if not exists idx_op_log_doc_seq on op_log (doc_id, seq);

create table if not exists message_dedup (
  doc_id text not null,
  message_id text not null,
  durable_seq integer not null,
  seen_at integer not null,
  primary key (doc_id, message_id)
);

create table if not exists checkpoint_runs (
  run_id text primary key,
  doc_id text not null,
  upper_seq integer not null,
  snapshot_key text,
  state_vector blob,
  status text not null,               -- writing | r2-written | pointer-updated | compacted | failed
  error text,
  created_at integer not null,
  r2_written_at integer,
  pointer_updated_at integer,
  compacted_at integer
);

create table if not exists connected_devices (
  device_id text primary key,
  y_client_id integer,
  last_seen_at integer not null,
  user_agent text,
  protocol_version integer not null
);

create table if not exists quarantined_updates (
  id text primary key,
  doc_id text not null,
  message_id text not null,
  device_id text not null,
  reason text not null,
  update_sha256 text not null,
  update_bytes blob not null,
  created_at integer not null
);
```

`devices` は認可・失効の永続台帳。`connected_devices` は presence/observability 用の接続状態 cache。認可判断は必ず `devices` を見る。

### 16.1 Yjs clientID の一意性

Yjs の state vector は `clientID -> clock` で差分を判断する。つまり `clientID` が端末間で重複・再利用されると、差分判定もマージも静かに壊れる。これは conflict として見えず、self-healing に乗らない。

不変条件:

- `deviceId` は plugin install 単位で永続する。
- `y_client_id` は `deviceId` から決定論的に導出するか、初回接続時に DO が払い出して `devices` に固定する。
- DO は `(vaultId, deviceId) -> y_client_id` を registry として保持する。
- 同じ `y_client_id` を別 `deviceId` が名乗ったら接続拒否し、片方に再採番を要求する。
- 同じ `deviceId` が別 `y_client_id` を名乗ったら、再インストール/IndexedDB 消失として扱い、full snapshot merge 経路に落としてから registry を更新する。

推奨は DO 払い出し方式:

```
setup/exchange:
  1. deviceId を生成または受理
  2. DO が未使用の y_client_id を払い出す
  3. devices に (deviceId, y_client_id, tokenVersion) を保存
  4. plugin は y_client_id を IndexedDB と data.json に保存
```

client hello では `deviceId` と `y_client_id` を必ず送る。DO は registry と一致しない hello を通常同期へ進めない。

実装上は yClientId を正の safe integer として扱い、0、小数、文字列は registry mismatch と同じく拒否する。deviceId が一致して yClientId が違う場合だけは、IndexedDB 消失・再インストールの可能性があるため即 reject ではなく full snapshot merge 経路へ誘導する。

### 16.2 seq 境界

`seq` は DO 内で単調増加。checkpoint は `upper_seq` を固定してから snapshot を作る。R2 書き込みが成功したら `checkpoint_runs.status = 'r2-written'` にする。per-doc pointer と `docs.latest_snapshot_seq` は、現在値より `upper_seq` が大きい場合だけ単調に進める。古い checkpoint run が遅れて完了しても pointer を巻き戻してはいけない。`op_log.seq <= upper_seq` を削除できるのは、pointer 更新が成功して `checkpoint_runs.status = 'pointer-updated'` になった後だけ。R2 書き込み前に op_log を削らない。

runtime の alarm は通常 checkpoint の前に orphaned checkpoint run を読む。`writing` は R2 snapshot が存在して Yjs update として検証できる場合だけ `r2-written` へ進め、欠けている場合は failed にする。`r2-written` は pointer を巻き戻さない範囲で `docs.latest_snapshot_seq/latest_snapshot_key` を進め、snapshot state vector を保存する。`pointer-updated` は pointer の snapshot が検証でき、pointer が run の `upper_seq` 以上である場合だけ op_log を compact して `compacted` にする。

`docs.min_retained_seq` と `horizon_state_vector` は「この地平より古い client には差分ではなく full snapshot を送る」判定に使う。`message_dedup` は短期の transport 重複排除用で、checkpoint/compact と同じタイミングで古い行を掃除する。`op_log.message_id` の unique 制約だけに頼ると永続的に肥大化するので、実装では op log 保持期間と dedup TTL を分けてもよい。dedup TTL を越えた同一 Yjs update の再送は seq を増やし得るが、Yjs update 適用は冪等なので復元 content は変わらない、という前提を model test で固定する。

`SyncRequest` の処理は「state vector を受け取ったら必ず diff を返す」ではない。DO は同じ turn で `docs.latest_seq`、`docs.min_retained_seq`、`horizon_state_vector`、必要なら R2 snapshot + residual op を読み、client の `stateVector` が retained horizon をカバーしているかを先に判定する。horizon より古い、または snapshot/residual のどちらかが欠けて現在 YDoc を復元できない場合は、差分生成を試みず `NeedFullSnapshot` を返す。差分生成後に update が空なら `sync-update` を送らず `no-update` として扱う。`decideSyncRequest` はこの分岐だけを純粋 decision にし、`Y.encodeStateAsUpdate`、R2 GET、SQLite read、WebSocket write は外側で行う。現在の `VaultRoom` runtime は、JSON `sync-request` を受けると client state vector を base64 decode し、doc が未作成なら no-update として無応答にする。doc が存在する場合は authoritative YDoc を lazy hydrate し、`horizon_state_vector` を Yjs の `clientID -> clock` として decode して client vector が全 clock を満たすかを比較する。満たす場合は `Y.encodeStateAsUpdate(doc, clientStateVector)` の非空差分だけを JSON `sync-update` で返し、満たさない場合は `NeedFullSnapshot(reason="state-vector-too-old")` を返す。full snapshot object そのものを返す HTTP/API 経路は別途接続する。

`VaultRoom` runtime は、doc ごとの初回 access 時に `docs.latest_snapshot_key/latest_snapshot_seq` と R2 prefix list から復元 snapshot を選ぶ。pointer が prefix list の最大 seq 以上なら pointer を使い、pointer が missing/stale なら listed snapshot へ fallback する。その後 SQLite `op_log.update_bytes` を `seq > selectedSnapshotSeq` の昇順で replay して authoritative in-memory YDoc を lazy hydrate する。選んだ snapshot object が読めない、または snapshot bytes を Yjs update として apply できない場合は server state の復元不能であり、client update の quarantine にはしない。DO は ack も append も差分応答もせず `hydrate-failed` として接続を閉じ、checkpoint recovery / snapshot fallback へ委ねる。

`SyncUpdate` の受信は doc ごとの append queue に入り、`docs.latest_seq` read、`message_dedup(doc_id,message_id)` read、hydrate/validation、append planning、SQLite/YDoc 反映、ack までを同一 doc では直列化する。DO は async `crypto.subtle` / R2 / hydrate の await 点で別 event とインターリーブし得るため、single-thread turn だけを seq 採番の排他にしない。事前に `message_dedup` を読んで duplicate かを確定し、duplicate なら op_log / YDoc / docs を一切変更せず、保存済み `durable_seq` の ack だけを再送する。dedup は `op_log` ではなく `message_dedup` を基準にするため、op_log に入らない snapshot-escape 済み message も再送時に同じ `durableSeq` で ack でき、NeedFullSnapshot 境界を何度も作らない。新規 update は append planning の前に empty temporary YDoc へ apply して、binary decode/hash、Yjs update としての構造的な適用可否を検証する。meta doc だけは hydrated meta YDoc の一時コピーへ inbound update を適用し、schema validation も通す。ここで失敗した update は `quarantined_updates` に保存し、op_log / docs / active YDoc へ反映せず、ack も返さない。ack を返すと client は pending outbox を done にしてしまい、破損 update が repair 不能になるため、quarantine は完了証拠ではなく retry/backoff と repair log の入口にする。

新規通常 update の transaction は `Y.applyUpdate(activeYDoc, updateBytes)`、`op_log insert(seq, message_id, device_id, y_client_id, update_bytes, update_sha256)`、`docs.latest_seq = seq`、`message_dedup upsert(durable_seq=seq)` を一つの成功単位として扱う。WebSocket ack はこの transaction が commit してから送る。DB unique 制約に負けた場合は、その場で再読して duplicate ack に変換し、二重 seq を作らない。append 後は `latestSeq - latestSnapshotSeq >= 128` なら即時 checkpoint alarm、それ未満なら 30 秒 debounce の alarm を入れる。

巨大 paste や初回 seed で `update_bytes` が大きすぎる場合は、op_log 1 行に詰めずに直接 snapshot 経路へ逃がす。

```
if updateBytes.length > largeUpdateThreshold:
  1. 現在 doc に apply
  2. snapshot を R2 に PUT
  3. per-doc pointer を更新
  4. docs.latest_snapshot_seq と docs.latest_seq を同じ seq へ進める
  5. client には snapshot commit 後に durable ack と NeedFullSnapshot(reason="large-update-snapshot") を返す
```

この経路の ack は「op_log append」ではなく「同じ seq の snapshot object + pointer + docs clock が durable」という意味でだけ返す。通常の ack と混同しないよう、worker decision は `snapshot-escape` action として分ける。この経路でも `message_dedup(durable_seq=seq)` を保存し、同じ message の再送は duplicate ack に変換する。R2 確定前に既存 op_log を消さない。

### 16.3 R2 snapshot key

```
snapshots/<vaultId>/meta/<seq>.yupdate
snapshots/<vaultId>/files/<ydocId>/<seq>.yupdate
snapshots/<vaultId>/manifests/latest.json
snapshots/<vaultId>/pointers/meta.json
snapshots/<vaultId>/pointers/files/<ydocId>.json
```

`latest.json` は「各 doc の最新 snapshot key と seq」を持つ全体 manifest。per-doc pointer は単一 doc の最新 snapshot だけを指す。更新順は `snapshot object PUT -> per-doc pointer PUT -> latest.json PUT`。`latest.json` が古くても、per-doc pointer または DO SQLite の op_log が残っていれば復元できる。DO が完全に消えた場合は R2 の pointer/manifest が復元入口になる。

`latest.json` 更新中のクラッシュに備えて、manifest 自体にも世代を持たせる。

```
snapshots/<vaultId>/manifests/<manifestSeq>.json
snapshots/<vaultId>/manifests/latest.json
```

復元時は `latest.json` を読む。読めない、または参照先 snapshot が欠けている場合は `manifests/` を列挙し、参照先がすべて存在する最大 `manifestSeq` を採用する。R2 は source of truth なので、manifest が壊れた時の復元入口を必ず複数残す。

per-doc 復元時は `pointers/<doc>.json` を読む。読めない、stale の疑いがある、または参照先 snapshot が欠けている場合は `snapshots/<vaultId>/<doc-prefix>/` を list し、検証できる最大 seq の snapshot を採用する。通常経路は pointer、復旧経路は list にする。R2 の pointer read が stale でも、prefix list で見える最大の健全 snapshot + その `upperSeq` より後の retained op_log から復元できなければならない。

Snapshot manifest:

```
type SnapshotManifest = {
  version: 1;
  vaultId: string;
  manifestSeq: number;
  createdAt: number;
  docs: Array<{
    docId: DocId;
    snapshotSeq: number;
    snapshotKey: string;
    updateSha256: string;
    stateVectorSha256: string;
  }>;
};
```

復元時は snapshot object を GET した後に sha256 を検証する。壊れていたら一つ古い manifest に戻る。R2 object が欠ける事故は通常想定しないが、source of truth と呼ぶ以上、検証と fallback は明文化しておく。

現在の `packages/worker/src/snapshots.ts` 実装は、この R2 snapshot 境界の最小 contract を持つ。`makeSnapshotObjectKey` / `makeSnapshotListPrefix` / `makeSnapshotPointerKey` / `makeManifestKey` / `makeLatestManifestKey` で命名を固定し、`isSnapshotManifest` で R2 から読んだ JSON を `unknown` から `DocId` / SHA-256 付き manifest に検証する。`chooseSnapshotForRestore(pointer, listedCandidates)` は pointer が健全かつ prefix list の最大健全 seq 以上の場合だけ pointer を採用し、stale/corrupt/missing pointer は最大健全 listed snapshot へ fallback する。

client が `NeedFullSnapshot` を受けた場合、対象 doc の通常 outbox flush を止めて snapshot fetch / local reset 経路へ入る。手順:

1. meta は `GET /vaults/:vaultId/meta/latest`、file doc は `GET /vaults/:vaultId/files/:ydocId/latest` で対象 doc の snapshot metadata と update bytes を取得する。file doc response は `DocLatestSnapshotResponse` として `docId={kind:"file", ydocId}` を含める。
2. response guard で `docId`、`snapshotSeq`、`snapshotKey`、`updateSha256`、`stateVectorSha256`、`stateVector`、`updateBytesBase64` を検証する。meta bootstrap だけは既存互換の `MetaLatestSnapshotResponse` を受け付け、local 側で requested doc を `{kind:"meta"}` として扱う。
3. `packages/core/src/snapshot.ts` の `decodeFullSnapshotBytesFromResponse(input)` で `updateBytesBase64` と `stateVector` を bytes に戻し、size limit と SHA-256 が `updateSha256` / `stateVectorSha256` と一致することを確認する。`invalid-base64` / `hash-mismatch` / `state-vector-hash-mismatch` は retry で直らない可能性が高いので repair log に残し、別 generation へ fallback する。
4. `makeFullSnapshotApplyInputFromResponse(input)` で response と computed hash を local apply decision の入力へ正規化する。meta response は requested doc が meta の時だけ使い、file doc には `DocLatestSnapshotResponse.docId` を要求する。
5. `decideFullSnapshotApply(input)` を通す。要求した doc と snapshot doc の一致、snapshot seq の前進、hash 一致、対象 doc の未送信 local update がないこと、active editor binding が外れていることを満たす場合だけ apply する。
6. `apply` の場合は `snapshot-apply-runtime.ts` の `planFullSnapshotApplyRuntime(input)` に通し、一時 YDoc に snapshot update を適用してから local YDoc を置き換えるための bytes、`remoteCursorSeq = snapshotSeq` / `stateVectorBase64 = response.stateVector` の patch、`planOutboxWorkerFullSnapshotRelease` が返す `full-snapshot-required` item の done transaction をまとめて受け取る。成功 plan の `indexedDbWriteTransaction` は `meta-ydoc` / `file-ydocs`、`remote-cursors`、outbox release の store/key/value を固定する。runtime は `commitFullSnapshotApplyIndexedDbTransaction(input)` で `meta-ydoc` / `file-ydocs`、`remote-cursors`、`outbox`、`running-leases` を含む 1 つの readwrite transaction を開き、YDoc 置換、remote cursor 更新、outbox release の全 request を先に同期発行してから request success と transaction complete を待つ。local YDoc 置換、cursor/stateVector 保存、対象 doc の pending outbox clear、full snapshot release を別 transaction に分けると、次回 hello が古い SV を送り full snapshot loop へ戻るので分離しない。outbox release persist が拒否された場合も local YDoc はまだ変えない。`full-snapshot-required` item を単に `pending` へ戻して再送しない。
7. `wait(pending-local-updates)` は local update を先に durable ack させるか、conflict UI で discard / fork を選ばせる。`wait(active-editor-bound)` は active editor を閉じるか binding を切るまで待つ。`reject(hash-mismatch/doc-mismatch)` は retry ではなく repair log に残し、別 snapshot generation へ fallback する。

### 16.4 snapshot retention と論理破損対策

「最新フルスナップショット 1 本だけを残す」は物理消失には強いが、論理破損に弱い。バグった client update、壊れた local state、実装ミスによる不正な meta 更新が DO の YDoc に適用され、そのまま checkpoint されると、唯一の復元アンカーも壊れる。

不変条件:

- 最新だけでなく、最低 `N` 世代（例: 20 世代）または一定期間（例: 30 日）の snapshot manifest を残す。
- まだ `compacted` / `failed` で閉じていない checkpoint run が参照する snapshot は retention 対象外でも消さない。`r2-written` だが pointer 未更新の snapshot を掃除すると、その run が後から完了できず復元入口が不定になる。`failed` は recovery で明示的に閉じた run なので pin しない。
- retention cleanup は、最新 `N` 世代に加えて「最新の健全 snapshot」を必ず残す。最新世代が corrupt と判定された後に cleanup が走っても、健全な rollback 先を消してはいけない。
- `latest` が壊れた場合だけでなく、「論理的におかしいが object としては読める」場合も古い snapshot へ戻せるようにする。
- compact は「retention 対象外の snapshot が十分残っている」ことを確認してから行う。ただし snapshot retention window 内の rollback に必要な op_log は、`status=compacted` 相当でも物理削除しない。corrupt snapshot から一つ前の健全 snapshot へ戻る場合、`healthySnapshot.upperSeq < seq <= corruptSnapshot.upperSeq` の update を retained op_log から replay できる必要がある。
- admin repair は任意の manifestSeq / snapshotSeq へ rollback できるようにする。

現在の `packages/worker/src/retention.ts` 実装は、この retention cleanup を `planSnapshotRetention(input)` という純粋 decision にしている。最新 `minGenerationCount` 世代、現在 pointer、最新の健全 snapshot、未完了 checkpoint run（`writing` / `r2-written` / `pointer-updated`）が参照する snapshot を retain し、それ以外を `deleteKeys` として返す。実 R2 delete は caller が dry-run / admin confirmation / transaction 境界で適用する。

Yjs update 適用前の健全性チェック:

```
1. update bytes の size 上限を確認
2. 一時 YDoc へ applyUpdate できるか try
3. meta YDoc の場合は schema validation:
   - path が空でない
   - canonicalPath が不正でない
   - type と ydocId/blobManifestHash の組み合わせが妥当
   - tombstone と active edit の意味衝突は repair policy に乗る
4. file YDoc の場合は巨大すぎる delete+insert を large update 経路へ逃がす
5. 合格した update だけ本 YDoc と op_log へ進める
```

チェックは完全な正当性証明ではないが、「明らかに壊れた update を権威 snapshot に焼く」確率を下げる。疑わしい update は即破棄せず、初期 schema の `quarantined_updates` table に保存し、repair panel/admin command から inspect できるようにする。

現在の `packages/worker/src/sync-update.ts` 実装は、この append 前 quarantine 境界を `decideSyncUpdateQuarantine(input)` として純粋 decision にしている。正常 evidence は `accept` として append decision へ渡し、hash mismatch / Yjs apply failure / meta schema invalid は `quarantine` row を返す。`quarantine` action には `Ack` を含めない。`VaultRoom.handleSyncUpdate` は `docId.kind === "meta"` の場合、hydrated meta YDoc の一時コピーへ inbound update を適用し、`meta` YMap の全 entry を `isMetaFile(value, fileId)` で検証した `metaSchemaValid` evidence をこの decision に渡す。これにより `meta-schema-invalid` は pure decision のテストだけでなく実 WebSocket update 経路からも到達する。caller は decoded bytes 本体を row の `update_bytes` として保存し、同じ transaction で repair log counter を進めるだけに留める。同じ quarantine id の再送は `on conflict(id) do nothing` で冪等化し、壊れた update の再送で handler をクラッシュさせない。

quarantine の admin repair は 3 種に絞る。`inspect` は row metadata、reason、hash、サイズ、docId/messageId/deviceId、必要なら bytes の download を返すだけで、確認 token は不要かつ状態を変えない。`discard` は明示 confirmation 後に quarantine row だけを削除し、op_log/docs/YDoc は変更せず、元 client に ack を送らない。`force-apply` は明示 confirmation に加えて、現在の snapshot/residual から作った temporary YDoc への再適用と meta schema validation が通った場合だけ、`latestSeq + 1` として op_log/docs に移し、quarantine row を削除する。これは admin が server state を修復する操作であり、その場で元 WebSocket へ ack を送る操作ではない。同じ `messageId` が後から再送された場合は、通常 duplicate path が既存 durable seq を ack する。

現在の `packages/worker/src/quarantine.ts` 実装は、この repair 境界を `decideQuarantinedUpdateAdmin(input)` として純粋 decision にしている。`inspect` は read-only、`discard` は confirmation 必須の delete patch、`force-apply` は confirmation / latestSeq / yClientId / fresh revalidation が揃った時だけ op_log append patch + docs patch + delete patch を返す。revalidation が欠ける、または失敗した update は force apply できない。

HTTP handler 境界は `packages/worker/src/quarantine-http.ts` に分ける。`buildQuarantinedUpdateListResponse(records)` は bytes 本体を含まない list response を作り、`buildQuarantinedUpdateDetailResponse(record, updateBytesBase64)` だけが明示 inspect 用に bytes を返す。runtime の `GET /admin/quarantine[/<id>]` は Bearer JWT を検証し、actor device に `sync:write` がある場合だけ `quarantined_updates` を guarded response として返す。destructive action の confirmation token は `quarantine:<action>:<id>` という subject に bound し、token hash 検証は caller が行う。`decideQuarantineConfirmation(input)` は caller から渡された `{subject, expiresAt, tokenHashMatches}` evidence を action/id/now と照合し、missing / mismatch / expired を区別する。`planQuarantinedUpdateActionHttp(input)` は protocol guard 済み request、confirmation evidence、quarantine row、force-apply revalidation evidence を受け取り、`decideQuarantinedUpdateAdmin` の patch と `QuarantinedUpdateActionResponse` の effect を同時に組み立てる。destructive `discard` / `force-apply` の runtime route は confirmation token の発行/保存境界を入れてから接続する。

この設計で「通常は最新へ進む」「壊れたら古い健全な世代へ戻る」「怪しい update は証拠として残る」を満たす。

### 16.5 schema migration

DO 起動時に `schema_migrations` を見て、未適用 migration を順番に実行する。migration は冪等に書く。失敗時は DO を degraded にして同期を受け付けない。半端な schema で op を受けるより、明示停止した方が復旧しやすい。

migration list は Worker bundle 側で version 1 からの contiguous な配列として持つ。`schema_migrations` に bundle に存在しない version がある、または applied versions が prefix になっていない場合は、破損・手動編集・downgrade の可能性があるため degraded とする。pending migration がある間も通常 sync は受けず、起動時 migration runner が SQL を適用して `schema_migrations` を更新した後だけ ready にする。

現在の `packages/worker/src/schema.ts` 実装は、初期 SQLite schema を `INITIAL_SCHEMA_OBJECTS` と `SCHEMA_MIGRATIONS` として構造化している。初期 migration は `schema_migrations`、`setup_tokens`、`devices`、`device_refresh_tokens`、`docs`、`op_log`、`message_dedup`、`checkpoint_runs`、`connected_devices`、`quarantined_updates` と、setup token lookup / refresh token lookup / op log scan / checkpoint recovery 用 index を作る。`docs` は `latest_seq` を持ち、runtime の append path はこの clock を読み書きして次 seq を決める。`op_log` は `(doc_id, seq)` primary key と `(doc_id, message_id)` unique を持ち、再送の永続重複と seq 順序を DB 制約でも固定する。

現在の `packages/worker/src/migrations.ts` 実装は、この判定を `decideSchemaMigration(input)` という純粋 decision にしている。戻り値は `ready`、`apply-migrations`、`degraded` のいずれかで、`migration-failed`、`invalid-migration-plan`、`unknown-applied-migration`、`non-contiguous-applied-migrations` を区別する。`schemaAcceptsSync(decision)` は `ready` のときだけ true になる。

現在の `packages/worker/src/health.ts` 実装は、DO/SQLite/R2 の availability と migration decision から `decideWorkerHealth(input)` で public health response を組み立てる。`healthAcceptsSync(health)` は DO/SQLite/migrations が ok のときだけ true になり、R2 degraded だけでは durable op append を止めない。`healthAcceptsCheckpoint(health)` は R2 も ok のときだけ true になる。さらに `decideDurableObjectSyncAdmission(input)` は各 DO ローカルの SQLite availability と migration decision から WS/op append の受理可否を決める。global `/health` は概況、DO startup gate が vault 単位の sync 権威、という責務分離にする。

### 16.6 orphaned checkpoint run の回収

コールドスタート時に `checkpoint_runs.status in ('writing', 'r2-written', 'pointer-updated')` が残っていたら、その run は完了不明として扱う。

1. `writing`: `snapshot_key` が無い、R2 に存在しない、または sha256/state vector を検証できないなら `failed` にし、対応する `op_log` は消さない。`writing` だが `snapshot_key` があり、R2 object も検証できる場合は、まず `r2-written` に戻して次の recovery pass で pointer advance 判定へ進める。
2. `r2-written`: `snapshot_key` が R2 に存在し、sha256/state vector が検証でき、かつ `upper_seq >= docs.latest_snapshot_seq` なら pointer/docs を進めてよい。古い場合は pointer を巻き戻さず、run を `failed` または stale として閉じる。
3. `pointer-updated`: pointer/docs が検証でき、`docs.latest_snapshot_seq >= upper_seq` なら `op_log.seq <= upper_seq` を compact して `compacted` に進める。pointer が未検証、または docs が run より behind の場合は compact を block し、通常復元へ進む。
4. その後、通常の `R2 snapshot + residual op_log` 復元を行う。

「書けたかもしれない snapshot」を即採用しない。必ず検証してから pointer/docs を進める。

現在の `packages/worker/src/checkpoint.ts` 実装は、新規 checkpoint 開始を `decideCheckpointWrite(input)`、checkpoint 後 compact を `decideCheckpointCompact(input)`、orphaned checkpoint run 回収を `decideOrphanedCheckpointRecovery(input)` という純粋 decision にしている。`decideCheckpointWrite` は `latestSeq > latestSnapshotSeq` の時だけ `write` を返し、同じ seq の再 checkpoint は `no-new-ops` として skip する。`decideCheckpointCompact` は run が `pointer-updated` で、`docs.latest_snapshot_seq >= upperSeq` の時だけ compact を許す。`decideOrphanedCheckpointRecovery` の戻り値は `fail-run`、`mark-r2-written`、`advance-pointer`、`mark-stale`、`compact-op-log`、`block-compact`、`ignore-terminal` のいずれかで、実 DB/R2 更新は caller が transaction 境界で適用する。これにより「古い run が pointer を巻き戻さない」「未検証 snapshot を採用しない」「pointer 未検証で op*log を compact しない」を unit test で固定する。runtime の `VaultRoom.checkpointDoc(docId)` はこの write/compact decision を使い、R2 PUT が終わるまで `docs.latest_snapshot*\*`を進めず、PUT 後に`checkpoint_runs.status='r2-written'`、docs pointer 更新、`checkpoint_runs.status='pointer-updated'`、covered op_log compact、`checkpoint_runs.status='compacted'` の順で進める。`VaultRoom.alarm()`は`docs.latest_seq > latest_snapshot_seq`のdocを最大16件ずつcheckpointし、append後に`setAlarm` を予約する。alarmはrequest pathを持たないため、accepted hello の vaultId を DO storage に保存し、evict 後の alarm instance はそこから snapshot key 用 vaultId を復元する。

---

## 17. R2 Blob と CDC の詳細

### 17.0 R2 オブジェクト命名

```
snapshots/<vaultId>/meta/<seq>.yupdate
snapshots/<vaultId>/files/<ydocId>/<seq>.yupdate
snapshots/<vaultId>/manifests/<manifestSeq>.json
vaults/<vaultId>/blobs/<chunk_sha256>
vaults/<vaultId>/blob-manifests/<manifest_sha256>.json
admin-exports/<vaultId>/<timestamp>.tar.zst
```

blob と blob manifest は vault prefix を必ず含める。content-addressed hash は object 同一性の検証には使うが、bucket 内の authorization boundary には使わない。cross-vault dedup を R2 key で直接やると、hash を知っている別 vault が plaintext blob を読めるため、初期実装では vault 間 dedup は捨てる。manifest は content-addressed にして不変化する。メタ YDoc は manifest hash を参照するだけにし、manifest 本文を Yjs に入れない。

### 17.1 chunk manifest

メタ YDoc の `blobChunks` だけでは復旧時に検証情報が薄いので、binary file には manifest を持たせる。

```
type BlobManifest = {
  version: 1;
  fileId: string;
  contentSha256: string;
  size: number;
  chunks: Array<{
    sha256: string;
    offset: number;
    size: number;
  }>;
  createdBy: string;
  createdAt: number;
};
```

メタ YDoc には `blobManifestHash` と `blobChunks` の両方を置く。`blobChunks` は materialize を速くするため、`blobManifestHash` は完全性検証と将来拡張のため。

現在の `packages/protocol/src/blob-manifest.ts` 実装は、manifest JSON の最小 schema guard を持つ。

- `fileId` は branded `FileId` とし、必要なら `isBlobManifest(value, expectedFileId)` で meta 側の fileId と一致させる。
- `contentSha256` と各 chunk `sha256` は lowercase SHA-256 hex だけを許す。
- `size=0` の manifest は `chunks=[]` だけを許す。`size>0` の manifest は 1 個以上の chunk が必要。
- chunk は `offset=0` から隙間なく並び、各 chunk `size` は正の safe integer、合計が manifest `size` と一致する。
- `blobManifestMatchesMetaFile(manifest, metaFile)` は binary meta の `fileId` と `blobChunks` fast path が manifest 本文と一致することを確認する。`blobManifestHash` が manifest body の SHA-256 と一致するかは、body bytes を持つ Worker/plugin 側で検証する。
- manifest body bytes は `encodeBlobManifestJson(manifest)` が返す canonical UTF-8 JSON に固定する。field order は `version,fileId,contentSha256,size,chunks,createdBy,createdAt`、chunk field order は `sha256,offset,size`、余計な whitespace は入れない。`blobManifestHash` はこの canonical bytes の SHA-256 にする。

現在の `packages/blob` 実装は、binary upload 前の共有処理として以下を持つ。

- `chunkBytes(bytes, options)` は `minSize` / `avgSize` / `maxSize` に従って決定論的に chunk を切る。初期実装は軽量 rolling hash による content-defined boundary で、実運用前に FastCDC 等の実績ある実装へ差し替え可能な境界に閉じ込める。
- `buildBlobManifest(fileId, bytes, createdBy, createdAt, options)` は content SHA-256、各 chunk SHA-256、offset、size、canonical manifest bytes、manifest hash を一括生成する。
- `assembleBlobBytes(manifest, chunksBySha256)` は chunk hash/size と manifest `contentSha256` を検証してから bytes を組み立てる。
- upload queue はこの戻り値の `chunks` を PUT し、全 chunk と manifest PUT の完了後にだけ meta YDoc の `blobManifestHash` / `blobChunks` を更新する。

### 17.2 upload queue

```
pending blob:
  1. chunk sha256 計算
  2. local cache に保存
  3. Worker /blobs/head で存在確認
  4. 無い chunk を PUT
  5. PUT 後に GET/HEAD で size/hash を確認
  6. manifest PUT
  7. meta YDoc 参照更新
```

手順 6 まで成功して 7 が失敗した場合は孤児 blob/manifest になるだけで無害。手順 7 だけ再試行する。手順 7 が成功した後に local materialize が失敗した場合も、メタ YDoc が真実なので再試行で治る。

### 17.3 CDC パラメータ

初期値:

- 平均 chunk size: 1 MiB
- 最小: 256 KiB
- 最大: 4 MiB
- 小さいファイル（8 MiB 未満）は固定 1 chunk でもよい

Obsidian の添付は画像/PDFが多く、巨大 VM image のような極端な差分効率は不要。まず実装単純性と R2 request 数を優先する。

---

## 18. クライアント同期エンジン

### 18.1 内部状態機械

```
stopped
  -> local-ready
  -> connecting
  -> meta-syncing
  -> online
  -> degraded
  -> offline
```

- `local-ready`: IndexedDB と Vault scan が終わり、オフライン利用可能。
- `meta-syncing`: ファイルツリーだけ収束中。ここでは大きな materialize は抑制。
- `online`: meta と active file が収束し、background queue が動く。
- `degraded`: WS はあるが blob upload/download 失敗、または checkpoint 遅延が見えている。
- `offline`: outbox に積むだけ。

UI は状態名をそのまま出さず、status bar に小さいアイコンと短い文言だけ出す。詳細は conflict/repair panel へ。

状態遷移イベント:

```
stopped
  -> local-ready
     on IndexedDB open + Vault scan completed

local-ready
  -> connecting
     on network available or manual sync

connecting
  -> meta-syncing
     on auth ok + ClientHello ack
  -> offline
     on auth/network failure

meta-syncing
  -> online
     on meta SV exchange completed + repair pass completed
  -> degraded
     on meta validation/quarantine exists

online
  -> degraded
     on blob queue stuck, checkpoint lag, quarantine, materialize CAS conflict
  -> offline
     on WS closed without reconnect

degraded
  -> online
     on queues drained + no blocking repair
  -> offline
     on network lost
```

`degraded` は同期停止ではない。未処理 queue や repair event があり、ユーザー確認が必要な可能性がある状態。

### 18.1.1 bootstrap / join / reconnect の入口

```
bootstrap new vault:
  1. setup/exchange で deviceId, yClientId, accessToken, refreshToken を取得
  2. local initial-index
  3. file snapshots/blob を R2 へ direct upload
  4. meta YDoc を DO へ送信
  5. online

join existing vault:
  1. setup/exchange
  2. GET /vaults/:vaultId/meta/latest
  3. remote meta へ local file を adopt
  4. missing file snapshot/blob を download
  5. local-only file だけ新規採番して upload
  6. online

reconnect:
  1. IndexedDB の meta/file YDoc を load
  2. ClientHello(deviceId, yClientId, stateVector)
  3. meta SV exchange
  4. active file SV exchange
  5. background file/blob queues resume
```

bootstrap と join を混ぜない。既存 vault に参加する端末は、remote meta を読む前に UUID を大量採番しない。`setup/exchange` の `bootstrapMode` が `new-vault` なら、plugin は `scan-local-vault -> create-local-meta-ydoc -> enqueue-initial-file-uploads -> send-meta-update` の順で進む。`join-existing` なら、`fetch-remote-meta-snapshot -> apply-remote-meta-snapshot` が先で、その後に初めて local-only file を adopt する。remote meta を見ずに local tree を先に採番すると、同じ path の remote file と local file が別 fileId になり、初回参加だけで不要な conflict repair を発生させる。

現在の `packages/core/src/startup.ts` 実装は、この入口を `planClientStartup(input)` にしている。setup intent に `SetupExchangeResponse` がまだ無い場合は `run-setup-exchange` を返す。setup response の `bootstrapMode` が user intent と食い違う、caller が期待した mode と食い違う、または既存 local vaultId と response vaultId が違う場合は reject し、同期 side effect を始めない。reconnect は device credentials、IndexedDB、local vaultId、schema version、auth metadata の `authState` を確認し、local auth が `revoked` または `reauth-required` の場合は `auth-blocked` に入り、setup exchange へ自動的に流さない。plugin 側の `sync-engine.ts` はこれを `enter-auth-blocked` effect として公開し、`startup-actuation.ts` の `planSyncRuntimeStartupActuation(input)` が `stop-background-queues -> set-status(auth-blocked) -> show-repair-entry -> show-notice` の shell command に変換する。`applySyncRuntimeShellCommands(state, commands)` は command を `SyncRuntimeShellState` に畳み込み、auth-blocked では `backgroundQueues="stopped"`、`repairEntries=[device-revoked|reauth-required]`、`runnableEffects=[]` を固定する。通常 startup でも shell state の初期値は `backgroundQueues="stopped" / backgroundQueueStopReason="startup-not-ready"` で、startup step の実行予定は `runnableEffects` に積む。actuation plan の適用だけでは queue worker を起動せず、shell executor が `resume-background-queues` runtime effect を実行し、その effect を `ack-runtime-effect` した時点で初めて `backgroundQueues="running"` にする。shell executor は `executeRunnableSyncRuntimeShellEffects(input)` を通り、`runnableEffects[0]` を順に実行し、成功時は `ack-runtime-effect` で先頭と構造的に同じ effect だけを `runnableEffects` から消して `completedEffects` へ移し、失敗時は `fail-runtime-effect` で先頭と構造的に同じ effect だけを `runnableEffects` から外し、後続 effect を実行せず、`lastFailedEffect` を記録し、`startup-rejected` repair entry / notice を出して `status="rejected" / backgroundQueues="stopped"` に戻す。`createSyncRuntimeStartupEffectExecutor(ports)` は local-store schema open/delete、setup exchange、accepted startup step、local-store rebuild 後の replan scheduling を別 port に分配し、`createSyncRuntimeIndexedDbLocalStoreEffectPort(input)` は executable な local-store schema open/delete effect を `applyLocalStoreIndexedDbOpenEffect(input)` へ接続し、`hold-degraded` / `reject-open` が誤って runnable queue に入った場合は IndexedDB を触らず fail にする。local-store rebuild の最後は `createSyncRuntimeLocalStoreRebuildReplanPort(input)` で fresh evidence collection / startup replan を scheduler に要求し、scheduler が拒否した場合は rebuild effect を ACK しない。`createSyncRuntimeStartupStepEffectPort(ports)` は accepted startup step を setup persistence、local scan/adoption、remote snapshot/state-vector、local YDoc load、WebSocket admission、outbox/background queue resume の domain port に分ける。setup persistence port は `createSyncRuntimeSetupPersistStepPort(input)` で `persistLocalSetupResponse(input)` へ接続し、SecretStorage write と metadata transaction のどちらかが拒否された場合は step を ACK せず `fail-runtime-effect` へ流す。各 step port method は `SyncRuntimeStartupStepEffect<"step-name">` を受け取り、例えば setup persistence port に `open-websocket` step を渡す配線ミスは typecheck で落とす。`enter-auth-blocked` / degraded / reject / schema evidence failure のような terminal effect が誤って runnable queue に入った場合は ACK せず fail にする。先頭以外への ack/fail は out-of-order として no-op にする。失敗 effect は自動再実行せず、UI/repair が `retry-last-failed-effect(user-requested-retry|startup-replan)` を明示した場合だけ `startup-rejected` repair entry を消して `runnableEffects` の先頭へ戻す。startup step が進み始めたら `clear-repair-entries(startup-progress)` を先に適用し、stop reason を `startup-not-ready` に戻して、再認証成功後の reconnect で古い revoked/reauth repair entry を残さない。これにより revoked device や再認証待ちは新規 setup と混同されず、background queue も再開されない。ここまでの decision/runtime shell 境界は `src/sync/` に実装済みで、現行 `src/main.ts` は CM6/Yjs/disk spike の plugin lifecycle に sync startup tick の手動 command を追加している。ただし実 Obsidian settings UI、SecretStorage-backed setup exchange、local-store schema probe、再認証 modal、revoked device repair view、queue worker executor へ配線する production runtime はまだ未接続である。次に plugin lifecycle へ繋ぐ時は、この state を唯一の描画/実行入力にし、UI handler が独自に auth 状態や queue 起動可否を再判定しない。local meta YDoc だけ欠けている場合は remote meta snapshot から `restore-local-meta-snapshot` へ入る。schema が plugin の supported version より新しい場合は degraded にして、古い plugin が新しい store を壊さないようにする。

`run-setup-exchange` の concrete port は `createSyncRuntimeSetupExchangePort(input)` に分離する。この port は HTTP/setup exchange port から `SetupExchangeResponse` を受け取り、その response を startup replan scheduler に渡すだけで、token や metadata は保存しない。HTTP 境界は `setup-exchange-http.ts` の `requestSetupExchange(input)` に分け、`POST /setup/exchange` に `SetupExchangeRequest` を JSON 送信し、2xx response body が `SetupExchangeResponseSchema` を満たす場合だけ `SetupExchangeResponse` として返す。non-2xx response は body を読まず `setup-exchange-http:<status>` で止め、token-bearing body を error や log に混ぜない。startup runtime からは `createEvidenceBackedHttpSyncRuntimeSetupExchangePort(input)` を使い、`readEvidence(effect)` で UI/settings にある endpoint/setupToken/deviceName/既存 deviceId evidence を実行直前に読み、`buildSetupExchangeRequest(evidence.request)` で `SetupExchangeRequest` に組み立て、validated response だけを replan scheduler に渡す。UI/settings の raw 文字列は trim / optional existingDeviceId 正規化 / `SetupExchangeRequestSchema` guard を通し、失敗時は `invalid-vault-id`、`missing-setup-token`、`invalid-requested-device-name`、`invalid-existing-device-id`、`invalid-setup-exchange-request` のいずれかだけを返して setup token 本体を状態やログへ混ぜない。`createHttpSyncRuntimeSetupExchangePort(input)` は、すでに guarded request を作れる caller 向けの低レベル adapter として残す。setup exchange 後の scheduler は `setup-replan.ts` の `planSyncRuntimeStartupAfterSetupExchange(input)` を使い、明示的な `setup-new-vault` / `join-existing-vault` intent はそのまま保持し、`reconnect` から missing credentials で入った場合だけ response の `bootstrapMode` に応じて `setup-new-vault` または `join-existing-vault` に写像する。これをしないと core planner は reconnect input の `setupResponse` を消費せず、missing credentials 判定に戻ってしまう。shell state へ反映する時は `applySyncRuntimeSetupExchangeShellReplan(input)` を通し、完了した setup exchange runtime effect を ACK したうえで、古い `runnableEffects` と `lastFailedEffect` を落として replan 後の actuation commands だけを新しい queue にする。replan 後に planner が返す `persist-setup-response` step だけが SecretStorage / metadata commit を担当する。exchange または replan scheduling が失敗した場合、setup exchange effect は ACK せず `fail-runtime-effect` に落とす。

startup planner が返す step は永続 transaction の境界でもある。`persist-setup-response` は endpoint/deviceId/yClientId/tokenVersion と SecretStorage 管理の access/refresh token を保存するが、join existing ではこの時点で local fileId を作らない。access/refresh token 本体は先に SecretStorage へ置き、access token claims を検証して expiry を取り出したうえで、`setup-persist.ts` の `planLocalSetupPersist(input)` が `write-secret(access) -> write-secret(refresh) -> put metadata(setup) -> put metadata(auth)` の実行計画を返す。production runtime では `createVerifiedSyncRuntimeSetupPersistStepPort(input)` を使い、setup response の access token を verifier port で検証し、claims の vaultId/deviceId/tokenVersion/scope/iat/exp が response と現在時刻に合う場合だけ `accessTokenExpiresAt=claims.exp` を `persistLocalSetupResponse(input)` へ渡す。HS256 JWT の署名・検証は `packages/protocol/src/device-token-jwt.ts` の `signHs256DeviceToken(input)` / `verifyHs256DeviceToken(input)` に集約し、worker の token mint / HTTP admission と plugin の setup persist verifier が同じ header/signature/payload guard を使う。plugin runtime の concrete verifier は `access-token-verifier.ts` の `createHs256AccessTokenVerifier(input)` で、payload は `DeviceTokenClaimsSchema` に通る場合だけ claims として返す。verification が失敗した場合は SecretStorage / IndexedDB を触らず `setup-persist-token:<reason>` で startup effect を fail し、token body は state や metadata に入れない。metadata store には token body を保存せず、`planClientAuthMetadataFromSetupResponse(input)` が作る active な `ClientAuthMetadata` と SecretStorage key 参照だけを保存する。`local-store-indexeddb.ts` の `planLocalStoreIndexedDbMetadataWrites(input)` はこの metadata put を `metadata` object store の concrete `put(value, key)` に写像し、`setup-persist-runtime.ts` の `persistLocalSetupResponse(input)` は SecretStorage write が両方成功した後、`createLocalSetupPersistIndexedDbMetadataPort(database)` 経由で `setup` record と `auth` record を単一 IndexedDB transaction で commit する。metadata transaction では 2 行の `put` request を先に同期発行してから request success と transaction complete を待ち、IndexedDB の active-window をまたいだ await で片方だけ書く状態を作らない。SecretStorage と IndexedDB は同一 transaction ではないため、metadata transaction が abort/error した場合は `planLocalSetupPersistSecretCleanup(input)` に成功済み secret write を渡し、返された SecretStorage delete を best-effort 実行してから setup persistence failure として停止する。cleanup まで失敗した場合も startup は進めず、repair UI が stale setup secret の retry/delete を促す。`apply-remote-meta-snapshot` と `adopt-local-files-after-remote-meta` は別 step として扱い、remote tree を canonical source にしたうえで、まだ remote に無い local file だけを新規採番する。`resume-background-queues` は reconnect の最後で、ClientHello と meta state-vector exchange が済むまで blob/materialize queue を走らせない。

### 18.2 outbox の単位

```
type OutboxItem =
  | { kind: "y-update"; id; dependsOn: string[]; docId; messageId; update; createdAt; retryCount }
  | { kind: "blob-put"; id; dependsOn: string[]; sha256; localCacheKey; size; retryCount }
  | { kind: "manifest-put"; id; dependsOn: string[]; fileId; blobManifestHash; retryCount }
  | { kind: "blob-get"; id; dependsOn: string[]; sha256; targetFileId; retryCount }
  | { kind: "meta-ref-update"; id; dependsOn: string[]; fileId; blobManifestHash; retryCount }
  | { kind: "materialize"; id; dependsOn: string[]; fileId; expectedHash; retryCount };
```

すべて冪等にする。`retryCount` は UX と backoff のためだけで、意味論に使わない。

依存関係:

- binary upload は `blob-put* -> manifest put -> meta-ref-update`。`meta-ref-update` は全 chunk と manifest の PUT 成功に dependsOn する。
- download は `blob-get* -> materialize`。materialize は全 chunk の取得・hash 検証に dependsOn する。
- 依存元が retry 中、paused、pending の item は実行しない。依存元が blocked なら dependent item も transient `blocked` にする。依存元が dead-letter / failed なら dependent item も `dead-letter(reason="dependency-dead-letter")` に連鎖させ、repair log / conflict panel に出す。terminal な欠落を単なる blocked として黙って残さない。
- `nextAttemptAt` が未来の retrying item は実行しない。WS reconnect や手動 sync は due item の scan を即時に走らせるだけで、依存未完了や paused item を飛び越えない。

`packages/core/src/outbox.ts` はこの依存関係を `buildBinaryUploadOutboxPlan(input)` / `buildBinaryDownloadOutboxPlan(input)` という純粋 plan builder にしている。upload は caller が事前採番した `OutboxPlanItemId` から `blob-put* -> manifest-put -> meta-ref-update` を生成し、`meta-ref-update` は全 chunk PUT と manifest PUT の両方に dependsOn する。download は `blob-get* -> materialize` を生成し、materialize は全 chunk GET に dependsOn する。builder は永続 queue を壊す ambiguous record を避けるため、重複 item ID、不正な blob size、空の local cache key を拒否する。0 chunk の manifest は有効で、manifest PUT / meta ref update または materialize に余計な hidden dependency を作らない。

同じ module の `planOutboxDependencyBlocks(items)` は、永続 queue の snapshot から failed / blocked ancestor を持つ item の終端処理を決める。blocked ancestor は `blockPatches`、failed / dead-letter ancestor は `deadLetterPatches` として分ける。直接依存だけでなく transitive ancestor も見る。重複 item ID や欠けた dependency がある queue snapshot は信用せず error にし、scheduler は side effect を開始しない。plugin の outbound queue は scan 開始時にこの plan を同一 IndexedDB transaction で適用してから、次の runnable item を探す。

同じ module の `planOutboxSchedulerTick(input)` は、1 回の outbound queue scan で「どの resume / blocked / dead-letter patch と lease reclaim patch を永続化し、その後どの item を side effect として開始してよいか」をまとめて決める。入力は IndexedDB transaction で読んだ queue snapshot、`now`、runtime profile、前回 tick 以降に観測した resume event 集合、現在の running lease snapshot、最大 start 数。手順は固定:

1. `now`、`maxStarts`、running lease を検証する。不正なら side effect を開始しない。lease は `itemId`、`kind`、`ownerId`、`leaseExpiresAt` を持つ。空 owner、欠けた item、重複 lease、不正な expiry は queue corruption として扱う。
2. `leaseExpiresAt <= now` の lease は stale として `leaseReclaims` に入れ、lane running count から外す。active lease は lane capacity を消費し、同じ item をこの tick で再 start しない。
3. resume event に合う paused item を `resumePatches` に入れ、effective status を `pending` に戻す。`manual` event は paused item を明示的に再試行対象へ戻せるが、依存関係の gate は飛び越えない。
4. resume 後の effective snapshot に対して `planOutboxDependencyBlocks` で block/dead-letter patch を決める。重複 ID / 欠けた dependency があれば side effect を開始しない。
5. resume / block / dead-letter patch と stale lease reclaim を反映した effective status で、input order の itemを見る。
6. 各 item は `decideOutboxRun` で due/dependency を確認し、`decideOutboxConcurrency` で lane capacity を確認する。
7. 開始予定に入れた item はまだ `done` ではない。同じ tick 内で、その item に依存する dependent を開始してはいけない。
8. ある lane が満杯でも、別 lane の後続 item は開始できる。例えば `sync-control` が満杯でも `blob-transfer` / `materialize` は空きがあれば進む。

plugin は `resumePatches`、`blockPatches`、`deadLetterPatches`、`leaseReclaims` を同一 transaction で保存してから、返された `starts` の lease を CAS で取得し、CAS に成功した item だけ side effect を発火する。tick の決定だけを権威にせず、最終的な二重起動防止の権威は lease CAS 結果に置く。CAS に失敗した start は単に捨て、次 tick で再評価する。現在の `packages/obsidian-plugin/src/sync/outbox-worker.ts` はこの順序を `planOutboxWorkerTick(input)` として固定しており、scheduler persist transaction が失敗した時点では start effect を返さない。lease attempt は candidate ごとに記録し、成功した lease だけ `start-side-effect` になるため、実 outbox worker はこの effect list だけを実行すればよい。各 persist / lease attempt は `local-store-driver.ts` の read set と write operation も返すので、実 runtime は同じ plan から IndexedDB transaction の read/write 対象を取り出せる。

`authRefreshBlocks` が返った場合、plugin は同じ tick で auth refresh worker の状態も見る。`decideOutboxAuthRefreshRequest(input)` は、block された item 集合、現在時刻、refresh worker の `idle` / `refreshing` / `backing-off(nextAllowedRefreshAt)` 状態から、refresh を 1 回だけ起動するか、既存 refresh / backoff を待つか、何もしないかを決める。複数 item が同じ near-expiry token で止まっても refresh request は 1 つに畳み、`token-expired` block が 1 つでもあれば request reason は `token-expired` を優先する。壊れた refresh backoff、重複 block、矛盾した block timing evidence は queue corruption として扱い、refresh を多重起動しない。`request-refresh` の場合は refresh HTTP を始める前に `auth-refresh-runtime.ts` の `persistAuthRefreshStart(input)` を通し、`decideClientAuthRefreshStart(input)` が返す `refreshState="refreshing"` / `refreshStartedAt=requestedAt` metadata を単一 IndexedDB transaction で durable commit する。この commit が失敗した場合は refresh HTTP side effect を開始せず、次 tick の scheduler decision に任せる。plugin 起動時または tick 前に `refreshing` が残っている場合は `recoverStaleAuthRefreshStart(input)` を通し、`refreshStartedAt + staleAfterMs` を過ぎていれば timeout 扱いで retryCount を増やし `backing-off(nextAllowedRefreshAt)` へ戻す。まだ stale でなければ `refresh-already-running` の wait を維持する。refresh 成功時は `auth-refresh-runtime.ts` が refresh token を SecretStorage から読み、`POST /auth/refresh` response の access token claims を検証し、`decideClientAuthRefresh` と `decideClientAuthRefreshAttempt` を通したうえで access/rotated refresh token secret と token metadata を保存する。`createAuthRefreshIndexedDbMetadataPort(database)` は refresh metadata put を `metadata` object store の concrete write に変換し、`commitLocalStoreIndexedDbMetadataTransaction(input)` で auth record だけを単一 IndexedDB transaction として commit する。SecretStorage と IndexedDB metadata は非 atomic で、refresh は同じ SecretStorage key を上書きするため、metadata commit が失敗したら新 token を単に delete せず、上書き前に読んだ access/refresh secret snapshot を restore する。snapshot に無かった key だけ delete し、restore まで失敗した場合は startup/outbox resume を止めて repair UI に stale token cleanup を促す。失敗時は token secret を触らず、`decideClientAuthRefreshAttempt` が返す refresh worker backoff / reauth patch だけを保存する。outbox item 自体は pending/retrying のまま残し、次 tick で再評価する。

`decideOutboxLeaseAcquire(input)` は start 直前の CAS 用 decision。既存 lease が無ければ `acquire`、既存 lease が同じ item/kind で `leaseExpiresAt <= now` なら `take-over-expired`、active lease があれば拒否する。owner が空、時計が不正、lease duration が 0 以下、既存 lease の item/kind が start 候補と食い違う場合も拒否する。caller はこの decision を「現在の lease row が input.existingLease と同じなら write」という compare-and-set で適用しなければならない。

`decideOutboxLeaseRenew(input)` は長い side effect の lease 更新 decision。現在 lease が存在し、itemId / kind / ownerId が一致し、かつ `leaseExpiresAt > now` の時だけ `renew` できる。更新後の期限は `now + leaseDurationMs`。owner が違う、kind が違う、すでに期限切れ、duration が 0 以下の場合は拒否する。blob upload/download のように時間が読めない処理は、期限切れ前に renew し続ける前提にする。plugin 側では `planOutboxWorkerLeaseRenewal(input)` が renewal decision、local-store driver commit、concrete IndexedDB writes までまとめ、成功時だけ `lease-renew` transaction と next lease rows を返す。renewal が owner mismatch / expired / missing lease で拒否された runner は、その後の success/failure completion を保存せず、遅延完了として破棄する。

`decideOutboxLeaseRelease(input)` は side effect 完了後または failure transition 後の release 用 decision。現在 lease が存在し、itemId と ownerId が一致し、かつ `leaseExpiresAt > now` の場合だけ release できる。owner が違う場合は、stale lease を別 owner が take-over した後の遅延完了なので、その worker は item state を上書きせず release もできない。owner が同じでも期限切れ後の completion は stale completion として拒否する。成功 patch / failure transition / lease release は同じ transaction で保存する。

`decideOutboxAckCompletion(input)` は、WS から受け取った server response を outbound `y-update` item の完了証拠として採用できるかを決める。完了できるのは `kind="y-update"` で、現在 status が `pending` / `retrying` の item だけ。`Ack` は `vaultId`、`deviceId`、`docId`、`messageId` が item と一致し、`durableSeq` が local cursor より新しい場合だけ `status="done"` patch になる。`NeedFullSnapshot` は item を完了させず、`paused(reason="full-snapshot-required", resumeOn="manual")` patch にして full snapshot fetch / local reset を優先させる。caller はこの completion patch と lease release を同じ transaction で保存し、`decideOutboxLeaseRelease` が stale completion を拒否した場合は ack patch も適用しない。plugin 側では `planOutboxWorkerAckCompletion(input)` がこの decision、lease release、local-store driver commit をまとめ、成功時だけ next outbox records / next lease rows / IndexedDB writes を返す。

`planOutboxFullSnapshotRelease(input)` は、full snapshot apply が成功した doc について、`paused(reason="full-snapshot-required")` の `y-update` を `done(completedBy="full-snapshot-apply", snapshotSeq)` に閉じる。これは `decideOutboxResume` / `planOutboxResumePatches` とは別系統で、手動 resume の対象にしない。full snapshot で local YDoc と cursor が新しい基準へ置き換わった後、古い update を再送すると同じ `NeedFullSnapshot` を再発するか、discard 済み local edit を復活させるので、plugin は snapshot apply と同じ IndexedDB transaction で terminal patch を保存する。plugin 側では `planOutboxWorkerFullSnapshotRelease(input)` が release decision、local-store driver commit、concrete IndexedDB writes までまとめ、matching doc の full-snapshot-required item だけを閉じる。

`decideOutboxQuarantinePause(input)` は、plugin が `/admin/quarantine` の list/detail を polling または repair panel open 時に取得したあと、pending/retrying `y-update` item を `server-quarantine` pause へ移すために使う。server は quarantine 時に ack を返さないので、何もしないと outbox は同じ破損 update を retry し続ける。plugin 側ではこの pause patch と lease release を同一 transaction plan にし、lease が stale の場合は pause patch も適用しない。`planOutboxWorkerQuarantineCompletion(input)` は quarantine evidence、lease owner、local-store snapshot をまとめ、hash/doc/message/device が一致し、かつ lease release CAS が通る場合だけ `server-quarantine` pause と lease delete を同時に適用する。pause patch は `quarantineId` / `quarantineReason` / `docId` を保持し、status bar では degraded、repair panel では該当 quarantine entry を開けるようにする。`discard` 後は local outbox item を自動で done にしない。ユーザーが local edit を捨てる、fork する、または full snapshot/reset を選んだ transaction で初めて terminal にする。`force-apply` 後も即座に古い item を done にせず、同じ `messageId` の再送が duplicate ack を返した時だけ通常 ack completion で閉じるか、repair flow が明示的に local outbox を閉じる。

`packages/model-tests/src/outbox-model.ts` はこの依存関係をより大きい実行可能モデルにしている。binary upload は `blob-put* -> manifest-put -> meta-ref-update`、binary download は `blob-get* -> materialize` を生成し、random operation sequence でも「依存が done になる前に meta ref publish / materialize が発生しない」「永続失敗は dependent を terminal failure として表面化する」ことを検証する。

### 18.3 backoff

- Yjs update: 250ms -> 1s -> 5s -> 30s。WS reconnect 時に即 flush。
- blob PUT/GET: 1s -> 5s -> 30s -> 5min。モバイル回線では同時数 2 まで。
- materialize: すぐ 3 回、以降はユーザー操作（ファイルを閉じる、再同期ボタン）まで待つ。Obsidian が file lock 的に失敗するケースを想定。

`retryAfterMs` を含む retryable API error は server 指示を backpressure の下限として扱う。つまり `effectiveDelay = max(kindSchedule[retryCount], retryAfterMs ?? 0)` で、429/503 や DO overload が「もっと待て」と返した時間を client 側の通常 schedule 上限で短縮しない。固定 schedule には caller 側で jitter をかける。現在の core decision は jitter 比率だけを返し、実際の乱数適用と `nextAttemptAt` の永続化は plugin の queue transaction が行う。

network / timeout / offline は retryable として扱う。auth failure は token refresh / re-auth で回復しうるので queue item を捨てず、`pause(resumeOn="auth-refresh")` にする。local conflict（materialize CAS conflict など）は自動 retry ではなく `pause(resumeOn="local-state-change")` にし、repair log / UI からユーザー操作またはファイル close / 再同期ボタンを待つ。non-retryable API error と invalid payload は retry しても進まないため `dead-letter` に退避し、dependent item も `dependency-dead-letter` として連鎖的に dead-letter へ落とす。Yjs update や meta ref update のような durable item は silent discard しない。

現在の `packages/core/src/outbox.ts` 実装は、この retry/backoff を `decideOutboxRetry(input)` という純粋 decision にしている。戻り値は `retry(delayMs, jitterRatio)`、`pause(reason, resumeOn)`、`dead-letter(reason)` の typed action union。`y-update` / `meta-ref-update` は 250ms -> 1s -> 5s -> 30s、blob 系は 1s -> 5s -> 30s -> 5min、`materialize` は即時 3 回までを policy として公開する。schedule 枯渇後も通常 retryable item は最後の schedule delay で再試行し続ける。`retryCount` はこの delay 計算だけに使い、依存関係の意味論には使わない。

`decideOutboxResume(input)` は paused item をいつ `pending` に戻せるかを決める。`resumeOn="auth-refresh"` は `decideClientAuthRefresh` が accept した token refresh / re-auth 成功後だけ、`resumeOn="local-state-change"` は file close / watcher import / conflict repair など local 状態が変わった後だけ、自動 resume できる。`manual` event は全 paused item を明示的に再試行対象へ戻せるが、依存未完了や dependency failure を飛び越えるわけではない。`planOutboxResumePatches(items, events)` は scheduler tick が受け取った event 集合から persistable `resumePatches` を作り、resume 後も scheduler は必ず `planOutboxDependencyBlocks`、`decideOutboxRun`、`decideOutboxConcurrency` を通す。

同じ module の `decideOutboxRun(input)` は、永続 queue から取り出した item が今実行可能かを status、`nextAttemptAt`、dependency status から判定する。`pending` / `retrying` かつ due で、すべての dependency が `done` のときだけ `run` を返す。dependency が `failed` / `blocked` なら `block`、dependency が未完了なら `wait`、terminal / paused item は実行しない。IndexedDB の並び順や batch size は caller が決めるが、この decision を通さずに side effect を発火しない。

同じ module の `transitionOutboxFailure(input)` は、失敗した attempt を永続 queue に反映する patch を返す。retry の場合は `status="retrying"`、`retryCount + 1`、`nextAttemptAt = now + delayMs + retryJitterMs` を同一 transaction で保存する。`retryJitterMs` は caller が選んだ非負の jitter で、core は `delayMs * jitterRatio` を超える値を clamp する。pause の場合は `retryCount` を増やさず、`nextAttemptAt` を消し、`lastError`、reason、`resumeOn` を保存する。dead-letter の場合も `retryCount` を増やさず `status="failed"` として保存するが、reason は `dead-letter` とし、具体理由は `deadLetterReason` に分けて UI / repair log が silent discard と区別できるようにする。時計が壊れている場合は誤った未来時刻を保存せず manual pause に落とす。plugin 側では `planOutboxWorkerFailureCompletion(input)` がこの failure patch と lease release を同一 local-store transaction にまとめ、lease が stale の場合は retry/pause/dead-letter patch も適用しない。

同じ module の `decideOutboxConcurrency(input)` は、実行可能になった item を本当に開始してよいかを lane ごとの running count で判定する。`sync-control` lane（`y-update` / `meta-ref-update`）と `materialize` lane は 1 本ずつ直列化する。`blob-transfer` lane（`blob-put` / `manifest-put` / `blob-get`）は desktop 4、mobile 2 を上限にする。scheduler は `decideOutboxRun` で due/dependency を確認し、その後 `decideOutboxConcurrency` で lane capacity を確認する。auth-protected item では、start 選定中に `decideClientAuthStart` を通す。`refresh-first` の場合は `authRefreshBlocks` に残して lease を取得せず、lane capacity や `maxStarts` も消費させない。これにより near-expiry token で詰まった sync/blob item が、後続の local `materialize` や別 lane の実行可能 item を飢餓させない。すべて通った item だけ `decideOutboxLeaseAcquire` の CAS へ進め、side effect を開始する。

### 18.4 ハッシュゲートの具体化

```
lastMaterialized[fileId] = {
  ydocHash,
  diskHash,
  path,
  writtenAt,
  writeId
}
```

watcher 発火時:

1. 現在 diskHash を計算。
2. `diskHash == lastMaterialized.diskHash` なら自分の書き込みなので no-op。
3. `diskHash == currentYTextHash` ならすでに収束済みなので no-op。
4. それ以外は外部編集として YText に transaction で取り込む。

materialize 実行時:

1. 対象 fileId が active editor に binding 中なら disk write しない（§9.1）。
2. 書く直前に現在 diskHash を再計算。
3. `diskHash == lastMaterialized.diskHash` の時だけ `Vault.modify` する。
4. 違う場合は未観測の外部編集なので、上書き禁止。
   - 現在の disk 内容を conflict copy として退避
   - disk 内容を YText へ外部編集として取り込み
   - その後、改めて YText の収束結果を materialize queue へ積む
5. write 成功後に `lastMaterialized` を更新する。

この compare-and-swap が最後の防衛線。watcher event が欠落・coalesce・順序入れ替わりしても、未観測の disk 変更を上書きで消さない。

外部編集の取り込みは全文 delete+insert にしない。少なくとも共通 prefix/suffix を削って中央だけを `Y.Text.delete/insert` する。全文置換は op 肥大化だけでなく、他端末の並行 edit と合流した時に「全消し」と中間 insert が絡み、外部編集の意図と違う形に収束しやすい。

hash gate / materialize CAS は raw text ではなく SHA-256 の canonical text hash を使う。

- 先頭 BOM を除去
- CRLF/CR を LF に正規化
- non-empty text は terminal newline 1 つとして比較

YText 本文は BOM なし・LF 改行を canonical form とする。ただし terminal newline の正規化は hash 比較専用で、YText 本文には強制しない。disk から取り込む時は BOM 除去 + LF 正規化後の本文に対して minimal replacement を計算し、YText へ適用する。これにより Obsidian/外部エディタの EOL 差や末尾改行差で外部編集を誤検出し、conflict copy を量産するのを避ける。

現在の `packages/core/src/materialize.ts` 実装は、この hash gate / materialize CAS の決定部分を `decideWatcherHashGate(input)` と `decideMaterializeWrite(input)` として共有する。watcher は `ignore-own-write`、`ignore-converged-write`、`import-external-edit` の 3 分岐、materialize は `skip-active-editor`、`write`、`block-conflict` の 3 分岐に閉じる。`lastMaterialized` が欠けている時は安全な base hash がないため `missing-last-materialized` として write を拒否する。

---

## 19. 初回導入と既存 Vault の index

### 19.1 初回 scan

既存 Vault を初めて同期対象にする時は、通常 watcher とは別の `initial-index` モードで走らせる。

ただし「最初の端末が vault を作る bootstrap」と「既に同期済みの vault に別端末が参加する join」は分ける。join 端末はローカルファイルへ即 UUID 採番しない。まず remote meta YDoc を取得し、path/content hash が一致する entry があれば既存 fileId に adopt する。

```
bootstrap:
  1. ignore rules を確定
  2. 全ファイルを列挙
  3. 既存 file-ids.json があれば path -> fileId を復元
  4. 無ければ UUID 採番
  5. .md は YText seed、binary は blob upload queue へ
  6. meta YDoc に file entry を追加
  7. meta sync 開始

join:
  1. remote meta snapshot を取得
  2. local path と canonicalPath を照合
  3. hash が一致するものは remote fileId を adopt
  4. path は同じだが hash が違うものは Yjs merge または conflict copy
  5. remote に無い local file だけ UUID 採番して新規追加
```

初回 scan 中に Vault が変更されたら、scan 完了後にもう一度差分 scan を走らせる。scan 中の watcher イベントを逐次処理しようとすると順序が複雑になるため、初期実装では「scan snapshot + 追い scan」でよい。

### 19.2 path 正規化

- path separator は `/`。
- Unicode normalization は Obsidian/OS 差を考慮し、比較用 canonical path を別に持つ。
- 大文字小文字は OS によって衝突条件が違う。`canonicalPath = lower(normalize(path))` を conflict detection に使い、実表示 path は保持する。
- `.obsidian`, `.trash`, `.git`, plugin cache は default ignore。

---

## 20. 観測性と運用ログ

self-healing は「治ったかどうか」が見えないと信用できない。初期から最低限の counters と repair log を持つ。

### 20.1 クライアント側

```
repair-log.jsonl:
  { ts, level, event, fileId, path, action, beforeHash, afterHash, detail }
```

記録するイベント:

- external edit imported
- echo event ignored
- path conflict auto-renamed
- delete-vs-edit restored
- blob download retry exhausted
- full snapshot fallback used
- local materialize failed

### 20.2 Worker/DO 側

DO は構造化ログで以下を出す。

- connection open/close count
- op append latency
- checkpoint duration / snapshot size / compacted op count
- cold start restore source（R2 manifest / DO SQLite residual）
- duplicate message ignored
- auth rejected reason

個人用途でも、問題発生時に「どの層で詰まっているか」を判別できることが重要。

---

## 21. テスト戦略

### 21.1 core/protocol の単体テスト

実装済みの足場:

- `packages/core` は canonical text hash、YText 用 canonicalization、任意 bytes の SHA-256、client auth metadata setup persist / guard / refresh attempt apply / revoke patch apply、client auth refresh decision、client auth refresh attempt/backoff decision、client device revoke local patch decision、client auth start expiry gate、単一 middle replacement の最小置換、同一 path 別 fileId の deterministic repair plan、delete vs edit repair plan、repair plan の meta entry 適用、watcher hash gate、materialize CAS decision、full snapshot bytes/hash verification、full snapshot response normalization / apply gate / stateVector patch、local store schema create/open/upgrade/rebuild gate、local store degraded repair/export gate、local outbox repair import staging/resume gate、client startup bootstrap/join/reconnect planner、binary upload/download outbox plan builder、outbox retry/backoff decision、outbox paused resume decision、outbox resume patch planner、outbox ack completion decision、outbox quarantine pause decision、outbox full snapshot release planner、outbox dependency block / dead-letter propagation、outbox scheduler tick plan、outbox scheduler auth start gate、outbox auth refresh request decision、stale running lease reclaim、outbox lease acquire/renew/release CAS decision、outbox run scheduler decision、outbox failure transition、outbox concurrency decision をテストする。
- `packages/protocol` は branded ID、protocolVersion guard、health response guard、setup exchange request/response guard、setup token issue response guard、device token claims guard、device token refresh request/response guard、blob HTTP request/response guard、meta/doc latest snapshot response guard、local outbox repair export guard、admin operation request/response guard、revoke device request/response guard、`hello` / `sync-request` / `sync-update` / `ack` / `need-full-snapshot` の control message guard、binary frame encode/decode、binary header guard、ApiError guard、MetaFile schema guard、BlobManifest schema guard、canonical manifest JSON、meta 照合をテストする。
- `packages/blob` は決定論的 chunking、BlobManifest 構築、canonical manifest hash、binary meta fast path との一致、chunk/content hash 検証付き assemble をテストする。
- `packages/worker` は Worker fetch / `VaultRoom` Durable Object shell routing、auth admission decision、auth refresh HTTP response plan、device revoke HTTP response plan、blob head/upload-url HTTP response plan、worker health decision、schema migration decision、initial SQLite schema DDL、setup token consume decision、setup exchange HTTP response plan、`VaultRoom` setup exchange HTTP route / token consume / device credential persist / transaction rollback、`VaultRoom` auth refresh HTTP route / refresh token rotation / transaction rollback、`VaultRoom` device revoke HTTP route / authenticated revoke / idempotent already-revoked、`VaultRoom` quarantine list/detail HTTP route / authenticated inspect / bytes付きdetail、R2 snapshot key naming、SnapshotManifest guard、stale/corrupt pointer から prefix list 最大健全 snapshot へ fallback する復元候補選択、checkpoint write/compact decision、`VaultRoom.checkpointDoc` の R2 PUT + docs pointer update + covered op_log compact、`VaultRoom.alarm` の append後予約 / vaultId復元 / 未checkpoint doc batch checkpoint、orphaned checkpoint run recovery decision、snapshot retention delete plan、setup exchange credential plan、client hello / token refresh / refresh token rotation / revoke device registry decision、`VaultRoom` hello registry admission / WS JWT admission / missing secret fail-closed / hibernation attachment session restore / session identity mismatch、binary frame の decode + hello gate + durable append 後 broadcast、sync request diff/full-snapshot boundary decision、`VaultRoom` sync-request の diff/no-update/full-snapshot 応答、sync update quarantine/append/duplicate/snapshot-escape decision、quarantined update admin inspect/discard/force-apply decision をテストする。
- `packages/model-tests` は checkpoint/cold-start に加えて、outbox dependency graph が blob/manifest 完了前の meta ref publish と download 完了前の materialize を防ぐこと、sync update の retry が seq を増やさないこと、large update が op_log ではなく snapshot boundary へ流れ、snapshot pointer と doc clock が巻き戻らないこと、compacted op_log の message dedup TTL が切れた後に同じ update が replay されても restored logical content が変わらないことを random sequence でテストする。

追加していく項目:

- Yjs update の冪等適用。
- 古い SV に最新 full snapshot を apply して合流できること。
- deterministic repair plan を meta YDoc transaction へ適用した結果が全クライアントで一致すること。
- delete vs edit repair plan を meta YDoc transaction へ適用し、binary 欠損時は tombstone 維持と repair log へ流れること。
- Worker/plugin は `hashBytesSha256(encodeBlobManifestJson(manifest))` が `blobManifestHash` と一致することを確認する。
- binary frame envelope の encode/decode と schema validation。
- protocolVersion / minCompatible の拒否条件。
- outbox dependency graph が参照公開前に blob PUT 完了を要求すること。

### 21.2 Worker の統合テスト

- op append -> checkpoint -> compact -> cold start 復元。
- checkpoint 中に op が来ても snapshot + residual op で復元できること。
- R2 PUT 失敗時に op_log が消えないこと。
- duplicate `messageId` で op_log が二重化しないこと。
- `latest.json` が古い状態でも DO SQLite から復元できること。
- `latest.json` が壊れても旧 manifest へ fallback できること。
- revoked device token が WS/HTTP の両方で拒否されること。
- migration 失敗時に degraded になり op を受けないこと。
- per-doc pointer が stale/欠落しても prefix list で最大 seq を拾えること。
- large update が op_log を経由せず snapshot 経路に逃げること。
- `checkpoint_runs.status = writing` のまま残った cold start で安全に復旧できること。
- 最新 snapshot が論理破損した時、retention された旧 manifest/snapshot へ rollback できること。
- 不正 update が本 YDoc/op_log に入らず `quarantined_updates` に残ること。
- 同じ `y_client_id` を別 `deviceId` が名乗った時に接続拒否されること。
- blob GC が `gcRetentionWindow < maxOfflineWindow` 設定では有効化されないこと。

### 21.3 Obsidian plugin の結合テスト

Obsidian 本体を完全に headless で動かすのは重いので、最初は adapter を薄くして fake Vault でテストする。

- YText -> materialize -> watcher の echo が no-op になる。
- 外部編集が YText に取り込まれる。
- rename が delete+create ではなく fileId path update になる。
- conflict copy が必要なケースで元データを捨てない。
- foreground resume で WS 再接続と SV 交換が必ず走る。
- 同一既存 Vault を 2 端末で join して、fileId が二重採番されず adopt される。
- active file を開いたままリモート rename/delete されても CM6 binding が壊れない。
- GET した chunk の hash 不一致を破棄し、再取得で収束する。
- 2 端末で同一ファイルを同時 rename して deterministic repair に収束する。
- IndexedDB 消失後に同じ `deviceId` が再参加しても full snapshot merge 経路で復旧する。
- 初回フルシンクが WS/op_log に大量 seed を流さず、snapshot 直 PUT + meta 参照更新で進む。
- watcher event を意図的に落としても、materialize 直前 CAS が未観測 disk edit を conflict copy に退避する。
- binary delete vs edit 復活時に chunk 欠落があれば、壊れたファイルを復活/materialize しない。

### 21.4 手動検証シナリオ

1. 2 端末で同じ段落を同時編集し、文字単位で両方残る。
2. 端末 A offline で編集、端末 B online で編集、A 復帰で merge。
3. 端末 A が画像追加中に Worker/R2 を一時失敗させ、復帰後に参照と実体が揃う。
4. 端末 A delete、端末 B edit を同時に行い、編集勝ちで復活。
5. DO を再起動/消去相当して、R2 snapshot + residual op から復元。

---

## 22. 実装前スパイク計画

設計が固まっても、実装前に必ず潰すべき未証明領域が 2 つある。ここは本実装とは分け、捨てる前提の spike と model test で検証する。

### 22.1 CM6 ⇄ Yjs ⇄ disk スパイク

目的: Obsidian の実エディタ上で、`CodeMirror6 -> Y.Text -> disk -> watcher -> Y.Text` が反響せず往復できるかを証明する。ここが通らない場合、同期設計ではなくクライアント統合方針を変える。

範囲:

- desktop Obsidian を主対象にする。
- iOS/mobile は同じ plugin build で最低限 smoke test する。
- 対象 file は 1 つに固定してよい。
- backend / DO / R2 は使わない。
- y-indexeddb は使う。再起動後に YDoc が復元されるかを見る。
- CM6 binding は `y-codemirror.next` の `yCollab` を使い、独自 ViewPlugin で全文置換する経路は避ける。
- hash gate / CAS は `@kuroflare/core` の canonical text hash を使う。
- disk -> YText import は `@kuroflare/core` の minimal replacement で中央差分だけを YText に適用する。

捨てる前提:

- UI は status bar と console log だけでよい。
- 設定画面は不要。
- fileId は固定値でよい。
- conflict UI は不要。conflict copy のファイル生成だけ確認する。
- コードは本実装へ流用してもよいが、流用前提で抽象化しない。

検証項目:

1. `registerEditorExtension` で空 extension を登録し、active file open 時に `Compartment.reconfigure` できる。
2. `leaf.view.editor.cm` または代替経路で `EditorView` を取得できる。
3. CM6 編集が Y.Text に反映される。
4. Y.Text transaction が editor view に反映される。
5. active file には background materialize しない。
6. file close / inactive 化で Y.Text を disk flush できる。
7. flush 後 watcher event が発火しても hash gate で no-op になる。
8. watcher event を意図的に無視した後、materialize CAS が未観測 disk edit を検出して conflict copy を作る。
9. Obsidian undo と Y.UndoManager が二重に破綻しない。破綻するなら Obsidian undo を優先し、Y.UndoManager は spike では無効化する。
10. Obsidian restart 後、y-indexeddb の `whenSynced` 後に YDoc が復元され、古い disk 内容で上書きされない。
11. CRLF/LF・BOM・末尾改行差は canonical hash で no-op と判定される。
12. 外部 disk edit は全文 delete+insert ではなく、共通 prefix/suffix を保った single replacement として YText に入る。

成功条件:

- 1 ファイルで 10 分程度編集しても echo loop が起きない。
- 外部エディタで変更しても内容が消えず Y.Text に取り込まれる。
- watcher を落とした最悪ケースでも materialize CAS が上書きを止める。
- Obsidian restart 後に YText と disk の整合が保たれる。
- canonical hash / minimal replacement の単体テストが通る。

失敗時の分岐:

- `EditorView` を安全に取れない: CM6 binding を諦め、Vault watcher ベース + conflict copy 中心の同期へ縮退するか、対応 Obsidian version を固定する。
- undo が壊れる: spike では Y.UndoManager を使わず、Obsidian の undo に寄せる。
- mobile で CM6 経路が違う: mobile は active editor binding を諦め、foreground resume + file-level materialize へ縮退する可能性を残す。

### 22.2 DO checkpoint/cold-start model test

目的: 「R2 snapshot + residual op_log でいつでも完全復元できる」を、文章ではなく実行可能な状態機械として固定する。ここは backend 実装の土台なので、機能を広げる前に property/model test にする。

モデル化する状態:

```
ModelDoc:
  ackedValid: Set<UpdateId>
  seenMessages: Set<MessageId>
  opLog: Array<{ seq, updateId, messageId, status }>
  checkpointRuns: Array<{ runId, upperSeq, status, snapshotKey }>
  r2Snapshots: Map<snapshotKey, { upperSeq, content: Set<UpdateId>, healthy: boolean }>
  pointer: snapshotKey
  quarantined: Set<UpdateId>
```

操作:

- append valid update
- append invalid update -> quarantine
- start checkpoint
- crash before R2 PUT
- crash after R2 PUT before pointer update
- crash after pointer update before compact
- compact op_log
- cold start
- load old client with stale SV
- large update direct snapshot
- retention rollback
- duplicate message replay
- duplicate replay after compaction / expired dedup
- stale pointer cold start
- corrupt snapshot cold start

不変条件:

- valid update は、`latest snapshot + residual op_log` のどちらかに必ず残る。
- R2 PUT が確認される前に op_log を消さない。
- compact 後も retention 対象の snapshot から rollback できる。
- `r2-written` / `pointer-updated` で未 compact の checkpoint run が参照する snapshot は retention cleanup で消さない。
- snapshot pointer は `upperSeq` 単調増加。古い checkpoint run が遅れて完了しても pointer を巻き戻さない。
- stale pointer を読んだ cold start は、prefix list 相当で最大 `upperSeq` の健全 snapshot を選び、retained op_log を replay して復元する。
- 最新 snapshot が corrupt と判定された cold start は、最新の健全 retained snapshot へ fallback し、その snapshot の `upperSeq` より後の retained op_log を replay して復元する。
- retention cleanup は最新の健全 snapshot を最低 1 つ保持する。
- quarantined update は snapshot に入らない。
- live dedup window 内の duplicate messageId は状態を二重に進めない。
- compaction 後に dedup TTL を越えて同じ update が replay されても、seq は増え得るが cold start 復元 content は変わらない。
- cold start 後の復元 content は crash 前に durable ack した update をすべて含む。
- large update 経路でも pointer 更新前に旧 snapshot/op_log が復元可能。

成功条件:

- ランダム操作列 + crash injection を 10,000 ケース程度流して不変条件が破れない。
- 破れた場合、最小反例を再現できる。
- 実 Worker 実装の checkpoint/compact はこの model の操作名に対応する関数名に寄せる。

実装済み:

- `packages/model-tests/src/checkpoint-model.ts`
- `packages/model-tests/src/checkpoint-model.test.ts`
- `pnpm test` で deterministic seed 1..10,000 を実行する。
- `replayCompactedDuplicateWithoutDedup` は compact 済み update の message dedup が失効した後の再送をモデル化し、復元 content が不変であることを deterministic/random sequence の両方で検証する。
- 追加時に見つかった反例:
  - retention が未 compact checkpoint snapshot を消すと、遅れて完了する run が壊れる。
  - 古い checkpoint run が pointer を巻き戻すと、すでに compact 済みの新しい update を cold start で失う。
  - corrupt snapshot から古い健全 snapshot へ戻るには、snapshot retention だけでなく rollback 用 op_log retention が必要。
  - retention cleanup が corrupt 最新世代だけを残すと、健全な rollback 先を失う。

MVP との関係:

- CM6 spike が通ったら MVP-0 に進む。
- DO model test が通ったら MVP-1 の backend 実装に進む。
- どちらかが落ちたら設計を戻して修正する。UI や binary CDC を先に積まない。

---

## 付録: remotely-save / Self-Hosted LiveSync との比較

| 観点             | remotely-save          | LiveSync                                | 本設計                              |
| ---------------- | ---------------------- | --------------------------------------- | ----------------------------------- |
| 同期単位         | ファイル全体           | CDC チャンク                            | テキスト=Yjs op / バイナリ=CDC      |
| テキスト並行編集 | 後勝ち（ロールバック） | チャンク単位、同チャンクは手動 conflict | **文字単位 CRDT で自動**            |
| 衝突時のデータ   | 消えうる               | 両版保存・手動選択                      | 消さず収束、意味的衝突のみ通知      |
| バックエンド     | 各種クラウド           | CouchDB / Object Storage                | Cloudflare（DO + R2）               |
| E2EE             | 対応                   | 対応（故にサーバーはマージ不可）        | 非対応（DO がマージ・スナップ生成） |
| 設計思想         | 正しく上書き           | だいたい自動 + 人間の受け皿             | **自己修復（防止より修復）**        |

> 本設計の本質は、LiveSync が諦めた「同チャンク並行編集の自動解決」を Yjs で取りに行きつつ、LiveSync が実戦で培った「詰まった時の人間用の非常口（手動エスケープハッチ・conflict レビュー・Setup URI）」も併せ持つこと。理論的な収束強度と運用の現実性を両取りする。

---

## 付録: 実装ステータス（2026-06-20 スナップショット）

> このセクションは外部レビュー時点の実装状況メモであり、設計仕様ではない。進捗に応じて更新する。

### 規模

| パッケージ                    | src 行数 | test 行数 | 中身                                                                                                                                                            |
| ----------------------------- | -------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| worker                        | 約6,100  | 約6,200   | WS 同期・setup/exchange・auth/refresh・device revoke・quarantine admin・blob data plane・checkpoint・R2 cold-start 復元までの実ランタイム。`wrangler.toml` あり |
| core                          | 約4,400  | 約4,200   | startup / reconcile / materialize / outbox / snapshot / auth metadata 等の純 decision                                                                           |
| obsidian-plugin               | 約9,300  | 約10,200  | spike プラグイン（`KuroflareSpikePlugin`）＋ IndexedDB local store・outbox worker・sync-engine planner・startup-actuation                                       |
| protocol / blob / model-tests | 約2,300  | 約1,700   | wire guard・blob planner・性質/モデルテスト                                                                                                                     |

合計 約2.2万行 src ＋ 約2.2万行 test。テスト比はほぼ 1:1 で、純ロジックの検証密度は高い。

### できているもの

- Worker 実ランタイム（`packages/worker/src/runtime.ts` 約3,150行）に MVP-1 backend の制御面が一通り存在する。
- core / protocol の decision 層と wire guard が広くカバーされ、単体・モデルテストで固められている。
- blob data plane は `head()` 化・vault 別 R2 キー・サイズ上限・multipart の明示拒否まで対応済み。
- startup の auth 状態判定（active / revoked / reauth-required → auth-blocked）が決定層で実装済み。

### 未検証・未配線の「長い棒」

> 2026-06-29 更新で 1・2・4・7 が解消した（実 Linux Obsidian app + obsidian-cli を実機で回せるようになった）。2026-06-30 更新で MVP-2 の Worker 経由 meta 同期と text 本文 per-file YDoc 化を実機 e2e に載せた。下記は更新後の状態。

1. **plugin↔Worker のフル e2e を実機で検証済み**。`packages/worker/vitest.e2e.config.ts` + `test/e2e/sync.e2e.test.ts` の workerd 単体 e2e（JWT hello → durable ack、2 クライアント同段落並行編集収束、meta YDoc broadcast + late join 復元、後続参加者の sync-request 再構成、R2 checkpoint、DO eviction → op_log cold-start）に加え、`packages/obsidian-plugin/scripts/obsidian-miniflare-smoke.mjs` が **実 Linux Obsidian + miniflare Worker** 上で setup token 交換 → R2 snapshot→Obsidian disk 反映 → 別デバイスのリモート編集→disk 反映 → Obsidian ローカル編集→リモートへブロードキャスト → meta YDoc の cross-device concurrent rename → deterministic conflict repair → disk materialize → plugin reload 後の再接続まで、dev:errors なしで通す（`pnpm --filter @kuroflare/worker dev:local` + `pnpm --filter @kuroflare/obsidian-plugin test:e2e:obsidian:miniflare`）。
2. **ワークスペース全体ビルド・typecheck・lint・format は全て通過**。`pnpm typecheck` / `oxlint .` / `oxfmt --check .` / `pnpm build` が green。node 単体 647 + worker e2e 6。
3. **終端状態の actuation 未配線**。`enter-auth-blocked` / `enter-degraded` は shell command 化までは実装済みだが、実 Obsidian の UI / repair flow へは未接続。
4. **CM6 ⇄ Y.Text ⇄ disk の往復を実 Obsidian シェルで検証済み（MVP-0 受け入れ）**。headless の `src/obsidian/editor-binding.test.ts`（jsdom + 実 CodeMirror6 + 実 yjs/y-codemirror.next）に加え、`scripts/obsidian-cli-smoke.mjs` が [obsidian-cli](https://github.com/chhoumann/obsidian-e2e)（実 Linux Obsidian + 実 vault）上で binding seed → remote insert→YText→disk flush（materialize CAS 経由）、外部 disk 編集→watcher hash gate→YText 取り込み、2 つの Markdown file を開き分けても text YDoc が混ざらない per-file YDoc レグ、watcher を意図的に落とした際の materialize CAS conflict-copy 退避を dev:errors なしで通す（`pnpm --filter @kuroflare/obsidian-plugin test:e2e:obsidian`）。
5. **MVP-2 の path repair / file-tree は live 配線済み、Worker 経由の cross-device 同期も実機 e2e 済み。MVP-3 の危険仮説も実機 e2e に載った**。plugin に live meta YDoc を持たせ、vault create/rename/delete を `applyFileCreate/Rename/Delete`（`src/sync/meta-file-tree.ts`）へ、meta afterTransaction を `reconcileMetaDoc`（`src/sync/meta-reconcile.ts`）へ接続。収束した rename は `materializedPaths` 経由で `app.fileManager.renameFile` により disk へ反映する。`test:e2e:obsidian:mvp2` が実 Linux Obsidian で「rename が同一 fileId の path 更新（delete+create にならない）」を実証し、`test:e2e:obsidian:miniflare` が meta YDoc を Worker（`docId.kind='meta'`）へ同期して remote peer との concurrent rename を deterministic に収束・materialize する。text 本文は active file ごとに別 YDoc / IndexedDB persistence を持つ。バイナリは実 Worker の blob proxy に chunk PUT、blob manifest PUT、meta 参照公開、manifest/chunk GET、content hash reassemble まで載った。初回フルシンクは Worker/R2 に seed 済みの meta snapshot と file YDoc snapshot から、空の Obsidian vault に Markdown 本文を materialize するところまで載った。ただし production latest snapshot API、通常 bootstrap/import flow、outbox runner 常用化は §11.2 の残タスク。
6. **UI 全般が未着手**。conflict UI・手動エスケープハッチ・Setup URI フロー・設定タブは spike コマンドのみ。
7. **git 初期コミット済み + CI 雛形あり**。`.github/workflows/ci.yml` が push(main)/PR で format:check → lint → typecheck → unit test → worker e2e を回す。実 Obsidian e2e は実機（display + Obsidian app）依存のため CI 外の手動/ローカル実行。デプロイ検証は未。

> e2e 立ち上げで顕在化し修正した実バグ 2 件（fake が隠していた）:
>
> - DO が SQLite スキーマ migration を**一度も適用していなかった**（`decideSchemaMigration` は純関数として存在するが runtime 未配線）。`VaultRoom.ensureSchema()` を SQL を触る各入口で実行するよう配線。
> - real SQLite は `NULL` 列を `null` で返すが runtime は不在を `undefined` 前提にしており、`devices.revoked_at` が `null` の非失効デバイスが全て `unknown-device` 拒否されていた。`nullToUndefined` で正規化。

### MVP チェックリスト（§11.1 対応）

- [x] MVP-0: local editor loop（実 Linux Obsidian + obsidian-cli で CM6 ⇄ Y.Text ⇄ disk の両レグ、per-file YDoc、watcher-drop CAS conflict-copy を往復。`test:e2e:obsidian`）
- [x] MVP-1: one file remote sync（workerd e2e に加え、実 Linux Obsidian + miniflare で plugin↔Worker フル同期・リモート並行編集・再接続を証明。`test:e2e:obsidian:miniflare`）
- [x] MVP-2: meta YDoc + path repair（decision + live 配線済み。rename=path 更新、Worker 経由 cross-device concurrent rename 収束、text 本文 per-file YDoc 化を実 Obsidian e2e で実証）
- [x] MVP-3: initial sync + binary（binary blob PUT→meta 参照公開、manifest/chunk 再取得、初回 meta/file snapshot からの Markdown materialize を実機 e2e で証明。production API/UX 化は §11.2 に残す）

### 推奨する次の縦切り

(a) 完了: 全体ビルド通過。(b) 完了: miniflare で MVP-1 の 1 ファイル同期 e2e。(c) 完了: 実 Linux Obsidian + obsidian-cli で MVP-0（CM6 往復 + disk materialize + 外部編集取り込み + watcher-drop CAS conflict-copy）と MVP-1（plugin↔Worker フル同期）を実機受け入れ。(d) 完了: MVP-2 の path repair / file-tree を live 配線し、`test:e2e:obsidian:mvp2` と `test:e2e:obsidian:miniflare` で rename=path 更新、Worker 経由 concurrent rename 収束、text 本文 per-file YDoc 化を実機実証。(e) 完了: MVP-3 の CDC バイナリ（blob PUT→meta 参照公開）と初回フルシンク（meta/file snapshot から Markdown materialize）を実機 e2e 化。**次は §11.2 の P0**: startup pipeline、production snapshot API、outbox runner を ad-hoc 実装から production runtime へ接続する。
