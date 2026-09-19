# Architecture

Phase 3 is a modular monolith with two Node.js processes:

```text
Cocos panel --> extension main process -- Bearer key --> Fastify API --> PostgreSQL
                    ^                      |
                    |                      v
                    |               Redis / BullMQ --> Worker
                    |                                  --> AiProvider
                    |                                  --> Sharp
                    +-- validated result.zip <-- local filesystem
```

The API validates requests, writes the generation row, and enqueues a small `{ generationId }` job. PostgreSQL is the source of truth. Redis contains no prompt, image, or result package beyond the job identifier. BullMQ uses queue `sprite-generation` and the generation UUID as `jobId`.

The worker reads the request from PostgreSQL, moves it through the explicit state machine, calls the selected `AiProvider`, runs the Phase 2 Sharp pipeline, creates the manifest/sheet/frames ZIP, and copies the output from an isolated temporary directory to `RESULT_STORAGE_PATH/{generationId}`. Temporary directories are always removed in `finally`; directories older than two hours are cleaned when the worker starts.

The fake and fal.ai providers implement the same interface. Automated tests use only the fake provider. Turbo generation uses FLUX.2 Turbo Edit with a generated 4×2 pose guide for idle, walk, or attack; Schnell remains a text-to-image fallback. Retryable transport errors use at most three calls with 2-second and 8-second backoff before later attempts plus ±20% jitter. A retry re-runs the whole provider call, so only failures raised _before_ a job is accepted are retryable. PixelLab bills a background job from acceptance, so a poll failure or job timeout is reported as non-retryable: retrying would submit a second paid job for work already charged. Invalid layout, matte, motion, or character-palette consistency may receive exactly one strict 4x2 regeneration. This generation-level retry stays enabled for fake tests and is disabled for paid fal output by default; the user must press Retry to authorize another billed generation. A final rejected result fails and refunds the application credit instead of importing an unusable clip.

PostgreSQL transitions use a compare-and-update guard against the current status. Terminal states cannot transition. A failed generation stores a stable public error code and sanitized message. Credit charging/refunds, users, API keys, Paddle, R2, recovery scheduling and production deployment remain outside Phase 3.

The panel sends typed commands to the extension main process. `ApiClient` sends the shared generation request, requires HTTP 202, and rejects invalid responses. `GenerationService` polls the authoritative backend status after 2, 4, then 8 seconds for every later attempt. A client timeout leaves the backend generation running; Retry resumes polling the same generation. A terminal backend failure starts a new generation on Retry.

Package downloads must use the backend origin, cannot redirect, and are capped at 32 MiB. Extraction accepts only `manifest.json`, `sheet.png`, and the eight manifest frame paths. It rejects path traversal, duplicate or extra entries, oversized expanded data, generation-ID mismatches, and invalid PNG dimensions before calling Cocos AssetDB. The importer then writes to `db://assets/AI_Sprites/{generationId}`, refreshes the database, resolves SpriteFrame UUIDs in manifest order, and creates `{animation}.anim` through the scene process.

The operation lives in the extension main process, so closing and reopening the panel does not cancel it. The panel reads a snapshot for progress and presents sanitized retryable errors.

Phase 5 stores users, API-key metadata, generations, and the append-only credit ledger in PostgreSQL. Raw keys contain 32 random bytes and are stored only by the client; the database stores an HMAC-SHA256 digest made with `API_KEY_PEPPER`. Authentication checks expiry, revocation, ownership, and route scope.

Generation admission locks the user row. In one transaction it checks user-scoped idempotency, active-generation count, the free-plan cooldown, atomically decrements a nonnegative balance, inserts the generation, and appends the charge ledger entry. Permanent worker failure changes status and appends an idempotent refund while holding generation and user locks. A stalled worker delivery found in a nonterminal state is closed and refunded. Free users route to FLUX.1 Schnell when fal.ai is enabled; other plans use the configured primary model.

Redis token buckets enforce generation and polling limits per API key. PostgreSQL remains authoritative for credits and concurrent-generation limits.

## Character animation pipeline

The pipeline is additive: it reuses the existing `generations` table, BullMQ queue, credit reservation, polling, failure handling, and exactly-once refund. Migration `0002_characters_batches.sql` adds `characters`, `character_animations`, and `generation_batches`.

`AIOrchestrator` in `packages/ai` sits in front of the providers. PixelLab is the primary provider for base-character creation, text-driven animation, and rotations. fal.ai stays available for concept images and as the base-creation fallback when `allowFallback` is set. The orchestrator never talks to storage or the database; the worker still owns persistence.

A character is created once and reused. `POST /v1/characters` queues a base-character generation; each later `POST /v1/characters/:id/animations` or `POST /v1/characters/:id/batches` reserves its own credit and inserts one normal generation row per animation, linked by `character_id` and optionally `batch_id`. Clients keep polling `GET /v1/generations/:id`, so there is no second status protocol.

Presets live in code only, in `packages/core/src/presets.ts`: `platformer`, `side_scroller`, and `top_down_rpg`. A preset fixes frame size, per-animation fps, the available animations, the directions, and the pivot. Explicit request fields override individual preset values.

Provider frames pass through the same Sharp normalization as single generations, then through `runAnimationQa` in `packages/image`. QA is deterministic and provider-independent: it checks frame count, exact dimensions, foreground ratio, baseline stability, bounding boxes, and adjacent-frame difference, and returns `PASS`, `WARN`, or `FAIL`. The result is stored on the generation and the character animation row. `FAIL` stops packaging.

Skeleton-driven `precise` animation is not implemented. `animationModeSchema` in `packages/contracts` rejects it, so requests fail validation with HTTP 400 before a credit is reserved. The orchestrator still contains an unused skeleton code path whose pose interpolation is a placeholder: every keypoint follows the same sine curve regardless of animation type. That code must be replaced with real per-animation keyframes before the mode is re-enabled.

The Cocos extension keeps the single-generation path unchanged and adds named batch folders plus `{character}_{animation}.anim` clips.
