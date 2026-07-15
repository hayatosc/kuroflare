# クライアント: 同期エンジン

[← 設計書トップ](../../spec.md)

## 1. 起動シーケンス

UI をネットワークでブロックしない。

```
Phase 0: ローカルロード（オフラインでも完結）
  - y-indexeddb からメタ YDoc + 各ファイル YDoc を復元
  - この時点で Vault は完全に使える（local-first）
  - SV も IndexedDB に生きている（消すとフル再同期になる）

Phase 1: 接続 & メタ YDoc の収束
  - WebSocket で DO へ接続、メタ YDoc の SV を交換 → ファイルツリーが合流

Phase 2: テキスト YDoc の収束（遅延）
  - 開いているファイルを最優先で SV 交換。残りは裏でバッチ

Phase 3: バイナリの収束
  - メタ YDoc が指すチャンクと手元を突合。無いものだけ GET、無いものだけ PUT
```

Phase 1 → 2 → 3 の順序が重要である。
先にファイルツリーを確定させないと「どこに置くべきか分からない孤児 op」が生まれる。
ただし CRDT の収束自体は自由に先行してよく、順序が縛るのは materialize のタイミングだけである（収束と実体化の分離）。

## 2. bootstrap / join / reconnect

起動時の入口は 3 つあり、混ぜない。

```
bootstrap new vault:
  setup/exchange → local initial-index（§8）
  → meta/file snapshot を production import route へ direct PUT → meta YDoc 送信 → online

join existing vault:
  setup/exchange → GET /vaults/:vaultId/meta/latest
  → remote meta へ local file を adopt（§8）
  → missing snapshot/blob を download → local-only file だけ新規採番して upload → online

reconnect:
  IndexedDB の YDoc を load → ClientHello → meta SV exchange
  → active file SV exchange → background queues resume
```

join 端末は remote meta を読む前に UUID を大量採番しない。
先に採番すると、同じ path の remote file と local file が別 fileId になり、初回参加だけで不要な conflict repair を発生させる。

startup planner（`core/src/sync/startup.ts` の `planClientStartup`）の判定:

- setup response がまだ無ければ `run-setup-exchange`。
- response の `bootstrapMode` が user intent と食い違う、または local vaultId と response vaultId が違えば reject し、同期 side effect を始めない。
- reconnect は credentials、IndexedDB、vaultId、schema version、auth metadata を確認する。local auth が `revoked` / `reauth-required` なら `auth-blocked` に入り、setup exchange へ自動で流さない。
- local meta YDoc だけが欠けていれば remote meta snapshot から `restore-local-meta-snapshot`。
- local schema が supported version より新しければ degraded（古い plugin で新しい store を壊さない）。

startup step は永続 transaction の境界でもある。

- `persist-setup-response`：token 本体を先に SecretStorage へ置き、claims 検証で expiry を取った後、metadata（setup / auth record）を単一 IndexedDB transaction で commit する。metadata commit が失敗したら成功済み secret write を補償 delete してから停止する。join existing ではこの時点で local fileId を作らない。
- `apply-remote-meta-snapshot` と `adopt-local-files-after-remote-meta` は別 step。remote tree を canonical source にしたうえで、remote に無い local file だけを新規採番する。
- `resume-background-queues` は最後。ClientHello と meta SV exchange が済むまで blob / materialize queue を走らせない。

setup exchange の実行規則:

- exchange port は response を replan scheduler に渡すだけで、token や metadata を保存しない（保存は `persist-setup-response` の責務）。
- non-2xx は body を読まずに止め、token を含む body を error / log に混ぜない。外部 port の `Error.message` も素通しせず、固定 reason code に正規化する。
- reconnect から missing credentials で入った場合だけ、response の `bootstrapMode` に応じた intent に写像し直してから replan する。

new-vault の初回 publish は WS / op_log に流さず、production の snapshot import route で snapshot と pointer を直接作る。
import route は token / vault guard、update validation、meta schema validation、R2 PUT、pointer upsert、stale seq rejection を通し、既存 remote 内容があれば hydrate して `Y.applyUpdate` でマージした結果を snapshot し直す（上書きしない）。

