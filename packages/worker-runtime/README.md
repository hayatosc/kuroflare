# @kuroflare/worker-runtime

The public Kuroflare Cloudflare Worker runtime.

This package contains the deployable Worker entrypoint and Durable Object
implementation. It is bundled as a self-contained ES module so a consumer can
deploy it without installing Kuroflare's private monorepo packages.

```ts
import worker, { VaultRoom } from '@kuroflare/worker-runtime'

export { VaultRoom }
export default worker
```

For a complete deployment, use the Kuroflare deployment template. The template
provides bindings, release metadata, and the Wrangler configuration required by
Cloudflare Workers.

## License

MIT © 2026 hayatosc
