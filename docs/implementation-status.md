# 実装ステータス

[spec.md](../spec.md) が設計仕様、この文書が実装の現在地である。
進捗に応じて更新する。
設計レビュー（2026-07-03）で見つかった項目は spec 本文へ反映済みで、記録は git 履歴にある。
The 2026-07-10 cross-cutting audit and its release gates are tracked in [design-review.md](spec/design-review.md).

## Current summary (2026-07-16)

- ワークスペース全体の build / typecheck / lint / format は green。直近の検証は core 196 件、worker 267 件、model-tests 17 件、Obsidian 477 件、worker e2e 7 件。
- workerd 単体 e2e（JWT hello → durable ack、2 クライアント同段落並行編集の収束、meta YDoc broadcast + late join 復元、sync-request 再構成、R2 checkpoint、DO eviction → op_log cold-start）は green。
- **Real Linux Obsidian + miniflare `:app` E2E passed on 2026-07-14** after starting `worker dev:local` in a separate terminal. This resolves the previously recorded active-file first-full-sync content-loss regression and returns MVP-1 to green.
- Production composition/startup, durable outbox worker, authentication refresh/revoke lifecycle wiring, and the trial-readiness baseline are committed at `122d2a0`. The rejection-evidence work described below builds on that baseline. The remaining P0/P1/P2 items and design-review release gates are still authoritative.
- DR-008 (snapshot health and rollback) is closed. Immutable R2 bytes are now admitted only by append-only SQLite evidence, and the authenticated health API and Obsidian operator panel expose server-computed action authority.
- DR-001 (durability contract) is closed. Recovery authority is the latest authoritative, verified, healthy R2 snapshot plus later SQLite op-log rows; normal runtime eviction is recoverable, while complete SQLite loss is a disaster/manual-recovery case. The Worker disaster test and snapshot-health operator note prove that R2 bytes without pointer/health evidence fail closed. The nominal 128-operation / 30-second checkpoint triggers remain best-effort signals, not an RPO bound.
- DR-005 (metadata merge granularity) and DR-006 (delete-versus-edit causality) are closed. Schema version 2 stores each file ID in grouped child maps (`identity`, `location`, `content`, `deletion`), preserves concurrent rename/content and rename/delete changes, and rejects immutable-identity changes. Deleted v2 entries carry a typed `deletedContentVersion` witness (text YDoc state vector + canonical content hash, or binary manifest hash). Reconciliation is clock-skew invariant, restores unseen edits, keeps deletes whose base content is unchanged, and defers missing/incomplete evidence without materializing deletion. Legacy migration is an authoritative snapshot-import CAS after Hello admission; stale retries rebuild from the latest v1 snapshot, while an already-v2 remote is adopted only when all local entries are represented unchanged. Otherwise local metadata is retained and downgraded to read-only; legacy outbox rows are paused with an actionable migration reason. Legacy deleted tombstones remain read-only/manual recovery. DR-012 (general capability negotiation) remains open.
- DR-007 slice 2 is implemented in the Obsidian provider/startup path. Non-creating
  `indexedDB.databases()` probes establish per-document epoch evidence in the existing
  local-store `metadata` store. Provider loss enters a global gated recovery that merges
  authoritative remote snapshots, local YDoc bases, and retained outbox updates, retries
  bounded snapshot CAS conflicts, and atomically commits candidate YDoc/cursor state,
  exact outbox completions, and a ready epoch after a fresh provider persistence barrier.
  Malformed, dependency-missing, wrong-document, or unavailable-directory evidence fails
  closed without dropping rows. Real Obsidian process-restart coverage is now green
  (2026-07-16): the `:app` E2E kills and restarts the actual Obsidian process
  (/proc-based identification) mid-edit and drives epoch recovery through both the
  sync-request and need-full-snapshot paths, passing 6 consecutive runs. Getting there
  surfaced and fixed a delete-set leak in outbound meta updates (vector-diffing a temp
  doc re-emitted unrelated, not-yet-durable tombstones and intermittently quarantined
  binary meta updates server-side) and three redundant full-doc meta resends.