## 3. 実行状態モデル

状態は単一の状態機械ではなく 3 つの軸で表現する。

1. **shell state**：起動ゲート。`status`、`backgroundQueues`（stopped / running と stop reason）、`repairEntries`、`runnableEffects`（未実行の startup effect queue）。
2. **startup step の進行**：`runnableEffects` の先頭から順に実行。成功は先頭と構造的に同じ effect だけを ACK、失敗は後続を実行せず `startup-rejected` として停止。失敗 effect は自動再実行せず、UI / repair からの明示 retry だけが先頭へ戻す。
3. **outbox / queue の状態**：§5 の永続 queue と lease。

規則:

- `backgroundQueues` の初期値は stopped で、`resume-background-queues` の ACK で初めて running になる。
- `auth-blocked` は stopped queue + repair entry（device-revoked / reauth-required）+ 空の runnable effects を固定し、新規 setup と混同しない。startup が進み始めたら古い repair entry を先に消す。
- UI（status bar、Notice、repair panel）は shell state から presentation 層が導出し、UI handler が auth 状態や queue 起動可否を再判定しない。表示は内部状態名を出さず、小さいアイコンと短い文言 + repair panel。
- 複数の startup tick が同時に来ても同じ in-flight tick を返し、Obsidian event の多重発火で二重実行しない。

「meta 収束前の大規模 materialize 抑制」は専用状態を持たない。
materialize は background queue の一部であり、`resume-background-queues` が meta SV exchange 後にしか ACK されないことで自然に抑制される。

degraded は同期停止ではなく、未処理 queue や repair event がありユーザー確認が必要かもしれない状態を指す。

## 4. ローカル永続化

**Vault 内**は最小化する。

```
.obsidian/plugins/kuroflare/data.json
  endpoint / vaultId / deviceId / auth secret reference（token 本体は保存しない）
  ignore rules / sync mode flags
  repairLog        # 自動修復イベント。repair panel から読む
```

`path → fileId` の Vault 内キャッシュは持たない。
マッピングは IndexedDB で完結し、失われても join adoption（§8）で remote meta から再構築できる。
`data.json` の setup metadata mirror は UI / 復旧用 cache で、IndexedDB 側の trusted snapshot と食い違えば trusted 側で上書きする。

**IndexedDB**:

```
db: kuroflare:<vaultId>
  metadata          # schemaVersion, vaultId, deviceId, endpoint, auth metadata
  meta-ydoc / file-ydocs
  remote-cursors    # docId -> 最後に durable ack された seq / stateVector
  last-materialized # fileId/path -> diskHash, ydocHash, writeId（editor.md §2）
  outbox / running-leases
  blob-cache        # chunk_sha256 -> local chunk bytes
```

IndexedDB が壊れても Vault + R2 から、Vault が壊れても IndexedDB + R2 から復旧できるようにする。
どちらも source of truth ではないが、片方が残れば復旧できる。

**outbox record の evidence 要件**：record は status / dependsOn / retry metadata に加え、runner が I/O 前に検証できる evidence（blob 系: `blobSha256` / `blobManifestHash` / `blobManifest` / `localCacheKey` / `blobSize`、materialize 系: `expectedHash` / `targetPath` / `lastMaterialized`）を持つ。
evidence が欠ける record は repair / import 由来でも自動実行せず、failure completion か manual repair に回す。

**IndexedDB transaction の規律**：transaction は active window を外れると auto-commit / inactive 化する。
read 結果を `await` してから別 tick で write を発行してはならない。
「全 read を同期発行し、最後の read success callback 内で commit validation と write 発行まで済ませる」helper を使い、`complete` を待ってから成功とする。
`abort` / `error` は request が成功していても durable commit 失敗として扱う。

