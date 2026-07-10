# サーバー: VaultRoom Durable Object

[← 設計書トップ](../../spec.md)

## 1. 三層ストレージと復元不変条件

DO は「ホットキャッシュ + 合流点」であり、真実は R2 にある。

```
メモリ(YDoc)  … 揮発OK。アクティブな間だけ存在
DO Storage    … ホットな差分ログ + 直近スナップショット（再構成可能なキャッシュ）
R2            … 真実。ここから常に全再構成できる
```

**不変条件**：「R2 のスナップショット + それ以降の op」だけで、いつでも YDoc を完全復元できる。
これさえ守れば DO はいつ蒸発しても安全である。

稼働中は `client op → メモリ YDoc に適用 → 全 client へブロードキャスト → DO Storage に op 追記`。
op ごとに R2 へ書くと write 課金とレイテンシで破綻するので、DO Storage が書き込みバッファになる。

コールドスタートは `R2 から最新スナップショットをロード → 未 compact op を適用 → SV 交換`。
全 op 再生ではなく「スナップショット + 少数 op」なので巨大 Vault でも速い。

- DO には「同一オブジェクトへ 10 秒以内に過剰リクエストで overload」という rate limit があるため、client は update を debounce してから送る。
- 同期の永続化は DO SQLite を必須とし、`state.storage.sql` がなければ `sync-storage-unavailable` で閉じる。KV-like API は vaultId metadata と alarm 復元のためだけに使う。

## 2. SQLite schema

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

create table if not exists device_refresh_tokens (
  token_hash text primary key,
  device_id text not null references devices(device_id),
  issued_at integer not null,
  expires_at integer not null,
  revoked_at integer
);
create index if not exists idx_device_refresh_tokens_device_expires
  on device_refresh_tokens (device_id, expires_at);

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

`devices` は認可と失効の永続台帳、`connected_devices` は presence / observability 用 cache で、認可判断は必ず `devices` を見る。

`message_dedup` は短期の transport 重複排除用で、checkpoint / compact と同じタイミングで古い行を掃除する（op log 保持期間と dedup TTL は分けてよい）。
dedup TTL を越えた再送は seq を増やし得るが、Yjs update の適用は冪等なので復元 content は変わらない。
この前提は model test で固定する（[operations.md](operations.md) §7）。

## 3. update 受信 pipeline

`SyncUpdate` の受信から ack までを次の順で固定する。

**1. doc 単位の直列化**。
受信は doc ごとの append queue に入り、seq read から ack までを同一 doc では直列化する。
DO は `crypto.subtle` / R2 / hydrate の await 点で別 event とインターリーブし得るため、single-thread turn だけを seq 採番の排他にしない。

**2. 重複の確定**。
先に `message_dedup` を読み、duplicate なら何も変更せず保存済み `durable_seq` の ack だけを再送する。
基準を op_log でなく `message_dedup` に置くのは、op_log に入らない snapshot-escape 済み message も同じ `durableSeq` で ack でき、NeedFullSnapshot 境界を繰り返さないためである。

**3. 適用前チェックと quarantine**。

```
1. update bytes の size 上限を確認
2. 空の temporary YDoc へ applyUpdate できるか try
3. meta YDoc は hydrated copy へ適用し、全 entry を schema validation に通す
4. 巨大 update は large update 経路へ逃がす
5. 合格した update だけ本 YDoc と op_log へ進める
```

hash mismatch / Yjs apply failure / meta schema invalid の update は `quarantined_updates` に保存し、op_log / docs / active YDoc へ反映せず、**ack も返さない**。
ack を返すと client は pending outbox を done にしてしまい、破損 update が repair 不能になる。
quarantine は完了証拠ではなく retry / backoff と repair log の入口である。
同じ quarantine id の再送は `on conflict(id) do nothing` で冪等化する。

