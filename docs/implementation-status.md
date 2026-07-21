# 実装ステータス

[spec.md](../spec.md) が設計仕様、この文書が実装の現在地である。
進捗に応じて更新する。
設計レビュー（2026-07-03）で見つかった項目は spec 本文へ反映済みで、記録は git 履歴にある。
The 2026-07-10 cross-cutting audit and its release gates are tracked in [design-review.md](spec/design-review.md).

## Current summary (2026-07-20)

- 2026-07-20: 実 Obsidian e2e が 07-19〜20 のリファクタ由来の実機限定退行 2 件を検出し修正（`hono/client` が plugin バンドルから漏れてロード失敗 → tsdown `alwaysBundle` に追加、冷えた vault では plugin コピー後に manifest 再スキャンが走らず `plugin:enable` 失敗 → smoke に `loadManifests()` を追加）。また per-file YDoc の vaultId スコープ化（fd25524）以降、setup 未完了ではプラグインの編集パイプラインが構造的に起動しないため、MVP-0/MVP-2 smoke を worker `dev:local` + setup exchange 前提に再定義し（`scripts/e2e-worker-setup.ts` に共通化、worker 未起動は fail-fast、vault 排他ロック付き）、[client.md](spec/client.md) Phase 0 の記述を実態（setup 前は安全に不活性、setup 後はオフライン編集を outbox が継続）に合わせて明確化。MVP-0/MVP-1/MVP-2 いずれも実機で green を再確認。あわせて `host/plugin.ts` を 1782→1032 行に分割（snapshot / materialize / meta-migration を抽出、挙動不変）、worker 構造化ログ next tier を実装。

- ワークスペース全体の build / typecheck / lint / format は green。直近の検証 (2026-07-20) は core 214 件、worker 290 件、model-tests 17 件、Obsidian 539 件、worker e2e 16 件（multipart upload の実 R2 e2e を含む）。
- Worker SQLite e2e suite: extended from 11 to 16 tests, adding real-workerd coverage
  for quarantine discard (confirm/execute, audit trail, double-discard rejection),
  `GET /admin/retention` cursor pagination across page boundaries, snapshot rollback
  (op-log replay onto a new authoritative generation, plus fail-closed rejection of
  an unknown source generation), and device-token refresh/revoke (fresh access-token
  window on refresh, and revoked-device rejection of both HTTP refresh and WS hello).
  No production bugs surfaced; all four features behaved as designed.
