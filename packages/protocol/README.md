# Kuroflare Protocol

Shared protocol types and lightweight runtime guards for plugin/worker
boundaries.

Current scope:

- branded IDs
- protocol version constants
- WebSocket control messages
- binary Yjs update frame header metadata
- retryable API error payloads

Run:

```bash
pnpm --filter @kuroflare/protocol build
pnpm --filter @kuroflare/protocol test
```