**schema gate**：plugin は `targetVersion` と `minimumReadableVersion` を持ち、起動時に schema evidence（存在、version、store 名、pending outbox 件数）を読んでから開く。
probe は directory API（`indexedDB.databases()` 相当）で存在確認し、存在しない DB を `open()` で暗黙作成しない。
`outbox` store が欠けた DB は pending 0 と証明できないため conservative に degraded 側へ倒す。
directory API が無い環境は `database-directory-unavailable` として止める。
iOS WebView での可否は未検証のスパイク項目で、非対応なら schema version を `data.json` に冗長保持して代理証拠にする fallback を予約している。

| evidence                                     | action                                                                     |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| DB 無し                                      | `create(targetVersion)`。pending outbox evidence があれば矛盾なので reject |
| `current == target` かつ required store 揃い | `open`                                                                     |
| `minReadable <= current < target`            | `upgrade`。足りない store だけ作り、outbox と cursor は保持                |
| `current < minReadable`                      | pending outbox 0 なら `rebuild`、あれば `degraded`                         |
| `current > target`                           | `degraded`（古い plugin で新しい store を壊さない）                        |
| version 最新なのに store 欠落                | 破損。pending 0 なら `rebuild`、あれば `degraded`                          |

`degraded` / `reject` では同期 side effect を開始せず、status bar と repair panel に出す。

**degraded store の repair** は「export してから rebuild」「明示 discard して rebuild」「何もしない」の 3 経路だけにする。
export 完了前の `rebuild-after-export` は拒否し、`discard-and-rebuild` は確認文言付き confirmation がある時だけ許可する。
pending outbox 0 の場合だけ無条件 rebuild してよい。
この規則が「壊れた IndexedDB を直すために、唯一残っている未送信 update を黙って消す」経路を閉じる。

repair export は guard 可能な JSON（format marker、version、vault / device ID、schema metadata、entries）に固定する。
`done` item、`createdAt` 欠落、不正 retryCount、不正 base64 は export せず、token material を含めない。
export は権威ではなく「失われる前の未送信 evidence」である。

import は即 replay ではなく **staging**:

- file-level reject: vault / device 不一致、重複 ID、壊れた durable seq。
- entry skip: `y-update` 以外、`failed` / `blocked`、依存付き、必須 field 欠落、既存 outbox ID と衝突、既に durable な message、quarantine 一致。
- staged item は `paused / resumeOn="manual" / reason="imported-repair-export"` とし、resume 直前に server の durable / quarantine evidence を再取得して再照合する。古い evidence のまま再送してはいけない。
- blob / materialize / 依存付き entry は復元しない。cache key の有効性や base hash を export だけから証明できないため、rebuild 後の通常 planning で再生成する。

## 5. outbox

外向き side effect はすべて永続 outbox を通す。
`y-update` も直接送信せず durable enqueue → runner tick に寄せる。

```
type OutboxItem =
  | { kind: "y-update";        docId; messageId; update; ... }
  | { kind: "blob-put";        sha256; localCacheKey; size; ... }
  | { kind: "manifest-put";    fileId; blobManifestHash; ... }
  | { kind: "blob-get";        sha256; targetFileId; ... }
  | { kind: "meta-ref-update"; fileId; blobManifestHash; ... }
  | { kind: "materialize";     fileId; expectedHash; ... };
// 共通: id, dependsOn: string[], createdAt, retryCount
```

すべて冪等にする。`retryCount` は backoff と UX のためだけで、意味論に使わない。

**依存関係**:

- upload は `blob-put* → manifest-put → meta-ref-update`（[sync-model.md](sync-model.md) §3 の順序を queue 構造で強制）。download は `blob-get* → materialize`。
- 依存元が未完了の item は実行しない。依存元が blocked なら dependent も transient `blocked`、failed / dead-letter なら dependent も `dead-letter(reason="dependency-dead-letter")` に連鎖させ repair log へ出す。terminal な欠落を黙って blocked のまま残さない。
- 判定は transitive ancestor まで見る。重複 ID や欠けた dependency がある snapshot は信用せず、side effect を開始しない。

**scheduler tick**（1 回の scan の固定手順）:

