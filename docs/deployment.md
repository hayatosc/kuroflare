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
  state (op log, device registry, checkpoints).
- **R2 bucket** — stores Yjs snapshots and blob (attachment) content written
  by the Durable Object.

For personal use, all of this is deployed as a single Worker + one Durable
Object namespace + one R2 bucket, driven by `wrangler` from
`packages/worker`.

## 2. Deployment contract

This is the fixed set of bindings, secrets, and routes that any deployment of
`@kuroflare/worker` must provide. A future separate deployment project (its
own `wrangler.toml`/CI, consuming this worker package) should reproduce this
contract rather than reinvent it.

### Bindings (from `packages/worker/wrangler.toml`)

| Binding | Type | Name | Notes |
| --- | --- | --- | --- |
| `VAULT_ROOM` | Durable Object | class `VaultRoom` | Requires the SQLite-backed DO migration below. |
| `SNAPSHOT_BUCKET` | R2 bucket | bucket `kuroflare-snapshots` | Stores Yjs snapshots and blobs. Optional at the type level (`R2BucketBinding \| undefined` in `WorkerEnv`) so tests can omit it, but checkpointing, snapshot fetch, and blob routes all return `503` without it — treat it as required in any real deployment. |

Durable Object migration (required, exactly as declared today):

```toml
[[migrations]]
tag = "v1"
new_sqlite_classes = ["VaultRoom"]
```

`compatibility_date` currently pinned in `packages/worker/wrangler.toml`:
`2026-06-12`. A downstream deploy project should track (or exceed) this date.

### Secrets (`WorkerEnv`, `packages/worker/src/runtime/types.ts`)

| Var | Required? | Purpose |
| --- | --- | --- |
| `DEVICE_TOKEN_SECRET` | **Effectively required** | HS256 signing/verification secret for device access tokens. It is typed optional, but `VaultRoom.authorizeHello` fails closed: once the Durable Object's SQLite storage exists (i.e. any real, non-fresh vault), a missing secret causes every WebSocket `hello` to be rejected with `auth-reject:missing-secret`. HTTP admin/auth routes (`/setup/exchange`, `/auth/refresh`, `/devices/:id/revoke`, `/admin/*`, snapshot/blob routes) all return `503` when this secret is absent. |
| `E2E_SETUP_TOKEN_SECRET` | Optional | Gates the `/__e2e/setup-token` and `/__e2e/snapshot` routes (see §4). It is the **only** mechanism today for seeding a setup token, so in practice it must be set to onboard any device. Treat it as a shared admin secret, not an end-user-facing credential. |

### Production routes (`packages/worker/src/runtime.ts`, `src/runtime/app.ts`)

| Method + path | Auth | Purpose |
| --- | --- | --- |
| `GET /ws/:vaultId` | WebSocket subprotocol/bearer token, validated in DO `hello` handling | Main sync transport (Yjs updates, sync-request/response). |
| `POST /setup/exchange` | Setup token (body) | Exchanges a one-time setup token for a device access + refresh token pair. |
| `POST /auth/refresh` | Refresh token (body) | Rotates the device's refresh token and mints a new access token. |
| `POST /devices/:deviceId/revoke` | Bearer device token, scope `sync:write` | Revokes a device. |
| `GET /admin/quarantine`, `GET /admin/quarantine/:id` | Bearer device token, scope `sync:write` | Inspect quarantined (rejected) updates. |
| `GET /admin/retention` | Bearer device token, scope `sync:write` | Inspect snapshot retention events. |
| `POST /admin/{gc,force-local,force-remote,rebuild}` | Bearer device token, scope `sync:write` | Admin recovery operations. |
| `POST /admin/quarantine/:id/{discard,force-apply}` | Bearer device token, scope `sync:write` | Resolve a quarantined update. |
| `GET /vaults/:vaultId/meta/latest`, `GET /vaults/:vaultId/files/:ydocId/latest` | Bearer device token, scope `sync:read` | Fetch the latest hydrated snapshot for a doc. |
| `PUT /vaults/:vaultId/meta/snapshot`, `PUT /vaults/:vaultId/files/:ydocId/snapshot` | Bearer device token | Import a snapshot. |
| `POST /blobs/head`, `POST /blobs/upload-url`, `GET/PUT /blobs/:hash`, `GET/PUT /blob-manifests/*` | Bearer device token, scope `blob:read`/`blob:write` | Attachment (blob) storage. **Multipart upload is explicitly unimplemented**: `/blobs/upload-url` and `PUT /blobs/:hash` both reject with `413 blob-upload-url:multipart-unimplemented` once size exceeds `BLOB_SINGLE_PUT_MAX_BYTES` (16 MiB − 1 byte) or `multipart: true` is requested. |
| `POST /__e2e/setup-token`, `POST /__e2e/snapshot` | `x-kuroflare-e2e-secret` header == `E2E_SETUP_TOKEN_SECRET` | Interim admin seeding routes; see §4. `404` if `E2E_SETUP_TOKEN_SECRET` unset, `403` on header mismatch. |

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

