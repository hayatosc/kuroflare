# Desktop Trial Readiness Plan (historical; desktop baseline complete)

## Objective

Make the current Kuroflare repository verifiably ready for a backed-up,
disposable-vault desktop trial without claiming production or distributed
release readiness.

The repository-local desktop baseline is complete: production composition and
the real Linux Obsidian + miniflare `:app` synchronization path are green. This
plan is retained as a historical record and does not attest Windows, two
physical devices, scheduled automatic updates, production operations, or staged
promotion readiness.

## Agreed decisions

- The immediate target is a desktop personal trial, not a public release.
- The real Obsidian plus miniflare regression is the primary acceptance gate.
- Real Cloudflare deployment was historically deferred until repository-local
  acceptance was green. It is now separately verified for `yakugakunotes` from
  the public canonical template; the verification is recorded in
  [deployment.md](../deployment.md) and does not close the remaining human-only
  gates.
- Existing implementation and tests are the authority when the dated status
  document disagrees with the current HEAD; the document must then be updated.
- Any real Obsidian test must use the script-managed disposable vault and must
  not target an existing user vault.

## Historical implementation steps (completed or superseded)

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

- [x] Production startup creates and runs the intended sync composition.
- [x] A real Obsidian client completes the miniflare synchronization scenario
      without content loss.
- [x] Existing Worker/workerd evidence and the desktop acceptance lane are green.
- [x] Documentation distinguishes disposable-vault desktop trial readiness from
      primary-vault and distributed-release readiness.
- [x] No secrets, credentials, or real user vault contents are committed or logged.

## Out of scope

- Deploying or mutating a real Cloudflare account (historical scope; the verified
  deployment is documented separately).
- Public device-invitation UX and release packaging.
- Multipart uploads, mobile support, awareness, and blob garbage collection.
- Closing every cross-cutting design review item required for a distributed
  release.

Remaining human-only release gates are Windows Obsidian BRAT install/update,
two physical-device concurrent editing/awareness/offline/binary/reconnect,
scheduled automatic update against a newer canary version, production
operations drills, and staged 1/10/50/100 promotion observations.