1. `now` / `maxStarts` / running lease を検証。不正なら開始しない（空 owner、重複 lease、不正 expiry は queue corruption）。
2. 期限切れ lease を stale として reclaim。active lease は lane capacity を消費し、同一 item を再 start しない。
3. resume event に合う paused item を `pending` へ戻す patch を作る。
4. effective snapshot に対して dependency block / dead-letter patch を決める。
5. patch 適用後の状態で input order に item を見る。
6. due / dependency 判定（`decideOutboxRun`）→ lane capacity 判定（`decideOutboxConcurrency`）。
7. 開始予定の item はまだ done ではないので、同 tick 内で dependent を開始しない。
8. ある lane が満杯でも別 lane の item は開始できる。

patch 群を同一 transaction で保存してから lease を CAS で取得し、成功した item だけ発火する。
二重起動防止の最終権威は lease CAS に置き、失敗した start は捨てて次 tick で再評価する。

**lease CAS**: acquire は既存 lease 無し（または同 item / kind の期限切れ take-over）の時だけ。renew は itemId / kind / ownerId 一致かつ期限内のみ。release は itemId / ownerId 一致かつ期限内のみで、owner 違いは take-over 後の遅延完了なので item state を上書きも release もしない。
completion patch と lease release は同一 transaction で保存し、renewal を拒否された runner は以後の completion を破棄する。

**完了の証拠**:

- `y-update` / `meta-ref-update` は server `Ack` だけで done（条件は [protocol.md](protocol.md) §1）。runner の送信成功では閉じない。
- `NeedFullSnapshot` は `paused(reason="full-snapshot-required", resumeOn="manual")` に落とし、full snapshot 経路（§7）を優先する。apply 成功後は対象 doc の該当 item を `done(completedBy="full-snapshot-apply")` に閉じる（manual resume と別系統。snapshot apply と同一 transaction で terminal にしないと古い差分の再送で full snapshot loop に戻る）。
- `SyncUpdateRejected` is handled as a separate terminal evidence path. The client requires an exact local match for `vaultId`, `deviceId`, `docId`, `messageId`, and `updateSha256`, then atomically patches that outbox item to `paused(reason="sync-update-rejected", resumeOn="manual", rejectionRetryable=false)` and releases its lease with a compare-and-swap. A stale or mismatched lease rejects the transaction and changes neither the newer lease nor the outbox record.
- `SyncUpdateRejected` does not mean that the update was durably applied, and it must not be routed through the `NeedFullSnapshot` completion or snapshot-apply release path. Snapshot import, discard, or fork remains an explicit repair decision; older clients that do not understand the message retain the existing close/reconnect behavior.
- server quarantine は ack を返さないため、放置すると同じ破損 update を retry し続ける。`/admin/quarantine` の list / detail と照合し、一致した `y-update` を `paused(reason="server-quarantine", resumeOn="manual")` に落とす。`discard` 後も自動 done にせず、ユーザーが捨てる / fork する / reset する transaction で terminal にする。
- blob 系と materialize は runner の結果 evidence を分類器に通す（401/403 → auth、408 → timeout、429 / 5xx → retryable、他の非 2xx → non-retryable、disk CAS mismatch → local-conflict）。runner は retry / pause / dead-letter を直接判断しない。

**backoff と失敗遷移**:

| kind                       | schedule                                                     |
| -------------------------- | ------------------------------------------------------------ |
| y-update / meta-ref-update | 250ms → 1s → 5s → 30s                                        |
| blob PUT/GET               | 1s → 5s → 30s → 5min                                         |
| materialize                | 即時 3 回、以降はユーザー操作（file close / 再同期）まで待つ |

