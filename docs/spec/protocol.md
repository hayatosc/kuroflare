# Wire protocol と認証

[← 設計書トップ](../../spec.md)

## 1. WebSocket メッセージ

Yjs update は binary frame、制御系は JSON frame に分ける。
すべての frame に `protocolVersion`, `vaultId`, `docId`, `deviceId`, `messageId` を持たせ、再送を idempotent にする。

```
type DocId = { kind: "meta" } | { kind: "file"; ydocId: string };

type ClientHello = {
  type: "hello";
  protocolVersion: number;
  vaultId: string;
  deviceId: string;
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
  update: string;          // base64。主経路は binary frame へ逃がす
  updateSha256?: string;   // sender が載せた場合は payload hash と照合
  baseStateVector?: string;
  durableSeq?: number;     // server の append 後 broadcast / 応答にだけ付く
};

type Ack = { type: "ack"; messageId: string; docId: DocId; durableSeq: number };

type NeedFullSnapshot = {
  type: "need-full-snapshot";
  docId: DocId;
  reason: "state-vector-too-old" | "missing-log" | "protocol-upgrade" | "large-update-snapshot";
};

type SyncUpdateRejected = {
  type: "sync-update-rejected";
  protocolVersion: number;
  vaultId: string;
  deviceId: string;
  messageId: string;
  docId: DocId;
  updateSha256: string;
  reason: "large-update-requires-snapshot-import" | "metadata-read-only"
      | "hash-mismatch" | "yjs-apply-failed" | "meta-schema-invalid";
  retryable: false;
};

type AwarenessUpdate = {
  type: "awareness-update";
  vaultId: string;
  deviceId: string;
  docId: DocId;
  clientId: number;         // the sender's local Y.Doc-shaped clientID (§8), not an authenticated actor
  state: object | null;     // null means the clientId left; a few KB size cap, no messageId/durableSeq
};
```

メッセージ意味論:

- `Ack` は「DO の SQLite op_log にこの update が durable append 済み」だけを意味する。client は `vaultId / deviceId / docId / messageId` が pending outbox item と完全一致し、`durableSeq` が既知の durable seq より新しい場合だけ item を `done` にできる。別 doc / 別 message / 別 device の ack を流用してはいけない。
- `NeedFullSnapshot` は ack ではなく、full snapshot 境界（[client.md](client.md) §7）へ戻る要求である。
- `SyncUpdateRejected` is a terminal, evidence-bearing response for a rejected live update. The Worker computes `updateSha256` from the received bytes, sends exactly one JSON rejection, and does not append the update, write a deduplication row, or mutate the hydrated YDoc. After the rejection frame, `large-update-requires-snapshot-import` closes the session with `1011` and `metadata-read-only` closes with `1008`, while quarantine rejections (`hash-mismatch`, `yjs-apply-failed`, `meta-schema-invalid`) persist quarantine evidence and keep the session open. `retryable: false` requires snapshot import or an explicit local/admin repair decision; the update is not acknowledged.
- The rejection contains no update bytes. Clients must only accept it when `vaultId`, `deviceId`, `docId`, `messageId`, and `updateSha256` exactly match one locally pending outbox item. A mismatch or missing item is ignored without changing local queue state.
- `durableSeq` は client → server では未設定。Worker が append 後に確定した値を peer broadcast と `sync-request` 応答に付与する。
- server が `sync-request` に応答する `sync-update` には、requester 自身の `deviceId` と `updateSha256` を載せる。client は送信中 sync-request の `messageId` を追跡し、一致する応答を self-broadcast 判定（[client.md](client.md) §6）から除外する。
- ack がなければ client は同じ update を再送する。永続 op log の重複は `messageId` unique 制約で弾く（[server.md](server.md) §3）。
- `AwarenessUpdate` is a same-vault broadcast of ephemeral presence (cursor position, open-file hint), not a durable sync message: it carries no `messageId`/`durableSeq`, is never acked, and the DO never persists it or writes quarantine/evidence for it. `y-protocols` is not an installed dependency, so `state` is a plain JSON object rather than a binary-encoded awareness update. The DO fans the frame out unchanged to every other authenticated socket in the vault (sender excluded); it does not filter by `docId`, matching `sync-update`'s existing vault-wide broadcast. `state` is capped at a few KB; oversized or otherwise malformed awareness frames are dropped silently (no quarantine, no evidence, and the session is not closed, since presence loss is tolerable). When a connection that has sent at least one `AwarenessUpdate` disconnects, the DO broadcasts one synthetic `state: null` for the `docId`/`clientId` it last advertised, so peers drop the stale remote cursor; the connection→clientId mapping is kept in the WebSocket attachment (`serializeAttachment`/`deserializeAttachment`) so it survives Hibernation like session state does (§6).
- `ClientHello.capabilities` (DR-012) is validated as a list of opaque, format-guarded tokens, not a closed set: a peer that does not recognize an entry ignores it and negotiates the known intersection instead of rejecting the whole hello. Capability order and duplicates carry no meaning. A capability a peer requires for admission is tracked in that peer's own required-capability list (currently empty on the Worker); a hello missing one closes with `capability-required:<name>` (`1008`), not the generic `invalid-control-message` close used for structurally malformed frames.