**4. append transaction**。
`Y.applyUpdate(activeYDoc)`、`op_log insert`、`docs.latest_seq = seq`、`message_dedup upsert` を一つの成功単位とし、ack は commit 後に送る。
unique 制約に負けたら再読して duplicate ack に変換し、二重 seq を作らない。
append が確定した場合だけ authoritative YDoc に適用し、duplicate や snapshot escape では doc を変えない。

**5. large update escape**。
巨大 paste や初回 seed は op_log 1 行に詰めず、apply → snapshot R2 PUT → pointer 更新 → `docs.latest_snapshot_seq` と `latest_seq` を同 seq へ前進、の直接 snapshot 経路に逃がす。
ack は「同じ seq の snapshot + pointer + docs clock が durable」という意味でだけ返し（decision は `snapshot-escape` として区別）、client には durable ack と `NeedFullSnapshot(reason="large-update-snapshot")` を返す。
この経路でも `message_dedup` を保存し、R2 確定前に既存 op_log を消さない。

binary frame 経由の update も envelope guard（[protocol.md](protocol.md) §2）通過後に同じ pipeline へ流す。

実装: `worker/src/sync-update.ts` の `decideSyncUpdateQuarantine` / `decideSyncUpdateAppend`（純粋 decision。実 I/O は caller が transaction 境界で適用）。

## 4. sync-request と full snapshot 境界

「state vector を受け取ったら必ず diff を返す」ではない。
client の `stateVector` が retained horizon（`docs.min_retained_seq` / `horizon_state_vector`）をカバーしているかを先に判定する。

| 状況                                 | 応答                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| horizon をカバー                     | `Y.encodeStateAsUpdate(doc, clientSV)` の差分を `sync-update` で返す。空なら無応答（doc 未作成も同様） |
| horizon より古い                     | `NeedFullSnapshot(reason="state-vector-too-old")`                                                      |
| snapshot / residual が欠けて復元不能 | `NeedFullSnapshot(reason="missing-log")`                                                               |

doc の hydrate（初回 access 時の R2 snapshot + op_log replay）に失敗した場合は server 側の復元不能であって client update の問題ではない。
ack も append も差分応答もせず `hydrate-failed` で接続を閉じ、checkpoint recovery / snapshot fallback へ委ねる。
hydrate は in-flight Promise を共有し、読み取りパスと書き込みパスが同じ doc を並行 hydrate して片方の適用結果を握り潰さないようにする。

## 5. checkpoint と compact

手順（setAlarm で定期 + op 数しきい値）:

```
1. メモリ YDoc をエンコード（snapshot と SV は await を挟まない同一同期ブロックで取る）
2. R2 へ snapshot object を書く
3. per-doc pointer を単調に進める
4. pointer 更新が成功した後だけ op_log.seq <= upper_seq を compact
5. 古い snapshot は retention 規則（§8）で世代管理
```

seq 境界の規則:

- `seq` は DO 内で単調増加。checkpoint は `upper_seq` を固定してから snapshot を作る。
- R2 成功で `checkpoint_runs.status = 'r2-written'`。pointer は現在値より大きい場合だけ進め、古い run が遅れて完了しても巻き戻さない。
- op_log を消せるのは `pointer-updated` 後だけ。R2 書き込み前に削らない。

checkpoint（と quarantine force-apply）以外の書き込みは doc 単位 write queue で直列化されるが、checkpoint は queue 外に置く。
snapshot 取得が await を挟まない同期ブロックだからこそ許される判断で、将来 await が入るなら checkpoint も queue に乗せ直す。

**compact の retention clamp**。
compact は checkpoint 自身の `upperSeq` まで無条件に消すのではなく、retention 対象 snapshot の最古 `upperSeq`（retention floor）で `compactedSeq` を clamp する。
floor が求まらない場合（初回など）は自身の `upperSeq` を floor とする。
これで「retention window 内の最古の健全 snapshot から op_log replay で新しい世代に辿り着ける」という §8 の rollback 不変条件を維持する。
orphaned run の回収経路（§6）も同じ floor を適用し、retention 情報が信頼できなければ `block-compact` で保留する。

