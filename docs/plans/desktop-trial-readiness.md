# Desktop Trial Readiness Plan

## Objective

Make the current Kuroflare repository verifiably ready for a backed-up,
disposable-vault desktop trial without claiming production or distributed
release readiness.

## Agreed decisions

- The immediate target is a desktop personal trial, not a public release.
- The real Obsidian plus miniflare regression is the primary acceptance gate.
- Real Cloudflare deployment is deferred until repository-local acceptance is
  green because it changes external infrastructure and requires user-owned
  credentials.
- Existing implementation and tests are the authority when the dated status
  document disagrees with the current HEAD; the document must then be updated.
- Any real Obsidian test must use the script-managed disposable vault and must
  not target an existing user vault.

## Implementation steps

1. Audit the current production composition, startup, outbox, authentication,
   and resume wiring against `docs/implementation-status.md`.
2. Inspect the real Obsidian/miniflare test harness and prove that its vault and
   process side effects are isolated before running it.
3. Run the acceptance test. If it fails, reduce the failure to the smallest
   reproducible path, fix the root cause, and add focused regression coverage.
4. Re-run the focused test, workspace tests, type checks, lint, formatting, and
   Worker E2E suite.
5. Update the implementation status with the verified date, evidence, and
   remaining operational limits.
6. Obtain an independent code review before declaring the repository ready for
   a disposable-vault trial.

## Acceptance criteria

- Production startup creates and runs the intended sync composition.
- A real Obsidian client completes the miniflare synchronization scenario
  without content loss.
- Existing workspace and Worker E2E checks remain green.
- Documentation distinguishes disposable-vault desktop trial readiness from
  primary-vault and distributed-release readiness.
- No secrets, credentials, or real user vault contents are committed or logged.

## Out of scope

- Deploying or mutating a real Cloudflare account.
- Public device-invitation UX and release packaging.
- Multipart uploads, mobile support, awareness, and blob garbage collection.
- Closing every cross-cutting design review item required for a distributed
  release.