- DR-010 と DR-011 は design-review.md で acceptance evidence 付きでクローズ済み。DR-010: `blobChunks: []` をスキーマで許可し（`blobManifestHash` は必須のまま）、manifest 側の既存不変条件（size=0 ⇔ chunks=[]）と突合で空バイナリの整合性を保証。plugin の「空ファイルを黙ってスキップ」も撤去。DR-011: OS 分岐なしの純粋関数 `portablePath()`（`core/src/sync/meta.ts`）が Windows 予約名・禁止文字・末尾 space/dot・255 byte 超過を決定論的に修復し、sanitizer が生む衝突は既存の path-conflict 機構（conflict suffix / repair log / retry・resolve UI）に合流する。recommended contract にある「portable に表現できない制約向けの OS-only local conflict copy」は未実装で、acceptance evidence の対象外として design-review.md に明記した。
- workerd 単体 e2e（JWT hello → durable ack、2 クライアント同段落並行編集の収束、meta YDoc broadcast + late join 復元、sync-request 再構成、R2 checkpoint、DO eviction → op_log cold-start）は green。
- **Real Linux Obsidian + miniflare `:app` E2E passed on 2026-07-14** after starting `worker dev:local` in a separate terminal. This resolves the previously recorded active-file first-full-sync content-loss regression and returns MVP-1 to green.
- Production composition/startup, durable outbox worker, authentication refresh/revoke lifecycle wiring, and the trial-readiness baseline are committed at `122d2a0`. The rejection-evidence work described below builds on that baseline. The remaining P0/P1/P2 items and design-review release gates are still authoritative.
- DR-008 (snapshot health and rollback) is closed. Immutable R2 bytes are now admitted only by append-only SQLite evidence, and the authenticated health API and Obsidian operator panel expose server-computed action authority.
- DR-001 (durability contract) is closed. Recovery authority is the latest authoritative, verified, healthy R2 snapshot plus later SQLite op-log rows; normal runtime eviction is recoverable, while complete SQLite loss is a disaster/manual-recovery case. The Worker disaster test and snapshot-health operator note prove that R2 bytes without pointer/health evidence fail closed. The nominal 128-operation / 30-second checkpoint triggers remain best-effort signals, not an RPO bound.
- DR-005 (metadata merge granularity) and DR-006 (delete-versus-edit causality) are closed. Schema version 2 stores each file ID in grouped child maps (`identity`, `location`, `content`, `deletion`), preserves concurrent rename/content and rename/delete changes, and rejects immutable-identity changes. Deleted v2 entries carry a typed `deletedContentVersion` witness (text YDoc state vector + canonical content hash, or binary manifest hash). Reconciliation is clock-skew invariant, restores unseen edits, keeps deletes whose base content is unchanged, and defers missing/incomplete evidence without materializing deletion. Legacy migration is an authoritative snapshot-import CAS after Hello admission; stale retries rebuild from the latest v1 snapshot, while an already-v2 remote is adopted only when all local entries are represented unchanged. Otherwise local metadata is retained and downgraded to read-only; legacy outbox rows are paused with an actionable migration reason. Legacy deleted tombstones remain read-only/manual recovery.
- DR-007 is closed (device/actor identity separation plus provider-loss and real-process
  restart evidence; see [design-review.md](spec/design-review.md) DR-007). It is
  implemented in the Obsidian provider/startup path. Non-creating
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
- DR-009 is closed (see [design-review.md](spec/design-review.md) DR-009): all public HTTP
  errors use the unified `ApiError` envelope (`{code, retryable, detail}`, 12 codes) and
  WebSocket reject evidence is generalized beyond oversized-update to the quarantine paths
  (`hash-mismatch`, `yjs-apply-failed`, `meta-schema-invalid`) plus `metadata-read-only`,
  covered by worker contract tests. A quarantined live update now sends
  `sync-update-rejected` without closing the session, and the client pauses the matching
  outbox item instead of retrying forever. `/auth/refresh` rejections distinguish
  `auth/expired` / `auth/revoked` / `auth/rejected`; the plugin detects device revocation
  via `code === 'auth/revoked'`. 2026-07-21: a mechanical route-enumeration contract test
  (`packages/worker/src/tests/routes.test.ts`) now asserts the envelope across the whole
  Hono route surface (guarding against future ad hoc error bodies); it surfaced and fixed a
  real gap where the public `POST /setup/exchange`, `POST /auth/refresh`, and
  `GET /ws/:vaultId` routes returned the raw validator issue list on request-validation
  failure (they run the validator before any auth middleware) instead of the `ApiError`
  envelope.
- Capability negotiation (DR-012) is implemented and closed in design-review.md:
  `ClientHello.capabilities` is validated as opaque, format-guarded tokens rather
  than a closed union, so an unrecognized optional capability no longer fails hello
  admission. `decideClientCapabilityNegotiation` (packages/core) computes the known
  intersection and only rejects a hello when it is missing a capability from an
  explicit required list, closing with a stable `capability-required:<name>` reason
  distinct from the generic malformed-message close. The Worker's
  `metadata-schema-v2` write gate now derives `metadataAccess` from this negotiated
  intersection instead of a raw advertised-list check. No capability is currently
  mandatory (`REQUIRED_CLIENT_CAPABILITIES` is empty), so the required-capability
  path is exercised by unit tests rather than live traffic.

### MVP チェックリスト（[operations.md](spec/operations.md) §8 対応）

