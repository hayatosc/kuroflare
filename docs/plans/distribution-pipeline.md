# Kuroflare 配布パイプライン実装計画

## 目的

Kuroflareの利用者が、開発用モノレポをcloneせずにObsidian PluginとCloudflare Workerを導入し、Git操作なしで継続更新できる配布経路を構築する。

初回導入では、Pluginを通常のObsidian Pluginとしてインストールし、WorkerをDeploy to Cloudflareから利用者自身のCloudflareアカウントへ配置する。

更新では、PluginはObsidianの既存更新経路を使う。

WorkerはCron Triggerで更新を確認し、対象になった場合だけDeploy HookからWorkers Buildsを起動する。

Workers Buildsは検証済みの固定成果物を準備し、Cloudflare標準の`wrangler deploy`で配置する。

## 設計判断

- PluginとWorkerは同じKuroflare製品バージョンでリリースする。
- 製品バージョンにはSemantic Versioningを使う。
- PluginのGitHub Releaseタグは`manifest.json`の`version`と一致させる。
- Workerの主要実装は`@kuroflare/worker-runtime`へ集約する。
- runtimeは`@kuroflare/core`を内部へbundleし、外部のworkspace依存を持たない。
- 初回Workerデプロイには、外部の`hayatosc/kuroflare-cloudflare-templete`リポジトリが所有するテンプレートを使う。
- 利用者のテンプレートリポジトリにはKuroflare本体のソースを置かない。
- 独自のdeployer packageとdeploy CLIは実装しない。
- ユーザー向けの更新コマンド、対話型CLI、Cloudflare API wrapperも実装しない。
- Workerの配置は初回と更新の両方で`wrangler deploy`へ任せる。
- 固定bootstrapは引数を持たないbuild scriptとして成果物の準備だけを担当し、Cloudflare APIを直接操作しない。
- release manifestを成果物の正本とし、npmの`stable` dist-tagをbuild時のバージョン解決に使わない。
- Worker更新はインストール単位で段階配信するが、配信率を厳密な上限として扱わない。
- PluginとWorkerの互換性を証明できないreleaseは自動更新しない。
- PluginとWorkerへCloudflare APIトークンを保存しない。
- Durable Objectのクラス名とbinding名は、配布開始後の互換性境界として固定する。
- 永続データのmigrationは追加的かつ後方互換にする。

### deploy CLIについて

Kuroflare専用のdeploy CLIは不要である。

CloudflareのDeploy to CloudflareとWorkers Builds自体が、deploy script未定義時に`npx wrangler deploy`を標準のdeploy commandとして設定する。

この計画では再現性を保つため、release manifestで固定したWranglerをWorkers Buildsが非対話で実行する。

したがって、追加するのは「成果物を検証して一時ディレクトリへ準備する固定build script」だけである。

利用者がコマンドを実行したり、Kuroflare独自のdeploy toolをinstallしたりする設計にはしない。

## 配布構成

配布経路は、開発元、初回デプロイ用テンプレート、利用者環境に分ける。

```text
kuroflare
  ├─ Obsidian Plugin release assets
  ├─ @kuroflare/worker-runtime
  ├─ versioned build lockfile
  ├─ versioned release manifest
  └─ stable.json / beta.json

hayatosc/kuroflare-cloudflare-templete
  ├─ src/index.ts
  ├─ scripts/prepare-build.mjs
  ├─ wrangler.json
  ├─ package.json
  ├─ .dev.vars.example
  └─ Deploy to Cloudflare button
          │
          ▼
利用者のCloudflareアカウント
  ├─ Worker
  ├─ VaultRoom Durable Object namespace
  ├─ UpdateCoordinator Durable Object namespace
  ├─ R2 bucket
  ├─ Workers Builds
  └─ Deploy Hook
```

WorkerのCron Triggerは更新対象を検出した場合だけDeploy HookへPOSTする。

Workers Buildsはテンプレートをcheckoutし、固定bootstrapでruntimeとWranglerを一時ディレクトリへ用意した後、Wranglerを直接実行する。

## 配布物の責務

### 開発用モノレポ

現在の`kuroflare`リポジトリを実装、テスト、バージョン決定の正本とする。

release workflowは、Plugin成果物、Worker runtime、release manifest、build lockfileの生成と公開を担当する。

更新チャネルのpointerは成果物の公開から分離し、検証後の昇格操作だけで変更する。

利用者はこのリポジトリをcloneしてWorkerをデプロイしない。

### Worker runtime

`@kuroflare/worker-runtime`は、Cloudflareへ配置するWorker handler、`VaultRoom`、`UpdateCoordinator`を公開する。

runtime packageには、Worker実行時に必要なコードと静的アセットだけを含める。

runtime packageへdeploy CLI、release manifest resolver、Wrangler wrapperを含めない。

runtime packageはCloudflare上で実行されるアプリケーションコードであり、デプロイ機能を持たない。

`@kuroflare/core`はruntime bundleへ取り込み、runtime packageのproduction dependencyを可能な限りなくす。

