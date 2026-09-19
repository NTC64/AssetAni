# Architecture through Phase 5

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

The fake and fal.ai providers implement the same interface. Automated tests use only the fake provider. Turbo generation uses FLUX.2 Turbo Edit with a generated 4×2 pose guide for idle, walk, or attack; Schnell remains a text-to-image fallback. Retryable transport errors use at most three calls with 2-second and 8-second backoff before later attempts plus ±20% jitter. Invalid layout, matte, motion, or character-palette consistency may receive exactly one strict 4x2 regeneration. This generation-level retry stays enabled for fake tests and is disabled for paid fal output by default; the user must press Retry to authorize another billed generation. A final rejected result fails and refunds the application credit instead of importing an unusable clip.

PostgreSQL transitions use a compare-and-update guard against the current status. Terminal states cannot transition. A failed generation stores a stable public error code and sanitized message. Credit charging/refunds, users, API keys, Paddle, R2, recovery scheduling and production deployment remain outside Phase 3.

The panel sends typed commands to the extension main process. `ApiClient` sends the shared generation request, requires HTTP 202, and rejects invalid responses. `GenerationService` polls the authoritative backend status after 2, 4, then 8 seconds for every later attempt. A client timeout leaves the backend generation running; Retry resumes polling the same generation. A terminal backend failure starts a new generation on Retry.

Package downloads must use the backend origin, cannot redirect, and are capped at 32 MiB. Extraction accepts only `manifest.json`, `sheet.png`, and the eight manifest frame paths. It rejects path traversal, duplicate or extra entries, oversized expanded data, generation-ID mismatches, and invalid PNG dimensions before calling Cocos AssetDB. The importer then writes to `db://assets/AI_Sprites/{generationId}`, refreshes the database, resolves SpriteFrame UUIDs in manifest order, and creates `{animation}.anim` through the scene process.

The operation lives in the extension main process, so closing and reopening the panel does not cancel it. The panel reads a snapshot for progress and presents sanitized retryable errors.

Phase 5 stores users, API-key metadata, generations, and the append-only credit ledger in PostgreSQL. Raw keys contain 32 random bytes and are stored only by the client; the database stores an HMAC-SHA256 digest made with `API_KEY_PEPPER`. Authentication checks expiry, revocation, ownership, and route scope.

Generation admission locks the user row. In one transaction it checks user-scoped idempotency, active-generation count, the free-plan cooldown, atomically decrements a nonnegative balance, inserts the generation, and appends the charge ledger entry. Permanent worker failure changes status and appends an idempotent refund while holding generation and user locks. A stalled worker delivery found in a nonterminal state is closed and refunded. Free users route to FLUX.1 Schnell when fal.ai is enabled; other plans use the configured primary model.

Redis token buckets enforce generation and polling limits per API key. PostgreSQL remains authoritative for credits and concurrent-generation limits.