- [x] MVP-0: local editor loop。実 Linux Obsidian + obsidian-cli で CM6 ⇄ Y.Text ⇄ disk の両レグ、per-file YDoc、watcher-drop CAS conflict-copy を往復（`test:e2e:obsidian`）。2026-07-20 以降は worker `dev:local` + setup exchange 済みを前提に実行する（per-file YDoc の IndexedDB 名前空間が vaultId でスコープされるため。setup 前のプラグインは安全に不活性 — [client.md](spec/client.md) Phase 0 参照）。
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
- The worker health API, SQLite/e2e coverage, and Obsidian settings panel are implemented. Protocol-level self-healing guarantees are now unblocked (DR-009 closed).

### Completed P0: DR-003 safe rejection + explicit repair

- The unsafe live `snapshot-escape` branch remains disabled. Oversized live updates are rejected without acknowledgement or durable mutation using a stable close reason.
- Protocol v1 carries one guarded `sync-update-rejected` evidence frame. The Obsidian runtime matches vault/device/message/document/hash evidence and atomically pauses the exact outbox item with `reason: sync-update-rejected`, `resumeOn: manual`, and lease release.
- Obsidian settings now exposes an explicit per-row repair action. It verifies the complete evidence and actual update-bytes SHA-256, fetches the latest `manifestSeq` (404 means a new document), imports the exact Yjs delta through the authenticated snapshot route, and only then marks that same row done with the returned `snapshotSeq` in a guarded IndexedDB transaction. Conflict, authentication, network, malformed-response, hash, evidence, and local-commit failures leave the row paused; retries after remote success are safe.
- This closes DR-003 narrowly as safe rejection plus explicit repair. It does not claim transparent large-update support. At the time it did not close DR-009 generally; capability negotiation, generalized rejection evidence, and public HTTP error migration were out of scope for DR-003 and have since been completed under DR-012 and DR-009 respectively.
- A transactional live escape remains future work if live updates above the configured threshold become a product requirement.

### Completed P1: DR-005 grouped metadata schema

- Core decodes strict grouped schema version 2 values into the normalized `MetaFile` view while preserving explicit `supported-v2`, `legacy-v1`, `unsupported`, and `invalid` dispositions.
- Obsidian creates and mutates only integrated child maps. Legacy v1 entries are migrated only after Hello admission through a latest-sequence snapshot-import CAS; metadata writes remain disabled until the CAS succeeds. A remote v2 snapshot is adopted only when it contains every local entry unchanged; divergent/local-only entries remain local, trigger a manual-repair Notice, and force read-only repair. Read-only sessions do not enqueue or send metadata, and already-persisted flat-v1 metadata outbox rows are paused with `metadata-schema-v2-migration-required` rather than discarded. Invalid values are logged without rewriting local IndexedDB/Yjs state; explicit discard requires write access and exact confirmation, and the repaired state is synchronized in full once the document becomes writable.
- Worker hello admission records `metadataAccess`. The `metadata-schema-v2` capability grants metadata write access; an old-server invalid-control close triggers one retry without that capability, and an accepted omission remains read-only. Metadata live updates reject v1-to-v2 root replacement and v2 root replacement/deletion; imports use the CAS path and preserve immutable identity. File-YDoc updates remain available to read-only sessions.
- Regression coverage includes grouped child invariants, CAS migration sequencing and stale import rejection, migration and mtime preservation, detached/mixed fail-closed handling, immutable identity rejection, concurrent rename/content and rename/delete merges, old-server capability fallback, legacy outbox pausing, and metadata import evidence.
- DR-006 is closed by causal witness validation, deferred reconciliation, and text/binary convergence tests.

### P0: production startup pipeline の常用化

