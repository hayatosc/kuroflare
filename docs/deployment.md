# Deploying Kuroflare

This document explains how to deploy the Kuroflare Worker to Cloudflare and
connect the Obsidian plugin to it today, and defines a stable contract so a
separate deployment project can be built on top of `@kuroflare/worker` later.

## 1. Overview

Kuroflare is a local-first sync system for Obsidian vaults. Three pieces are
involved:

- **Obsidian plugin** (`packages/obsidian-plugin`) — runs inside Obsidian,
  holds the local Yjs state, and talks to the Worker over WebSocket/HTTP.
- **Cloudflare Worker** (`packages/worker`) — a Hono app (`src/index.ts`,
  `src/runtime.ts`) that routes vault-scoped requests to a per-vault
  **Durable Object** (`VaultRoom`), which owns the vault's SQLite-backed
  state (op log, device registry, checkpoints). The latest recoverable document
  is the latest authoritative, verified, healthy R2 snapshot plus later SQLite op-log rows.
- **R2 bucket** — stores Yjs snapshots and blob (attachment) content written
  by the Durable Object. R2 bytes are immutable storage, not standalone authority;
  SQLite pointer and snapshot-health evidence are required for automatic restore.

Normal Durable Object execution-instance eviction is recoverable because SQLite
storage survives the instance. Complete SQLite loss is a disaster/manual-recovery
case outside the normal guarantee and may lose acknowledged updates newer than the
last checkpoint. The nominal 128-operation and 30-second checkpoint triggers are
best-effort scheduling signals, not a hard recovery-point bound.

For personal use, all of this is deployed as a single Worker + one Durable
Object namespace + one R2 bucket, driven by `wrangler` from
`packages/worker`.

## 2. Deployment contract

This is the fixed set of bindings, secrets, and routes that any deployment of
`@kuroflare/worker` must provide. A future separate deployment project (its
own `wrangler.toml`/CI, consuming this worker package) should reproduce this
contract rather than reinvent it.

### Bindings (from `packages/worker/wrangler.toml`)

| Binding           | Type           | Name                         | Notes                                                                                                                                                                                                                                                          |
| ----------------- | -------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VAULT_ROOM`      | Durable Object | class `VaultRoom`            | Requires the SQLite-backed DO migration below.                                                                                                                                                                                                                 |
| `SNAPSHOT_BUCKET` | R2 bucket      | bucket `kuroflare-snapshots` | Stores Yjs snapshots and blobs. Optional at the type level (`R2BucketBinding \| undefined` in `WorkerEnv`) so tests can omit it, but checkpointing, snapshot fetch, and blob routes all return `503` without it — treat it as required in any real deployment. |

Durable Object migration (required, exactly as declared today):

```toml
[[migrations]]
tag = "v1"
new_sqlite_classes = ["VaultRoom"]
```

`compatibility_date` currently pinned in `packages/worker/wrangler.toml`:
`2026-06-12`. A downstream deploy project should track (or exceed) this date.

### Secrets (`WorkerEnv`, `packages/worker/src/runtime/types.ts`)

| Var                   | Required?                | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DEVICE_TOKEN_SECRET` | **Effectively required** | HS256 signing/verification secret for device access tokens. It is typed optional, but `VaultRoom.authorizeHello` fails closed: once the Durable Object's SQLite storage exists (i.e. any real, non-fresh vault), a missing secret causes every WebSocket `hello` to be rejected with `auth-reject:missing-secret`. HTTP admin/auth routes (`/setup/exchange`, `/auth/refresh`, `/devices/:id/revoke`, `/admin/*`, snapshot/blob routes) all return `503` when this secret is absent. |
| `ADMIN_TOKEN_SECRET`  | **Effectively required** | Gates the operator-only `POST /admin/setup-tokens` and `POST /admin/snapshots/seed` routes (see §4). It is the **only** mechanism today for seeding a setup token, so in practice it must be set to onboard any device. Typed optional so tests can omit it, but both routes return `503 server/degraded` when it is absent, and reject with `403` on a header mismatch (constant-time compared). Treat it as a shared operator secret, not an end-user-facing credential.           |

