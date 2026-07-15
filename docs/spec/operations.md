# 運用、構成、テスト、ロードマップ

[← 設計書トップ](../../spec.md)

## 1. 手動エスケープハッチ

self-healing で治らない時の非常口として必須。

- **「この端末を真実に」**：ローカル YDoc からスナップ生成 → DO / R2 の最新を強制置換。
- **「リモートを真実に」**：ローカル破棄 → 最新スナップショットから再構築。
- **「再構築」**：R2 のスナップ + blob から全再生成。

DO が plaintext を扱えるので DO 側コマンドとして素直に実装できる。
いずれも破壊的なので dry-run と確認 token を必須にする（[protocol.md](protocol.md) §3）。

## 2. 修復レビュー UI

テキスト本文の衝突は自動マージされ、手動解決は不要である。
残るのは意味的衝突（削除 vs 編集、同 path 別 fileId、移動重複）だけなので、常設ダイアログではなく、たまに出る小さな「自動修復しました」レビューパネルで足りる。
repair panel からは repair log の閲覧に加え、quarantine の inspect / discard、path conflict の resolve / retry、binary restore の再検証、staged import の resume を行う。

## 3. モバイル

iOS は背面で WebSocket を維持できない。
常時接続を前提にせず、フォアグラウンド復帰時に必ず WS 再接続 + SV 再交換を基本動作にする。
background 中は queue を無理に進めない。
IndexedDB directory API の可否は未検証のスパイク項目（§8、[client.md](client.md) §4）。

## 4. 同期対象の除外と awareness

- `.obsidian` 配下（プラグイン設定、ワークスペース）は端末固有なので、同期対象から除外または opt-in の選択的同期にする。
- Yjs Awareness（「今誰がどのファイルを開いているか」）は同時編集事故を UX レベルで減らす。MVP では editor binding への optional injection だけ用意し、transport / provider は後続実装。

## 5. 観測性

self-healing は「治ったかどうか」が見えないと信用できない。
最初から最低限の counters と repair log を持つ。

クライアント側（`data.json` の `repairLog`）:

```
{ ts, level, event, fileId, path, action, beforeHash, afterHash, detail }
```

記録するイベント: external edit imported、echo event ignored、path conflict auto-renamed、delete-vs-edit restored、blob download retry exhausted、full snapshot fallback used、local materialize failed。

Worker / DO 側は構造化ログを出す。
最小セットは checkpoint の開始 / 完了 / 失敗、quarantine 発生、auth rejected reason の 3 種。
その後 connection count、op append latency、checkpoint duration、cold start restore source、duplicate message ignored を足す。
個人用途でも「どの層で詰まっているか」を判別できることが重要である。

### 5.1 Snapshot health operator runbook

Recovery authority is composite: use the latest authoritative, verified R2 snapshot
with later Durable Object SQLite operation-log rows. Normal runtime eviction is
recoverable because SQLite survives. Complete SQLite loss is a disaster/manual
recovery case; acknowledged updates after the last checkpoint may be unavailable,
and R2 bytes without pointer and health evidence must not be promoted automatically.
The nominal 128-operation and 30-second checkpoint triggers are best effort, not a
recovery-point bound.

Snapshot health administration is an authenticated, explicit recovery workflow. The
operator token must carry the `sync:write` scope. R2 objects are immutable: do not
delete or overwrite a snapshot object directly.

1. Inspect the latest evidence row for each generation:

   ```text
   GET /admin/snapshots?docId=meta&limit=64
   GET /admin/snapshots?docId=file:<ydocId>&limit=64
   ```

   The response is latest-per-generation evidence, not an audit-history page. Use
   `nextCursor` to continue pagination. Treat `allowedActions` as the server's
   authority; an empty list and `actionBlockReason` mean that no safe mutation is
   currently admitted.

