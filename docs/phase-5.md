# Phase 5 completion and test procedure

Phase 5 adds commercial authentication and credits without Paddle.

Implemented behavior:

- Users receive three lifetime trial credits when provisioned.
- API keys contain 32 random bytes, use the `spr_live_` format, expire after 180 days, and are stored as HMAC-SHA256 hashes using `API_KEY_PEPPER`.
- Plugin scopes are `generation:create`, `generation:read`, and `credit:read`.
- Each accepted generation reserves one credit atomically with generation and ledger insertion.
- User-scoped idempotency prevents duplicate charge and queue delivery.
- Permanent generation failure refunds exactly once, including repeated or recovered worker delivery.
- Free accounts allow one active generation with a 30-second cooldown. Other plans allow two.
- Redis enforces generate 10/minute with burst 2 and polling 60/minute per API key.
- The Cocos panel stores its key in the extension's local profile and sends it for POST, polling, and package download.

## Exact local commands

Create ignored `.env` from `.env.example`, then generate and set a unique pepper:

```sh
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
pnpm docker:dev
pnpm db:migrate
pnpm user:create --email developer@example.com --name "Local Cocos"
```

Copy the printed API key immediately; it cannot be read from the database later. Start both processes:

```sh
pnpm dev:api
```

```sh
pnpm dev:worker
```

Build and reload `dist/ai-sprite-generator` in Cocos Creator 3.8.x:

```sh
pnpm build
```

Paste the key into the plugin, enter a prompt, and click **Generate and Import**. A successful first trial request reports two remaining credits. A permanent fake-provider failure restores the reserved credit.

## Automated verification

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The Phase 5 suite launches concurrent database transactions and proves:

1. Twenty reservations competing for one credit produce one successful charge and a zero balance.
2. Concurrent requests with one idempotency key create one generation and one charge.
3. Twenty simultaneous failure retries create one refund and restore the exact prior balance.
4. Free concurrency and cooldown rules reject excess work before charging.
5. Authentication, expiry, scopes, ownership, HTTP 402, Redis rate limiting, and the three-credit grant follow the public contract.

Current limits: user and key provisioning is an operator CLI until Paddle onboarding exists; there is no self-service key rotation or account recovery UI. The API-to-Redis enqueue window still needs the recovery scheduler planned for production. The Cocos local profile contains the usable client key, so compromised developer machines require key revocation.

Paddle is not implemented. Stop after Phase 5.