### Vars (`WorkerEnv`, `packages/worker/src/runtime/types.ts`)

| Var                                  | Required? | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SNAPSHOT_RETENTION_MIN_GENERATIONS` | Optional  | Overrides the minimum number of snapshot generations kept per doc during retention cleanup (code default: 3, `packages/worker/src/runtime/constants.ts`). Set as a plain `wrangler.toml` `[vars]` entry (see the commented example there), not a secret. Must be a positive integer string; if set to anything else, retention cleanup fails closed (skips cleanup and logs `snapshot-retention-invalid-config`) rather than silently falling back to the default — fix the value and the next checkpoint alarm retries. |

### Production routes (`packages/worker/src/runtime.ts`, `src/runtime/app.ts`)

| Method + path                                                                                           | Auth                                                                 | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /ws/:vaultId`                                                                                      | WebSocket subprotocol/bearer token, validated in DO `hello` handling | Main sync transport (Yjs updates, sync-request/response).                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `POST /setup/exchange`                                                                                  | Setup token (body)                                                   | Exchanges a one-time setup token for a device access + refresh token pair.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `POST /auth/refresh`                                                                                    | Refresh token (body)                                                 | Rotates the device's refresh token and mints a new access token.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `POST /devices/:deviceId/revoke`                                                                        | Bearer device token, scope `sync:write`                              | Revokes a device.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `GET /admin/quarantine`, `GET /admin/quarantine/:id`                                                    | Bearer device token, scope `sync:write`                              | Inspect quarantined (rejected) updates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GET /admin/retention`                                                                                  | Bearer device token, scope `sync:write`                              | Inspect `snapshot_retention_events`, newest first. Paginated: `limit` (1-200, default 50) and `cursor` (the `id` of the previous page's last item) query params; response is `{ items, nextCursor? }`, and an invalid `limit`/`cursor` returns `400 request/invalid`.                                                                                                                                                                                                                                    |
| `POST /admin/quarantine/:id/{discard,force-apply}`                                                      | Bearer device token, scope `sync:write`                              | Resolve a quarantined update.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `GET /vaults/:vaultId/meta/latest`, `GET /vaults/:vaultId/files/:ydocId/latest`                         | Bearer device token, scope `sync:read`                               | Fetch the latest hydrated snapshot for a doc.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `PUT /vaults/:vaultId/meta/snapshot`, `PUT /vaults/:vaultId/files/:ydocId/snapshot`                     | Bearer device token                                                  | Import a snapshot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `POST /blobs/head`, `POST /blobs/upload-url`, `GET/PUT /blobs/:hash`, `GET/PUT /blob-manifests/*`       | Bearer device token, scope `blob:read`/`blob:write`                  | Attachment (blob) storage. Blobs at or above `BLOB_MULTIPART_THRESHOLD_BYTES` (16 MiB), or any upload the client explicitly asks for with `multipart: true`, must use the multipart flow below instead of a single `PUT /blobs/:hash`: `/blobs/upload-url` rejects with `413 blob-upload-url:multipart-required` if the client doesn't ask for multipart in that case, and `PUT /blobs/:hash` rejects with `413 blob-put:use-multipart` once size exceeds `BLOB_SINGLE_PUT_MAX_BYTES` (16 MiB − 1 byte). |
| `PUT /blobs/:hash/parts/:uploadId/:partNumber`, `POST /blobs/:hash/complete`, `POST /blobs/:hash/abort` | Bearer device token, scope `blob:write`                              | Multipart blob upload: upload each part returned by `/blobs/upload-url`, then complete or abort the session. Implemented end-to-end (create/part/complete/abort) on both worker and client and covered by real-R2 e2e, but the current client-side chunking (max 1 MiB per chunk) never produces a single blob at or above the 16 MiB threshold, so this path is not exercised by real traffic yet — see `docs/implementation-status.md`.                                                                |
| `POST /admin/setup-tokens`                                                                              | `x-kuroflare-admin-secret` header == `ADMIN_TOKEN_SECRET`            | Issues a one-time setup token for device onboarding; see §4. `503` if `ADMIN_TOKEN_SECRET` unset, `403` on header mismatch.                                                                                                                                                                                                                                                                                                                                                                              |
| `POST /admin/snapshots/seed`                                                                            | `x-kuroflare-admin-secret` header == `ADMIN_TOKEN_SECRET`            | Test/fixture-only: seeds a doc's snapshot pointer directly from a raw Yjs update, bypassing the normal sync/checkpoint path. Not part of the normal operator workflow. `503` if `ADMIN_TOKEN_SECRET` unset, `403` on header mismatch.                                                                                                                                                                                                                                                                    |