2. If hydration fails with `snapshot-health:no-verified-generation`, compare the
   candidate's `snapshotKey` and `upperSeq` with the document clock and checkpoint
   evidence shown by the inspection response. Only an unquarantined, physically
   `unverified` candidate with `verify` in `allowedActions` may be approved:

   ```text
   POST /admin/snapshots/verify
   {
     "docId": { "kind": "file", "ydocId": "..." },
     "snapshotKey": "snapshots/<vault>/<doc>/<upperSeq>.yupdate",
     "upperSeq": 123,
     "reason": "Operator approved the immutable bytes after inspection",
     "confirmation": "verify"
   }
   ```

   Verification records a pending lease before reading R2 and rechecks document
   authority before committing. A mismatch, concurrent write, or quarantine returns
   a conflict; retry only after re-inspecting the latest row. A successful recovery
   creates the durable document pointer before the in-memory document is rehydrated.

3. To remove a generation from automatic restore, submit quarantine only when the
   response advertises `quarantine`:

   ```text
   POST /admin/snapshots/quarantine
   {
     "docId": { "kind": "file", "ydocId": "..." },
     "snapshotKey": "snapshots/<vault>/<doc>/<upperSeq>.yupdate",
     "upperSeq": 123,
     "reason": "Logical corruption confirmed",
     "confirmation": "quarantine"
   }
   ```

   Quarantine is append-only and idempotent. The server refuses
   `snapshot-health-quarantine-would-break-floor` when this would remove the last
   authoritative healthy retained floor; retain or repair an alternative generation
   first.

4. To restore from an older healthy generation, submit rollback only when
   `rollback` is listed. Rollback replays the exact retained op-log range and writes a
   new immutable generation; it never rewrites the source object:

   ```text
   POST /admin/snapshots/rollback
   {
     "docId": { "kind": "file", "ydocId": "..." },
     "snapshotKey": "snapshots/<vault>/<doc>/<upperSeq>.yupdate",
     "upperSeq": 123,
     "reason": "Restore from the verified rollback floor",
     "confirmation": "rollback"
   }
   ```

   On success, record the returned `auditId` and new `snapshotKey`. A stale source,
   op-log gap, changed health evidence, or existing target returns a conflict and
   leaves the source and pointer unchanged.

5. Re-fetch the inspection endpoint after every mutation and preserve the returned
   audit identifiers with the incident record. Never treat a successful HTTP response
   as proof that a candidate is safe unless the response schema and the subsequent
   latest evidence row both validate.

## 6. プロジェクト構成

最初から monorepo にする。
Obsidian 側と Worker 側で型とメッセージ定義と Yjs 補助関数を共有するためで、最初に境界を切った方がプロトコルの破壊的変更を管理しやすい。

```
packages/
  core/              # wire format、メタデータ型、CDC/manifest、修復、決定層（環境非依存）
    src/sync/ outbox/ local-store/ auth.ts http/ health.ts utils/
  worker/            # Cloudflare Worker + VaultRoom DO
    src/runtime.ts db/ checkpoint/ devices/ http/ sync/ runtime/
  obsidian-plugin/
    src/main.ts obsidian/ sync/{engine,auth,store,meta,obsidian}/
  model-tests/       # 決定層の実行可能な状態機械テスト
```

| package           | 依存してよいもの           | 依存してはいけないもの             | 責務                                     |
| ----------------- | -------------------------- | ---------------------------------- | ---------------------------------------- |
| `core`            | `yjs`、schema library 程度 | Obsidian / Cloudflare / DOM        | wire format、型、CDC、修復、ハッシュ     |
| `worker`          | `core`                     | Obsidian API                       | DO / R2 / HTTP / WS                      |
| `obsidian-plugin` | `core`                     | Cloudflare Worker runtime 直接 API | UI、Vault、IndexedDB、同期 orchestration |
| `model-tests`     | `core` の decision を経由  | Obsidian / Cloudflare 実体         | 状態機械テスト                           |