- DR-009 is implemented: all public HTTP errors use the unified `ApiError` envelope
  (`{code, retryable, detail}`, 12 codes) and WebSocket reject evidence is generalized
  beyond oversized-update to the quarantine paths (`hash-mismatch`, `yjs-apply-failed`,
  `meta-schema-invalid`) plus `metadata-read-only`, covered by worker contract tests.
  A quarantined live update now sends `sync-update-rejected` without closing the
  session, and the client pauses the matching outbox item instead of retrying forever.
  `/auth/refresh` rejections distinguish `auth/expired` / `auth/revoked` /
  `auth/rejected`; the plugin detects device revocation via `code === 'auth/revoked'`.
  DR-012 (general capability negotiation) is not claimed.

### MVP チェックリスト（[operations.md](spec/operations.md) §8 対応）

- [x] MVP-0: local editor loop。実 Linux Obsidian + obsidian-cli で CM6 ⇄ Y.Text ⇄ disk の両レグ、per-file YDoc、watcher-drop CAS conflict-copy を往復（`test:e2e:obsidian`）。
- [x] MVP-1: one file remote sync。The real Linux Obsidian + miniflare `:app` E2E passed on 2026-07-14 with `worker dev:local` running separately.
- [x] MVP-2: meta YDoc + path repair。rename = 同一 fileId の path 更新、Worker 経由 cross-device concurrent rename の収束、text 本文の per-file YDoc 化を実機 e2e で実証。
- [x] MVP-3: initial sync + binary。binary blob PUT → meta 参照公開、manifest/chunk 再取得、初回 meta/file snapshot からの Markdown materialize を実機 e2e で証明。production API / UX 化は残タスク。

### 次にやるべきこと

1. Keep the real Obsidian + miniflare `:app` E2E green while changing the production runtime.
2. Close the remaining P0/P1/P2 and design-review release gates before distribution.

## 残タスク

### Completed P0: atomic update append

- `op_log`, `docs.latest_seq`, and `message_dedup` now commit in one Durable Object storage transaction.
- Fault-injection tests cover failure after every SQL statement, stable-sequence retry, post-commit in-memory rehydration, and commit-before-broadcast ordering. This closes DR-002.

### Completed P0: checkpoint boundary and rollback retention

- Checkpoint capture and snapshot import now share the document write queue, while R2 I/O runs after checkpoint capture so later appends can continue.
- Normal and orphan compaction use the oldest retained snapshot floor and its exact state vector. Invalid or incomplete retention evidence fails closed without deleting snapshots or operation-log rows. This closes DR-004.

### Completed P0: DR-001 durability contract

- The authoritative recovery boundary is the latest valid, healthy R2 snapshot plus later Durable Object SQLite `op_log` rows. Runtime execution-instance eviction remains a normal recoverable event because SQLite survives.
- Complete SQLite loss is explicitly outside the normal guarantee; acknowledged updates after the last checkpoint may be unavailable. R2 objects found without SQLite pointer and snapshot-health evidence are never auto-promoted.
- Worker coverage in `runtime/vault-room.test.ts` simulates checkpoint seq 1, acknowledged residual seq 2, and complete SQLite loss while retaining R2. Hydration fails closed without ack/broadcast, SQL durable mutation, or R2 mutation. The snapshot-health panel explains this boundary and the best-effort checkpoint triggers.

### Completed P0: DR-008 snapshot health and rollback

- Snapshot health evidence is append-only and versioned. Each generation records expected and observed byte length, update hash, state-vector hash, physical verification, logical status, and authority. Inspection returns the latest row per generation with server-computed `allowedActions` and an optional block reason.
- Hydration treats prefix listing as candidate discovery only. Without authoritative, physically verified, healthy evidence, R2-only recovery fails closed with `snapshot-health:no-verified-generation`; explicit authenticated verification creates the durable document pointer and rehydrates the in-memory document.
- Verification uses a pending lease and final authority rechecks. Checkpoint pointer advancement, rollback, quarantine, compaction, and retention deletion are serialized by the document write queue. Retention and quarantine preserve the last healthy retained floor.
- Rollback replays a contiguous retained op-log range into a new immutable generation and commits the pointer only after source and target evidence are revalidated. Repeated verification and quarantine requests are idempotent.
- The worker health API, SQLite/e2e coverage, and Obsidian settings panel are implemented. Protocol-level self-healing guarantees remain gated by DR-009.

### Completed P0: DR-003 safe rejection + explicit repair

