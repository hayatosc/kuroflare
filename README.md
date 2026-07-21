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

Kuroflare is preparing its first public release. The automated GitHub Release
pipeline produces the Obsidian assets required by BRAT and the Community Plugin
directory, the pinned Worker runtime, and immutable deployment metadata. The
isolated Cloudflare deployment template and Deploy Hook based Worker updater
are implemented but are not a live installation path until the public
repository, npm trusted publisher, release environment, and first release are
configured. See [the distribution plan](docs/plans/distribution-pipeline.md).

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
