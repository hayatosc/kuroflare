# 実装ステータス

[spec.md](../spec.md) が設計仕様、この文書が実装の現在地である。
進捗に応じて更新する。
設計レビュー（2026-07-03）で見つかった項目は spec 本文へ反映済みで、記録は git 履歴にある。
The 2026-07-10 cross-cutting audit and its release gates are tracked in [design-review.md](spec/design-review.md).

## 現状サマリ（2026-07-07）

- ワークスペース全体の build / typecheck / lint / format は green。node 単体 647 件 + worker e2e 6 件。
- workerd 単体 e2e（JWT hello → durable ack、2 クライアント同段落並行編集の収束、meta YDoc broadcast + late join 復元、sync-request 再構成、R2 checkpoint、DO eviction → op_log cold-start）は green。
- **実 Linux Obsidian + miniflare の e2e（`test:e2e:obsidian:miniflare`）は not green**。2026-06-30 以降のリファクタと機能追加で退行し、10 件の実バグを修正した後も、アクティブファイル初回フルシンクの content-loss が 1 件未解決（後述）。

### MVP チェックリスト（[operations.md](spec/operations.md) §8 対応）

- [x] MVP-0: local editor loop。実 Linux Obsidian + obsidian-cli で CM6 ⇄ Y.Text ⇄ disk の両レグ、per-file YDoc、watcher-drop CAS conflict-copy を往復（`test:e2e:obsidian`）。
- [ ] MVP-1: one file remote sync。**2026-07-07 時点で退行し not green**。workerd e2e は green だが、実 Obsidian + miniflare はアクティブファイル初回フルシンクの content-loss で失敗。
- [x] MVP-2: meta YDoc + path repair。rename = 同一 fileId の path 更新、Worker 経由 cross-device concurrent rename の収束、text 本文の per-file YDoc 化を実機 e2e で実証（miniflare 経由の実証は MVP-1 と同様に退行中）。
- [x] MVP-3: initial sync + binary。binary blob PUT → meta 参照公開、manifest/chunk 再取得、初回 meta/file snapshot からの Markdown materialize を実機 e2e で証明。production API / UX 化は残タスク。

### 次にやるべきこと

1. 後述の CM6/yCollab content-loss を実ブラウザ DevTools で調査し、MVP-1 を green に戻す。
2. その後、残タスク P0（startup pipeline の常用化、outbox runner の production 常用化）を進める。

## 残タスク

### P0: production startup pipeline の常用化

- startup step port（`fetch-remote-meta-snapshot` / `apply-remote-meta-snapshot` / `adopt-local-files-after-remote-meta` / `enqueue-missing-downloads` / `load-indexeddb-ydocs` / `resume-background-queues`）と composition root は実処理に接続済み。残りは `main.ts` に残る ad-hoc 直呼び経路（直送 WebSocket / outbox、lifecycle 呼び出し）を runtime port 経由へ寄せ、production lifecycle で常時この経路を使うこと。
- setup persistence は SecretStorage + IndexedDB metadata の実行境界を通り、`data.json` に token を保存しない。残りは `data.json.setupMetadata` mirror を UI / 復旧用 cache として明確化するか、完全廃止するかの決着。

### P0: full snapshot の production 経路

- `GET/PUT /vaults/:vaultId/{meta,files/:ydocId}/{latest,snapshot}` は production route として実装済み。plugin の `NeedFullSnapshot` → fetch → guard → 同一 IndexedDB transaction apply も接続済み。
- CLI（`snapshot:import` script）と miniflare smoke は e2e seed API に依存せず production import route を使う。

### P0: outbox worker の実 side effect runner 化

- scheduler tick、lease transaction、`blob-put` / `blob-get` / `manifest-put` / `materialize` / `meta-ref-update` / `y-update` runner、completion 分類、failure completion は接続済み。`sendDocUpdateToWorker()` は durable outbox enqueue + runner tick に寄せた。
- resume lifecycle adapter（layout ready / focus / visibility / online → resume tick）も接続済み。残りは production 常用化と、miniflare smoke で固定した一連の regression（binary upload/download/materialize、rename/delete 伝播、binary restore repair、invalid-meta inspect/discard、path-conflict retry/resolve、remote-materialize-blocked action）の維持。

### P1