## 2. binary frame

```
binary frame:
  magic:        2 bytes   "KF"
  version:      u16
  headerLength: u32
  headerJson:   utf8      { type, messageId, vaultId, docId, deviceId, updateSha256?, durableSeq? }
  updateBytes:  bytes     Yjs update
```

- header は `BinaryFrameHeader` として JSON control message と同じ guard を通す。壊れた magic / version / header length / schema は decode で拒否する。
- Worker は binary frame を任意 broadcast せず、decode が通った payload だけを通常の `sync-update` pipeline へ流す。hello 前の binary frame は `hello-required`、壊れた frame は `invalid-binary-frame` として close し、peer へは送らない。
- broadcast 先は hello 済みで session を復元できる socket だけ。upgrade 済みだが hello 未完了の socket へ Yjs plaintext を送らない。
- broadcast は受信 frame の転送ではなく、`durableSeq` 付き header と元 payload から新しい frame を作る。

wire 境界の検証は `packages/core` の guard に集約する。

| 対象            | 規則                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| ID 群           | `vaultId / deviceId / messageId / ydocId` は branded string。`[A-Za-z0-9][A-Za-z0-9._:-]{0,127}` のみ |
| DocId           | discriminated union。path を wire に載せない                                                          |
| control message | `parseControlMessage` で unknown から検証                                                             |
| SV / update     | base64 のみ。`updateSha256` は SHA-256 hex。JSON `update` は bootstrap / debug 用の逃げ道             |
| hash 照合       | `updateSha256` があれば Worker が実 bytes と照合し、ズレは `hash-mismatch` として隔離                 |

## 3. HTTP API

```
GET  /health
POST /setup/exchange              # setup URI の one-time token を device token に交換
POST /auth/refresh
GET  /vaults/:vaultId/meta/latest             # join/bootstrap 用 meta snapshot
GET  /vaults/:vaultId/files/:ydocId/latest    # NeedFullSnapshot 用 file snapshot
PUT  /vaults/:vaultId/meta/snapshot           # bootstrap 時の snapshot direct import
PUT  /vaults/:vaultId/files/:ydocId/snapshot
POST /blobs/head                  # chunk hashes -> exists[]
POST /blobs/upload-url
PUT  /blobs/:sha256?size=N        # 認証付き upload proxy（single-put）
GET  /blobs/:sha256
PUT  /blobs/:sha256/parts/:uploadId/:partNumber   # 認証付き upload proxy（multipart 1 part）
POST /blobs/:sha256/complete
POST /blobs/:sha256/abort
PUT  /blob-manifests/:sha256.json
GET  /blob-manifests/:sha256.json
POST /devices/:deviceId/revoke
GET  /admin/quarantine[/:id]
POST /admin/quarantine/:id/{discard,force-apply}
```

