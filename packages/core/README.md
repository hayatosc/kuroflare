# Kuroflare Core

Shared UI-independent helpers for the Obsidian plugin and future Worker code.

Current scope:

- SHA-256 canonical text hashing for disk/YText compare-and-swap
- YText canonicalization that strips a leading BOM and stores LF line endings
- minimal text replacement calculation for disk-to-YText imports

Run:

```bash
pnpm --filter @kuroflare/core build
pnpm --filter @kuroflare/core test
```
