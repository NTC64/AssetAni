# Phase 01 — Operational hardening

Depends on: nothing. Blocks: everything.
These are defects in code that already ships. Fix before building on top.

## Context

- `apps/api/src/services/generation-service.ts` — `create()` reserves then enqueues.
- `packages/db/src/repository.ts` — `reserve()`, `failAndRefund()`.
- `packages/core/src/local-storage.ts` — `LocalResultStorage`.
- `apps/api/src/services/generation-service.ts` — `RESULT_TTL_SECONDS = 900`.
- `apps/worker/src/worker.ts` — already calls `cleanupAbandonedTempDirectories()` on boot; same pattern applies here.

## 1.1 Orphaned generation recovery

### Problem

`GenerationService.create()` already wraps `queue.enqueue()` in try/catch and calls `failAndRefund()` on failure. That covers a Redis error. It does **not** cover the API process dying between `repository.reserve()` committing and `queue.enqueue()` returning — crash, OOM kill, container restart, power loss. The row is committed as `QUEUED`, the credit is spent, and no BullMQ job exists. Nothing will ever move that row. The user is charged for nothing.

`docs/phase-5.md` already names this: "The API-to-Redis enqueue window still needs the recovery scheduler planned for production."

### Approach

A periodic reconciler in the worker process (not a new service — YAGNI).

1. Query generations in a non-terminal status whose `created_at` is older than a threshold (start at 5 minutes; `QUEUED` only for the enqueue gap, plus `AI_SUBMITTED`/`AI_RUNNING`/`PROCESSING`/`UPLOADING` for dead-worker recovery).
2. For each, ask BullMQ whether a job with that `jobId` exists.
3. Job exists and is active: leave alone.
4. No job and status is `QUEUED`: re-enqueue. Safe because `jobId = generationId` makes BullMQ deduplicate.
5. No job and status is past `QUEUED`: the worker died mid-flight. Terminate with `failAndRefund()`.

Re-enqueue over refund for `QUEUED` because the user wanted the sprite, not the refund. Only refund when work was already attempted and lost.

### Files

- Create `apps/worker/src/services/generation-reconciler.ts`.
- Modify `apps/worker/src/worker.ts` — start the interval, clear it on shutdown.
- Modify `packages/db/src/repository.ts` — add a query for stale non-terminal generations.
- Modify `packages/queue/src/index.ts` — expose job lookup by id on `GenerationQueue`.
- Modify `apps/worker/src/config.ts` — `RECONCILE_INTERVAL_MS`, `RECONCILE_STALE_AFTER_MS`.
- Modify `.env.example`.

### Validation

New test file `tests/generation-reconciler.test.ts`:

1. Reserve a generation without enqueueing (simulates the crash), run the reconciler, assert a job now exists and the credit was not refunded.
2. Reserve, enqueue, force status to `PROCESSING`, delete the job, run the reconciler, assert `FAILED` and exactly one refund.
3. Run the reconciler twice against the same stranded row; assert still exactly one refund and one job. Idempotency matters — the reconciler runs forever.
4. A healthy in-flight generation is untouched.

### Risks

Reconciler refunding a generation a live worker is still processing. Mitigate with a stale threshold well above the longest expected job (`PIXELLAB_JOB_TIMEOUT_MS` is 180000, so use at least 10 minutes for non-`QUEUED` states) and by checking BullMQ job state, not just existence. `failAndRefund()` already guards terminal states, so a late refund cannot double-refund.

## 1.2 Result file retention

### Problem

`toGenerationResponse()` tells the client `expiresIn: 900`, and the API stops serving files after 15 minutes. But `LocalResultStorage` never deletes anything — `rm` is only called to overwrite the same `generationId`. Every generation leaves `result.zip`, `sheet.png`, `manifest.json`, 8 frames, and `raw.png` on disk forever. The contract says expired; the disk says permanent. The server fills up and the API stops accepting work.

Character base images under `characters/{id}/base.png` are **not** expiring data. A character is reusable by design; deleting its base breaks every future animation. Retention must exclude them.

### Approach

Same shape as `cleanupAbandonedTempDirectories()`: a periodic sweep in the worker.

1. Every N minutes, select generations where `completed_at` is older than the retention window.
2. Delete their storage directory.
3. Null the object-key columns so the API stops advertising URLs for deleted data.

Retention window must exceed `RESULT_TTL_SECONDS` by a wide margin — the client may be mid-download. Start at 24 hours.

### Files

- Modify `packages/core/src/local-storage.ts` — add `deleteGeneration(generationId)`.
- Create `apps/worker/src/services/result-retention.ts`.
- Modify `apps/worker/src/worker.ts`, `apps/worker/src/config.ts`, `.env.example`.
- Modify `packages/db/src/repository.ts` — query expired generations, clear object keys.

### Validation

Extend `tests/generation-status.test.ts` or add `tests/result-retention.test.ts`:

1. A generation completed beyond the window has its directory removed and keys nulled.
2. A generation completed inside the window is untouched.
3. `characters/{id}/base.png` survives a sweep.
4. Sweeping an already-swept generation does not throw.

### Risks

Deleting a result a customer is still downloading. The window is 96x the advertised TTL; accept it. Deleting a character base by path-matching mistake is the real hazard — `deleteGeneration` must reject any id that is not a bare UUID, reusing the existing `generationDirectory` guard.

## 1.3 Continuous integration

### Problem

No `.github/workflows`. Every check is manual. This repo just proved the cost: a formatting violation and four env-dependent test failures sat unnoticed in the working tree.

### Approach

One workflow, `.github/workflows/ci.yml`, on push and pull request to `main`.

- Node 22, pnpm 10.28.2 via `corepack`.
- `pnpm install --frozen-lockfile`.
- Service containers: `postgres:16-alpine`, `redis:7-alpine` — matching `infra/docker-compose.dev.yml`.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.

Runner is Linux, so `redis-memory-server` would work, but pinning the service container makes CI match the documented Windows path and removes a platform-dependent branch from CI reliability.

Set `API_KEY_PEPPER` to a throwaway CI value. No provider keys — tests use the fake provider and must stay that way.

### Files

- Create `.github/workflows/ci.yml`.
- Modify `docs/development.md` — note that CI runs the same four commands.

### Validation

Push a branch with a deliberate lint error; CI must fail. Remove it; CI must pass. Confirm no secret is required for a green run.

### Risks

CI green-washing if the suite silently skips the integration test when Redis is absent. It currently fails loudly instead, which is correct — do not add a skip.

## Phase acceptance

- A generation stranded by an API crash is recovered or refunded within one reconcile interval, proven by test.
- Result storage does not grow without bound, proven by test.
- `main` is protected by an automated run of lint, typecheck, test, build.
- Full suite still passes; no existing test weakened.
