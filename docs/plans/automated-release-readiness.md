# Automated Release Readiness Plan (historical; 0.1.0 baseline complete)

## Objective

Complete every first-distribution readiness item that can be finished inside this repository without changing external accounts or relying on physical/manual environments.

This plan is retained as a historical record. The immutable `0.1.0` release is
complete at commit/tag `7593cbc21f6bb6c5df207b6f8f433a16d1fdc76d`, with complete
release assets/checksums and npm provenance. The canonical Cloudflare template
is public, its Deploy Button points there, and the first production deployment
has been verified. The remaining items below are human-only validation rather
than repository implementation blockers.

## Agreed decisions

- Keep the existing bounded repair operations: local-store export/rebuild and quarantine inspect/discard/force-apply.
- Do not restore the removed generic `force-local`, `force-remote`, or `rebuild` admin APIs. They have no safe payload, target, CAS, or audit contract.
- Replace the stale generic escape-hatch requirement with the implemented bounded repair contract.
- License both repositories under MIT with all first-party credit metadata assigned to `hayatosc`.
- Treat GitHub and npm publication as completed release work; retain Windows,
  real multi-device, production operations, scheduled-update, and staged-promotion
  checks as human-owned gates.
- Keep transactional oversized-update escape, mobile support, and per-document socket tracking out of scope because the specifications classify them as conditional or future work.
- Treat the standalone Cloudflare template as published at
  `hayatosc/kuroflare-cloudflare-templete`; its production deployment, R2
  lifecycle, required secrets, Workers Builds, and Deploy Hook are configured.

## Historical implementation steps (superseded)

1. Finish the safe Settings repair actions and local registration reset flow, preserving confirmation and data-loss guards.
2. Add a local, non-secret-leaking QR presentation for issued setup URIs and cover the UI boundary with tests.
3. Document migration and backward-compatibility policy, operator responsibilities, and the exact human-owned release checklist.
4. Reconcile the implementation status and design-review release gate with current test evidence and remove stale completion language.
5. Add or tighten repository automation only where it provides a deterministic release-gate check without requiring external credentials.
6. Run targeted tests followed by the complete local quality gate and independent review.

## Human-owned completion gates

- [x] Create npm ownership and Trusted Publisher configuration; publish
      `@kuroflare/worker-runtime@0.1.0` with provenance and `stable`, `latest`, and
      `release-candidate` tags.
- [x] Configure the production Cloudflare account, one-day R2 incomplete-multipart
      lifecycle policy, required secrets, Workers Builds, and Deploy Hook for
      `yakugakunotes` from the canonical template.
- [x] Verify one direct Deploy Hook POST: Cloudflare produced Worker Version 9 at
      100%, `/version` changed, and required bindings and secrets remained present.
- [ ] Verify the full scheduled automatic update against a newer canary product
      version. The current Worker and both channel pointers remain at `0.1.0`.
- [ ] Install/update the Plugin through BRAT on Windows Obsidian.
- [ ] Validate two physical devices concurrently editing with awareness, offline
      convergence, binary transfer, Plugin update, and reconnect after a Worker
      update.
- [ ] Exercise production operations drills: quarantine repair, local-store
      export/rebuild, alert observation, Deploy Hook rotation, emergency pause,
      code rollback, and the documented migration boundary.
- [ ] Observe staged promotion at 1/10/50/100 percent with build-drain records.

Branch protection is intentionally skipped and must not be reintroduced as a
release task. Historical GitHub release-visibility red runs are also not current
blockers; that race was fixed after those runs.

## Out of scope

- Generic destructive remote-authority replacement APIs.
- Transparent transactional escape for oversized live updates.
- Mobile support and iOS WebView storage validation.
- Performance-only per-document socket tracking without observed churn.