`gc`/`force-local`/`force-remote`/`rebuild` admin operations were named as a
placeholder route family but never given a payload/effect contract, so no
route exists for them (see docs/spec/server.md §9 and
docs/implementation-status.md).

R2 の public URL を直接配らず、初期実装は Worker 経由で認証を一元化する（個人用途なので単純さを優先）。

**blob data plane**:

- `/blobs/upload-url` の single-put URL は同一 Worker origin の `PUT /blobs/:sha256?size=N`。`expiresAt` は再取得のための advisory TTL で、認可条件にしない。防御境界は device token scope、body size、Content-Length、streaming read limit、path の SHA-256、vault-scoped R2 key に置く（署名なし query param は改ざんできる）。
- PUT は body size と SHA-256 が URL と一致する場合だけ R2 へ書く。GET も読んだ bytes の SHA-256 を照合してから返す。manifest PUT は schema 検証 → canonical bytes 化 → path hash 一致の時だけ保存する。
- `/blobs/head` は 1 request 最大 512 hashes、超過は client がページング。応答は blob 本体を読まず R2 metadata だけで組み立てる。
- R2 key の vault prefix により、別 vault が hash を知っていても token の vault 外 object は読めない。

**multipart upload**（`size >= BLOB_MULTIPART_THRESHOLD_BYTES`（16 MiB）または request の `multipart: true`）:

- `/blobs/upload-url` は `{ kind: "multipart", uploadId, parts: [{ partNumber, url, headers }], expiresAt }` を返す。`parts` は DO が R2 `createMultipartUpload` で開始したセッションを固定長 `BLOB_MULTIPART_PART_SIZE_BYTES`（8 MiB。R2/S3 の非最終 part 最小要件 5 MiB に対して余裕を持たせた値）で分割した計画で、各 `url` は `PUT /blobs/:sha256/parts/:uploadId/:partNumber` を指す。part 数は `MAX_BLOB_MULTIPART_PARTS`（10,000、R2/S3 の上限）を超えたら計画せず `request/invalid` で拒否する。閾値未満でも `multipart: true` を明示すれば multipart 経路を使える。
- `PUT /blobs/:sha256/parts/:uploadId/:partNumber` は single-put と同じ認証付き proxy。DO は R2 `uploadPart` を呼び、返る ETag と実際の受信バイト数・part 単位 SHA-256 を DO の SQLite（pending テーブル）に永続化する。DO 再起動を跨いでも安全。partNumber は計画された part 数の範囲外だと拒否し、受信サイズは計画上の期待サイズ（最終 part 以外は固定サイズ、最終 part だけ端数）と一致しない場合 `blob/size-mismatch` で拒否する。
- `POST /blobs/:sha256/complete`：`{ uploadId, parts: [{ partNumber, etag }] }`。DO は自分が永続化した part 記録と突合し（client が送る etag は DO 記録と完全一致必須。不一致・part 数不一致は R2 を呼ばず reject）、一致すれば R2 `completeMultipartUpload` を呼ぶ。**blob を参照可能にする前に、complete 後の object を streaming GET してから全体 SHA-256 を必ず再照合する。** 一致しなければ object を削除し pending 行を消して `blob/hash-mismatch` を返す（他の失敗経路と同様、その手前で DO 記録との突合や R2 `complete` 自体が失敗した場合は R2 `abortMultipartUpload` を呼んでから reject する）。
- `POST /blobs/:sha256/abort`：`{ uploadId }`。R2 `abortMultipartUpload` を呼び pending 行を消す。既に消えているセッションへの再送は idempotent に成功を返す。
- 放置されたセッションは pending テーブルの `expiresAt`（upload-url の `expiresAt` と同じ TTL）を alarm が経過チェックし、期限切れなら abort する。ただしこの alarm 呼び出し自体は他の理由（checkpoint 等）で起きた時の best-effort な掃除であり、単独では起こさない。完全に放置された vault のための権威ある backstop は R2 bucket 側の lifecycle rule（incomplete multipart upload を ~24h で abort、`wrangler.toml` 参照）である。

