# Phase 05 — Paddle credit packs

Depends on: 04. Blocks: 08.
First phase where money moves.

## Context

The schema was built for this and never wired up:

- `users.paddle_customer_id` — exists, unused.
- `credit_ledger.paddle_transaction_id` — exists, unused.
- `credit_ledger` — append-only, unique `idempotency_key`, `balance_after` with a non-negative check.

No Paddle code exists anywhere. Grep confirms only those two column definitions.

## Model

One-off credit packs. No subscription, no renewal, no proration, no dunning, no cancellation. A purchase is a single event that appends one positive ledger entry.

Paddle is Merchant of Record: it handles VAT, sales tax, and invoicing. That is the reason to use it over a raw payment processor at this scale.

## Approach

### 5.1 Products

Define packs in Paddle (for example 50 / 200 / 500 credits). Map Paddle price IDs to credit amounts in application config, not in the database — this is deployment configuration, and a price ID that does not map must be rejected, never guessed.

### 5.2 Checkout

Dashboard opens Paddle Checkout with the user's `paddle_customer_id`, creating it on first purchase. Never trust the browser for fulfilment; checkout completion in the UI is a hint, not a grant.

### 5.3 Webhook is the only source of truth

New route on the API — not the web app, because the API owns the ledger and the database.

Required behaviour:

1. **Verify the signature** before parsing. Reject unverified payloads without touching the database.
2. Handle `transaction.completed` for credit grants.
3. Resolve the price ID to a credit amount from config; reject unknown price IDs.
4. Append one ledger entry with `reason='purchase'`, the Paddle transaction id, and a deterministic `idempotency_key` derived from that transaction id.
5. Update the user's balance in the same transaction that appends the ledger entry.
6. Return 2xx only after commit, so Paddle retries on failure.

The existing unique constraint on `credit_ledger.idempotency_key` makes redelivery safe: a duplicate webhook hits the constraint and becomes a no-op. This is exactly the mechanism already proven for refunds in `tests/phase5-commercial.test.ts` — reuse the pattern rather than inventing one.

### 5.4 Refunds and chargebacks

Handle `transaction.refunded` and the dispute events by appending a negative ledger entry. The `balance_after >= 0` check means a refund below current balance will fail the constraint. Decide the policy explicitly:

- Clamp to zero and record the shortfall, or
- Allow negative balance for refund cases only, or
- Reject and flag for manual handling.

Recommend clamping to zero plus an alert. A user who spent credits then refunded is an abuse case that needs a human, not an automatic negative balance.

This is the single most likely source of a real money bug. Do not skip it.

### 5.5 Reconciliation

A scheduled job comparing Paddle transactions against ledger entries over a rolling window, reporting mismatches. Webhooks get lost. Without reconciliation, a paying customer with no credits is discovered by a support email.

## Files

- Create `apps/api/src/routes/paddle-webhook.ts`, `apps/api/src/services/billing-service.ts`.
- Modify `apps/api/src/app.ts` — register the route, raw body for signature verification.
- Modify `packages/db/src/account-repository.ts` — purchase and refund ledger operations.
- Create `migrations/0004_billing.sql` if new reason values or indexes are needed.
- Modify `apps/web/**` — pricing page, checkout, purchase history.
- Modify `apps/api/src/config.ts`, `.env.example` — `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_ENVIRONMENT`, price-to-credit map.
- Create `docs/billing.md`; modify `docs/api.md`, `docs/architecture.md`.

## Validation

New `tests/billing.test.ts`, modelled on the existing commercial suite:

1. Valid webhook grants exactly the mapped credits and appends one ledger entry.
2. The same webhook delivered twenty times concurrently grants credits exactly once.
3. Invalid signature grants nothing and returns 4xx.
4. Unknown price ID grants nothing.
5. Refund event appends a negative entry; balance never goes below zero.
6. A webhook that fails mid-transaction leaves no partial state and returns non-2xx.
7. Balance after a purchase-then-spend sequence matches the ledger sum exactly.

Manual: Paddle sandbox end-to-end, including a sandbox refund.

## Risks

| Risk                                                    | Mitigation                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Double-granting on webhook redelivery                   | Deterministic idempotency key + existing unique constraint; tested under load. |
| Forged webhook minting free credits                     | Signature verified before any parsing or DB access; negative test required.    |
| Refund driving balance negative and violating the check | Explicit clamp policy plus alert; tested.                                      |
| Lost webhook leaving a paying customer uncredited       | Reconciliation job; support runbook in Phase 06.                               |
| Paddle account approval delay                           | Start the application at the beginning of this phase, not the end.             |
| Credit price below provider cost                        | Phase 08 sets price from measured cost; do not guess here.                     |

## Open questions

1. Do purchased credits expire? Schema has no expiry; "never expires" is simplest and is what customers prefer.
2. Pack sizes and prices — decide in Phase 08 after cost measurement.
3. Refund policy published to customers: full refund on unused credits only?

## Phase acceptance

- Sandbox purchase credits the account exactly once, proven under concurrent redelivery.
- Forged and malformed webhooks grant nothing.
- Refunds never produce a negative balance.
- Every credit change traces to a Paddle transaction id in the ledger.
- Reconciliation detects a deliberately dropped webhook.
