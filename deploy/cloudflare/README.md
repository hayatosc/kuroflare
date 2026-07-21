# Kuroflare Cloudflare template

This directory is the standalone source for the Kuroflare **Deploy to
Cloudflare** button. Cloudflare copies the directory into the installer's
repository, so it must remain independent from the Kuroflare monorepo and must
not contain workspace dependencies.

## Deploy

Create a Deploy to Cloudflare button that targets this directory in the public
Kuroflare repository. The first Workers Build runs the fixed bootstrap:

1. Read `KUROFLARE_UPDATE_CHANNEL` (`stable` by default).
2. Fetch the channel pointer from the one allowlisted raw GitHub URL.
3. Fetch the immutable release manifest and build lockfile from the matching
   GitHub Release.
4. Validate the release contract and lockfile before installing anything.
5. Run the pinned npm install into a temporary directory and atomically publish
   the generated Worker build.

The bootstrap never invokes a Cloudflare API, accepts command-line arguments,
or deploys a Worker. The Deploy command calls the exact Wrangler binary that
the release lockfile installed.

The following secrets are required by the Worker and are declared in
`wrangler.json`:

- `DEVICE_TOKEN_SECRET`
- `ADMIN_TOKEN_SECRET`

Enter both values in the Deploy button form (or configure them in the
Cloudflare Dashboard). Use long, independently generated random values and do
not commit `.dev.vars`.

`DEPLOY_HOOK_URL` is deliberately not required for the initial deployment.
After Workers Builds is connected, create a Deploy Hook in the Cloudflare
Dashboard and store its URL as the optional `DEPLOY_HOOK_URL` Worker secret.
This URL is the credential used by the scheduled update coordinator; it is
never placed in the repository, manifest, or public API response.

## Local verification

Use Node.js 22 or newer:

```sh
npm test
npm run build
npm run deploy
```

`npm run build` needs network access to the fixed GitHub and npm endpoints and
requires a release pointer to be published. `npm run deploy` requires a
Cloudflare login and is intentionally not run by the bootstrap.

To select the beta channel for a dedicated canary Worker, set the Workers
Build variable before running the build:

```text
KUROFLARE_UPDATE_CHANNEL=beta
```

Changing the channel or the generated bindings is an installation-level
decision. Keep the template protocol at version `1`; a release that requires a
new template protocol is rejected by this bootstrap instead of being deployed
silently.
