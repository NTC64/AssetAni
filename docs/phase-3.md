# Phase 3 completion and test procedure

Implemented scope:

- Fastify API with 16 KiB request limit, request IDs, `/health`, `/ready`, POST and polling routes.
- PostgreSQL `generations` table, Drizzle schema/repository and migration.
- Redis/BullMQ queue `sprite-generation` with `jobId = generationId`.
- Worker concurrency default 2, authoritative status transitions, provider retry policy and one strict structural retry.
- Fake provider for automated tests and fal.ai behind the same existing interface.
- Temporary worker directories and local result storage.
- Local package, sheet and manifest download routes.

Automated integration coverage starts a real BullMQ worker against a temporary Redis server and uses Drizzle against PGlite's PostgreSQL engine. It proves:

1. POST returns HTTP 202 while the fake provider is deliberately blocked.
2. BullMQ delivers the UUID job to the worker.
3. The worker calls the provider, processes the sheet and writes the package.
4. GET polling reaches `SUCCEEDED`.
5. The ZIP downloads and validates with eight manifest frames.
6. Duplicate idempotency keys return the same generation.
7. Two invalid structures cause exactly two provider calls, `FAILED`, and no package.

Verification record: frozen-lockfile install, ESLint, Prettier, strict typecheck, 79 automated tests, backend integration, and extension/POC/backend builds all pass. No paid provider call is part of the Phase 3 test suite.

Exact commands and manual request examples are in [development.md](development.md). API shapes are in [api.md](api.md).

Known Phase 3 limits:

- Local result links use API file routes; they are not signed URLs.
- There is no recovery scheduler for jobs orphaned between the database insert and queue add or during a process crash.
- Provider request reconciliation after a hard worker crash is not implemented.
- The global idempotency key becomes per-user in Phase 5.
- Authentication, credit accounting/refunds, Paddle, R2 and production deployment are not present.

Stop after Phase 3.