CORS is wide open (`origin: '*'`) at the top-level Hono app
(`packages/worker/src/runtime/app.ts`); a downstream deployment that wants to
restrict origins must override this.

## 3. First deployment (personal use)

Run everything from `packages/worker`.

1. **Authenticate wrangler** (one-time):

   ```bash
   pnpm --filter @kuroflare/worker exec wrangler login
   ```

2. **Create the R2 bucket** named in `wrangler.toml`:

   ```bash
   pnpm --filter @kuroflare/worker exec wrangler r2 bucket create kuroflare-snapshots
   ```

3. **Apply the R2 lifecycle rule for stray multipart uploads.** This is bucket
   config, not part of `wrangler.toml` (see the comment above
   `[[r2_buckets]]` in `packages/worker/wrangler.toml`), so it must be applied
   out of band once per environment; it aborts incomplete multipart uploads
   (§2) after ~24h even if the Durable Object's own best-effort sweep never
   runs for an otherwise-idle vault:

   ```bash
   pnpm --filter @kuroflare/worker exec wrangler r2 bucket lifecycle add \
     kuroflare-snapshots abort-incomplete-multipart --abort-multipart-days 1
   ```

4. **Set secrets** (replace the placeholder values — do not reuse these
   examples as real secrets):

   ```bash
   pnpm --filter @kuroflare/worker exec wrangler secret put DEVICE_TOKEN_SECRET
   # paste a long random value, e.g. from `openssl rand -hex 32`

   pnpm --filter @kuroflare/worker exec wrangler secret put ADMIN_TOKEN_SECRET
   # paste a second, independent long random value
   ```

5. **Deploy**:

   ```bash
   pnpm --filter @kuroflare/worker exec wrangler deploy
   ```

   `wrangler` bundles `src/index.ts` directly (Hono `default` export plus the
   `VaultRoom` Durable Object class); no separate build step is required for
   deployment. The Durable Object SQLite migration (`tag = "v1"`) applies
   automatically on first deploy.

6. **Smoke-check** the deployed Worker responds (any vault ID; expect a
   WebSocket-upgrade-required response, not a 5xx):

   ```bash
   curl -i "https://<your-worker>.workers.dev/ws/smoke-check-vault"
   # expect: HTTP/1.1 426 Expected WebSocket upgrade
   ```

## 4. Device onboarding

There is currently no self-service "invite a device" UI. Onboarding a device
is an operator action run from the command line, using the admin route
`POST /admin/setup-tokens`, gated by the `ADMIN_TOKEN_SECRET` you set above.
Do not expose this secret or route to end users.

1. **Generate a random setup token locally** (never reuse across vaults or
   let it leave your machine other than to your own device):

   ```bash
   SETUP_TOKEN=$(openssl rand -hex 32)
   ```

