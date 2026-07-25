# Kuroflare

Kuroflare is a local-first Obsidian synchronization system backed by a Worker
deployed to the user's own Cloudflare account.

The repository contains:

- the Obsidian plugin;
- the Cloudflare Worker and Durable Objects;
- the public `@kuroflare/worker-runtime` distribution bundle;
- release and deployment automation;
- protocol, storage, recovery, and distribution design documents.

## Release status

Kuroflare has published its first public release. The automated GitHub Release
pipeline produces the Obsidian assets required by BRAT and the Community Plugin
directory, the pinned Worker runtime, and immutable deployment metadata. The
Cloudflare deployment template is maintained outside this monorepo in the
intended canonical repository,
[`hayatosc/kuroflare-cloudflare-templete`](https://github.com/hayatosc/kuroflare-cloudflare-templete).
Its public repository, Deploy Button target, local extraction, and Deploy Hook
based Worker updater are implemented, but the template is not a supported live
installation path until the production Cloudflare and real-device validation
gates are complete.
Repository automation and historical test runs do not satisfy the
account-configuration, production Cloudflare, Windows, or real multi-device
gates. See the exact
[human-owned release checklist](docs/plans/distribution-pipeline.md#human-owned-release-gates).

Do not use a personal vault for development or pre-release testing. Follow the
[desktop trial guide](packages/obsidian-plugin/README.md) with a disposable
vault.

## Development

Install the workspace and run the local quality gates:

```bash
ni
nr format:check
nr lint
nr typecheck
nr test
```

The Worker deployment procedure for development environments is documented in
[docs/deployment.md](docs/deployment.md). It is not the public installation
path.

## Security

Never commit Worker secrets, device tokens, setup tokens, Cloudflare API
tokens, or Deploy Hook URLs. Report vulnerabilities according to
[SECURITY.md](SECURITY.md).

## License

Kuroflare is licensed under the [MIT License](LICENSE).

Copyright (c) 2026 hayatosc.
