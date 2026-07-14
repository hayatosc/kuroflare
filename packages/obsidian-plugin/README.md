# Kuroflare Obsidian Plugin

This package contains the production Obsidian client composition used by the
Kuroflare Worker sync runtime. It persists Yjs documents in IndexedDB, applies
remote snapshots and updates to the vault, and sends local changes through the
durable outbox. It is suitable for a disposable desktop trial; it is not yet a
marketplace-ready distribution.

## Safe desktop trial

Use a disposable vault. The trial exercises file writes, plugin installation,
local IndexedDB persistence, and remote materialization.

1. Start the local Worker in one terminal and leave it running:

   ```bash
   nr --filter @kuroflare/worker dev:local
   ```

2. In another terminal, prefer the `:app` harness. It creates and opens the
   disposable vault at `/tmp/kuroflare-obsidian-cli-smoke` before running the
   real Linux Obsidian + miniflare E2E:

   ```bash
   nr --filter @kuroflare/obsidian-plugin test:e2e:obsidian:miniflare:app
   ```

   `worker dev:local` must already be running in the other terminal; the
   harness does not start a Worker for you.

3. The direct harness is for an Obsidian instance that is already open. It has
   a fail-fast guard and refuses to mutate an active vault unless its absolute
   path exactly matches `KUROFLARE_E2E_OBSIDIAN_VAULT_PATH` (default:
   `/tmp/kuroflare-obsidian-cli-smoke`):

   ```bash
   export KUROFLARE_E2E_OBSIDIAN_VAULT_PATH=/tmp/kuroflare-obsidian-cli-smoke
   nr --filter @kuroflare/obsidian-plugin test:e2e:obsidian:miniflare
   ```

   Do not point the direct harness at a personal or production vault. The
   guard validates the active vault before each Obsidian CLI operation and
   again inside each eval. Do not switch vaults while the harness is running;
   a CLI vault switch can race the separate validation call. The harness uses
   run-specific document IDs and does not delete the shared
   `kuroflare-file:*` IndexedDB namespace.

   Only one harness may own a disposable vault at a time. A concurrent run
   fails on `.kuroflare-e2e.lock`. If a process was killed without cleanup,
   remove that file only after confirming no harness is still running.

## Build and manual install

```bash
nr --filter @kuroflare/obsidian-plugin build
```

The build writes `main.js` next to `manifest.json`. For a local manual install:

```bash
mkdir -p /path/to/vault/.obsidian/plugins/kuroflare
cp packages/obsidian-plugin/manifest.json /path/to/vault/.obsidian/plugins/kuroflare/
cp packages/obsidian-plugin/versions.json /path/to/vault/.obsidian/plugins/kuroflare/
cp packages/obsidian-plugin/main.js /path/to/vault/.obsidian/plugins/kuroflare/
```

Enable `Kuroflare` from Obsidian's Community plugins settings, then complete
setup using the Worker deployment described in the
[deployment guide](../../docs/deployment.md). The desktop trial commands above
are not a production deployment procedure.

## Current limits

- Blob uploads use one PUT. Payloads at or above 16 MiB are rejected until
  multipart upload is implemented.
- This trial targets desktop Obsidian. Obsidian mobile/WebView IndexedDB
  behavior is not yet verified or supported.
- Presence/awareness, marketplace packaging, and the remaining design-review
  release gates are not claims of this README.