2. **Register it with the Worker** for a chosen `vaultId` (pick any stable
   string identifying the vault; it becomes the Durable Object name):

   ```bash
   curl -s -X POST "https://<your-worker>.workers.dev/admin/setup-tokens" \
     -H "content-type: application/json" \
     -H "x-kuroflare-admin-secret: <your-ADMIN_TOKEN_SECRET>" \
     -d '{"vaultId":"<your-vault-id>","setupToken":"'"$SETUP_TOKEN"'"}'
   ```

   Request body fields (`AdminSetupTokenIssueRequestSchema`,
   `packages/worker/src/runtime/types.ts`): `vaultId` (required), `setupToken`
   (required, non-empty string), `expiresInMs` (optional, defaults to
   10 minutes / `10 * 60 * 1000`, capped at 24h). The server never stores the
   raw token — only its SHA-256 hash — and the token is single-use (consumed
   by `/setup/exchange`).

3. **Choose the bootstrap intent and compose the setup URI** the plugin understands
   (`packages/core/src/sync/setup.ts`, `parseSetupUri`):

   ```
   kuroflare://setup?endpoint=<url-encoded-worker-origin>&vaultId=<vault-id>&setupToken=<setup-token>&bootstrapMode=<new-vault-or-join-existing>
   ```

   Example:

   ```
   kuroflare://setup?endpoint=https%3A%2F%2Fyour-worker.workers.dev&vaultId=my-vault&setupToken=<the-token-from-step-1>&bootstrapMode=join-existing
   ```

   Use `new-vault` only when this is the first device and the Worker has no
   persisted documents for the vault. Use `join-existing` when attaching a
   device to an existing remote vault. The plugin rejects a setup response
   whose bootstrap mode does not match this explicit intent.

4. **Paste the URI into the plugin's settings tab** ("Setup URI" field,
   `packages/obsidian-plugin/src/editor/settings-tab.ts`) and click Apply, or
   open the equivalent Obsidian deep link by replacing the scheme and action:

   ```
   obsidian://kuroflare-setup?endpoint=<url-encoded-worker-origin>&vaultId=<vault-id>&setupToken=<setup-token>&bootstrapMode=<new-vault-or-join-existing>
   ```

   On an unregistered device with no setup already in progress, both paths
   validate the fields and show the endpoint, vault ID, and bootstrap mode in a
   confirmation dialog before writing settings or starting setup. The dialog
   never displays the setup token. If a legacy URI omits `bootstrapMode`, the
   plugin uses the bootstrap mode currently selected in settings and shows that
   effective value for confirmation. A registered device or a device already
   running setup rejects another URI without opening the dialog; an explicit
   local registration-reset flow is not implemented. Alternatively, fill the
   Worker endpoint, Vault ID, setup token, and bootstrap mode fields manually.

Setup tokens expire quickly (10 minutes by default) — generate and register
one right before pasting it into the plugin, not in advance.

## 5. Plugin build and install

From the repository root, for each vault you want to sync, run the
`install:vault` script (`packages/obsidian-plugin/scripts/install-to-vault.ts`).
It builds the plugin (`NODE_ENV=production tsdown && mv main.cjs main.js`,
same as the plain `build` script) and copies `manifest.json` and `main.js`
(plus `styles.css` if the build produced one) into
`<vault>/.obsidian/plugins/kuroflare/`, overwriting any previous install. It
fails fast if the target path doesn't look like a vault (no `.obsidian/`
directory):

```bash
pnpm --filter @kuroflare/obsidian-plugin install:vault /path/to/vault
# or: KUROFLARE_VAULT_PATH=/path/to/vault pnpm --filter @kuroflare/obsidian-plugin install:vault
```

Enable `Kuroflare` from Obsidian's Community plugins settings, open the
plugin's settings tab, and follow §4 to connect it to your deployed Worker.

## 6. Operational caveats

- **Production Cloudflare deploy is so-far unverified.** The project's e2e
  suites exercise the Worker against `wrangler dev`/miniflare and
  `@cloudflare/vitest-pool-workers` (real `workerd`), not an actual deployed
  Cloudflare account. Treat the first real deploy as a trial: watch logs
  (`wrangler tail`) and confirm sync end-to-end before trusting it with real
  notes.
