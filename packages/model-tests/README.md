# Kuroflare Checkpoint Model Tests

Executable model tests for the Durable Object checkpoint/cold-start contract.

The model deliberately ignores Yjs internals and tracks update identity instead:

- acknowledged valid updates
- residual `op_log`
- R2 snapshots
- snapshot pointer updates
- retention rollback snapshots
- quarantined invalid updates
- duplicate message IDs

Run:

```bash
pnpm --filter @kuroflare/model-tests build
pnpm --filter @kuroflare/model-tests test
```

The randomized test uses deterministic seeds. If it fails, the seed is printed
so the operation sequence can be reproduced.
