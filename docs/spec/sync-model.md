# 同期モデル

[← 設計書トップ](../../spec.md)

## 1. state vector による差分合流

オフライン編集を特別扱いしない。
「クロックが古いだけの普通の操作」として合流させ、「どっちが正しいか決める」処理を持たない。
これを可能にするのが Yjs の **state vector（SV）**、「どのクライアントの、どこまでの操作を持っているか」のコンパクトな目次（`clientID → 最大 clock`）である。
全文ではなく目次だけを交換し、相手に足りない op だけを送る。

```
クライアント:  SV = { A: 152, B: 88 }
DO:           SV = { A: 152, B: 91, C: 30 }
→ DO は「クライアントに B:89-91 と C 全部が足りない」と計算 → その差分 op だけ送る
→ クライアントも自分が持つ DO に無い op を送る
→ 双方向で合流。全文転送ゼロ。
```

3 日オフラインでも、送るのは「相手が持っていない操作」だけになる。
タイムスタンプで勝敗を決めないので両方の編集が残る。
差分マージなので「上書き」という概念自体が無く、これが remotely-save との決定的な差である。

## 2. 長期オフラインと full snapshot merge

`encodeStateAsUpdate(doc)` が返すのは op 履歴ではなく現在状態を圧縮した update で、新規クライアントは全履歴を再生しない。
つまりスナップショット戦略がそのまま Yjs 内部 tombstone の肥大化対策になる。
Yjs の `gc:true`（デフォルト）も削除内容を回収するので基本は触らない。

長期オフラインの危険は「古い snapshot や op-log を消した後に、それより古い SV のクライアントが戻ってくる」ことにある。
これへの解は不変条件 2 本で足りる。

> 最新のフルスナップショットは絶対に消さない。
> さらに論理破損から戻るため、retention window 内の旧スナップショットも保持する（[server.md](server.md) §8）。
> op-log は compact してよいが、snapshot retention は別管理とする。

どれだけ古いクライアントが戻っても、(1) 最新フルスナップショットを 1 つの update として `applyUpdate` でマージし、(2) 自分の未同期 op を DO へ送り返す、の 2 手で必ず合流できる。
Yjs のマージは可換なので、古い doc に最新フル状態を被せても壊れず収束する。
「差分計算できず壊れる」が「差分は無理だがフルマージはできる」に格下げされる。
運用上は、SV が保持地平（[server.md](server.md) §4）より古いクライアントを検出したら full snapshot merge 経路に落とす分岐を入れるだけでよい。

## 3. バイナリは参照だけを同期する

R2 のチャンクは content-addressed、つまり不変である。
不変なものは「同期」する必要がない。
ハッシュが一致すれば同じものだし、手元になければ取りに行くだけでよい。

同期すべきは「`fileId → このチャンク群`」という参照だけで、これをメタ YDoc に入れる。
結果、ファイルツリー、テキスト、画像参照、削除がすべて Yjs の因果一貫性の下に乗り、「同期チャンネルが複数あって順序がバラける」問題が消える。

**書き込み順序（厳守）**：必ず blob 本体が先、参照が後。

```
1. CDC でチャンク分割し、各チャンクの sha256 を計算
2. R2 に未存在のチャンクだけ PUT（HEAD で存在確認 → 重複排除）  ← 完了を待つ
3. 完了してから メタ YDoc に fileId → { blobChunks: [...] } を書く
```

逆順にすると、他クライアントが「ハッシュはあるのに R2 に実体がない」状態を見る。
順序を守れば、参照が見えた時点で blob は必ず R2 に存在する（R2 は同一キーの PUT-then-GET が強整合）。

読み込み側は取得した bytes を必ず検証する。

```
1. チャンクがローカルに無ければ R2 から GET
2. bytes の sha256 が chunk key と一致 → cache して組み立て
   不一致 → 破棄してリトライ。一定回数で degraded + repair log
3. 取得失敗 → リトライキューへ（不変なので何度でも安全に再取得できる）
```

共有実装 `assembleBlobBytes` は missing chunk / chunk size mismatch / chunk hash mismatch / content hash mismatch を区別して返し、Worker と plugin はこれを retry / degraded / repair log に変換する。

「`blobChunks` は manifest と一致必須」という不変条件を、Worker は書き込み時にクロスチェックしない（一致検証は plugin 側のみ）。
meta update のたびに R2 GET を伴う突合を行うコストを避けるための割り切りで、矛盾は防ぐのではなく読み込み側の `assembleBlobBytes` で検出して repair log へ回す。

一瞬「参照は来たがダウンロード中」が生じるが、チャンクは不変なので必ず収束する。
古いチャンクも消えずに残るため、「古いファイルで後勝ち上書き → ロールバック」は起きない。

