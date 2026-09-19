# Phase 02 — Object storage on R2

Depends on: 01. Blocks: 03.

## Why before deploy

Once the app runs on a VPS, results written to container disk vanish on every redeploy and cannot be shared between API and worker if they ever land on different hosts. Storage must move off local disk before the first real deployment, not after.

## Context

- `packages/core/src/local-storage.ts` — `LocalResultStorage`, the only storage implementation.
- Consumers: `apps/worker/src/jobs/process-generation.ts` (writes), `apps/api/src/app.ts` (reads and serves `/v1/generations/:id/files/:name`).
- `docs/api.md` already states signed URLs are the intended end state and local endpoints are development-only.

## Approach

### 2.1 Extract the interface

`LocalResultStorage` is a concrete class passed directly as `AppDependencies.storage` and into the worker processor. Extract a `ResultStorage` interface from its existing public surface — `persist`, `persistDiagnostics`, `persistCharacterBase`, `readCharacterBase`, `readPublicFile`, and the `deleteGeneration` added in Phase 01 — and have both implementations satisfy it.

Keep `LocalResultStorage` as-is. Tests use it, local development uses it, and it stays the default. This is the one abstraction worth adding: it has two real implementations, not a speculative one.

### 2.2 R2 implementation

Create `R2ResultStorage` using the S3-compatible API. R2 speaks S3, so `@aws-sdk/client-s3` plus `@aws-sdk/s3-request-presigner` works and keeps the door open for plain S3.

Selection by env (`RESULT_STORAGE_DRIVER=local|r2`), resolved in `apps/api/src/config.ts` and `apps/worker/src/config.ts`.

### 2.3 Signed URL delivery

Today `toGenerationResponse()` builds three URLs pointing at the API, and the API streams bytes from disk. Under R2 the API should hand out short-lived presigned URLs so file bytes never transit the app server.

Two options:

- **Presign directly in the response.** Fewer hops, no bandwidth on the VPS. The URL leaks R2 details and cannot be revoked before expiry.
- **Keep the API path and 302-redirect to a presigned URL.** Preserves the public contract in `docs/api.md`, keeps ownership checks at request time, one extra round trip.

Choose the redirect. The ownership check in the current route is a real security control — presigning at response time would grant a URL that outlives a revoked key. Redirect keeps the check on every fetch and keeps the documented URL shape stable, so the Cocos plugin needs no change.

Presign TTL must match `RESULT_TTL_SECONDS` (900) so the advertised `expiresIn` stays honest.

### 2.4 Retention under R2

Phase 01's retention sweep calls `deleteGeneration`. With the interface in place this works unchanged against R2, but deletion is a listing plus batch delete rather than an `rm -rf`. Implement it as such; do not assume a directory exists.

## Files

- Modify `packages/core/src/local-storage.ts` — export the `ResultStorage` interface.
- Create `packages/core/src/r2-storage.ts`.
- Modify `packages/core/src/index.ts` — export both plus a factory.
- Modify `apps/api/src/config.ts`, `apps/worker/src/config.ts` — driver selection.
- Modify `apps/api/src/app.ts` — redirect to presigned URL when the driver is R2.
- Modify `package.json` — add the two AWS SDK packages.
- Modify `.env.example` — `RESULT_STORAGE_DRIVER`, `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
- Modify `docs/architecture.md`, `docs/api.md`, `docs/deployment.md`.

## Validation

- New `tests/result-storage.test.ts`: run the same contract suite against `LocalResultStorage` and a mocked-S3 `R2ResultStorage`, so both provably satisfy the interface.
- Existing integration tests keep using `LocalResultStorage`; do not add a paid or network dependency to the suite.
- Add an API test that a file request under the R2 driver returns 302 with a presigned `location`, and still 404s for a non-owner.
- Manual: real R2 bucket, one generation, confirm the plugin downloads and imports unchanged.

## Risks

| Risk                                                 | Mitigation                                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Presigned URL outlives a revoked API key             | Redirect design keeps auth on every request; TTL capped at 900s.                                  |
| Character base images silently lost on driver switch | Base images are not migrated automatically. Decide explicitly: re-create or copy.                 |
| R2 egress or operation cost surprises                | Measure in Phase 08 pricing; R2 has no egress fee, class-A operations still cost.                 |
| SDK bloat in the Cocos extension bundle              | Storage lives in `packages/core`, used by API/worker only. Verify bundle size after `pnpm build`. |

## Phase acceptance

- Both storage drivers pass one shared contract test.
- With `RESULT_STORAGE_DRIVER=r2`, a full generation succeeds and the plugin imports the result unchanged.
- No result bytes are stored on the app server under the R2 driver.
- Ownership enforcement is unchanged, proven by test.