**admin API**: 共通 payload は `operation` と `mode: "dry-run" | "execute"`。
dry-run は confirmation token を含まず、response が `confirmationToken` と planned effects を返す。
execute はその token を必須にし、response は token を返さない。
これにより古い token の誤送信や dry-run を飛ばした destructive operation を protocol guard で拒否する。

**revoke**: idempotent。active device の revoke は `tokenVersion` を進めて既存 JWT を `stale-token` 化し、already-revoked への再送は現在の値を返すだけで version を進めない。

主要 payload:

```
POST /setup/exchange
request:  { vaultId, setupToken, requestedDeviceName, existingDeviceId? }
response: { endpoint, vaultId, deviceId, accessToken, refreshToken,
            tokenVersion, protocolVersion, bootstrapMode: "new-vault" | "join-existing" }

GET /vaults/:vaultId/meta/latest
response: { manifestSeq, snapshotKey, snapshotSeq,
            updateSha256, stateVectorSha256, stateVector, updateBytesBase64 }

POST /blobs/head
request:  { hashes: string[] } // max 512
response: { exists: Record<string, { found: boolean; size?: number }> }

POST /blobs/upload-url
request:  { sha256, size, multipart?: boolean }
response: { kind: "already-exists" }
        | { kind: "single-put"; url; headers; expiresAt }
        | { kind: "multipart"; uploadId; parts: Array<{ partNumber; url; headers }>; expiresAt }

PUT /blobs/:sha256/parts/:uploadId/:partNumber   # body はこの part の生バイト列
response: { status: "stored"; partNumber; etag; size }

POST /blobs/:sha256/complete
request:  { uploadId; parts: Array<{ partNumber; etag }> }
response: { status: "stored"; sha256; size }

POST /blobs/:sha256/abort
request:  { uploadId }
response: { status: "aborted"; sha256 }

GET /health
response: { status: "ok" | "degraded", protocolVersion, checkedAt,
            checks: Array<{ name: "worker" | "durable-object" | "sqlite" | "r2" | "migrations",
                            status, detail? }> }
```

すべての HTTP payload は `core` の guard（`sync/setup.ts`、`auth.ts`、`http/*`）で unknown から検証してから使う。

| 対象                          | guard の規則                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| URL                           | http(s) のみ。credential / fragment 付きを拒否。header 値に CR/LF 禁止                                                                                                                            |
| setup issue response          | `kuroflare://setup?...` URI 内の endpoint / vaultId / setupToken が本体と一致しないものを拒否                                                                                                     |
| /blobs/head                   | request hash と evidence の 1:1 対応（重複、未要求、欠落を拒否）。`found=true` は `size` 必須、`found=false` は `size` 禁止（[sync-model.md](sync-model.md) §5: size 不明を復活許可扱いにしない） |
| snapshot response             | `snapshots/.../*.yupdate` 形式の key、update / SV の SHA-256、base64 本体。空 vault bootstrap 用に空 base64 は許可                                                                                |
| quarantine                    | list は bytes 本体なし。明示 inspect の detail だけが `updateBytesBase64` を返す                                                                                                                  |
| multipart part/complete/abort | scope `blob:write`、vault-scoped R2 key prefix、partNumber は計画済み part 数の範囲内、part 数上限 `MAX_BLOB_MULTIPART_PARTS`。complete の `parts` は DO 記録（part 数・etag）と完全一致必須      |

**エラー形式**：公開エラーは 1 型に寄せ、client は `retryable` と `retryAfterMs` だけで backoff 判定する。

```
type ApiError = {
  code: "auth/revoked" | "auth/expired" | "auth/rejected" | "protocol/upgrade-required"
      | "rate-limited" | "blob/hash-mismatch" | "snapshot/not-found" | "server/degraded"
      | "server/error" | "request/invalid" | "request/not-found" | "request/conflict";
  retryable: boolean;
  retryAfterMs?: number;
  detail?: string;
};
```