この依存方向を守る。
同期の知識が plugin と worker に散るのは許すが、メッセージ型、メタデータ型、ハッシュ規則は `core` に押し込める。
plugin 内部は「純粋 decision（core）→ plan / driver（engine）→ concrete port（main.ts / adapters）」の層に分け、UI handler や lifecycle adapter が同期条件を再判定しないようにする。
モジュール対応表は [implementation-status.md](../implementation-status.md) にある。

## 7. テスト戦略

**core の単体テスト**：decision と guard は環境非依存の純粋関数なので、unit test で規則を固定する。
代表: Yjs update の冪等適用、古い SV への full snapshot merge、deterministic repair plan の全クライアント一致、binary 欠損時の tombstone 維持、canonical manifest hash、binary frame の encode / decode、protocolVersion 拒否、outbox 依存 graph が参照公開前に blob PUT 完了を要求すること。

**Model tests**: encode complete recovery from `R2 snapshot + residual op_log` as an executable state machine under the normal eviction and crash boundary where DO SQLite survives.
Model checkpoint, cold-start, outbox, and sync-update transitions; verify the invariants over randomized operation sequences with crash injection (approximately 10,000 cases), and preserve the smallest counterexample when an invariant fails.
Complete SQLite loss is a disaster outside the normal guarantee, and R2 bytes alone are never restored automatically.

checkpoint モデルの不変条件:

- valid update は `latest snapshot + residual op_log` のどちらかに必ず残る。R2 PUT 確認前に op_log を消さない。
- compact 後も retention 対象の snapshot から rollback できる。未 compact run が参照する snapshot は cleanup で消さない。
- pointer は `upperSeq` 単調増加。古い run が遅れて完了しても巻き戻さない。
- stale pointer / corrupt snapshot の cold start は、最大 `upperSeq` の健全 snapshot + retained op_log の replay で復元する。cleanup は最新の健全 snapshot を最低 1 つ保持する。
- quarantined update は snapshot に入らない。
- dedup window 内の duplicate は状態を二重に進めない。dedup TTL 失効後の replay は seq を増やし得るが復元 content は変わらない。
- cold start 後の復元 content は crash 前に durable ack した update をすべて含む。large update 経路でも pointer 更新前に旧 snapshot / op_log が復元可能。

このモデルで見つかった反例は、そのまま設計制約になっている:

- retention が未 compact checkpoint snapshot を消すと、遅れて完了する run が壊れる。
- 古い run が pointer を巻き戻すと、compact 済みの新しい update を cold start で失う。
- corrupt snapshot からの復旧には snapshot retention だけでなく rollback 用 op_log retention が必要。
- cleanup が corrupt 最新世代だけを残すと、健全な rollback 先を失う。

**Worker の統合テスト**:

- op append → checkpoint → compact → cold start 復元（checkpoint 中の op 受信込み）。
- R2 PUT 失敗時に op_log が消えない。duplicate `messageId` で op_log が二重化しない。
- pointer が stale / 欠落でも prefix list で最大 seq を拾える。large update が snapshot 経路に逃げる。
- `writing` のまま残った cold start から安全に復旧できる。最新 snapshot の論理破損時に旧世代へ rollback できる。
- 不正 update が `quarantined_updates` に残り本 YDoc / op_log に入らない。
- revoked device token が WS / HTTP の両方で拒否される。監査 identity は JWT/setup-derived `deviceId` に固定され、client-provided actor fields are ignored or rejected.
- migration 失敗時に degraded になり op を受けない。
- blob GC が `gcRetentionWindow < maxOfflineWindow` 設定では有効化されない。

**Obsidian plugin の結合テスト**（fake Vault + 実 Obsidian e2e の 2 レーン）:

- YText → materialize → watcher の echo が no-op。外部編集が YText に取り込まれる。
- rename が delete+create ではなく fileId の path update になる。
- conflict copy が必要なケースで元データを捨てない。watcher を落としても CAS が未観測 disk edit を退避する。
- foreground resume で WS 再接続と SV 交換が必ず走る。
- 2 端末 join で fileId が二重採番されず adopt される。同時 rename が deterministic repair に収束する。
- active file を開いたままリモート rename / delete されても binding が壊れない。
- chunk の hash 不一致を破棄し再取得で収束する。binary delete vs edit で chunk 欠落なら復活しない。
- IndexedDB 消失後の再参加が full snapshot merge で復旧する。
- 初回フルシンクが WS / op_log に大量 seed を流さない。