- **binary の常用化**: multipart upload（create/part/complete/abort + R2 lifecycle）は未実装で、16MiB 以上は拒否される。大きい添付を扱うなら実装する。binary conflict / repair UI の追加 regression も残る。
- **meta materialize の残り**: 欠損 Markdown 作成、親フォルダ作成、invalid path の repair log、active file の remote rename/delete 追従は実装済み。settings panel の各 repair action（invalid-meta inspect/discard、path-conflict resolve/retry、keep-deleted retry、remote-materialize-blocked resolve/retry/clear）も実機 e2e で固定済み。
- **local store degraded / repair flow**: schema gate、degraded、export、discard/rebuild、import staging、manual resume は settings panel から実行できる。
- **DO multi-doc eviction の degraded 判定**（メモリ圧迫時に新規 doc load を拒否する規則、[server.md](spec/server.md) §11）は未実装。

### P2: 運用と配布

- snapshot retention は checkpoint 後に実行され、`snapshot_retention_events` に記録される。残りは retention policy の運用設定、event pagination、alerting。
- quarantine admin は Worker HTTP と plugin settings panel の両方にある。残りは force-apply 後の user-facing audit summary と大量 quarantine 向け pagination。
- auth refresh / revoke runtime はあるが、plugin lifecycle（foreground/resume、expiry 前 refresh、revoked device の local shutdown）への接続が残る。
- presence / awareness は型とテスト片のみで editor binding 未接続。
- 配布前に settings UI、Setup URI/QR、ログの secret redaction、migration / backward-incompatible policy、手動エスケープハッチの UI を整える。
- Worker/DO の構造化ログ（[operations.md](spec/operations.md) §5 の最小セット: checkpoint 開始/完了/失敗、quarantine 発生、auth reject reason）はほぼ未実装。
- `BlobHeadEntrySchema` の size 必須化（[sync-model.md](spec/sync-model.md) §5 の「size 不明なら復活させない」を schema 側でも強制する）が実装課題として残る。

## モジュール対応表

spec の設計要素と実装モジュールの対応。決定層（純粋関数）と concrete port を分離する方針は [operations.md](spec/operations.md) §6 を参照。

### packages/core

| モジュール                           | 内容                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------- |
| `sync/meta.ts`                       | MetaFile schema guard、`canonicalizeVaultPath`                              |
| `sync/messages.ts` / `sync/frame.ts` | WS control message guard、binary frame encode/decode                        |
| `sync/manifest.ts` / `sync/blob.ts`  | CDC chunker、BlobManifest 構築、canonical JSON、assemble 検証               |
| `sync/reconcile.ts`                  | path conflict / delete-vs-edit repair plan、`applyMetaRepair`               |
| `sync/snapshot.ts`                   | full snapshot decode / apply decision                                       |
| `sync/startup.ts`                    | `planClientStartup`（bootstrap / join / reconnect planner）                 |
| `sync/join-adoption.ts`              | join 時 fileId adoption decision                                            |
| `sync/jwt.ts` / `sync/setup.ts`      | HS256 sign/verify、setup exchange guard                                     |
| `auth.ts`                            | claims guard、client auth refresh / revoke / start decision                 |
| `outbox.ts`（+ `outbox/`）           | plan builder、scheduler tick、lease CAS、completion、retry/backoff decision |
| `local-store.ts`（+ `local-store/`） | schema gate、repair decision、repair import、hash gate / materialize CAS    |
| `http/*`                             | admin / blob / device / snapshot payload guard                              |
| `health.ts` / `utils/*`              | health guard、branded ID、hashing、ApiError                                 |

### packages/worker

| モジュール                                                            | 内容                                                                                            |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `runtime.ts`                                                          | Worker entrypoint + `VaultRoom` DO shell（WS admission、sync pipeline、HTTP route）             |
| `db/`                                                                 | SQLite schema / migration / retention / repository                                              |
| `checkpoint/checkpoint.ts`                                            | checkpoint write / compact / orphaned run recovery decision                                     |
| `devices/`、`setup-tokens.ts`                                         | device registry、setup token consume decision                                                   |
| `http/`（setup / auth-refresh / device / quarantine / blob / health） | HTTP handler の response plan                                                                   |
| `sync/`（snapshots / request / update）、`quarantine.ts`              | snapshot key / restore 候補選択、sync-request / sync-update decision、quarantine admin decision |
| `runtime/eviction.ts`                                                 | multi-doc eviction decision                                                                     |

### packages/obsidian-plugin

| モジュール                   | 内容                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `main.ts`                    | Plugin lifecycle、Obsidian concrete port（spike 由来コードを含む）                                      |
| `obsidian/editor-binding.ts` | CM6 ⇄ Y.Text binding、EditorView adapter                                                                |
| `sync/engine/`               | startup planner / actuation / shell driver / presentation / websocket runtime / outbox worker / persist |
| `sync/store/`                | local store driver / IndexedDB adapter / schema / repair                                                |
| `sync/meta/`                 | meta reconcile、file tree 適用                                                                          |
| `sync/obsidian/`             | composition root、evidence reader、lifecycle adapter、settings / repair panel                           |