- The unsafe live `snapshot-escape` branch remains disabled. Oversized live updates are rejected without acknowledgement or durable mutation using a stable close reason.
- Protocol v1 carries one guarded `sync-update-rejected` evidence frame. The Obsidian runtime matches vault/device/message/document/hash evidence and atomically pauses the exact outbox item with `reason: sync-update-rejected`, `resumeOn: manual`, and lease release.
- Obsidian settings now exposes an explicit per-row repair action. It verifies the complete evidence and actual update-bytes SHA-256, fetches the latest `manifestSeq` (404 means a new document), imports the exact Yjs delta through the authenticated snapshot route, and only then marks that same row done with the returned `snapshotSeq` in a guarded IndexedDB transaction. Conflict, authentication, network, malformed-response, hash, evidence, and local-commit failures leave the row paused; retries after remote success are safe.
- This closes DR-003 narrowly as safe rejection plus explicit repair. It does not claim transparent large-update support and does not close DR-009 generally; capability negotiation, generalized rejection evidence, and public HTTP error migration remain out of scope.
- A transactional live escape remains future work if live updates above the configured threshold become a product requirement.

### Completed P1: DR-005 grouped metadata schema

- Core decodes strict grouped schema version 2 values into the normalized `MetaFile` view while preserving explicit `supported-v2`, `legacy-v1`, `unsupported`, and `invalid` dispositions.
- Obsidian creates and mutates only integrated child maps. Legacy v1 entries are migrated only after Hello admission through a latest-sequence snapshot-import CAS; metadata writes remain disabled until the CAS succeeds. A remote v2 snapshot is adopted only when it contains every local entry unchanged; divergent/local-only entries remain local, trigger a manual-repair Notice, and force read-only repair. Read-only sessions do not enqueue or send metadata, and already-persisted flat-v1 metadata outbox rows are paused with `metadata-schema-v2-migration-required` rather than discarded. Invalid values are logged without rewriting local IndexedDB/Yjs state; explicit discard requires write access and exact confirmation, and the repaired state is synchronized in full once the document becomes writable.
- Worker hello admission records `metadataAccess`. The `metadata-schema-v2` capability grants metadata write access; an old-server invalid-control close triggers one retry without that capability, and an accepted omission remains read-only. Metadata live updates reject v1-to-v2 root replacement and v2 root replacement/deletion; imports use the CAS path and preserve immutable identity. File-YDoc updates remain available to read-only sessions.
- Regression coverage includes grouped child invariants, CAS migration sequencing and stale import rejection, migration and mtime preservation, detached/mixed fail-closed handling, immutable identity rejection, concurrent rename/content and rename/delete merges, old-server capability fallback, legacy outbox pausing, and metadata import evidence.
- DR-006 is closed by causal witness validation, deferred reconciliation, and text/binary convergence tests. DR-012 remains intentionally open.

### P0: production startup pipeline の常用化

- The production plugin instantiates the startup composition root and lifecycle wiring at HEAD `122d2a0`; the Obsidian + miniflare `:app` E2E exercises it together with the trial-readiness fixes.
- Production adapters for snapshot operations, IndexedDB YDoc loading, setup persistence, local evidence, resume lifecycle, and auth refresh/revoke are connected. Startup side-effect gates still protect the existing WebSocket, outbox, metadata enqueue, and active-file request paths from duplicate effects.
- setup persistence は SecretStorage + IndexedDB metadata の実行境界を通り、`data.json` に token を保存しない。残りは `data.json.setupMetadata` mirror を UI / 復旧用 cache として明確化するか、完全廃止するかの決着。

### P0: full snapshot の production 経路

- The production `GET /vaults/:vaultId/{meta,files/:ydocId}/latest` and `PUT /vaults/:vaultId/{meta,files/:ydocId}/snapshot` routes and guarded startup snapshot fetch/apply are implemented. Runtime `NeedFullSnapshot` handling currently pauses matching outbox work for manual recovery; it does not automatically fetch and apply a replacement snapshot.
- CLI（`snapshot:import` script）と miniflare smoke は e2e seed API に依存せず production import route を使う。

### P0: outbox worker の実 side effect runner 化

