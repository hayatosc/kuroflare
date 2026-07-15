# Kuroflare 設計書

Cloudflare エコシステムで完結する、CRDT ベースの Obsidian Vault 同期プラグイン。
remotely-save が抱える「同期失敗 → ロールバック（データ消失）」を、**自己修復（self-healing）型同期**で原理的に置き換える。

この文書は設計の骨格（原則、アーキテクチャ、不変条件の総覧）だけを持つ。
各領域の規範的な詳細は `docs/spec/` の章に分冊してある。

| 章                                             | 内容                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| [data-model.md](docs/spec/data-model.md)       | fileId、メタ YDoc、本文 YDoc、CDC チャンクと manifest、path 正規化                    |
| [sync-model.md](docs/spec/sync-model.md)       | state vector 合流、full snapshot merge、バイナリ参照同期、削除、決定論的修復、blob GC |
| [protocol.md](docs/spec/protocol.md)           | WebSocket / binary frame / HTTP API、認証、デバイス管理、device identity              |
| [server.md](docs/spec/server.md)               | VaultRoom DO、SQLite schema、checkpoint / compact、retention、quarantine              |
| [client.md](docs/spec/client.md)               | 起動シーケンス、状態モデル、IndexedDB、outbox、full snapshot 適用、初回同期           |
| [editor.md](docs/spec/editor.md)               | CM6 バインディング、ハッシュゲート、materialize CAS                                   |
| [operations.md](docs/spec/operations.md)       | 運用機能、観測性、プロジェクト構成、テスト戦略、ロードマップと MVP                    |
| [design-review.md](docs/spec/design-review.md) | Cross-cutting design review, unresolved changes, and acceptance criteria              |

実装の進捗とモジュール対応表は [docs/implementation-status.md](docs/implementation-status.md) にある。

---

## 1. 確定事項

| 項目              | 決定                                | 理由                                                                                                                          |
| ----------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| デプロイ形態      | 個人が自分でデプロイ                | 自分の複数端末での利用が主                                                                                                    |
| E2EE              | **採用しない**                      | サーバー（DO）が plaintext の Yjs を読めることで、マージとスナップショット生成と運用コマンドが大幅に単純化する                |
| テキストマージ    | **Yjs（真の文字単位 CRDT）を死守**  | 「同じ段落を同時編集しても壊れない」を自動で満たす。これが LiveSync 等に対する最大の差別化点                                  |
| バイナリ          | content-defined chunking (CDC) + R2 | 大ファイルの差分転送と重複排除                                                                                                |
| Recoverable state | **R2 snapshot + DO SQLite op-log**  | Combines the latest authoritative, verified, healthy snapshot with later durable operations; R2 bytes alone are not authority |

## 2. 自己修復という設計原則

本設計で起きる不整合は、すべて「2 つのストアを 1 トランザクションで更新できない継ぎ目」で生じる（§4）。
跨ぎ書き込みを原子化しようとは頑張らない。
Once an un-atomic boundary is accepted, the following four tools keep ordinary failures within “a briefly stale view that quickly converges” and avoid data loss. Complete SQLite loss is treated separately as a disaster boundary outside the normal guarantee.

1. **単調な永続化**：データは内側から外側へ一方向に流し、外側が確定するまで内側を消さない。
2. **冪等な操作**：すべての操作を何度でも再実行できる形にする。部分失敗は再実行で無害に回収する。
3. **防がずに修復**：不整合の完全な防止ではなく、ハッシュ突合による決定論的 reconciliation で起動時に必ず修復する。
4. **収束と実体化の分離**：CRDT の収束はいつ先行してもよい。順序で縛るのはファイルシステムへの配置（materialize）だけにする。

## 3. アーキテクチャ