- The production plugin instantiates the startup composition root and lifecycle wiring at HEAD `122d2a0`; the Obsidian + miniflare `:app` E2E exercises it together with the trial-readiness fixes.
- Production adapters for snapshot operations, IndexedDB YDoc loading, setup persistence, local evidence, resume lifecycle, and auth refresh/revoke are connected. Startup side-effect gates still protect the existing WebSocket, outbox, metadata enqueue, and active-file request paths from duplicate effects.
- setup persistence は SecretStorage + IndexedDB metadata の実行境界を通り、`data.json` に token を保存しない。`data.json.setupMetadata` mirror は完全廃止で決着済み: UI 表示には未使用で、唯一の実用途だった vaultId ヒントは setup 完了時に常に併記される既存 `setupVaultId` と完全重複、初回起動/再接続判定は元々 IndexedDB 由来の `trustedSetupMetadata` のみを参照し、IndexedDB 消失時は mirror の有無に関わらず setup exchange に倒れるため復旧経路としても機能していなかった。既存ユーザーの `data.json` に残る旧キーは型に存在しないフィールドとして無視される(token は含まれない)。`client.md` §4 に現行の local-persistence 形を反映済み。

### P0: full snapshot の production 経路

- The production `GET /vaults/:vaultId/{meta,files/:ydocId}/latest` and `PUT /vaults/:vaultId/{meta,files/:ydocId}/snapshot` routes and guarded startup snapshot fetch/apply are implemented. Runtime `NeedFullSnapshot` handling now automatically fetches and applies a replacement snapshot through the same authenticated fetch-latest/verify/apply pipeline used at startup (merge-safe: it only replaces local state when there are no pending local updates and no bound active editor), retrying a short bounded backoff schedule (`[0, 2s, 5s]`); exhausting it fails closed by leaving the matching outbox item paused (`reason: 'full-snapshot-required', resumeOn: 'manual'`) for the existing explicit repair path. `planOutboxFullSnapshotRelease` now also releases paused `meta-ref-update` items, matching how they already share the ack/need-full-snapshot completion path with `y-update`. Verified by unit tests plus the real Obsidian + miniflare `:app` E2E (green 2026-07-17).
- CLI（`snapshot:import` script）と miniflare smoke は e2e seed API に依存せず production import route を使う。

### P0: outbox worker の実 side effect runner 化

- Scheduler tick, lease transactions, `blob-put` / `blob-get` / `manifest-put` / `materialize` / `meta-ref-update` / `y-update` runners, completion classification, and failure completion are wired into the production plugin at HEAD `122d2a0`. `sendDocUpdateToWorker()` uses durable outbox enqueue + runner tick.
- Resume lifecycle (layout ready / focus / visibility / online → resume tick) and auth refresh/revoke transitions are also active. Remaining work is operational hardening and preserving the miniflare regression coverage (binary upload/download/materialize, rename/delete propagation, binary restore repair, invalid-meta inspect/discard, path-conflict retry/resolve, and remote-materialize-blocked actions).
- WebSocket startup now reads trusted auth metadata and refreshes an expired or soon-to-expire token before creating the socket; a transient refresh backoff retries startup without admitting the stale token.

### P1

- **binary の常用化**: multipart upload（create/part/complete/abort）は worker + client で実装済み（[protocol.md](spec/protocol.md) §3 に契約を明文化、DO SQLite の pending テーブルで再起動を跨いで安全、complete 時は ETag 突合 + 全体 sha256 の streaming 再検証に合格するまで blob を公開しない、期限切れセッションは alarm でベストエフォート abort）。実 R2（miniflare）e2e で完走・abort を検証済み。注意: 現行の chunking 設定（max 1MiB）では 16MiB しきい値に到達しないため client 側 multipart 分岐は実トラフィックでは未使用。R2 bucket 側の lifecycle rule（AbortIncompleteMultipartUpload）は `wrangler r2 bucket lifecycle add` の実行が別途必要（wrangler.toml にコメントで記載）。The settings-tab refactor regression that replaced binary restore Retry/Clear with placeholder notices is fixed; the same regression affected all Repair log branches, so invalid-meta, path/portable-conflict, remote-materialize-blocked, and binary restore actions are all wired back to their existing guarded plugin commands. A settings-tab callback test protects the UI-to-command boundary, and the existing real Obsidian CLI, MVP-2, and miniflare application E2E suites remained green on 2026-07-20.
- **meta materialize の残り**: 欠損 Markdown 作成、親フォルダ作成、invalid path の repair log、active file の remote rename/delete 追従は実装済み。settings panel の各 repair action（invalid-meta inspect/discard、path-conflict resolve/retry、keep-deleted retry、remote-materialize-blocked resolve/retry/clear）も実機 e2e で固定済み。
- **local store degraded / repair flow**: schema gate、degraded、export、discard/rebuild、import staging、manual resume は settings panel から実行できる。
- **DO multi-doc eviction の degraded 判定**（[server.md](spec/server.md) §11）は実装済み。`decideDocLoadAdmission`（`eviction.ts`）が resident file doc 数の上限 `MAX_HYDRATED_FILE_DOCS` 到達時に新規 load を WS/HTTP 全チョークポイントで拒否する（`server/degraded`、retryable）。checkpoint alarm 末尾の `evictIdleDocs` が checkpointed かつ idle な file doc を実際に evict するため degraded は自動復帰する。残ギャップ: per-doc の socket tracking が無く `activeSocketCount` は常に 0 扱い（active doc の evict は再 hydrate コストのみで無損失。churn が問題になれば追加する）。

