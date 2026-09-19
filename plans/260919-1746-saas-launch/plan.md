# AssetRun SaaS launch plan

Status: SUPERSEDED on 2026-09-19 by [260919-2257-standalone-extension](../260919-2257-standalone-extension/plan.md)
Created: 2026-09-19
Goal: turn the working generation core into a paid, self-service SaaS.

> **Superseded.** PixelLab's terms require contacting them before building a
> service on their API or reselling it, and PixelLab sells to the same
> customers directly. The product became a standalone Cocos extension where the
> user supplies their own PixelLab key. This plan is kept because it records the
> analysis behind that change, and because its Phase 01 defects (orphaned
> generations, unbounded result storage) were real.

## Decisions already made

| Decision      | Choice                                 | Rationale                                                                  |
| ------------- | -------------------------------------- | -------------------------------------------------------------------------- |
| Product model | Paid SaaS                              | User decision, 2026-09-19.                                                 |
| Billing       | One-off credit packs (no subscription) | Half the surface of subscriptions: no renewal, dunning, proration, cancel. |
| Customer web  | Separate Next.js app (`apps/web`)      | Billing and onboarding are the first paid surface; must not look cheap.    |
| Auth (web)    | Better Auth                            | TypeScript-native, email/password + OAuth + sessions without hand-rolling. |
| Hosting       | Self-managed VPS + Coolify + Caddy     | Matches the Caddy/GHCR direction already in `docs/deployment.md`.          |
| Storage       | Cloudflare R2 + signed URLs            | Already the documented target; result files must leave the app disk.       |

Hard constraint: the worker uses Sharp (native binary) and runs multi-minute jobs. It cannot run on serverless. A always-on host is required.

## What already works

Prompt to `.anim` end-to-end, scoped API-key auth, atomic credit reservation with exactly-once refund, Redis rate limiting, deterministic frame QA, character pipeline with presets and batches. 138 automated tests, clean lint/typecheck/build.

## Phases

| Phase                                      | Title                           | Depends on | Blocks launch |
| ------------------------------------------ | ------------------------------- | ---------- | ------------- |
| [01](phase-01-operational-hardening.md)    | Operational hardening           | —          | Yes           |
| [02](phase-02-object-storage.md)           | Object storage on R2            | 01         | Yes           |
| [03](phase-03-production-packaging.md)     | Production packaging and deploy | 02         | Yes           |
| [04](phase-04-web-dashboard.md)            | Web dashboard and self-service  | 03         | Yes           |
| [05](phase-05-paddle-credit-packs.md)      | Paddle credit packs             | 04         | Yes           |
| [06](phase-06-observability-and-backup.md) | Observability, backup, runbook  | 03         | Yes           |
| [07](phase-07-precise-animation.md)        | Precise animation               | —          | No            |
| [08](phase-08-launch-readiness.md)         | Launch readiness                | 05, 06     | Yes           |

Phase 07 is independent and can be slotted anywhere. Everything else is a chain.

## Critical path

```text
01 hardening -> 02 R2 -> 03 deploy -> 04 dashboard -> 05 Paddle -> 08 launch
                              \-> 06 observability -/
```

Phase 03 is the first point where a real user could touch the system. Phase 05 is the first point where money can be taken. Do not expose the service publicly before 03 and 06 are both done — `docs/deployment.md` already warns the current API must not be exposed.

## Acceptance criteria for the whole plan

1. A stranger can sign up, verify email, buy a credit pack, get an API key, and generate a sprite without any operator action.
2. No generation can strand a reserved credit. Every terminal state either delivers a result or refunds.
3. Result files do not accumulate on the app server disk.
4. A push to `main` runs lint, typecheck, test, and build automatically.
5. Loss of the VPS does not lose customer accounts, credit balances, or the ledger.
6. Every paid state change is traceable to a Paddle transaction in the ledger.

## Risks carried across phases

| Risk                                                           | Mitigation                                                                                |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Provider cost per generation exceeds credit price              | Phase 08 prices only after measuring real PixelLab cost per animation across presets.     |
| PixelLab outage or pricing change takes the product down       | fal.ai fallback already exists for base creation; Phase 06 alerts on provider error rate. |
| Single VPS is a single point of failure                        | Phase 06 automated offsite backup; accept downtime risk at launch scale, revisit later.   |
| Worker concurrency exhausts VPS memory (Sharp is memory-heavy) | Phase 03 sets explicit container memory limits and tunes `WORKER_CONCURRENCY`.            |
| EU/UK VAT and invoicing obligations                            | Paddle is Merchant of Record and handles this; confirmed in Phase 05.                     |

## Explicitly out of scope

Subscriptions, team/organization accounts, multi-region, horizontal worker autoscaling, in-editor credit purchase, mobile app, public generation gallery.

## Open questions

1. Domain name registered yet? Phase 03 needs it for Caddy and TLS.
2. Is there a Cloudflare account for R2, or should Phase 02 target S3-compatible storage generically?
3. Paddle seller account approved? Approval can take days and is a hard gate on Phase 05.
4. Target price per credit, or should Phase 08 propose one from measured provider cost?