**手動検証シナリオ**: 2 端末の同段落同時編集で両方残る / offline 編集の復帰 merge / 画像追加中の Worker 一時失敗からの収束 / delete vs edit の編集勝ち復活 / DO 再起動からの R2 復元。

## 8. 実装ロードマップと MVP

リスクの高い順に検証する（進捗は [implementation-status.md](../implementation-status.md)）。

1. CM6 ⇄ Yjs ⇄ ディスクの単体疎通（スパイク済み）。ハードコード 1 ファイルで反響しない往復。
2. 1 ファイルのリアルタイム Yjs 同期を DO 上で。
3. deviceId authentication and audit attribution. Yjs actor IDs remain document-local implementation details; epoch recovery is a later DR-007 slice.
4. DO ライフサイクル（checkpoint、compact、retention、quarantine、cold start。model test 済み）。
5. 起動時 reconciliation（state vector 交換）。
6. メタ YDoc によるファイルツリー同期（リネーム、tombstone）。
7. 初回フルシンク専用モード。
8. バイナリ CDC + R2。
9. 整合性の継ぎ目の作り込み（特にハッシュゲート）。
10. 運用機能（エスケープハッチ、conflict UI、Setup URI、モバイル resync）。

残る未検証スパイク: mobile（iOS WebView）での IndexedDB directory API の可否。mobile 対応の着手前に必ず潰す。

**MVP 縦切り**（「一番危ない仮説」から検証する）:

- **MVP-0: local editor loop**。固定 1 ファイルで CM6 ⇄ Y.Text ⇄ disk materialize が往復する。active file には materialize しない。watcher echo は no-op。watcher を落としても CAS が外部編集を消さない。y-indexeddb 再起動後に YDoc が復元される。
- **MVP-1: one file remote sync**。Worker + 1 DO + 1 file YDoc。hello で registry 検証。2 クライアント同段落同時編集で両方残る。DO restart 相当から R2 snapshot + residual op_log で復元。quarantine の最小経路。
- **MVP-2: meta YDoc + path repair**。rename が delete+create にならない。同一 path 競合が deterministic rename に収束。delete vs edit が text は復活、binary は chunk 検証後だけ復活。
- **MVP-3: initial sync + binary**。bootstrap と join を分離。binary は blob PUT 完了後に参照公開。初回 seed は snapshot 直 PUT。

MVP を越えるまでやらないこと: full conflict UI の作り込み、tombstone / blob GC の実行、mobile 最適化、複数 vault / multi-tenant UX、marketplace 配布向け polish。

## 9. DR-007 provider-loss runbook

At startup, inspect the IndexedDB directory before opening any y-indexeddb provider. A
missing or malformed directory API is a degraded, fail-closed condition; do not delete
the local store or create a replacement provider to make the warning disappear.

For an affected document, the plugin writes a `recovering` epoch row before making a
remote request and stops editor, watcher, metadata, WebSocket, and outbox side effects.
Inspect the latest authenticated snapshot, local-store YDoc base, and retained outbox
rows. A 404 latest response is safe only when the remote document is genuinely new.
Malformed bytes, wrong-document rows, or missing dependencies require repair; do not
discard any row.

Recovery imports a merged candidate with the latest manifest sequence and retries a
bounded 409 conflict by refetching and rebuilding. Only after import validation does it
create the fresh provider and await the persistence barrier. The final local transaction
stores YDoc/cursor state, exact outbox completions, and the `ready` epoch together. If a
crash occurs at any boundary, leave the epoch `recovering` and rerun the same guarded
procedure; never resume queues while recovery evidence is incomplete.