### P2: 運用と配布

- snapshot retention は checkpoint 後に実行され、`snapshot_retention_events` に記録される。保持世代数は `SNAPSHOT_RETENTION_MIN_GENERATIONS` var でデプロイ時に調整可能 (不正値は fail closed で compaction 停止 + `snapshot-retention-invalid-config` ログ)。`GET /admin/retention` は `limit`/`cursor` → `{ items, nextCursor? }` 形式で pagination する。Worker 内 alerting 連携は追加せず、既存 `logEvent` を Workers Logs / Logpush で拾う運用ガイドを deployment.md §6 に記載。
- Quarantine admin now includes a working force-apply/discard confirm→execute flow (`POST /admin/quarantine/:id/{discard,force-apply}`, single-use hashed confirmation tokens with 5-minute TTL, live-state re-validation at execute time), an append-only `quarantine_audit_events` trail (`GET /admin/quarantine/audit`), and cursor pagination (`limit`/`cursor`, `{items, nextCursor?}`) on both the open-quarantine list and the audit trail, matching the retention-events pagination convention. The Obsidian settings panel drives all of this (list, prepare/confirm discard or force-apply, resolved-quarantine audit trail). Note: the destructive quarantine actions were previously edge-validated but never wired to a Durable Object handler (they always returned 426); this session added the missing runtime wiring on top of the pre-existing decision layer. The generic `POST /admin/{gc,force-local,force-remote,rebuild}` placeholder routes were removed entirely rather than wired: `gc` overlaps with blob/tombstone GC, which `docs/spec/operations.md` explicitly defers past MVP; `force-local`/`force-remote`/`rebuild` never had a payload contract (no target `docId`, no source data) and `docs/spec/server.md` §9 scopes admin repair to exactly three operations (`inspect`/`discard`/`force-apply`), all under quarantine. The never-called scaffolding (core admin operation schemas and the worker placeholder-effect/confirmation helpers) was deleted with the routes.
- Auth refresh / revoke runtime and plugin lifecycle wiring (foreground/resume, pre-expiry refresh, and revoked-device local shutdown) are active at HEAD `122d2a0`; distribution still requires the surrounding settings UX, migration policy, and operator documentation.
- Device setup-token issuance now uses an operator-secret-gated route (`POST /admin/setup-tokens`, `ADMIN_TOKEN_SECRET`, constant-time comparison, `ApiError`-envelope responses) instead of the former e2e-disguised `/__e2e/setup-token` path. The e2e-only snapshot-seeding route was folded into the same admin secret as `POST /admin/snapshots/seed` (test/fixture use only, not part of the normal operator flow). There is still no self-service "invite a device" UI: an operator issues the token with `curl` (see `docs/deployment.md` §4), then the user can paste the generated `kuroflare://setup` URI or open an `obsidian://kuroflare-setup` deep link. On an unregistered, idle device both entry points share validated, confirmation-gated application; the confirmation shows the endpoint, vault ID, and effective bootstrap intent but never the setup token, and only a confirmed action writes settings and resumes startup. Existing registration metadata, a pending setup response, a settings write, or an in-flight lifecycle tick rejects a new URI without mutation; URI application remains serialized until startup reaches a non-blocked shell result. Terminal startup-plan rejection releases the staged response for a fresh token, while transient credential-persist failure retains it for retry. The operator route remains verified by unit/worker-e2e suites plus the real Obsidian + miniflare `:app` E2E (green 2026-07-18); the new plugin onboarding boundary is covered by core/plugin unit tests added 2026-07-20.
- presence / awareness は WS 伝搬まで実装済み: `awareness-update` control frame（[protocol.md](spec/protocol.md) §1）を DO が永続化なしで vault 内 fan-out し、切断時は最後に広告された presence の `state: null` を合成 broadcast する。クライアントは接続中のみローカル state 変更を送信（オフライン時は黙って捨て、outbox に積まない）、受信した peer state を `LocalAwareness` に反映して y-codemirror.next がリモートカーソルを描画する。worker unit + 実 workerd e2e + plugin unit でカバー。実 Obsidian 複数端末での目視確認は未実施。
- 配布前に settings UI、QR、migration / backward-incompatible policy、手動エスケープハッチの UI を整える。Setup URI confirmation/Obsidian deep-link handling and log secret redaction are implemented.
- Worker/DO の構造化ログ（[operations.md](spec/operations.md) §5 の最小セット: checkpoint 開始/完了/失敗、quarantine 発生、auth reject reason）は `logEvent` 経由で実装済み（quarantine イベントは `quarantineId` 付き）。next tier も実装済み (2026-07-20): `connection-open`/`connection-close`（接続数付き）、`op-append-latency`、`checkpoint-duration`、`doc-restore-source`（`r2-snapshot` / `op-log-replay` / `empty` の別）、`sync-duplicate-ignored`。既存イベントのスキーマは無変更（追加のみ）。
- `BlobHeadEntrySchema` の size 必須化（[sync-model.md](spec/sync-model.md) §5 の「size 不明なら復活させない」）は schema 側でも強制済み（`found === (size !== undefined)` の双方向チェック、worker の head 応答計画も size 欠如を reject）。

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

