# Phase 04 — Remove the backend

Depends on: 03. Blocks: 05.
Nothing is deleted before the replacement is proven. That proof is Phase 03.

## Scope

| Delete                                                                 | Lines | Why it existed                      |
| ---------------------------------------------------------------------- | ----- | ----------------------------------- |
| `apps/api`                                                             | 1,091 | HTTP boundary, auth, rate limits    |
| `apps/worker`                                                          | 651   | Async job execution                 |
| `packages/db`                                                          | 907   | Accounts, credits, generation state |
| `packages/queue`                                                       | 175   | BullMQ and Redis                    |
| `packages/ai/src/fal-provider`                                         | 501   | Second provider                     |
| `packages/ai/src/pose-guide`                                           | 276   | fal-only pose guides                |
| `migrations/`, `infra/`                                                | —     | PostgreSQL schema, Compose          |
| `drizzle.config.ts`                                                    | —     | ORM config                          |
| Backend scripts                                                        | —     | migrate, create-user, build-backend |
| `packages/core`: `api-key.ts`, `local-storage.ts`, `status-machine.ts` | ~200  | Server-side auth, storage, state    |
| `packages/image`: `grid.ts`, `package.ts`                              | —     | Grid slicing (fal), ZIP packaging   |
| Sharp dependency                                                       | —     | Replaced in Phase 01                |

Keep `packages/core/src/presets.ts` — the extension uses it. Keep `temp-files.ts` if Phase 03's temp directory approach kept it.

## Tests

Delete tests for deleted code: `backend-integration`, `phase5-commercial`, `character-pipeline` (API-level parts), `generation-status`, `provider-retry`, `ai.test.ts` fal cases, `ai-poc`.

Keep `image-equivalence` until Sharp is removed, then delete it with Sharp — it exists solely to compare against Sharp.

Do not keep a test whose subject is gone. A test suite that passes because it tests nothing is worse than a smaller suite.

Count before and after, and state what coverage was lost and why it no longer matters. "Twenty tests deleted" should be explainable, not discovered later.

## Dependencies to drop

`fastify`, `bullmq`, `ioredis`, `pg`, `drizzle-orm`, `drizzle-kit`, `sharp`, `@electric-sql/pglite`, `redis-memory-server`, `@types/pg`.

`fflate` goes if ZIP handling is fully gone. `zod` stays — contracts and config still validate. `undici` stays.

## Configuration

`.env` collapses from sixteen variables to roughly none. The PixelLab token lives in the extension's profile, not in a dotenv file. Poll interval and timeout become extension settings or constants.

Delete `.env.example` or reduce it to whatever remains for development.

## Documentation

This is a larger job than the deletion. Every document describes a system that will no longer exist:

- `README.md` — architecture diagram, phase status, repository structure, install steps.
- `docs/architecture.md` — entirely about the two-process backend.
- `docs/api.md` — documents an API that is being deleted. Remove it.
- `docs/deployment.md` — no deployment exists. Remove or replace with "install the extension".
- `docs/development.md` — Docker, migrations, two dev servers, all gone.
- `docs/phase-3.md`, `phase-4.md`, `phase-5.md` — historical records of a discontinued direction. Decide: keep as history, or delete. Recommend keeping `phase-1`/`phase-2` (image and Cocos work, still relevant) and removing `3`–`5`.
- `CODEX_HANDOFF.md` — rewrite.

Stale documentation is worse than none: it sends the next person down a path that no longer exists.

## Plans

`plans/260919-1746-saas-launch/` describes a model being abandoned. `plans/260919-1919-top-down-directions/` is still valid — the multi-direction defect exists regardless of architecture, though its phases referencing API routes and credits need revision.

Mark the SaaS plan superseded rather than deleting it. It records why the direction changed, which is worth keeping.

## Validation

1. Full suite passes after deletion, with the reduced count explained.
2. `pnpm build` produces only the extension.
3. No import references a deleted module — typecheck proves this.
4. No native binary in the bundle.
5. Bundle size measured and reported. Removing Sharp should shrink it substantially.
6. Fresh clone, `pnpm install`, `pnpm build`, install in Creator, generate a sprite — with no Docker, no database, no `.env`.

## Risks

| Risk                                                | Mitigation                                                 |
| --------------------------------------------------- | ---------------------------------------------------------- |
| Deleting something the extension quietly depends on | Typecheck plus full manual run after deletion.             |
| Losing test coverage without noticing               | Count and explain before/after.                            |
| Stale docs pointing at a deleted architecture       | Documentation is part of this phase, not a follow-up.      |
| Regret — needing the backend later                  | It is in git history. Recovery is a revert, not a rewrite. |

## Phase acceptance

- Roughly 3,900 lines removed, with nothing referencing them.
- Fresh clone to working extension with no infrastructure.
- All documentation describes the system that actually exists.
- Bundle contains no native binary.