**alarm のスケジューリング**:

- 通常 append 後は 30 秒後の alarm、未 checkpoint op が 128 件以上なら即時 alarm。
- alarm は冒頭で orphaned run を recovery し（§6）、dirty doc（`latest_seq > latest_snapshot_seq`）を 16 件ずつ checkpoint する。
- バッチ上限まで処理した場合は短い遅延で再スケジュールし、新規 op が来ない doc の op_log 残留を防ぐ。
- alarm は request path を持たないため、vaultId を DO storage に保存し、evict 後の alarm はそこから復元する。

**Hibernation との関係**。
hibernatable WebSocket は「これから眠る」通知を提供しないため、hibernation 前 flush はデータ保全の必須条件ではない。
op は SQLite に同期 durable であり、眠っても「R2 の古い snapshot + 未 compact op」の再生で戻る。
flush は cold start の replay 量を減らす最適化で、実装するなら「認証済み socket が 0 になった時に checkpoint」がフック候補（現状は通常 alarm のみ）。

## 6. orphaned checkpoint run の回収

コールドスタート時と alarm 冒頭で、`writing / r2-written / pointer-updated` のまま残った run は完了不明として扱う。

1. `writing`: snapshot が無い / R2 に無い / 検証不能なら `failed`（op_log は消さない）。検証できるなら `r2-written` へ進める。
2. `r2-written`: R2 object が検証でき `upper_seq >= docs.latest_snapshot_seq` なら pointer / docs を進める。古ければ巻き戻さず stale として閉じる。
3. `pointer-updated`: pointer / docs が検証でき `docs.latest_snapshot_seq >= upper_seq` なら compact して `compacted`（floor clamp は §5）。未検証なら compact を block。
4. その後、通常の「R2 snapshot + residual op_log」復元を行う。

「書けたかもしれない snapshot」を即採用せず、必ず検証してから pointer / docs を進める。

実装: `worker/src/checkpoint/checkpoint.ts` の `decideCheckpointWrite` / `decideCheckpointCompact` / `decideOrphanedCheckpointRecovery`。

## 7. R2 snapshot の配置と復元

```
snapshots/<vaultId>/meta/<seq>.yupdate
snapshots/<vaultId>/files/<ydocId>/<seq>.yupdate
snapshots/<vaultId>/manifests/<manifestSeq>.json / latest.json   … 将来実装
snapshots/<vaultId>/pointers/...                                 … 将来実装
admin-exports/<vaultId>/<timestamp>.tar.zst
```

**MVP スコープ**：R2 上の manifest / pointer object はまだ書かない。
per-doc pointer は DO SQLite の `docs.latest_snapshot_key` を正とし、DO storage が完全消滅した場合の復元入口は `SNAPSHOT_BUCKET.list(prefix)` の prefix list fallback とする。

復元候補の選択:

- pointer が健全かつ prefix list の最大健全 seq 以上の場合だけ pointer を採用する。
- pointer が missing / stale / corrupt なら、list で見える最大 seq の検証済み snapshot へ fallback する。
- 選んだ object が読めない / apply できない場合は hydrate failure（§4）。

将来の目標設計では、更新順を `snapshot PUT → per-doc pointer PUT → latest.json PUT` とし、manifest に世代を持たせて「latest が壊れたら参照先が揃う最大 manifestSeq へ戻る」fallback を用意する。
R2 を source of truth と呼ぶ以上、復元入口を必ず複数残す。

実装: `worker/src/sync/snapshots.ts`（key 命名、`isSnapshotManifest`、`chooseSnapshotForRestore`）。

## 8. snapshot retention と論理破損対策

「最新 1 本だけ残す」は物理消失には強いが論理破損に弱い。
バグった update が checkpoint に焼かれると、唯一の復元アンカーも壊れる。

不変条件:

