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
  reason: "large-update-requires-snapshot-import";
  retryable: false;
};
```

メッセージ意味論:

- `Ack` は「DO の SQLite op_log にこの update が durable append 済み」だけを意味する。client は `vaultId / deviceId / docId / messageId` が pending outbox item と完全一致し、`durableSeq` が既知の durable seq より新しい場合だけ item を `done` にできる。別 doc / 別 message / 別 device の ack を流用してはいけない。
- `NeedFullSnapshot` は ack ではなく、full snapshot 境界（[client.md](client.md) §7）へ戻る要求である。
- `SyncUpdateRejected` is a terminal, evidence-bearing response for an oversized live update. The Worker computes `updateSha256` from the received bytes, sends exactly one JSON rejection before closing the session with `1011`, and does not append the update, write a deduplication row, or mutate the hydrated YDoc. `retryable: false` requires snapshot import or an explicit local repair decision; the update is not acknowledged.
- The rejection contains no update bytes. Clients must only accept it when `vaultId`, `deviceId`, `docId`, `messageId`, and `updateSha256` exactly match one locally pending outbox item. A mismatch or missing item is ignored without changing local queue state.
- `durableSeq` は client → server では未設定。Worker が append 後に確定した値を peer broadcast と `sync-request` 応答に付与する。
- server が `sync-request` に応答する `sync-update` には、requester 自身の `deviceId` と `updateSha256` を載せる。client は送信中 sync-request の `messageId` を追跡し、一致する応答を self-broadcast 判定（[client.md](client.md) §6）から除外する。
- ack がなければ client は同じ update を再送する。永続 op log の重複は `messageId` unique 制約で弾く（[server.md](server.md) §3）。

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
PUT  /blobs/:sha256?size=N        # 認証付き upload proxy
GET  /blobs/:sha256
PUT  /blob-manifests/:sha256.json
GET  /blob-manifests/:sha256.json
POST /devices/:deviceId/revoke
POST /admin/gc                    # dry-run/execute
GET  /admin/quarantine[/:id]
POST /admin/quarantine/:id/{discard,force-apply}
POST /admin/{force-local,force-remote,rebuild}   # 手動エスケープハッチ
```

R2 の public URL を直接配らず、初期実装は Worker 経由で認証を一元化する（個人用途なので単純さを優先）。

**blob data plane**:

- `/blobs/upload-url` の single-put URL は同一 Worker origin の `PUT /blobs/:sha256?size=N`。`expiresAt` は再取得のための advisory TTL で、認可条件にしない。防御境界は device token scope、body size、Content-Length、streaming read limit、path の SHA-256、vault-scoped R2 key に置く（署名なし query param は改ざんできる）。
- PUT は body size と SHA-256 が URL と一致する場合だけ R2 へ書く。GET も読んだ bytes の SHA-256 を照合してから返す。manifest PUT は schema 検証 → canonical bytes 化 → path hash 一致の時だけ保存する。
- MVP は single PUT のみ。16 MiB 以上または `multipart=true` は `multipart-unimplemented` として拒否（multipart response 型は予約 contract）。
- `/blobs/head` は 1 request 最大 512 hashes、超過は client がページング。応答は blob 本体を読まず R2 metadata だけで組み立てる。
- R2 key の vault prefix により、別 vault が hash を知っていても token の vault 外 object は読めない。

**admin API**: 共通 payload は `operation` と `mode: "dry-run" | "execute"`。
dry-run は confirmation token を含まず、response が `confirmationToken` と planned effects を返す。
execute はその token を必須にし、response は token を返さない。
これにより古い token の誤送信や dry-run を飛ばした destructive operation を protocol guard で拒否する。

**revoke**: idempotent。active device の revoke は `tokenVersion` を進めて既存 JWT を `stale-token` 化し、already-revoked への再送は現在の値を返すだけで version を進めない。

主要 payload:

```
POST /setup/exchange
request:  { vaultId, setupToken, requestedDeviceName, existingDeviceId? }
response: { endpoint, vaultId, deviceId, yClientId, accessToken, refreshToken,
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
        | { kind: "multipart"; ... } // 予約。Worker MVP は拒否

GET /health
response: { status: "ok" | "degraded", protocolVersion, checkedAt,
            checks: Array<{ name: "worker" | "durable-object" | "sqlite" | "r2" | "migrations",
                            status, detail? }> }
```

すべての HTTP payload は `core` の guard（`sync/setup.ts`、`auth.ts`、`http/*`）で unknown から検証してから使う。

| 対象                 | guard の規則                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| URL                  | http(s) のみ。credential / fragment 付きを拒否。header 値に CR/LF 禁止                                             |
| setup issue response | `kuroflare://setup?...` URI 内の endpoint / vaultId / setupToken が本体と一致しないものを拒否                      |
| /blobs/head          | request hash と evidence の 1:1 対応（重複、未要求、欠落を拒否）。`found=false` に `size` 禁止                     |
| snapshot response    | `snapshots/.../*.yupdate` 形式の key、update / SV の SHA-256、base64 本体。空 vault bootstrap 用に空 base64 は許可 |
| quarantine           | list は bytes 本体なし。明示 inspect の detail だけが `updateBytesBase64` を返す                                   |

**エラー形式**：公開エラーは 1 型に寄せ、client は `retryable` と `retryAfterMs` だけで backoff 判定する。

```
type ApiError = {
  code: "auth/revoked" | "auth/expired" | "protocol/upgrade-required"
      | "rate-limited" | "blob/hash-mismatch" | "snapshot/not-found" | "server/degraded";
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

## 8. Yjs clientID の一意性

state vector は `clientID → clock` で差分を判断するため、`clientID` の重複や再利用は差分判定もマージも静かに壊す。
conflict として見えず、self-healing に乗らない。

不変条件:

- `deviceId` は plugin install 単位で永続する。
- `y_client_id` は setup exchange 時に DO が未使用の値を払い出して `devices` に固定する。
- DO は `(vaultId, deviceId) → y_client_id` を registry として保持する。
- 同じ `y_client_id` を別 `deviceId` が名乗ったら接続拒否し、片方に再採番を要求する。
- 同じ `deviceId` が別 `y_client_id` を名乗ったら、再インストールまたは IndexedDB 消失として扱い、即 reject ではなく full snapshot merge 経路（[sync-model.md](sync-model.md) §2）に落としてから registry を更新する。

hello では `deviceId` と `yClientId` を必ず送り、registry と一致しない hello を通常同期へ進めない。
`yClientId` は正の safe integer のみ受け付ける。

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