- **Large attachments use multipart upload, but it's untested by real
  traffic.** Blobs at or above `BLOB_MULTIPART_THRESHOLD_BYTES` (16 MiB,
  `packages/worker/src/runtime/constants.ts`) go through the multipart
  create/part/complete/abort flow (§2), which is implemented and covered by
  real-R2 e2e tests. In practice the plugin's client-side chunking caps each
  chunk at 1 MiB and never assembles a single blob that large, so this path
  has not yet seen real traffic — treat it as less battle-tested than the
  single-PUT path until that changes.
- **Mobile is untested.** The plugin manifest does not set
  `isDesktopOnly`, but `spec.md` documents an open, unresolved spike
  question about whether Obsidian mobile's WebView supports the IndexedDB
  directory API (`indexedDB.databases()`) the plugin's schema-startup gate
  relies on. Assume desktop-only until that spike is done.
- **Use a backed-up or disposable vault first.** This is an early sync
  implementation; validate it against a vault you can afford to lose or
  restore before pointing it at your primary notes.
- **Setup tokens expire fast (10 minutes by default).** Issue one
  immediately before pasting it into the plugin (§4), not ahead of time.

### Alerting on structured log events

There is no built-in notification/alerting integration (e.g. email, Slack,
PagerDuty) — this is deliberately out of scope; wire up whichever of your
existing Cloudflare-native options below fits your operational setup instead
of adding one to the Worker itself.

The Worker emits single-line structured JSON log entries via `logEvent`
(`packages/worker/src/runtime/utils.ts`) for checkpoint and retention
lifecycle events, notably `checkpoint-failed`, `snapshot-retention-delete-failed`,
and `snapshot-retention-invalid-config` (emitted when
`SNAPSHOT_RETENTION_MIN_GENERATIONS` is set to an invalid value; see the Vars
table in §2). Each entry has an `event` field you can filter on.

- **`wrangler tail`** streams these live during manual operation — the
  quickest way to watch a deploy, per the first bullet above.
- **Workers Logs** (enabled per Worker in the Cloudflare dashboard, or via
  `[observability]` in `wrangler.toml`) retains and lets you query these log
  lines in the dashboard without a persistent `tail` session.
- **Logpush** (Cloudflare dashboard → your account → Logpush, or the
  `wrangler.toml` `[[logpush]]`/API config) can ship Workers Trace Events —
  including `console.log` output, so the `logEvent` JSON lines above — to an
  external destination (e.g. an object storage bucket, Datadog, Splunk) for
  alerting rules built in that destination. This is the recommended path for
  anything beyond ad hoc `wrangler tail` watching: filter the shipped logs on
  `event` values ending in `-failed` or `-invalid-config` and alert on any
  occurrence.
- Cloudflare **Notifications** (dashboard → Notifications) cover
  account/zone-level alerts (e.g. Workers CPU/error-rate thresholds), not
  arbitrary log-line content; they're a coarser complement to Logpush-based
  alerting on the specific `logEvent` names above, not a replacement for it.

## 7. Staged rollout and channel promotion

Worker auto-updates are driven by two committed channel pointers,
`distribution/channels/stable.json` and `beta.json`, served over
`raw.githubusercontent.com`. A deployed Worker's Cron reads its channel's pointer
and issues a Deploy Hook only when eligible (see
[distribution-pipeline.md](plans/distribution-pipeline.md)). Promotion **only edits a
pointer** — it never rebuilds or republishes a release, because the immutable release
manifest already fixes the runtime bundle.

`rolloutPercentage` is the share of installations that _newly_ issue a Deploy Hook; it is
not a hard cap on deployed Workers, because a build queued before a pointer change can
still land. Only promote releases that are backward-compatible across every Worker in the
`template protocol version 1` range (`automaticUpdate: true`).

### Pointer CLI

All actions are pure pointer mutations with validation (allowed stages, no skipping or
rolling backward, no promoting to an older version). Run locally to prepare a change, or
drive them through the `Kuroflare worker channel promotion` workflow
(`.github/workflows/release-worker-promote.yml`, `workflow_dispatch`), which applies one
action, re-validates, and commits the pointer to the default branch.