3. **Set secrets** (replace the placeholder values — do not reuse these
   examples as real secrets):

   ```bash
   pnpm --filter @kuroflare/worker exec wrangler secret put DEVICE_TOKEN_SECRET
   # paste a long random value, e.g. from `openssl rand -hex 32`

   pnpm --filter @kuroflare/worker exec wrangler secret put E2E_SETUP_TOKEN_SECRET
   # paste a second, independent long random value
   ```

4. **Deploy**:

   ```bash
   pnpm --filter @kuroflare/worker exec wrangler deploy
   ```

   `wrangler` bundles `src/index.ts` directly (Hono `default` export plus the
   `VaultRoom` Durable Object class); no separate build step is required for
   deployment. The Durable Object SQLite migration (`tag = "v1"`) applies
   automatically on first deploy.

5. **Smoke-check** the deployed Worker responds (any vault ID; expect a
   WebSocket-upgrade-required response, not a 5xx):

   ```bash
   curl -i "https://<your-worker>.workers.dev/ws/smoke-check-vault"
   # expect: HTTP/1.1 426 Expected WebSocket upgrade
   ```

## 4. Device onboarding (interim path)

There is currently no production-grade "invite a device" flow. The only
route that mints a setup token is the e2e-named admin route
`POST /__e2e/setup-token`, gated by the `E2E_SETUP_TOKEN_SECRET` you set
above. Treat this as an interim operator tool, not something to expose to
end users, until a real issuance flow exists (see §7).

1. **Generate a random setup token locally** (never reuse across vaults or
   let it leave your machine other than to your own device):

   ```bash
   SETUP_TOKEN=$(openssl rand -hex 32)
   ```

2. **Register it with the Worker** for a chosen `vaultId` (pick any stable
   string identifying the vault; it becomes the Durable Object name):

   ```bash
   curl -s -X POST "https://<your-worker>.workers.dev/__e2e/setup-token" \
     -H "content-type: application/json" \
     -H "x-kuroflare-e2e-secret: <your-E2E_SETUP_TOKEN_SECRET>" \
     -d '{"vaultId":"<your-vault-id>","setupToken":"'"$SETUP_TOKEN"'"}'
   ```

   Request body fields (`E2eSetupTokenSeedRequestSchema`,
   `packages/worker/src/runtime/types.ts`): `vaultId` (required), `setupToken`
   (required, non-empty string), `expiresInMs` (optional, defaults to
   10 minutes / `10 * 60 * 1000`, capped at 24h). The server never stores the
   raw token — only its SHA-256 hash — and the token is single-use (consumed
   by `/setup/exchange`).

3. **Compose the setup URI** the plugin understands
   (`packages/core/src/sync/setup.ts`, `parseSetupUri`):

   ```
   kuroflare://setup?endpoint=<url-encoded-worker-origin>&vaultId=<vault-id>&setupToken=<setup-token>
   ```

   Example:

   ```
   kuroflare://setup?endpoint=https%3A%2F%2Fyour-worker.workers.dev&vaultId=my-vault&setupToken=<the-token-from-step-1>
   ```

4. **Paste the URI into the plugin's settings tab** ("Setup URI" field,
   `packages/obsidian-plugin/src/obsidian/settings-tab.ts`) and click Apply.
   This fills in the Worker endpoint, vault ID, and setup token fields for
   you. Alternatively, fill the "Worker endpoint" / "Vault ID" / "Setup
   token" fields manually with the same values.

Setup tokens expire quickly (10 minutes by default) — generate and register
one right before pasting it into the plugin, not in advance.

## 5. Plugin build and manual install

From the repository root:

```bash
pnpm --filter @kuroflare/obsidian-plugin build
```

This produces `packages/obsidian-plugin/main.js` next to `manifest.json`.
Then, for each vault you want to sync:

```bash
mkdir -p /path/to/vault/.obsidian/plugins/kuroflare
cp packages/obsidian-plugin/manifest.json /path/to/vault/.obsidian/plugins/kuroflare/
cp packages/obsidian-plugin/versions.json /path/to/vault/.obsidian/plugins/kuroflare/
cp packages/obsidian-plugin/main.js /path/to/vault/.obsidian/plugins/kuroflare/
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
- **Large attachments are rejected.** Multipart blob upload is not
  implemented (`packages/worker/src/runtime.ts`, `BLOB_MULTIPART_THRESHOLD_BYTES
  = 16 MiB`); any blob at or above 16 MiB is rejected with `413
  blob-upload-url:multipart-unimplemented`.
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

## 7. Future work

- A production-grade setup-URI issuance flow (replacing the
  `/__e2e/setup-token` admin path with something safe to expose, e.g.
  authenticated, rate-limited, and not sharing a route name with the e2e
  test harness).
- A separate deployment project with its own `wrangler.toml`/CI that
  consumes `@kuroflare/worker` as a package and reproduces the contract in
  §2 (bindings, secrets, migration tag, compatibility date), rather than
  deploying straight from this monorepo.
- CI-driven deploys (build, typecheck, test, then `wrangler deploy`) once the
  separate deployment project exists.