```
クライアント（Obsidian Plugin）
  ├ アクティブファイル: CodeMirror6 ⇄ Yjs バインディング
  │     （エコーループは debounce + ハッシュゲートで遮断）
  ├ 非アクティブ: Vault watcher ⇄ Yjs（同上）
  ├ y-indexeddb: ローカル永続（state vector を保持 → 再起動後も差分同期）
  └ Vault API: ファイルツリー操作の検知・反映
       │
       │  WebSocket（Yjs update / awareness）
       │  HTTP（blob chunk upload/download, snapshot 交換）
       ▼
Cloudflare Worker（Hono）
  ── 認証（JWT）/ ルーティング / blob proxy
       │
       ├─▶ Durable Object: VaultRoom（vaultId 単位で 1 インスタンス）
       │      役割 = 「順序付き耐久 update ログ + スナップショット生成」
       │      ├ メモリ上に Yjs ドキュメント（揮発してよい）
       │      ├ WebSocket Hibernation で接続維持
       │      ├ SQLite Storage（10GB/obj）に update ログ & メタデータ
       │      ├ 定期 + しきい値で R2 へ checkpoint
       │      └ メタ YDoc（fileId ↔ path / blobChunks / tombstone）も収束
       │
       └─▶ R2 (immutable snapshot bytes + blobs)
              ├ snapshots/<vaultId>/...    … Yjs スナップショット
              └ vaults/<vaultId>/blobs/... … CDC チャンク（重複排除）
```

- **Worker (Hono)**：ステートレスな API 層。認証、ルーティング、blob の認証付き proxy。
- **Durable Object (VaultRoom)**：vaultId ごとに必ず 1 インスタンス。Yjs の「単一の収束点」。
- **R2**: Stores immutable snapshot bytes and binary chunks. Snapshot restore authority is determined together with the Durable Object SQLite pointer and health evidence.

DO は「マージ機」である必要はない。
Yjs の update は CRDT op（可換かつ冪等）なので、DO は update を順序付きで追記保存し、新規参加者へ流すだけでよく、実マージは各クライアントの `Y.applyUpdate` が行う（y-websocket の発想）。
非 E2EE なので DO 自身も plaintext を読め、スナップショット生成と運用コマンドを DO 側で素直に実装できる。

**テキストとバイナリの二層構造**（最重要の設計判断）。
文字単位 CRDT は大きなバイナリに全く向かないため、同期の層を分ける。

| 対象                                       | 同期方式                                | 衝突解決                                         |
| ------------------------------------------ | --------------------------------------- | ------------------------------------------------ |
| `.md` 本文                                 | **Yjs (CRDT)** を DO で権威化           | 文字単位マージ（衝突しない）                     |
| 画像や PDF 等のバイナリ                    | **CDC チャンク + content-addressed R2** | ハッシュが同じなら衝突しない／違えば参照だけ LWW |
| ファイルツリー構造（パス、リネーム、削除） | **メタ YDoc（Y.Map）**                  | 安定 fileId ベースで管理                         |

remotely-save がロールバックで悩ましいのは「ファイル全体をまるごと転送し、タイムスタンプで後勝ち判定」しているためである。
これを **fileId ベース + 差分ベース** に変えるのが本設計の核心になる。

## 4. 整合性の継ぎ目

継ぎ目は 4 つあり、それぞれの機構は各章が規定する。

**継ぎ目 1: メモリ、DO Storage、R2**。
snapshot と state vector は await を挟まない同一同期ブロックで撮り、順序は `snapshot → R2 確定 → compact` に固定する。
クラッシュが挟まっても残るのは冗長な op だけで、再生は冪等なので無害（→ [server.md](docs/spec/server.md) §5）。

The recoverable document is the combination of the latest `authoritative + verified + healthy` R2 snapshot and the contiguous op-log rows appended to Durable Object SQLite afterward. A normal Durable Object execution-instance eviction remains recoverable because SQLite survives. Complete SQLite loss is a disaster and may lose updates acknowledged after the last checkpoint. R2 bytes discovered by listing without pointer or health evidence fail closed and require explicit operator verification and recovery.

