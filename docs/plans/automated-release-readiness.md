# Automated Release Readiness Plan

## Objective

Complete every first-distribution readiness item that can be finished inside this repository without changing external accounts or relying on physical/manual environments.

## Agreed decisions

- Keep the existing bounded repair operations: local-store export/rebuild and quarantine inspect/discard/force-apply.
- Do not restore the removed generic `force-local`, `force-remote`, or `rebuild` admin APIs. They have no safe payload, target, CAS, or audit contract.
- Replace the stale generic escape-hatch requirement with the implemented bounded repair contract.
- License both repositories under MIT with all first-party credit metadata assigned to `hayatosc`.
- Treat GitHub, npm, Cloudflare, Windows validation, and real multi-device visual checks as human-owned gates.
- Keep transactional oversized-update escape, mobile support, and per-document socket tracking out of scope because the specifications classify them as conditional or future work.
- Treat the standalone Cloudflare template as published at `hayatosc/kuroflare-cloudflare-templete`; only account configuration and real deployment validation remain human-owned.

## Implementation steps

1. Finish the safe Settings repair actions and local registration reset flow, preserving confirmation and data-loss guards.
2. Add a local, non-secret-leaking QR presentation for issued setup URIs and cover the UI boundary with tests.
3. Document migration and backward-compatibility policy, operator responsibilities, and the exact human-owned release checklist.
4. Reconcile the implementation status and design-review release gate with current test evidence and remove stale completion language.
5. Add or tighten repository automation only where it provides a deterministic release-gate check without requiring external credentials.
6. Run targeted tests followed by the complete local quality gate and independent review.

## Human-owned completion gates

- Create npm ownership and Trusted Publisher configuration.
- Configure the production Cloudflare account, R2 lifecycle policy, canary, and Deploy Hook.
- Validate Windows Obsidian, real multi-device awareness, production deployment, and staged promotion.

## Out of scope

- Generic destructive remote-authority replacement APIs.
- Transparent transactional escape for oversized live updates.
- Mobile support and iOS WebView storage validation.
- Performance-only per-document socket tracking without observed churn.
