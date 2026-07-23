# Cloudflare Template Repository Extraction Plan

## Objective and status

The local extraction is complete: the Cloudflare deployment template is owned
exclusively by the independent `hayatosc/kuroflare-cloudflare-templete`
repository. This monorepo no longer owns a template copy. The intended canonical
remote is
[`hayatosc/kuroflare-cloudflare-templete`](https://github.com/hayatosc/kuroflare-cloudflare-templete),
but creating and pushing that remote remain human-owned gates.

## Agreed decisions

- The repository name is intentionally `kuroflare-cloudflare-templete`.
- This monorepo remains the source of Worker runtime packages, immutable release assets, channel pointers, and protocol contracts.
- The external repository owns the Deploy Button surface, Wrangler configuration, fixed bootstrap, template tests, and template CI.
- Do not retain a duplicate template or template test suite under this monorepo.
- Creating the remote GitHub repository and pushing the extracted local repository remain human-owned external actions.

## Completed work

1. Reconstructed the template as an independent local repository with its own package metadata, CI, documentation, and tests.
2. Verified that it consumes immutable Kuroflare release artifacts without workspace-relative dependencies.
3. Removed the template, its root script, and its CI step from this monorepo.
4. Replaced monorepo-local template references with the external repository boundary and intended canonical URL.
5. Prepared both repositories for independent verification of duplicated ownership, stale references, and release-contract regressions.
6. Published the canonical GitHub repository at `https://github.com/hayatosc/kuroflare-cloudflare-templete`.
7. Pushed the prepared repository and configured the Deploy Button to use the canonical URL.

## Human-owned completion gates

- Validate the first real Cloudflare deployment.

## Out of scope

- Moving Worker runtime source, release manifests, or channel pointers out of `hayatosc/kuroflare`.
- Creating or changing GitHub and Cloudflare account state.