unknown な `code` は retryable として扱わない。

**health の意味論**：`/health` は概況であり、vault 単位の sync 受理可否の権威ではない（それは各 DO の startup check、[server.md](server.md) §10）。
R2 degraded では durable op append は継続し、checkpoint / blob data plane だけを止める。
top-level `ok` に degraded check が混じる response は guard が拒否する。

## 4. プロトコル互換

`protocolVersion` は整数で、破壊的変更時だけ上げる。
Worker は `minSupportedProtocolVersion` 未満のクライアントを拒否し、Obsidian 側には「プラグイン更新が必要」と出す。
Yjs update 自体の互換性だけに頼らず、MetaFile schema の互換（[data-model.md](data-model.md) §2）を明示管理する。

## 5. Setup URI と setup exchange

E2EE しないため、token は vault の全 plaintext へのアクセス権そのものである。
同期トークンの漏洩と古い端末の失効は最初から設計に入れる。

デバイス登録は Setup URI（QR にもできる）1 本で行う。

```
kuroflare://setup?endpoint=...&vaultId=...&setupToken=...
```

- `setupToken` は one-time かつ短命（例: 10 分）。`POST /setup/exchange` で device token に交換し、以後使えない。QR / URI を再利用可能にしない。
- setup token は平文で保存せず、token hash から row（`vault_id / issued_at / expires_at / consumed_at`）を引く。consume 判定は unknown token、vault mismatch、壊れた有効期間、not-yet-valid、expired、already consumed をすべて拒否する。
- exchange handler は request guard の後、token consume、device registry 判定、device row 書き込み、access JWT mint、initial refresh token hash insert を 1 transaction で進める。token を consume してから後続の書き込みに失敗する状態を避けるためで、途中で失敗したら rollback して credential response を返さない。

## 6. device token と admission

```
JWT claims:
  iss: kuroflare-worker
  aud: vaultId
  sub: deviceId
  scope: ["sync:read", "sync:write", "blob:read", "blob:write"]  // 固定 4 種。未知 scope は拒否
  iat, exp
  tokenVersion
```

- Worker / DO は `vaultId` と JWT `aud` を必ず照合する。DO id は `vaultId` から導出するが、それだけを認可に使わない。
- device registry（[server.md](server.md) §2 の `devices`）と照合し、`tokenVersion` が registry より古い、または `revoked_at` がある device を拒否する。
- HTTP と WS の入口は同じ admission decision（`decideAuthAdmission`）を通す。
- HS256 の署名と検証は `core/src/sync/jwt.ts` に集約し、Worker の mint と plugin の検証が同じ guard を使う。

WebSocket の認証経路:

- 第一候補は upgrade 時の `Authorization: Bearer <jwt>`。browser / WebView は custom header を付けられないため、plugin は `Sec-WebSocket-Protocol: kuroflare.v1, kuroflare-token.<jwt>` subprotocol を使う。
- `?access_token=` query は受け付けない。URL、snapshot、log に token が残る経路を閉じる。
- DO の upgrade 応答は `Sec-WebSocket-Protocol` をエコーする。実ブラウザ / Electron のクライアントはこれが無いとハンドシェイクに失敗する。
- SQL registry があるのに `DEVICE_TOKEN_SECRET` 未設定の runtime は fail-closed（`auth-reject:missing-secret`）。
- accept した socket の identity と token は attachment に保存し、Hibernation 復帰後に復元する。インメモリ Map だけに依存しない。
- 後続 message が hello と異なる identity を名乗れば `session-mismatch` で閉じる。

## 7. token refresh と revoke

refresh（`POST /auth/refresh`）:

- refresh token も hash で保存し、lookup は hash で行う。
- 拒否: unknown / revoked device、missing / mismatched / revoked / expired / not-yet-valid refresh token、stale `previousTokenVersion`、registry より未来の tokenVersion。
- 成功時は現行 `tokenVersion` で短命 access token を mint し、refresh token を rotate する。旧 hash の revoke と新 hash の insert は同一 transaction で、失敗したら rollback して新 token を返さない。

