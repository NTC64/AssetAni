# Phase 04 — Web dashboard and self-service

Depends on: 03. Blocks: 05.

## Problem

Account creation is `pnpm user:create` run by an operator on the server. `docs/phase-5.md` names the gap: "user and key provisioning is an operator CLI until Paddle onboarding exists; there is no self-service key rotation or account recovery UI." No stranger can become a customer.

## Scope

Sign up, verify email, sign in, reset password, see credit balance, create and revoke API keys, see generation history. Buying credits is Phase 05 — this phase builds the surface it plugs into.

## Two identity systems, deliberately separate

The system will have two kinds of credential and they must not be conflated:

- **API keys** (`spr_live_…`) — machine credentials for the Cocos plugin. Already built: 32 random bytes, HMAC-SHA256 with `API_KEY_PEPPER`, scoped, 180-day expiry, shown once. Do not touch this design.
- **Web sessions** — human credentials for the dashboard. New in this phase, via Better Auth.

A web session must never be accepted by `/v1` routes, and an API key must never authenticate a dashboard page. Keep `createApiKeyAuthenticator` as the only authenticator on `/v1`.

## Approach

### 4.1 App skeleton

`apps/web`, Next.js App Router, TypeScript, Tailwind + shadcn/ui. Added to `pnpm-workspace.yaml` (already globs `apps/*`). Deployed as a third container in Phase 03's compose, behind Caddy.

Reuses `@sprite/db` and `@sprite/contracts` as workspace dependencies. Does not duplicate schema or credit logic.

### 4.2 Better Auth

Email/password plus email verification and password reset. Sessions in PostgreSQL alongside the existing schema.

Schema impact: Better Auth needs its own tables. The existing `users` table is referenced by `api_keys`, `generations`, `credit_ledger`, and `characters` with foreign keys — it cannot be replaced. Map Better Auth's user to the existing `users.id` so every FK stays valid. Write this as a new migration, `0003_web_auth.sql`, that adds tables and does not alter `users` beyond what auth requires (likely a password hash column and verification state, or a separate `auth_accounts` table — prefer the separate table to leave `users` untouched).

Decide and document before writing the migration. Getting this wrong means a destructive fix later.

### 4.3 Three-credit trial

`scripts/create-user.ts` currently grants the trial. Move that logic into a shared function in `@sprite/db` so signup and the CLI both use it. The CLI stays for operator use.

Abuse risk: free credits per email invites throwaway signups. Require verified email before the grant. Consider granting on first key creation rather than on signup.

### 4.4 API key management UI

Create (shown once, never retrievable — the hash is one-way), list metadata, revoke. Reuse `packages/core/src/api-key.ts`; do not reimplement generation or hashing.

Add a per-user active-key cap to bound abuse. Note that revocation is immediate at the DB level, but a plugin holding the key keeps it in its local profile, as `docs/phase-5.md` already warns.

### 4.5 Usage view

Read-only list of generations with status, animation, QA state, and credit cost, plus the credit ledger. This is the customer's receipt trail and it must reconcile exactly with the ledger — it is the first thing a disputing customer looks at.

## Files

- Create `apps/web/**`.
- Create `migrations/0003_web_auth.sql`.
- Modify `packages/db/src/schema.ts`, `packages/db/src/account-repository.ts`.
- Modify `scripts/create-user.ts` — call the shared trial-grant function.
- Modify `infra/docker-compose.prod.yml`, `infra/Caddyfile`.
- Modify `docs/architecture.md`, `docs/deployment.md`; create `docs/web-dashboard.md`.

## Validation

- Unit: trial granted exactly once per user, never twice.
- Unit: created key authenticates `/v1`; revoked key returns `INVALID_API_KEY`.
- Integration: a web session cookie is rejected by `/v1/generations`.
- Integration: user A cannot see user B's keys, generations, or ledger.
- Manual: full signup, verify, key, generate in Cocos, see it in history.
- Accessibility and mobile pass on signup and key pages.

## Risks

| Risk                                                      | Mitigation                                                                       |
| --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Better Auth migration conflicts with existing `users` FKs | Separate auth tables keyed to `users.id`; design reviewed before migrating.      |
| Free-credit farming via throwaway emails                  | Verified email required; grant on first key; monitor signup-to-generation ratio. |
| Session auth accidentally accepted on `/v1`               | Explicit negative test; `/v1` keeps a single authenticator.                      |
| Raw key logged or stored server-side                      | Return once from the create endpoint; assert it never reaches logs.              |
| Email deliverability (verification lands in spam)         | Use a real transactional provider with SPF/DKIM, not raw SMTP from the VPS.      |

## Open questions

1. Transactional email provider — Resend, Postmark, SES?
2. OAuth (Google/GitHub) at launch, or email/password only to reduce surface?
3. Does the Cocos plugin get a "log in" flow later, or stay paste-the-key forever?

## Phase acceptance

- A stranger completes signup to working API key with zero operator involvement.
- Web sessions and API keys are provably non-interchangeable.
- Trial credits cannot be granted twice.
- Usage view reconciles with the credit ledger exactly.
