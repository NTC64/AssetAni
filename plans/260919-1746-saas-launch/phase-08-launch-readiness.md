# Phase 08 — Launch readiness

Depends on: 05, 06. Blocks: nothing.
The last phase before taking money from strangers.

## 8.1 Price from measured cost, not from a guess

Nothing else in this plan can be decided correctly without this number.

1. Measure real provider cost per generation across every preset and animation. `generations.provider_cost_usd` already exists and is populated — query it, do not estimate.
2. Add infrastructure cost per generation: VPS, R2 operations, bandwidth, email, monitoring.
3. Add Paddle's fee, which as Merchant of Record is higher than a bare processor's.
4. Set credit price with margin for failed generations — a refunded failure costs provider money but earns nothing.

Note the asymmetry already built into the system: a permanent failure refunds the customer's credit but the provider call was still paid for. Failure rate directly erodes margin, which is why the QA FAIL metric in Phase 06 is a business metric, not just a quality one.

Then decide pack sizes. Three tiers is enough.

## 8.2 Trial economics

Three free credits per verified signup is a real cost, paid to the provider, for a user who may never buy. Before launch:

- Confirm three is the right number now that cost is measured.
- Confirm Phase 04's abuse controls are sufficient.
- Decide whether trial generations use a cheaper provider path — free users already route to FLUX.1 Schnell when fal.ai is enabled, per `docs/architecture.md`. Verify that path still works and still produces output good enough to convert.

## 8.3 Legal

Paddle as Merchant of Record covers VAT, sales tax, and invoicing. It does not cover:

- Terms of Service, including AI output ownership. **Customers will ask who owns generated sprites and whether they can ship them commercially.** Answer explicitly; it is the single most likely pre-purchase question for an AI art tool.
- Privacy policy and GDPR: what is stored (prompts, emails, generated images), retention, deletion on request. Prompts are stored in `generations.prompt` indefinitely — state this or change it.
- Acceptable use: what prompts are prohibited, and what happens on violation.
- Refund policy, consistent with what Phase 05 implements.
- Provider terms: confirm PixelLab and fal.ai licences permit commercial resale of output. **If they do not, the business model does not work.** Verify this before anything else in this phase.

## 8.4 Distribution

The extension builds to `dist/ai-sprite-generator` and installs via Extension Manager. Decide:

- Cocos Store listing, or direct download from the site?
- Version and update mechanism — a stale extension against a changed API breaks silently.
- Whether `backendUrl` stays user-editable. It is currently editable for development; in production it should default to the hosted API and probably be locked.

Consider an API version negotiation or a minimum-client-version check, so an old extension gets a clear error instead of a confusing failure.

## 8.5 Support

- A contact channel and a stated response expectation.
- Runbook entries from Phase 06 mapped to the questions customers actually ask.
- A documented way to grant goodwill credits — it will be needed in week one, and doing it by hand-editing the database corrupts the ledger. Build it as a ledger-appending operator command.

## 8.6 Pre-launch rehearsal

Walk the entire path as a stranger, on a clean machine, with nothing cached:

1. Land on the site, understand what it does and what it costs.
2. Sign up, verify email.
3. Spend trial credits, successfully generate a sprite in Cocos.
4. Buy the smallest pack.
5. Generate until credits run out; confirm the zero-balance message is clear.
6. Trigger a failure deliberately; confirm the refund lands and is visible.
7. Request account deletion; confirm it works and is legally sufficient.

Any step that requires explanation from the author is a step that loses a customer.

## 8.7 Launch gate

Do not open signups unless all are true:

- [ ] Provider terms permit commercial resale of output.
- [ ] Credit price exceeds measured cost per generation with margin.
- [ ] A backup has been restored and verified (Phase 06).
- [ ] Alerts fire for worker death, queue backlog, and ledger drift (Phase 06).
- [ ] Sandbox purchase, refund, and duplicate webhook all behave correctly (Phase 05).
- [ ] A stranger completes signup to sprite with no operator action (Phase 04).
- [ ] No stranded credits: crash recovery proven (Phase 01).
- [ ] ToS, privacy, acceptable use, refund policy published.
- [ ] Support channel live with a stated response time.
- [ ] Rollback to the previous release tag tested (Phase 03).

## Risks

| Risk                                        | Mitigation                                                            |
| ------------------------------------------- | --------------------------------------------------------------------- |
| Provider terms forbid commercial resale     | Verify first, before any other launch work. This can end the project. |
| Credit price below true cost                | Price from measured `provider_cost_usd`, include failure rate.        |
| Launch traffic exceeds single-VPS capacity  | Soft launch; queue depth alerts; accept rate-limiting over collapse.  |
| Support load exceeds one person             | Runbook, clear docs, honest response-time expectations.               |
| Customers dispute charges for bad AI output | Clear refund policy; QA gate already blocks the worst output.         |

## Open questions

1. Launch publicly, or invite-only first to bound support load?
2. Is there a free tier beyond the one-time trial?
3. Marketing surface — landing page copy, demo video, example sprites?