revoke（`POST /devices/:deviceId/revoke`）:

- actor の Bearer JWT を entrypoint と DO の両方で検証し、`sync:write` がある場合だけ target を revoke する。
- active device は tokenVersion bump、already revoked は idempotent に既存値を返す（§3）。

## 8. Authenticated device identity and Yjs actors

`deviceId` is the only identity accepted from the authenticated setup/JWT context. The
Worker binds every session, operation-log row, and quarantine row to that device ID; a
client cannot provide a separate actor or audit identity. `ClientHello` carries the
device ID only, and setup metadata mirrors the same durable value.

Yjs `clientID` values are generated by each real `Y.Doc` instance. They are CRDT
implementation details, not authenticated authorship claims, and are intentionally
absent from setup, hello, session, and SQL contracts. DR-007 recovery records are local
metadata evidence only and never become an authenticated actor claim.

When a y-indexeddb provider disappears, the client must probe `indexedDB.databases()`
before opening it. A missing provider with a ready/recovering epoch, local YDoc base, or
retained outbox update enters guarded recovery. The client fetches the latest authoritative
snapshot (a 404 is valid only for a genuinely new remote document), merges the validated
local base and exact pending/paused/in-flight Yjs bytes, and imports through a bounded
latest-`manifestSeq` CAS loop. The startup gate blocks editor, metadata, WebSocket, and
outbox side effects until the candidate is persisted by a fresh provider and one local
transaction commits the YDoc, cursor, outbox completions, and ready epoch. Directory API
absence or malformed evidence fails closed without opening the provider.

## 9. クライアント側の token 管理

保存:

- token 本体は Obsidian の SecretStorage に置き、`data.json` に平文保存しない。
- IndexedDB の `metadata` store には SecretStorage の key 参照と `ClientAuthMetadata`（`authState: "active" | "revoked" | "reauth-required"`、tokenVersion、expiry、refresh worker の状態と backoff）だけを置く。

refresh の受け入れ:

- 署名検証済みの新 claims を local vaultId / deviceId、必要 scope、現在時刻、保存済み tokenVersion に照合する。mismatch、`iat/exp` 外、scope 不足、tokenVersion 後退は reject し、resume event を出さない。
- accept の場合だけ SecretStorage を上書きし、metadata を単一 IndexedDB transaction で更新して `auth-refresh` resume event を出す。
- SecretStorage と IndexedDB は同一 transaction ではない。metadata commit に失敗したら refresh 前の secret snapshot へ rollback し、resume event を出さない。古い token、別 vault の token、読み取り専用 token で durable queue を再送しないためである。

refresh attempt の分類:

| 結果                                                     | patch                                                                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| accepted                                                 | `refreshState="idle"`、retryCount リセット、resume event                                           |
| network / timeout / offline / retryable server error     | `backing-off`、`retryCount+1`、`nextAllowedRefreshAt`（server の `retryAfterMs` を下限として尊重） |
| revoked device / refresh token rejection / 不正 response | `require-reauth`。outbox item は捨てずに auth UI へ誘導                                            |

revoke の反映:

- guarded revoke response を local deviceId と tokenVersion に照合し、accept なら SecretStorage の token を削除してから `authState="revoked"` の metadata を単一 transaction で保存する。
- secret delete の失敗は cleanup failure として記録するが、revoked metadata は secret key 参照を持たないので、後続 startup が残った secret を使うことはない。
- pending outbox は消さず、再認証 UI / repair UI に残す。

実行前の寿命 gate:

- auth が必要な side effect の開始直前に、token の残り寿命を `refreshMarginMs + estimatedDurationMs` と照合し、足りなければ開始せず先に refresh をスケジュールする（`refresh-first`）。
- `estimatedDurationMs` は outbox item 単位で渡して blob の大小を区別する。local-only の `materialize` は gate の対象外。
- これにより、長い blob 転送を期限間際の token で開始して途中 auth failure に落ちる経路を減らす。