| モジュール                                                            | 内容                                                                                                                                                                         |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.ts` / `types.ts`                                                | Worker entrypoint、env 型                                                                                                                                                    |
| `runtime/`                                                            | `VaultRoom` DO runtime（`app.ts` edge routing、`room.ts` WS admission、`sync.ts`、`checkpoints.ts`、`blobs.ts`、`documents.ts` hydration/eviction、`auth.ts`、`storage.ts`） |
| `db/`                                                                 | SQLite schema / migration / retention / repository                                                                                                                           |
| `checkpoint/`                                                         | checkpoint write / compact / orphaned run recovery decision                                                                                                                  |
| `devices/`                                                            | device registry、setup token consume decision                                                                                                                                |
| `http/`（setup / auth-refresh / device / quarantine / blob / health） | HTTP handler の response plan                                                                                                                                                |
| `sync/`（snapshots / request / update / yjs）、`quarantine.ts`        | snapshot key / restore 候補選択、sync-request / sync-update decision、yjs validation、quarantine admin decision                                                              |

### packages/obsidian-plugin

| モジュール  | 内容                                                                                                                                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.ts`   | 薄い entry（plugin と公開シンボルの re-export）                                                                                                                                                            |
| `host/`     | Plugin クラス本体と Obsidian concrete port（`plugin.ts` composition、auth / socket / files / vault / meta / meta-migration / editor / snapshot / materialize / repair / boot / guards / store、`outbox/`） |
| `editor/`   | CM6 ⇄ Y.Text binding（EditorView adapter）、awareness、settings tab                                                                                                                                        |
| `metadata/` | meta reconcile / materialize / evidence / generation / transition（file tree 適用）                                                                                                                        |
| `recovery/` | DR-007 document epoch recovery（startup probe / repair）                                                                                                                                                   |
| `sync/`     | 純 decision 層と composition（auth / engine / meta / obsidian / store / transport、`api-client.ts`）                                                                                                       |

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