runtimeは製品バージョン、Git commit、protocol version、最小対応Pluginバージョンをビルド時定数として持つ。

### Cloudflareデプロイテンプレート

Cloudflareデプロイテンプレートは、このモノレポではなく外部の
[`hayatosc/kuroflare-cloudflare-templete`](https://github.com/hayatosc/kuroflare-cloudflare-templete)
リポジトリが排他的に所有する。このURLは予定する正規リモートを示すものであり、
リモートの作成・pushが完了済みであることは意味しない。

Deploy Buttonはこの外部リポジトリを参照し、Cloudflareは利用者側へ
テンプレートだけをrepository rootとして複製する。

これにより、利用者のリポジトリへモノレポ本体を含めず、テンプレートの
設定、bootstrap、テスト、CIの所有権も外部リポジトリへ限定する。

テンプレートにはresource bindings、Secretの宣言、Wrangler設定、固定bootstrapだけを置く。

```text
kuroflare-cloudflare-templete/
├── src/
│   └── index.ts
├── scripts/
│   └── prepare-build.mjs
├── package.json
├── wrangler.json
├── .dev.vars.example
├── .gitignore
└── README.md
```

`src/index.ts`は、生成される`.kuroflare-build/index.mjs`からWorker handlerとDurable Object classを再公開する固定entry pointとする。

```ts
export { default, UpdateCoordinator, VaultRoom } from '../.kuroflare-build/index.mjs'
```

`wrangler.json`は`src/index.ts`をentry pointとして参照する。

設定には`VAULT_ROOM`、`UPDATE_COORDINATOR`、`SNAPSHOT_BUCKET`、Cron Trigger、Version metadata binding、Durable Object migration、`KUROFLARE_RELEASE_CHANNEL=stable`を定義する。

`.dev.vars.example`には`DEVICE_TOKEN_SECRET`と`ADMIN_TOKEN_SECRET`を宣言し、Deploy ButtonでSecretとして入力させる。

`.kuroflare-build`はgitignore対象とし、利用者リポジトリへ生成物をcommitしない。

テンプレートは`templateProtocolVersion=1`をpackage metadataへ持つ。

### 固定build bootstrap

`scripts/prepare-build.mjs`は、Workers Buildsのbuild commandからだけ実行する小さなNode.js scriptとする。

これは利用者が操作するCLIではない。

引数、対話UI、Cloudflare認証、deployコマンド、Cloudflare API操作は持たせない。

このscriptは次の処理だけを担当する。

1. channel pointerとrelease manifestを取得する。
2. `paused`とbootstrap protocol versionを検査し、配置不可の場合はdeploy commandへ進ませない。
3. releaseが要求するtemplate protocol versionを検査する。
4. build channelとWorker runtime channelが一致することを検査する。
5. URL、応答サイズ、timeout、redirect、JSON schema、Semantic Versioningを検証する。
6. 許可されたruntime package名と完全固定バージョンを確認する。
7. 固定配信元からrelease専用build lockfileを取得し、SHA-256を検証する。
8. lockfile内のruntimeとWranglerのversionとintegrityをrelease manifestと照合する。
9. 生成したpackage metadataと検証済みlockfileを使い、`npm ci`相当で`.kuroflare-build`へinstallする。
10. runtimeを再公開する`.kuroflare-build/index.mjs`を生成する。
11. build記録へ製品バージョン、integrity、Git commitを出力する。

bootstrapはWorkerをデプロイせず、Cloudflare APIも呼ばない。

channel pointerではredirectを拒否する。

GitHub Release assetでは、GitHubの固定CDN hostへ向かう厳格な一段のredirectだけを許可する。

deploy commandは`.kuroflare-build`へinstallされた固定版Wranglerを直接実行する。

```text
Build command:
node scripts/prepare-build.mjs

Deploy command:
.kuroflare-build/node_modules/.bin/wrangler deploy --config .kuroflare-build/wrangler.generated.json
```

通常の利用者はbuild variableを設定しない。

bootstrapは未指定のchannelを`stable`として扱い、テンプレート側のruntime varも`stable`に固定する。

専用canaryで`beta`を使う場合だけ、Workers Buildsの`KUROFLARE_UPDATE_CHANNEL`とruntimeの`KUROFLARE_RELEASE_CHANNEL`を明示的に変更する。

build bootstrapは利用者のテンプレートリポジトリに残り続けるため、bootstrap protocol version 1を長期互換性境界とする。

同様に、resource bindingsとWrangler設定を固定するtemplate protocol version 1を長期互換性境界とする。

将来のrelease manifestは、既存bootstrapが無視できるoptional fieldを追加してよいが、既存fieldの意味を変更しない。

version 1のbootstrapまたはtemplateで扱えないreleaseはstableへ昇格しない。

新しいbinding、Cron、compatibility設定、Durable Object lifecycle changeを必要とするreleaseは、required template protocolを上げて既存templateからの自動更新を拒否する。

`KUROFLARE_UPDATE_CHANNEL`は`stable`と`beta`だけを許可する。

利用者テンプレートはbuild variableとruntime varの両方を`stable`に固定し、専用canary environmentだけを`beta`に固定する。

## 更新メタデータ

### Channel pointer

`stable.json`と`beta.json`は、更新チャネルごとの可変pointerとして公開する。

pointerには運用中に変更する配信制御だけを置く。

```json
{
  "schemaVersion": 1,
  "channel": "stable",
  "productVersion": "1.4.2",
  "rolloutPercentage": 10,
  "blockedSourceVersions": [],
  "paused": false,
  "updatedAt": "2026-07-21T12:00:00Z"
}
```

### Release manifest

バージョン別release manifestは公開後に変更しない。

manifestには成果物、build tool、互換性の情報を置く。

```json
{
  "schemaVersion": 1,
  "bootstrapProtocolVersion": 1,
  "requiredTemplateProtocolVersion": 1,
  "productVersion": "1.4.2",
  "runtimeVersion": "1.4.2",
  "buildCommit": "0123456789abcdef0123456789abcdef01234567",
  "runtimeIntegrity": "sha512-...",
  "runtimeBundleSha256": "...",
  "wranglerVersion": "4.105.0",
  "wranglerIntegrity": "sha512-...",
  "buildLockSha256": "...",
  "protocolVersion": 3,
  "minimumProtocolVersion": 2,
  "minimumPluginVersion": "1.3.0",
  "automaticUpdate": true,
  "rolloutSalt": "1.4.2-1",
  "publishedAt": "2026-07-21T12:00:00Z"
}
```

bootstrapは`productVersion`から固定配信元のmanifest URLを組み立てる。

同じ製品バージョンからGitHub Release上の不変なbuild lockfile URLも組み立てる。

channel pointerやrelease manifestから任意のpackage名または配信先URLを指定できないようにする。

npmの`stable`と`beta` dist-tagは公開状態を人間が確認するために使い、Workers Buildsは必ずmanifest記載の完全固定バージョンをinstallする。

The stable release workflow advances both the `stable` and `latest` npm dist-tags.

`beta` dist-tagとbeta pointerの自動昇格は段階配信workflowを実装した後に有効化する。

build lockfileはruntimeとWranglerの推移的依存関係を含むinstall tree全体を固定する。

利用者リポジトリのlockfileは作成または変更しない。

## バージョンと互換性

### 製品バージョン

初期段階ではPluginとWorkerに同じ製品バージョンを付ける。

同じreleaseでPluginだけ、またはWorkerだけが変更された場合も、両方の製品バージョンを更新する。

独立バージョンへ分離するのは、互換性行列を自動生成して検証できるようになった後とする。

### Protocol version

製品バージョンとprotocol versionは別に管理する。

後方互換な機能追加ではprotocol versionを変更せず、既存のcapability negotiationを使う。

後方互換でない変更では、WorkerとPluginの両方が対応する移行期間を設ける。

Workerは休止中の端末を含む全Pluginバージョンを把握できないため、最近接続した端末だけを見て自動更新可否を判断しない。

自動更新対象のruntimeは、template protocol version 1で公開したすべてのWorker runtimeと、そのruntimeが対応していたPlugin範囲との後方互換性をrelease gateで証明する。

`automaticUpdate`はv1 manifestでは`true`だけを許可する。

後方互換性を証明できないreleaseは、自動更新用のv1 manifestとして公開せず、channel pointerからも参照しない。

手動移行が必要なreleaseを配布する場合は、自動更新用manifestとは別の手順と契約を先に設計する。

### Persistent data migration and backward-compatibility policy

Automatic Worker updates use an expand/migrate/contract policy:

1. **Expand:** add new tables, columns, evidence, and readers without removing or
   reinterpreting state required by the immediately previous stable runtime.
2. **Migrate:** make forward migration idempotent and transactional at each Durable
   Object boundary. A failed migration must leave the object fail-closed and safe to
   retry; it must not accept synchronization against a partially migrated schema.
3. **Verify:** the release gate must migrate a previous-stable fixture forward and
   prove that the candidate preserves vault documents, device registry, operation
   log, snapshots, quarantine/audit evidence, and blob references. It must also prove
   that the immediately previous stable runtime can read the post-migration state.
4. **Contract:** removal of old fields or readers is deferred to a later release,
   after the compatibility window has elapsed and rollback no longer depends on
   them. Destructive rewrites, irreversible data deletion, and migrations that need
   operator choices are never automatic updates.

Code rollback does not roll back Durable Object SQLite, R2, or blob state. A release
that cannot satisfy forward migration and previous-stable read compatibility must be
published only with a separately designed, explicit manual migration; it must not be
referenced by an automatic-update channel pointer. Arbitrary-version downgrade
compatibility is out of scope.

### Workerバージョン情報

Workerへ認証不要の`GET /version`を追加する。

`channel`はruntime packageへ焼き込まず、Wranglerの`KUROFLARE_RELEASE_CHANNEL` varから取得する。

レスポンスは少なくとも次の情報を返す。

```json
{
  "productVersion": "1.4.2",
  "protocolVersion": 3,
  "minimumProtocolVersion": 2,
  "minimumPluginVersion": "1.3.0",
  "channel": "stable",
  "buildCommit": "0123456789abcdef0123456789abcdef01234567",
  "deploymentVersionId": "00000000-0000-0000-0000-000000000000"
}
```

このAPIはSecret、account ID、resource ID、vault IDを返さない。

Pluginは起動時と設定画面表示時にこのAPIを読み、互換、不足、取得不能を区別して表示する。

## Obsidian Pluginの配布

Plugin release workflowはLinux上でlint、型検査、unit test、Worker E2E、Plugin buildを実行する。

workflowは`manifest.json`、`package.json`、`versions.json`のバージョン一致を検査する。

GitHub Releaseには次の成果物を添付する。

- `main.js`
- `manifest.json`
- `versions.json`
- `styles.css`（生成される場合）
- `worker-release.json`
- `build-lock.json`
- `SHA256SUMS`

runtime tarball、release生成script、publisherはworkflow内部の入力であり、公開release assetには含めない。

workflow内部の入力は別の`INPUT_SHA256SUMS`で検証する。

初期配布ではBRATを使い、GitHub ReleasesからPluginを導入して更新する。

Windows実機E2Eと配布前release gateが閉じた後、Obsidian Community Pluginsへ登録する。

Plugin独自の自己更新機能は実装しない。

## Workerの初回デプロイ

利用者はREADMEまたは配布ページにあるDeploy to Cloudflareボタンを押す。

Cloudflareはテンプレートを利用者のGitHubまたはGitLabアカウントへ複製し、Workers Buildsを接続する。

初回buildでも、更新と同じ`prepare-build.mjs`と`wrangler deploy`を使う。

初回deployは次のresourceを作成または接続する。

- `VAULT_ROOM` Durable Object namespace
- `UPDATE_COORDINATOR` Durable Object namespace
- `SNAPSHOT_BUCKET` R2 bucket
- `DEVICE_TOKEN_SECRET`
- `ADMIN_TOKEN_SECRET`

SQLite-backed Durable Object migrationの`v1`には、`VaultRoom`と最小実装の`UpdateCoordinator`を含める。

配布開始後に自動更新用のDurable Object classを追加しなくて済むよう、`UpdateCoordinator`を初回releaseへ含める。

### Deploy Hookの初期設定

Deploy HookはWorkers Buildsの接続後に作成するため、Deploy Buttonの入力時点ではURLが存在しない。

初回デプロイ後に、利用者はCloudflare DashboardでDeploy Hookを一つ作成し、そのURLをWorkerの`DEPLOY_HOOK_URL` Secretへ登録する。

この一度だけの設定はREADMEとPluginの初回診断画面で案内する。

`DEPLOY_HOOK_URL`が未設定でも、Workerは同期機能を提供し、Cronの更新処理を正常終了する。

Hook作成を自動化するために、Cloudflare APIトークンを要求しない。

## Workerの自動更新

### 更新確認

WorkerはCron Triggerを6時間ごとに実行し、`KUROFLARE_RELEASE_CHANNEL`に対応するchannel pointerを取得する。

利用者環境は`stable.json`、専用canaryは`beta.json`を確認する。

channel pointerとrelease manifestには、CDNで再検証できるcache headerとETagを付ける。

```jsonc
{
  "triggers": {
    "crons": ["17 */6 * * *"],
  },
}
```

Cron handlerは次の順序で更新可否を判定する。

1. channel pointerとrelease manifestを取得して検証する。
2. `paused`が`true`の場合は更新しない。
3. 対象製品バージョンが現在の製品バージョン以下であれば更新しない。
4. manifestが`automaticUpdate=true`というv1契約を満たさない場合は、metadata validationを失敗させる。
5. 現在のWorkerが`blockedSourceVersions`に含まれる場合は更新しない。
6. protocolとPluginの互換性条件を満たさない場合は更新しない。
7. `installationId`から決定的なrollout cohortを計算する。
8. 配信対象の場合だけ`UpdateCoordinator`から実行権を取得する。
9. `DEPLOY_HOOK_URL`へPOSTし、build UUIDを記録する。

Vaultごとに更新確認やHook呼び出しを行わない。

### 重複防止と再試行

`UpdateCoordinator`はWorker全体で一つの固定IDを使う。

少なくとも次の状態を保持する。

```text
installationId
lastCheckedAt
lastTriggeredVersion
lastBuildUuid
triggeredAt
failureCount
nextRetryAt
lastObservedRunningVersion
```

同じ対象バージョンを処理中の場合は、後続のCronからDeploy Hookを呼ばない。

新しいWorkerが起動し、実行中の製品バージョンが`lastTriggeredVersion`以上になった場合に更新成功として記録する。

旧Workerが残っている場合はbuild未完了または失敗として扱い、指数バックオフ後に有限回だけ再試行する。

最大試行回数を超えた場合は自動更新を停止し、診断APIとPlugin設定画面へ失敗状態を表示する。

build状態を取得するためのCloudflare APIトークンをWorkerへ追加しない。

### Workers Builds

Deploy Hookから起動されたWorkers Buildsは、build開始時のchannel pointerとrelease manifestを解決する。

bootstrapは完全固定されたruntimeとWranglerを準備し、Wranglerがproduction deploymentを作成する。

`wrangler deploy`は新しいversionを直ちにproductionへ配置するため、利用者環境でのpre-deploy smokeや0パーセントcandidateは作らない。

同じ対象バージョンのbuildが重複しても、immutable release manifestによって同じruntime bundleが配置される。

DashboardのRetryまたはHookの手動POSTも同じbuild経路を使い、利用者リポジトリやlockfileを変更しない。

手動buildはrollout cohortとsource version判定を経由しないため、通常の更新手段には使わない。

bootstrapは`paused`を必ず検査するが、手動buildの実行者は対象runtimeとの互換性を事前に確認する。

## 段階配信

### Stableの切り替え

`stable.json`の切り替え前には、新しいHook発行を止めるため現在のpointerを`paused=true`にする。

release workflowは現在のpointerを`paused=true`にし、Workers Buildsの最大build timeoutと余裕時間が経過するまで待つ。

待機中は新しいHook呼び出しを開始しない。

待機後に新しい`productVersion`を`paused=true`のまま設定し、npm dist-tagとGitHub Releaseが同じ固定成果物を指すことを再確認する。

最後に`paused=false`、`rolloutPercentage=1`として配信を開始する。

この待機は実行中buildを減らすためのbest-effortなdrainであり、queued buildがなくなったことは保証しない。

Deploy Hookで作られたqueued buildは、待機後に開始して新しいchannel pointerを解決する場合がある。

そのbuildは新しいrollout cohort判定を経由していないため、`rolloutPercentage`は厳密な配信上限にならない。

したがって、`automaticUpdate=true`にできるのは、template protocol version 1で公開したすべてのruntimeから安全に更新できるreleaseだけとする。

`blockedSourceVersions`とcohort判定は新規Hookの抑制には使えるが、安全性を支える唯一の境界にはしない。

### Rollout

cohortは`installationId`と不変な`rolloutSalt`のhashで決める。

stable昇格後は1、10、50、100パーセントの順に配信率を上げる。

この割合は新しくDeploy Hookを発行するインストールの割合であり、queued buildを含む実配置数の厳密な割合ではない。

各段階では最低観測時間を置き、canaryと対象cohortのWorker error、同期E2E、build失敗率を確認する。

問題を検出した場合は`paused=true`にし、新しいHook呼び出しを止める。

すでに実行中のbuildはdeployまで進む可能性があるため、停止完了の判定にはbuild timeoutと余裕時間の経過を必要とする。

manifest変更だけで配置済みWorkerを戻すことはできない。

修正版を新しいpatch versionとして発行するか、Cloudflare deployment historyから直前versionを選択する。

## Canaryとロールバック

### Canary

`wrangler deploy`を採用する代わりに、stable昇格前の専用canary installationを必須とする。

beta runtimeをcanaryへ100パーセント配置し、実Cloudflare resourceと実データ相当のfixtureを使って検証する。

canaryでは次を確認する。

- Workerの起動と`GET /version`
- `VaultRoom`と`UpdateCoordinator`のSQLite処理
- snapshotとbinaryの保存、復元
- Windows版Obsidianとの接続
- 二台のPlugin間の同期
- 直前stableからのschema migration
- 更新後の再接続と未送信outboxの継続

利用者環境ではpre-deploy smokeを行わないため、canaryを通過していない成果物をstableへ向けない。

### コードのロールバック

Cloudflare deployment historyから、直前のWorker versionへ戻す手順を文書化する。

Wranglerのversion messageには製品バージョン、runtime integrity、Git commitを記録する。

自動ロールバックは初期段階では実装しない。

### データのロールバック

Cloudflare Worker versionはDurable Object、R2、SQLiteの状態を含まない。

コードを戻してもdata migrationは戻らないため、schema migrationはexpand、移行、読み取り停止、削除の複数releaseへ分ける。

少なくとも直前stable runtimeがmigration後のデータを読めることをrelease gateで検証する。

破壊的migration、Durable Object classの削除、rename、transferを含むreleaseは自動更新対象にしない。

## セキュリティ境界

PluginとWorkerには`Workers Scripts Write`権限を持つCloudflare APIトークンを保存しない。

Workerの更新権限はDeploy Hook URLへ限定する。

`DEPLOY_HOOK_URL`はWorker Secretとして保存し、Plugin、利用者リポジトリ、API応答、ログへ渡さない。

Hook URLが漏えいした場合に備え、削除、再作成、Secret更新のrotation手順を用意する。

Workers BuildsのdeployはCloudflareが管理するbuild tokenで実行する。

npm packageの公開にはTrusted Publishingとprovenanceを使い、長期npm publish tokenをGitHub Secretsへ保存しない。

`@kuroflare/worker-runtime`のnpm Trusted Publisherは、このrepositoryと`release` environmentへ固定する。

Trusted Publishingは`npm dist-tag`を認証しないため、`stable`と`latest`の昇格だけはpackage限定・read/write・2FA bypass・短期有効期限のgranular tokenを使う。

このtokenはprotected `release` environmentへ`NPM_DIST_TAG_TOKEN`として保存し、各release後に失効させる。

PackageのPublishing accessは「Require 2FA or granular token with bypass 2FA」に保つ。「Require 2FA and disallow tokens」はbypass tokenも拒否するため、tokenlessなdist-tag昇格へ移行するまで選択しない。

The publisher verifies the tarball integrity, both `stable` and `latest` dist-tags, and SLSA v1 provenance metadata after publication and on retries.

GitHub Releaseはrepositoryのrelease immutabilityを有効にし、draftへ全assetを添付して検証してから公開する。

publisherは公開前にimmutable releases APIを確認する。

この確認には、protected `release` environmentへ保存したAdministration read権限だけのfine-grained tokenを`RELEASE_ADMIN_TOKEN`として使う。

release workflowの通常の公開操作には、job単位の`GITHUB_TOKEN`と`contents: write`を使う。

release workflowはruntime bundleのSHA-256を計算し、GitHub Releaseへchecksumを添付する。

bootstrapはnpm registryのpackage integrityとrelease manifestのbundle hashを検証する。

`DEVICE_TOKEN_SECRET`と`ADMIN_TOKEN_SECRET`はWorker更新で変更しない。

## CIとリリース手順

### Pull request gate

配布関連の変更を含むPull Requestでは、既存CIに次の検査を追加する。

- Worker runtimeの単独bundle build
- runtime packageのproduction dependency検査
- bootstrap protocol version 1のcontract test
- template protocol version 1のcontract test
- build channelとruntime channelの一致検査
- channel pointerとrelease manifestのschema test
- manifest URL、許可host、timeout、redirect、応答サイズのtest
- manifest記載の完全固定版とintegrityを使う準備test
- build lockfileの全依存固定、SHA-256、manifest整合性test
- `.kuroflare-build`以外を変更しないtest
- deploy templateを使ったMiniflare smoke test
- `GET /version`のschema contract test
- PluginとWorkerの互換性判定test
- UpdateCoordinatorの重複抑止、指数バックオフ、最大試行回数のtest
- rollout cohortの決定性、停止、source version除外のtest
- 直前stableからのSQLite migration test
- migration後データを直前stableが読めることのrollback compatibility test
- release manifestとruntime bundle hashの一致検査

### Release candidate

The current workflow accepts only stable `x.y.z` tags, publishes an immutable GitHub Release, and then advances both npm `stable` and `latest` dist-tags.

コミット済みの`stable.json`と`beta.json`は、初回releaseと実Cloudflare検証が完了するまで`paused=true`、`rolloutPercentage=0`に保つ。

mainへのmerge後にrelease candidateを`beta`チャネルへ公開する処理はPhase 7で追加する。

release workflowはruntimeとWranglerの全依存を固定したbuild lockfileを生成し、GitHub Releaseへ添付する。

beta公開時点では`stable` dist-tagと`stable.json`を変更しない。

build variableを`KUROFLARE_UPDATE_CHANNEL=beta`、runtime varを`KUROFLARE_RELEASE_CHANNEL=beta`に固定した専用canaryへ配置し、実CloudflareとWindows版ObsidianのE2Eを実行する。

### Stableへの昇格

stableへの昇格では、既存beta成果物を再ビルドしない。

release workflowはnpm package、GitHub Release、Plugin manifest、release manifest、build lockfileが同じ製品バージョン、bundle hash、依存treeを指すことを検査する。

その後、現在のstableを停止してbuildをdrainし、新しいpointerを1パーセントから開始する。

各配信段階では成果物を変更せず、`rolloutPercentage`だけを更新する。

stable成果物は公開後に差し替えない。

修正が必要な場合は新しいpatch versionを発行する。

## Human-owned release gates

モノレポ内のversion contract、公開Worker runtime、immutable release、channel pointer、UpdateCoordinator、protocol contract、release workflowは実装済みである。固定bootstrapとDeploy Button用テンプレートは、外部`kuroflare-cloudflare-templete`ローカルリポジトリへ抽出済みである。

Phase 7の段階配信ツールも実装済みである。`scripts/release/worker.ts`のchannel pointer操作コマンド（pause / promote / rollout / block / unblock、成果物を再ビルドせずpointerだけを検証付きで変更）、`workflow_dispatch`駆動の昇格workflow（`.github/workflows/release-worker-promote.yml`）、`docs/deployment.md`§7の運用手順（stable昇格・緊急停止・Deploy Hook rotation・code rollback）を含む。ただし実際のbeta→stable自動昇格は、下記の公開repository・npm公開・canary検証が揃うまで有効化しない。

独自deployer packageとdeploy CLIは存在せず、今後も追加しない。

公開GitHub repositoryは`https://github.com/hayatosc/kuroflare`に作成済みであり、local repositoryの`origin`もこのrepositoryを参照する。

The npm registry now contains the bootstrap `@kuroflare/worker-runtime@0.0.0` under the `bootstrap` tag (with npm's mandatory `latest` tag); the intended `0.1.0` release remains unpublished.

Repository automation cannot complete or attest the checklist below. Do not present
the Deploy Button as a supported installation path and do not advance either channel
from `paused=true`, `rolloutPercentage=0` until every item is recorded against the
exact release version:

- [x] **License:** MIT license files, package metadata, release notices, and
      first-party credit fields consistently identify `hayatosc`.
- [x] **GitHub publication:** create the public distribution repository at
      `https://github.com/hayatosc/kuroflare`, configure its remote, and publish
      `main`.
- [x] **GitHub release controls:** enable release immutability before the first
      release, create a protected `release` environment with required reviewers,
      and store an Administration-read-only fine-grained token as
      `RELEASE_ADMIN_TOKEN`.
- [x] **Cloudflare template publication:** publish the canonical repository at
      `https://github.com/hayatosc/kuroflare-cloudflare-templete`, push commit
      `0297374467e797f5690ca36ab8ee2d99ce270153`, and point its Deploy Button at
      that external repository.
- [ ] **npm:** configure the exact GitHub organization/repository/workflow and
      `release` environment as the Trusted Publisher for `@kuroflare/worker-runtime`;
      store a short-lived package-scoped token as `NPM_DIST_TAG_TOKEN`
      for the final `stable` and `latest` dist-tag promotion; keep Publishing access compatible
      with granular tokens that bypass 2FA.
- [ ] **First release:** publish the intended `x.y.z`; verify npm provenance and
      integrity, GitHub Release assets and checksums, version alignment, and immutable
      release state.
- [ ] **Cloudflare:** configure the production account, R2 lifecycle policy, required
      secrets, dedicated canary, Workers Builds, and Deploy Hook. Deploy from the Deploy
      Button and verify the pinned runtime plus one automatic update on real Cloudflare.
- [ ] **Windows and real devices:** install and update the Plugin through BRAT on
      Windows Obsidian; verify initial setup, two physical-device concurrent editing and
      awareness, offline convergence, binary transfer, Plugin update, and reconnection
      after a Worker update. Use backed-up disposable vaults.
- [ ] **Production operations:** exercise quarantine inspect/discard/force-apply,
      local-store export/rebuild, alert observation, Deploy Hook rotation, emergency
      pause, code rollback, and the documented migration boundary without using a
      personal vault.
- [ ] **Promotion:** point the channel at the validated immutable version while it is
      paused at zero percent, then perform the documented 1/10/50/100 percent staged
      promotion with observation and build-drain records.

The remaining gates require account ownership, external configuration, or
physical/manual environments. They must remain human-owned even when repository
automation prepares inputs or validates their schemas.

## 実装フェーズ

### Phase 1：バージョン契約

1. 製品バージョンの単一の正本を決める。
2. Plugin manifest、package metadata、Worker metadataを同期するversion scriptを追加する。
3. `GET /version`とPlugin側の互換性判定を実装する。
4. version contract testを追加する。

完了条件は、Pluginが接続先Workerの製品バージョンと互換性状態を表示できることである。

### Phase 2：Plugin release

1. Linux上でPluginをビルドするrelease workflowを追加する。
2. GitHub Release assetsとchecksumを生成する。
3. BRATによる導入と更新をWindows版Obsidianで確認する。
4. Community Plugins登録までの手順を文書化する。

完了条件は、ソースをcloneせずにPluginを導入して更新できることである。

### Phase 3：Worker runtime

1. Worker runtimeの公開entry pointを定義する。
2. `VaultRoom`と最小`UpdateCoordinator`を公開する。
3. `@kuroflare/core`を含む単独bundleを生成する。
4. packageの公開対象ファイルとproduction dependencyを制限する。
5. Trusted Publishingでstable packageを公開し、provenanceとregistry integrityを検証する。
6. package単体のMiniflare testを追加する。

完了条件は、モノレポ外の空のプロジェクトが公開packageだけでWorkerを起動できることである。

### Phase 4：固定bootstrap

1. channel pointerとrelease manifestのschemaを定義する。
2. `prepare-build.mjs`を実装する。
3. releaseごとのbuild lockfileを生成する。
4. lockfileのSHA-256、package integrity、bundle hashを検証する。
5. 検証済みlockfileからruntimeとWranglerを`.kuroflare-build`へinstallする。
6. 生成entry pointからruntimeを起動するtestを追加する。
7. bootstrap protocolとtemplate protocol version 1の後方互換規則を文書化する。

完了条件は、固定manifestからWorkerのdeploy準備を再現でき、利用者リポジトリのtracked fileを変更しないことである。

### Phase 5：Deploy Button

1. 外部`kuroflare-cloudflare-templete`リポジトリへテンプレートを抽出する。
2. Wrangler設定へDurable Object、R2、Secret、Cron、Version metadataを定義する。
3. template protocol versionを定義する。
4. Workers Buildsへstable channelのbuild variable、build command、deploy commandを設定する。
5. 外部リポジトリを参照するDeploy Buttonから新規Cloudflare accountへ配置する。
6. Deploy Hook作成と`DEPLOY_HOOK_URL`登録の手順を追加する。
7. setup token発行からPlugin接続までを確認する。

完了条件は、利用者がモノレポをcloneせずにWorkerを初回配置できることである。

### Phase 6：自動更新

1. UpdateCoordinatorへinstallation IDと更新状態を追加する。
2. Cronによるmanifest取得とcohort判定を実装する。
3. 互換性、停止、source versionによる更新判定を実装する。
4. Deploy Hook呼び出しとbuild UUID記録を実装する。
5. 重複抑止、指数バックオフ、最大試行回数を実装する。
6. `DEPLOY_HOOK_URL`未設定時と更新失敗時の診断を追加する。
7. 実Cloudflareで自動更新E2Eを実行する。

完了条件は、対象cohortのWorkerだけがHookを呼び、固定runtimeを`wrangler deploy`で更新できることである。

### Phase 7：段階配信

1. betaからstableへ成果物を再ビルドせず昇格するworkflowを追加する。
2. pause、build drain、pointer切り替えを自動化する。
3. 1、10、50、100パーセントの配信率と最低観測時間を定義する。
4. 緊急停止、修正版release、手動rollbackを実Cloudflareで確認する。
5. Deploy Hookのrotation手順を文書化する。

完了条件は、canary、段階配信、停止、修正版への更新、コードrollbackを一巡して確認できることである。

## 受け入れ条件

- PluginをGitHub Releaseから導入し、既存Vaultの設定を保ったまま更新できる。
- Deploy ButtonがDurable ObjectとR2を用意し、必須Secretをリポジトリへ保存しない。
- 初回デプロイとDeploy Hook設定後、利用者がGitHubを操作せずにWorkerを自動更新できる。
- 独自deployer packageまたはdeploy CLIを必要としない。
- buildはmanifestとbuild lockfileに記載された固定runtime、Wrangler、推移的依存関係だけを使う。
- 利用者リポジトリのpackage metadataとlockfileを更新しない。
- 同じ製品バージョンは同じruntime bundle hashを持つ。
- rollout対象外または`paused`中のWorkerはDeploy Hookを呼ばない。
- rollout割合がqueued buildを含む実配置数の厳密な上限ではないことを運用手順へ明記する。
- 同じ対象バージョンのHook呼び出しを重複させない。
- build失敗時は有限回の再試行後に停止する。
- stableへ向ける前に専用canaryの実Cloudflare E2Eを通過する。
- Worker更新前のVault、device registry、op log、snapshot、blobが更新後も利用できる。
- 更新中に同期接続が切断されても、Pluginが再接続して未送信outboxを継続できる。
- 非互換なPluginとWorkerの組み合わせは同期を開始せず、必要な更新を表示する。
- Cloudflare APIトークン、setup token、device token、Deploy Hook URLをログまたはGitHubへ出力しない。
- 直前stableへのコードrollback手順を実Cloudflareで確認する。

## 対象外

- Kuroflare運営者が利用者のVaultを収容する共有SaaS
- 独自のCloudflare deployer package
- Kuroflare専用のdeploy CLI
- `wrangler versions upload`を使った0パーセントcandidateとpre-deploy smoke
- PluginまたはWorkerがCloudflare APIトークンでWorker scriptを直接更新する仕組み
- 利用者によるforkの上流同期を前提とする更新方式
- Deploy Hookの作成とSecret登録の完全自動化
- 後方互換性を証明できないprotocol変更やdata migrationの無人更新
- migrationを伴う任意versionへのdowngrade
- Obsidian mobileへの配布保証
- Worker resourceのaccount間移行

## 参照資料

- [Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
- [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- [Workers Builds build image](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)
- [Workers Builds Deploy Hooks](https://developers.cloudflare.com/workers/ci-cd/builds/deploy-hooks/)
- [Workers versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)
- [Workers rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
- [Durable Object class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
- [Preventing changes to GitHub Releases](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/prevent-release-changes)
- [GitHub immutable releases REST API](https://docs.github.com/en/rest/repos/repos#check-if-immutable-releases-are-enabled-for-a-repository)
- [Obsidian plugin submission](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin)
- [BRAT](https://github.com/TfTHacker/obsidian42-brat)
- [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox)