- `retryAfterMs` は下限として扱う: `effectiveDelay = max(schedule[retryCount], retryAfterMs ?? 0)`。server の「もっと待て」を client schedule で短縮しない。固定 schedule には jitter をかける。
- network / timeout / offline は retry。auth failure は `pause(resumeOn="auth-refresh")`。local conflict は `pause(resumeOn="local-state-change")`。non-retryable と invalid payload は `dead-letter`（理由を `deadLetterReason` に分け、silent discard と区別する）。durable item を silent discard しない。
- 時計が壊れている場合は誤った未来時刻を保存せず manual pause に落とす。
- materialize の block-conflict（[editor.md](editor.md) §2）による再 enqueue は新規 item 扱いで `retryCount` をリセットする。ただし同一 fileId の連続 block-conflict に上限を設け、超えたら manual 化する。リセットしないと外部編集のたびに早すぎる manual pause に落ち、上限が無いと無限ループしうる。

**resume**: `auth-refresh` は refresh accept 後だけ、`local-state-change` は local 状態の変化後だけ自動 resume。`manual` は明示的に戻すが依存 gate は飛び越えない。resume 後も scheduler の全判定を通る。

**lane**: `sync-control`（y-update / meta-ref-update）と `materialize` は各 1 本直列。`blob-transfer` は desktop 4 / mobile 2。
auth-protected item は start 選定中に寿命 gate（[protocol.md](protocol.md) §9）を通し、`refresh-first` なら lease を取らず lane capacity も消費しない（別 lane を飢餓させない）。
refresh request は複数 item 分を 1 つに畳み、`refreshing` の durable commit 後にだけ HTTP を始める。stale な `refreshing` は timeout 扱いで backoff へ戻す。

**runner の検証**: `start.kind` と record kind の一致を検証し、mismatch は I/O 前に拒否する。
`localCacheKey` は `blob-cache/` namespace 内の normalized vault 相対 path のみ、`targetPath` も normalized vault 相対 path のみ（永続 row の文字列を OS path として直接信用しない）。
`manifest-put` は送信前に canonical bytes の hash 一致を検証する。

## 6. WebSocket セッションと受信処理

session 境界:

- startup、outbox sender、inbound dispatcher は単一 session を共有する。session は token を持たず、未接続 / 未 open の送信は fail fast。socket へは session の `send` / `close` / `snapshot` だけでアクセスする。
- `send-client-hello` step は `hello-accepted` の identity が local setup metadata と一致するまで完了しない。hello 後の close / error や identity mismatch は startup failure とし、`resume-background-queues` へ進めない。
- 状態 snapshot には redacted URL、hello、readyState だけを出す。

outbound: leased `y-update` / `meta-ref-update` を `sync-update` frame に直列化して送る。`docId` / `messageId` / `updateBytesBase64` が欠ける row は I/O 前に拒否する。

inbound:

- 文字列 JSON だけを `parseControlMessage` に通し、binary payload や invalid message を decision に渡さない。
- Routing treats `ack`, `need-full-snapshot`, and `sync-update-rejected` as local outbox evidence only when the device identity matches. Peer `sync-update` messages go to apply, peer `sync-request` messages go to the state-vector answer path, and invalid, vault-mismatched, self-broadcast, or unexpected `hello` messages are dropped.
- server の sync-request 応答は requester の `deviceId` を持つため、送信中 sync-request の `messageId` を追跡して self-broadcast 判定から除外する。
- peer `sync-update` の apply は base64 decode、`updateSha256` 照合、`durableSeq` 検証を通った update だけを YDoc に適用し、apply 後に compact state と cursor を同一 IndexedDB transaction で保存する。失敗した update は YDoc も IndexedDB も触らない。
- peer `sync-request` への応答は `Y.encodeStateAsUpdate(doc, sv)` の差分に `baseStateVector` と `updateSha256` を付け、`durableSeq` は付けない（server が append 後に付与）。
- ack completion は outbox / lease snapshot と照合し、対象 record が 1 件だけの場合に限って完了させる。候補なし / 複数 / stale lease / owner mismatch は IndexedDB を変更しない。
- Guarded outbox-completion handlers are serialized per WebSocket, and close/error recovery waits for already-delivered completion handlers to settle. Remote-update, sync-request, and drop handlers run independently with explicit rejection logging so stalled remote I/O cannot block recovery. Inbound outbox completion uses the queued IndexedDB read/validate/write transaction, preserving record-evidence and lease CAS checks at commit time.