### packages/model-tests

checkpoint / cold-start、outbox、sync-update の実行可能な状態機械。deterministic seed 1..10,000 を `pnpm test` で実行する。

## 検証記録

### 2026-07-07: miniflare e2e の退行調査

実 Linux Obsidian + miniflare Worker で `test:e2e:obsidian:miniflare` を再実行したところ、2026-06-30 以降の複数コミット（monolith 分割 `c5cf819`、invalid-meta isolation / quarantine admin `8dcd512`）で退行していた。
10 件の実バグを修正した末、最後の 1 件が未解決で not green のまま。

直した実バグ 10 件:

1. materialize CAS の conflict-copy 経路が死んでいた。`decideMaterializeWrite` に渡す `path` / `activeFilePath` が同じ値になっており、リファクタで `activeEditorBound: false` が自己参照の `activeFilePath` に置き換わったのが原因。
2. setup 未完了時のローカル編集が `setup-metadata-missing` を投げていた。outbox モデル移行時に「ソケットが開いている時だけ送る」旧ガードが失われていた。setup 未完了なら no-op に修正。
3. `PUT /vaults/:id/{meta,files/:id}/snapshot` の DO 側ハンドラが存在しなかった（エッジ側のルーティングだけあった）。
4. 初回 join-existing setup が「壊れたローカルメタデータ」として拒否されていた。「vaultId ヒントが無い」と「ヒントはあるが一度も persist されていない（初回起動）」を区別できていなかった。
5. Obsidian の SecretStorage ID は 64 文字上限だが、hex エンコードした ID が超過してトークンが黙って永続化されていなかった。SHA-256 hex（ちょうど 64 文字）に変更。
6. DO の WebSocket upgrade 応答が `Sec-WebSocket-Protocol` をエコーしておらず、実ブラウザ / Electron のクライアントがハンドシェイクに失敗していた（Node の `ws` は許容するため Worker 単体 e2e では検出されなかった）。
7. sync-request への直接応答が `self-broadcast` として誤ってドロップされていた。送信中 sync-request の messageId を追跡し、一致する応答を除外するよう修正（[protocol.md](spec/protocol.md) §1 / [client.md](spec/client.md) §6 に規則として反映済み）。
8. sync-request への応答に `updateSha256` が欠けていて、クライアントの整合性チェックで拒否されていた。
9. snapshot-import ルートが既存のリモート内容をマージせず上書きしていた。hydrate してから `Y.applyUpdate` でマージし再スナップショットするよう修正。
10. `ensureDocHydrated` が並行実行され得た（読み取りパスが write queue 外）。in-flight Promise を共有するよう修正。

未解決: **アクティブファイルの初回フルシンクで content-loss**。
CRDT マージ自体は一度成功しているのに、直後に「ローカルの内容だけで delete+insert し直す」何かが走り、リモート側 insert が `deleted: true` になる。
`bindActiveMarkdownView` が起動時に 2 回連続で呼ばれ、同じ Y.Text に対して yCollab 拡張を作り直していることを確認し、冗長な再バインドをスキップするガードを追加したが、この content-loss 自体は直らなかった。
obsidian-cli 経由の instrumentation では収束しなかったため、次に取り組む場合は Electron プロセスに実ブラウザ DevTools を繋ぐか、Obsidian の外で yjs + y-codemirror.next の最小再現を作るほうが効率的。

### fake が隠していた実バグ（real e2e 立ち上げ時に発見）

- DO が SQLite スキーマ migration を一度も適用していなかった（decision は純関数として存在したが runtime 未配線）。`VaultRoom.ensureSchema()` を SQL を触る各入口で実行するよう配線。
- real SQLite は `NULL` 列を `null` で返すが、runtime は不在を `undefined` 前提にしており、`devices.revoked_at` が `null` の非失効デバイスが全て `unknown-device` 拒否されていた。`nullToUndefined` で正規化。

## 規模スナップショット（2026-06-20）

| パッケージ      | src 行数 | test 行数 | 中身                                                                        |
| --------------- | -------- | --------- | --------------------------------------------------------------------------- |
| worker          | 約6,100  | 約6,200   | WS 同期、setup/auth、quarantine admin、blob data plane、checkpoint、R2 復元 |
| core            | 約4,400  | 約4,200   | startup / reconcile / materialize / outbox / snapshot / auth の純 decision  |
| obsidian-plugin | 約9,300  | 約10,200  | spike プラグイン + local store、outbox worker、sync engine                  |
| model-tests     | 約2,300  | 約1,700   | 性質 / モデルテスト                                                         |

合計 約 2.2 万行 src + 約 2.2 万行 test。テスト比はほぼ 1:1。