- 最低 `N` 世代（例: 20）または一定期間（例: 30 日）の snapshot を残す。
- `compacted` / `failed` で閉じていない checkpoint run が参照する snapshot は retention 対象外でも消さない（`failed` は明示的に閉じた run なので pin しない）。
- cleanup は最新 `N` 世代に加えて「最新の健全 snapshot」を必ず残す。最新世代が corrupt と判定された後の cleanup が rollback 先を消してはいけない。
- 「object としては読めるが論理的におかしい」場合も古い世代へ戻せるようにする。
- retention window 内の rollback に必要な op_log は物理削除しない（§5 の retention floor）。corrupt snapshot から健全 snapshot へ戻るには `healthy.upperSeq < seq <= corrupt.upperSeq` の replay が必要。
- admin repair は任意の世代へ rollback できる。

実装: `worker/src/db/retention.ts` の `planSnapshotRetention`。R2 delete の成否は `snapshot_retention_events` に記録し、失敗は次回 cleanup で再試行する。

## 9. quarantine の管理

admin repair は 3 種に絞る。

| 操作          | 規則                                                                                                                                                                                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspect`     | metadata、reason、hash、ID 群、必要なら bytes を返すだけ。確認 token 不要、状態を変えない                                                                                                                                                                                                                 |
| `discard`     | 明示 confirmation 後に quarantine row だけを削除。op_log / docs / YDoc は変更せず、元 client に ack を送らない                                                                                                                                                                                            |
| `force-apply` | confirmation に加え、現在の snapshot / residual から作った temporary YDoc への再適用と schema validation が通った場合だけ `latestSeq + 1` として op_log / docs に移す。admin による server state 修復であり、ack を送る操作ではない。後から同じ messageId が再送されたら通常の duplicate path が ack する |

confirmation token は `quarantine:<action>:<id>` という subject に bind し、missing / mismatch / expired を区別して拒否する。
admin endpoint は actor の Bearer JWT と `sync:write` scope を要求する。

これで「通常は最新へ進む」「壊れたら古い健全な世代へ戻る」「怪しい update は証拠として残る」を満たす。

## 10. schema migration と health

DO 起動時に `schema_migrations` を見て未適用 migration を順番に実行する。
migration は冪等に書き、失敗時は DO を degraded にして同期を受け付けない。
半端な schema で op を受けるより、明示停止した方が復旧しやすい。

- migration list は Worker bundle 側で version 1 からの contiguous な配列として持つ。
- bundle に無い version が applied 済み、または applied versions が prefix でない場合は、破損 / 手動編集 / downgrade の可能性があるため degraded。
- pending migration がある間は sync を受けず、適用完了後だけ ready。

health の責務分離は [protocol.md](protocol.md) §3 のとおり、global `/health` は概況、DO の startup check が vault 単位の権威である。

## 11. multi-doc のライフサイクル

vault あたり DO は 1 つだが、その中に `meta` と多数の per-file YDoc がある。
全 YDoc をメモリに載せ続けない。

- `meta` YDoc は常駐優先（Vault 全体の materialize gate で最頻アクセス）。
- file YDoc は lazy load。同期要求、差分要求、checkpoint 対象になった時だけ hydrate する。
- checkpoint 済み、接続中ソケットの参照なし、一定時間アクセスなしの file YDoc を evict する。dirty doc は flush 成功後にだけ evict し、再アクセス時は通常の hydrate で再構成する。
- メモリ圧迫時は「非 active の dirty flush → eviction」を優先し、それでも無理なら degraded にして新規 load を拒否する（degraded 判定は未実装の残タスク）。

実装: `worker/src/runtime/eviction.ts` の `decideDocEviction`。
`activeSocketCount` は「hello 後にその doc に触れ、かつ接続中のソケット数」の近似で、ファイル単位の open/close 通知が無いため切断時にのみ減る。
eviction は専用 timer を持たず checkpoint alarm の末尾で併走する。