## 4. 削除と tombstone

削除はメタ YDoc の **tombstone**（`deleted: true`）で表現する。
Yjs の因果性で削除操作の順序が保たれ、他クライアントは確実に追従する。
ローカルでは実ファイルを消す代わりに `.trash` へ退避する（Obsidian 標準のゴミ箱と同じ発想）。

meta YDoc は vault 全ファイルが集約される単一ドキュメントなので、tombstone entry を無条件に残し続けると長寿命 vault で無制限に肥大化する。
そこで **tombstone entry の horizon** を設ける。
blob GC と同じ retention horizon（`gcRetentionWindow >= maxOfflineWindow`、§7）を越えた tombstone entry は、full-snapshot 境界で Y.Map から物理削除してよい。
horizon 以内は「削除 vs 編集」の復活判定（§5）に応じられる状態を維持し、越えたら物理的に手放す。

## 5. 「削除 vs 編集」の解決

CRDT でも自動解決できない意味的衝突であり、ポリシーで決める。

- delete は tombstone を立てるが本文 YDoc は保持する。
- 並行（concurrent）な「削除 vs 編集」では**編集を勝たせて復活**させ、ユーザーに通知する。根拠: ノートは「消える事故」より「残る事故」の方が圧倒的にマシだからである。

```
if deleted=true and hasConcurrentEditAfterDelete(fileId):
  if type == "text":
    deleted=false + repair event "restored because concurrent edit exists"
  if type == "binary":
    verify manifest + chunks
    complete   -> deleted=false + repair event
    incomplete -> keep deleted=true + repair event "cannot restore: chunks missing"
```

binary の復活前検証は「manifest を取得し、全 chunk の HEAD found と size 一致を確認する」で足りる。
hash の再計算までしないのは手抜きではなく、PUT 時に hash 検証済みの content-addressed store では key = content sha256 なので、HEAD found + size 一致で同一内容と言えるからである。
size が不明な chunk は無条件 true にせず、復活させない側へ倒す。
chunk が欠けている場合は自動復活させず、repair log に「実体 GC 済みのため復元不可」と出して再アップロードか手動復元を促す。
参照だけの壊れたファイルを materialize してはならない。

`hasConcurrentEditAfterDelete` は本来 device clock / state vector で「削除を観測していない編集」を見るが、初期は `deletedAt < contentUpdatedAt` かつ `updatedBy != deletedBy` を conservative な近似としてよい。
迷ったら消さずに復活、ただし binary は実体が揃っている場合だけ。

実装: `core/src/sync/reconcile.ts` の `planDeleteVsEditRepairs`（text は復活 plan、binary は restorable set に含まれる場合だけ復活、他は `keep-deleted`）と `applyMetaRepair`。

## 6. 同一 path 衝突の決定論的修復

CRDT は「1 path = 1 fileId」というアプリ不変条件を保証しない。
並行新規作成で同一 path に別 fileId ができた場合は、収束後に検出し、全クライアントが同じ決定論的修復を行う。
誰も調整せず、全員が同じ結果に収束する。

```
for each group(canonicalPath, deleted=false) with length > 1:
  winner = minBy(entries, [createdAt, fileId])
  for loser in entries - winner sorted by fileId:
    loser.path = allocateSuffix(winner.path, loser.fileId)
    loser.canonicalPath = canonical(loser.path)
    loser.updatedAt = nowLogical; loser.updatedBy = "repair"
    append repair-log event
```

`allocateSuffix` は全端末で同じ結果を返す。
winner path の拡張子前に ` (conflict <shortFileId>)` を挿入し、既存 path とぶつかれば `-2`, `-3`... を付ける。
tie-break は `localeCompare` を使わず、code unit 順（`<` / `>`）で固定する。

「誰が勝つか」はユーザーの意図ではなく、収束のための機械的規則である。
勝敗で内容を捨てない。負けた側は path が変わるだけで、fileId と内容は残る。

実装: `reconcile.ts` の `planPathConflictRepairs`。

## 7. blob チャンクの GC

参照されなくなったチャンクは**当面消さない**ことを強く推奨する。
「削除したけどやっぱり戻したい」が常に効くし、R2 は安いので初期は溜める方が安全である。
容量が問題になってから、参照カウント 0 かつ一定期間（例: 30 日）経過したものだけを GC する。

GC を実装する場合の不変条件:

- `gcRetentionWindow >= maxOfflineWindow`。想定最大オフライン期間より短い保持期間で chunk を消さない。
- tombstone GC（§4）と blob GC は同じ retention horizon を見る。メタ上は復活できるのに実体だけ消えている状態を作らない。
- 復活前の実体検証（§5）までを GC と同じ機能として実装する。「参照は復活したが実体は GC 済み」は CRDT 収束では直せない。