**継ぎ目 2: R2 blob と Yjs 参照**。
「参照あり blob 無し」は blob PUT 完了を待ってから参照を書くので原理的に起きない。
「blob あり参照無し」は孤児 blob で無害。
実体が確定するまでポインタを公開しない、の一点で閉じる（→ [sync-model.md](docs/spec/sync-model.md) §3）。

**継ぎ目 3: CRDT 状態とローカルファイルシステム**（最難所）。
エコーループはハッシュゲートと materialize CAS で殺し、外部編集（git pull、別アプリ）は例外扱いせず一級の入力として取り込む。
分類不能なら捨てずに conflict copy へ退避する（→ [editor.md](docs/spec/editor.md) §2）。

**継ぎ目 4: CRDT 収束とアプリ不変条件**。
「1 path = 1 fileId」や「削除 vs 編集」は CRDT では解決しないので、全端末が同じ結果に到達する決定論的修復で解く（→ [sync-model.md](docs/spec/sync-model.md) §5-6）。

## 5. 領域別の設計要点

各章の核になる不変条件の総覧。詳細と根拠は各章を参照。

**データモデル**（[data-model.md](docs/spec/data-model.md)）

- ファイルの同一性は path でなく安定 fileId。リネームを「削除 + 作成」に化けさせない。
- メタ YDoc は schema guard を通った entry だけを materialize に使い、検証失敗は quarantine する。
- 本文はファイルごとに別 YDoc。開いているファイルだけアクティブ同期し、他は遅延ロードする。
- バイナリは不変チャンク + canonical JSON manifest。R2 key は vault prefix 必須（hash を認可境界にしない）。
- 衝突検出は NFC 正規化 + locale 非依存 lower の canonicalPath で行う。

**同期モデル**（[sync-model.md](docs/spec/sync-model.md)）

- 差分合流は state vector 交換。タイムスタンプで勝敗を決めないので両方の編集が残る。
- どれだけ古いクライアントも「最新フルスナップショットのマージ + 未同期 op の送信」の 2 手で必ず合流できる。
- バイナリ本体は同期せず、参照だけをメタ YDoc で同期する。書き込みは必ず blob 先、参照後。
- 削除は tombstone。並行する「削除 vs 編集」は編集勝ちで復活（binary は実体検証が通った場合だけ）。
- 同一 path 衝突は決定論的 rename で修復し、勝敗で内容を捨てない。
- blob GC は当面やらない。やるなら `gcRetentionWindow >= maxOfflineWindow` と復活前実体検証が前提。

**プロトコルと認証**（[protocol.md](docs/spec/protocol.md)）

- Yjs update は binary frame、制御は JSON。全 frame に ID 群を持たせ再送を冪等にする。
- `Ack` は「durable append 済み」だけを意味し、完全一致 + durableSeq 前進の時だけ outbox を閉じられる。
- token は vault 全 plaintext へのアクセス権そのもの。one-time setup token、短命 JWT、registry 照合、明示 revoke を最初から持つ。
- Yjs clientID の重複は静かにマージを壊すので、DO 払い出しの registry で強制する。

**サーバー**（[server.md](docs/spec/server.md)）

- The latest authoritative R2 snapshot plus subsequent Durable Object SQLite operations restores the document after a normal execution-instance eviction. Complete SQLite loss is a disaster outside the normal guarantee, and R2 alone is never auto-restored.
- update は検証してから append。壊れた update は quarantine に隔離し、ack を返さない。
- checkpoint の pointer は単調前進のみ。R2 確定前に op_log を消さず、compact は retention floor で clamp する。
- snapshot は複数世代 + rollback 用 op_log を保持し、論理破損から古い健全世代へ戻れるようにする。

**クライアント**（[client.md](docs/spec/client.md)）

