# Cloudflare Template Repository Extraction Plan (historical; completed)

## Objective and status

The local extraction is complete: the Cloudflare deployment template is owned
exclusively by the independent `hayatosc/kuroflare-cloudflare-templete`
repository. This monorepo no longer owns a template copy. The canonical
remote is
[`hayatosc/kuroflare-cloudflare-templete`](https://github.com/hayatosc/kuroflare-cloudflare-templete),
which is public, and its Deploy Button points to that repository. Creating and
pushing the remote were historical human-owned gates; both are complete.

## Agreed decisions

- The repository name is intentionally `kuroflare-cloudflare-templete`.
- This monorepo remains the source of Worker runtime packages, immutable release assets, channel pointers, and protocol contracts.
- The external repository owns the Deploy Button surface, Wrangler configuration, fixed bootstrap, template tests, and template CI.
- Do not retain a duplicate template or template test suite under this monorepo.
- Creating the remote GitHub repository and pushing the extracted local repository were human-owned external actions and are now complete.

## Completed work

1. Reconstructed the template as an independent local repository with its own package metadata, CI, documentation, and tests.
2. Verified that it consumes immutable Kuroflare release artifacts without workspace-relative dependencies.
3. Removed the template, its root script, and its CI step from this monorepo.
4. Replaced monorepo-local template references with the external repository boundary and canonical URL.
5. Prepared both repositories for independent verification of duplicated ownership, stale references, and release-contract regressions.
6. Published the canonical GitHub repository at `https://github.com/hayatosc/kuroflare-cloudflare-templete`.
7. Pushed the prepared repository and configured the Deploy Button to use the canonical URL.
8. Deployed the production Worker `yakugakunotes` from the canonical template and verified the production URL, required bindings and secrets, Workers Builds, and the one-day R2 incomplete-multipart lifecycle rule.
9. Deployed `DEPLOY_HOOK_URL` and verified a direct Deploy Hook POST: Cloudflare produced Worker Version 9 at 100%, `/version` changed, and required bindings and secrets remained present.

## Historical human-owned completion gates (closed)

- [x] Validate the first real Cloudflare deployment from the canonical template.
- [x] Validate the direct Deploy Hook path and preserve the deployment configuration.

The direct hook test does not attest that `UpdateCoordinator` automatically
updates to a newer product version; that remains a separate human gate in the
distribution pipeline plan.

## Out of scope

- Moving Worker runtime source, release manifests, or channel pointers out of `hayatosc/kuroflare`.
- Creating or changing GitHub and Cloudflare account state.

This plan is retained as a historical record. No further template extraction
work is pending; branch protection is intentionally not part of the remaining
release gates.