```bash
# Emergency stop: stop issuing new Deploy Hooks on a channel.
pnpm release:worker:pause --channel stable

# Promote an already-published, fixed version onto a channel (switches paused at 0%).
pnpm release:worker:promote --channel stable --version 1.4.2

# Advance (or resume) the staged rollout; only the current or next stage is allowed.
pnpm release:worker:rollout --channel stable --percentage 1

# Emergency: block / unblock a bad source version from auto-updating.
pnpm release:worker:block   --channel stable --version 1.4.1
pnpm release:worker:unblock --channel stable --version 1.4.1

# Read-only invariant check for both pointers.
pnpm release:worker:validate-pointers
```

### Stable promotion sequence

Promote beta → stable only after the dedicated canary has passed on real Cloudflare.

1. **Pause** the current stable pointer (`release:worker:pause --channel stable`) to stop
   issuing new hooks.
2. **Drain**: wait for the maximum Workers Build time plus a margin. This is a best-effort
   drain — a hook queued before the pause can still start and resolve the _new_ pointer, so
   `rolloutPercentage` is never an exact cap.
3. **Promote** to the new version (`release:worker:promote --channel stable --version x.y.z`).
   The pointer switches to `x.y.z`, `paused: true`, `rolloutPercentage: 0`.
4. **Re-verify** that the npm `stable` dist-tag, the GitHub Release assets, the release
   manifest, and the build lockfile all point at the same product version, bundle hash, and
   dependency tree (`pnpm release:worker:validate-pointers` plus the manifest/lockfile
   checks from §CI in distribution-pipeline.md).
5. **Roll out** in order: `--percentage 1`, then `10`, `50`, `100`, each after a minimum
   observation window. Watch canary and cohort Worker errors, sync E2E, and build-failure
   rate between stages. The rollout command clears `paused`; advancing may not skip a stage
   or roll backward.

### Emergency stop and fixes

- To halt a rollout, `release:worker:pause --channel <channel>`. Already-running builds may
  still deploy, so treat the stop as complete only after the build timeout plus margin.
- A pointer change **cannot** revert an already-deployed Worker. To fix a bad release,
  publish a new patch version and promote it, or roll back the code from Cloudflare
  deployment history (below).
- `release:worker:block --channel <channel> --version <bad-source>` suppresses new hooks
  from Workers still running a specific source version; it is a suppression aid, not the
  sole safety boundary.

### Code rollback

A Cloudflare Worker version does not include Durable Object, R2, or SQLite state, so code
rollback does not undo data migrations. To roll back code, select the previous version from
the Cloudflare dashboard's deployment history (Workers → the Worker → Deployments). Keep
schema migrations backward-readable by the immediately previous stable runtime so a code
rollback stays safe; ship destructive migrations as separate expand/migrate/contract
releases and never as an automatic update.

### Deploy Hook rotation

The Worker's update permission is limited to its `DEPLOY_HOOK_URL` secret. If the hook URL leaks:

1. Delete the Deploy Hook in the Cloudflare dashboard (Workers Builds → the build → Deploy
   Hooks) and create a new one.
2. Update the Worker's `DEPLOY_HOOK_URL` secret to the new URL
   (`wrangler secret put DEPLOY_HOOK_URL`).
3. The old URL stops working immediately; no pointer or release change is required. Never
   put the hook URL in the Plugin, the user repository, API responses, or logs.

## 8. Future work

- A self-service setup-URI issuance flow (e.g. rate-limited and safe to
  expose to end users), replacing the operator-run `curl` step in §4.
- A separate deployment project with its own `wrangler.toml`/CI that
  consumes `@kuroflare/worker` as a package and reproduces the contract in
  §2 (bindings, secrets, migration tag, compatibility date), rather than
  deploying straight from this monorepo.
- CI-driven deploys (build, typecheck, test, then `wrangler deploy`) once the
  separate deployment project exists.