## 7. full snapshot の取得と適用

`NeedFullSnapshot` を受けたら、対象 doc の通常 outbox flush を止めて snapshot fetch / local reset 経路へ入る。

1. `GET /vaults/:vaultId/meta/latest`（meta）または `GET .../files/:ydocId/latest`（file）で snapshot を取得する。
2. response guard で `docId` / seq / key / hash 群 / base64 を検証する。
3. bytes へ decode し、size limit と SHA-256 の一致を確認する。`invalid-base64` / `hash-mismatch` は retry で直らない可能性が高いので repair log に残し、別 generation へ fallback する。
4. apply decision の入力へ正規化する（meta response を file doc に流用すると `doc-mismatch`）。
5. apply 可否を判定する。doc の一致、snapshot seq の前進、hash の一致、対象 doc に未送信 local update が無いこと、active editor binding が外れていること、をすべて満たす場合だけ apply。
6. apply は local YDoc 置換、`remoteCursorSeq = snapshotSeq` と `stateVectorBase64` の patch、`full-snapshot-required` item の done を 1 つの IndexedDB transaction で commit する。分けると次回 hello が古い SV を送って full snapshot loop に戻る。outbox release の persist が拒否されたら local YDoc も変えない。
7. `wait(pending-local-updates)` は local update を先に durable ack させるか、conflict UI で discard / fork を選ばせる。`wait(active-editor-bound)` は binding が外れるまで待つ。`reject` は repair log に残して別 generation へ fallback する。

## 8. 初回 scan と join adoption

既存 Vault の初回は通常 watcher と別の `initial-index` モードで走らせる。

```
bootstrap:
  ignore rules 確定 → 全ファイル列挙
  → 既存 IndexedDB があれば path->fileId を復元、無ければ UUID 採番
  → .md は YText seed、binary は blob upload queue へ → meta YDoc に entry 追加 → meta sync

join:
  remote meta snapshot 取得 → canonicalPath で照合
  → hash 一致は remote fileId を adopt
  → path 同じで hash 違いは Yjs merge または conflict copy
  → remote に無い local file だけ UUID 採番
```

adoption の決定規則:

```
decideJoinFileAdoption(local file):
  remoteEntry = remote meta entry at same canonicalPath (text 型のみ)
  if absent:                            return allocate-new
  if hash(remote YText) == hash(disk):  return adopt-matching-content(remoteEntry.fileId)
  else:                                 return adopt-with-local-edit(remoteEntry.fileId)
                                        // remote fileId を採用し、ローカル内容を
                                        // 外部編集と同様に最小 diff で YText へ取り込む
```

remote YText は adopt step の時点ではまだ届いていないため、hash 比較と取り込みは remote content の到着時（sync update / full snapshot apply 時）まで遅延させる。

scan 中に Vault が変更されたら、scan 完了後に差分 scan をもう一度走らせる（「scan snapshot + 追い scan」。逐次処理は順序が複雑になる）。

**初回フルシンクの専用モード**：単一 DO はシングルスレッドなので、大量の seed を同時に投げると初回に overload しやすい。
初回フルシンクは通常同期の WS / op_log 経路に流し込まない。

- `.md` の seed は file YDoc snapshot を R2 へ直接 PUT し、per-doc pointer を作る（§2 の import route）。
- meta YDoc だけは DO を通すが、batch size と rate limit を厳しくする。
- binary blob は DO / WS を通さず Worker HTTP で直接 PUT する。`/blobs/head` はページングし、upload concurrency は desktop 4 / mobile 2。
- DO に送るのは「この fileId の snapshot / pointer / manifest が揃った」という小さい meta 参照更新だけ。
- 中断時は local outbox と R2 の既存 object を突合し、完了済みを飛ばして再開する。
- 初回 index 中の watcher event は即時同期せず、scan 完了後の差分 scan で吸収する。

これで DO は初回の巨大データ面を処理せず、制御面だけを順序付ける。