- Scheduler tick, lease transactions, `blob-put` / `blob-get` / `manifest-put` / `materialize` / `meta-ref-update` / `y-update` runners, completion classification, and failure completion are wired into the production plugin at HEAD `122d2a0`. `sendDocUpdateToWorker()` uses durable outbox enqueue + runner tick.
- Resume lifecycle (layout ready / focus / visibility / online → resume tick) and auth refresh/revoke transitions are also active. Remaining work is operational hardening and preserving the miniflare regression coverage (binary upload/download/materialize, rename/delete propagation, binary restore repair, invalid-meta inspect/discard, path-conflict retry/resolve, and remote-materialize-blocked actions).
- WebSocket startup now reads trusted auth metadata and refreshes an expired or soon-to-expire token before creating the socket; a transient refresh backoff retries startup without admitting the stale token.

### P1

- **binary の常用化**: multipart upload（create/part/complete/abort + R2 lifecycle）は未実装で、16MiB 以上は拒否される。[protocol.md](spec/protocol.md) は `multipart` レスポンス型を予約するのみで part-upload / complete / abort のワイヤ契約が未定義のため、実装前に契約決定（spec 追記）が必要。binary conflict / repair UI の追加 regression も残る。
- **meta materialize の残り**: 欠損 Markdown 作成、親フォルダ作成、invalid path の repair log、active file の remote rename/delete 追従は実装済み。settings panel の各 repair action（invalid-meta inspect/discard、path-conflict resolve/retry、keep-deleted retry、remote-materialize-blocked resolve/retry/clear）も実機 e2e で固定済み。
- **local store degraded / repair flow**: schema gate、degraded、export、discard/rebuild、import staging、manual resume は settings panel から実行できる。
- **DO multi-doc eviction の degraded 判定**（[server.md](spec/server.md) §11）は実装済み。`decideDocLoadAdmission`（`eviction.ts`）が resident file doc 数の上限 `MAX_HYDRATED_FILE_DOCS` 到達時に新規 load を WS/HTTP 全チョークポイントで拒否する（`server/degraded`、retryable）。checkpoint alarm 末尾の `evictIdleDocs` が checkpointed かつ idle な file doc を実際に evict するため degraded は自動復帰する。残ギャップ: per-doc の socket tracking が無く `activeSocketCount` は常に 0 扱い（active doc の evict は再 hydrate コストのみで無損失。churn が問題になれば追加する）。

### P2: 運用と配布

- snapshot retention は checkpoint 後に実行され、`snapshot_retention_events` に記録される。残りは retention policy の運用設定、event pagination、alerting。
- quarantine admin は Worker HTTP と plugin settings panel の両方にある。残りは force-apply 後の user-facing audit summary と大量 quarantine 向け pagination。
- Auth refresh / revoke runtime and plugin lifecycle wiring (foreground/resume, pre-expiry refresh, and revoked-device local shutdown) are active at HEAD `122d2a0`; distribution still requires the surrounding settings UX, migration policy, and operator documentation.
- presence / awareness は型とテスト片のみで editor binding 未接続。
- 配布前に settings UI、Setup URI/QR、ログの secret redaction、migration / backward-incompatible policy、手動エスケープハッチの UI を整える。
- Worker/DO の構造化ログ（[operations.md](spec/operations.md) §5 の最小セット: checkpoint 開始/完了/失敗、quarantine 発生、auth reject reason）は `logEvent` 経由で実装済み（quarantine イベントは `quarantineId` 付き）。残りは next tier（connection count、op append latency、checkpoint duration、cold start restore source、duplicate ignored）。
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

### 2026-07-07: miniflare e2e の退行調査 (resolved 2026-07-14)

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

At the time, the final unresolved issue was **active-file first-full-sync content-loss**.
CRDT マージ自体は一度成功しているのに、直後に「ローカルの内容だけで delete+insert し直す」何かが走り、リモート側 insert が `deleted: true` になる。
`bindActiveMarkdownView` が起動時に 2 回連続で呼ばれ、同じ Y.Text に対して yCollab 拡張を作り直していることを確認し、冗長な再バインドをスキップするガードを追加したが、この content-loss 自体は直らなかった。
obsidian-cli 経由の instrumentation では収束しなかったため、次に取り組む場合は Electron プロセスに実ブラウザ DevTools を繋ぐか、Obsidian の外で yjs + y-codemirror.next の最小再現を作るほうが効率的。

Resolution evidence (2026-07-14): the real Linux Obsidian + miniflare `:app` E2E passed for the changes later committed as `122d2a0` after `worker dev:local` was started in a separate terminal. The historical failure record above is retained for context; the current evidence marks the regression resolved at that commit.

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