- 起動はローカル完結が先、ネットワークは後。materialize はメタ収束後まで gate する。
- bootstrap / join / reconnect を混ぜない。join は remote meta を読むまで fileId を採番しない。
- 外向き side effect はすべて永続 outbox 経由。完了の権威は runner の成功ではなく server の証拠（Ack / hash）に置く。
- 未送信 update を黙って消す経路を持たない。degraded store の rebuild は export か明示 confirmation が先。

**エディタ**（[editor.md](docs/spec/editor.md)）

- file-open 時の真実は YText。y-indexeddb の復元完了前にディスクで seed しない。
- active file には materialize しない。CM6 binding が唯一の反映経路。
- materialize は書き込み直前の disk hash CAS が最後の防衛線。watcher が全部死んでも上書き消失は起きない。

**運用**（[operations.md](docs/spec/operations.md)）

- self-healing で治らない時の非常口（この端末を真実に / リモートを真実に / 再構築）を必須で持つ。
- conflict UI は常設ダイアログではなく、たまに出る「自動修復しました」レビューパネルで足りる。
- 修復は repair log に記録し、「治ったかどうか」を可視化する。

## 6. 既知のリスクと割り切り

| リスク                                   | 状態                              | 割り切り                                                                                    |
| ---------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------- |
| `leaf.view.editor.cm` が非公式 API       | Obsidian 更新で壊れうる           | 既存協調プラグインも踏む道。前例あり                                                        |
| 段落のファイル間移動の並行編集           | CRDT 保証外                       | 最悪でも一過性の重複。消失はしない                                                          |
| tombstone / 古いクライアント             | 緩和済み                          | full snapshot merge 経路で「壊れる」を回避                                                  |
| 論理破損した checkpoint                  | 緩和済み                          | snapshot retention と quarantine で rollback 可能にする                                     |
| Yjs clientID 衝突                        | 緩和済み                          | device registry で検出し通常同期へ進めない                                                  |
| DO execution-instance eviction           | Mitigated                         | SQLite pointer and op-log survive, so cold start restores the composite state               |
| Complete DO SQLite loss                  | Disaster outside normal guarantee | Acknowledged post-checkpoint operations may be lost; R2 bytes alone are never auto-promoted |
| 初回フルシンクの DO 過負荷               | 緩和済み                          | seed / blob データ面を DO に流さず、DO は制御面に寄せる                                     |
| materialize による未観測外部編集の上書き | 緩和済み                          | 書き込み直前 CAS と conflict copy で消さない                                                |
| blob GC 後の binary 復活                 | 緩和済み                          | GC horizon と復活前 chunk 検証で壊れた参照を materialize しない                             |
| iOS バックグラウンド制限                 | OS 制約                           | フォアグラウンド復帰 resync で吸収                                                          |

## 付録: remotely-save / Self-Hosted LiveSync との比較

| 観点             | remotely-save          | LiveSync                                | 本設計                              |
| ---------------- | ---------------------- | --------------------------------------- | ----------------------------------- |
| 同期単位         | ファイル全体           | CDC チャンク                            | テキスト=Yjs op / バイナリ=CDC      |
| テキスト並行編集 | 後勝ち（ロールバック） | チャンク単位、同チャンクは手動 conflict | **文字単位 CRDT で自動**            |
| 衝突時のデータ   | 消えうる               | 両版保存・手動選択                      | 消さず収束、意味的衝突のみ通知      |
| バックエンド     | 各種クラウド           | CouchDB / Object Storage                | Cloudflare（DO + R2）               |
| E2EE             | 対応                   | 対応（故にサーバーはマージ不可）        | 非対応（DO がマージ・スナップ生成） |
| 設計思想         | 正しく上書き           | だいたい自動 + 人間の受け皿             | **自己修復（防止より修復）**        |

本設計の本質は、LiveSync が諦めた「同チャンク並行編集の自動解決」を Yjs で取りに行きつつ、LiveSync が実戦で培った「詰まった時の人間用の非常口」（手動エスケープハッチ、conflict レビュー、Setup URI）も併せ持つことにある。
