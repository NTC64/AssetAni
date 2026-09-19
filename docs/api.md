# Phase 5 HTTP API

The local Fastify API listens on `127.0.0.1:3000` by default. Every `/v1` route requires `Authorization: Bearer spr_live_…`. `/health` and `/ready` remain unauthenticated probes.

Plugin keys can contain only `generation:create`, `generation:read`, and `credit:read`. Missing, revoked, out-of-scope, or malformed keys return `INVALID_API_KEY`; expired keys return `API_KEY_EXPIRED`.

## Account and credits

`GET /v1/me` returns the authenticated user, plan, subscription status, and non-secret API-key metadata. `GET /v1/me/credits` requires `credit:read` and returns:

```json
{ "balance": 3 }
```

## Health

`GET /health` returns HTTP 200 without checking dependencies:

```json
{ "status": "ok" }
```

`GET /ready` checks PostgreSQL and Redis. It returns HTTP 200 with `{"status":"ready"}` or HTTP 503 with `{"status":"not_ready"}`. It never calls fal.ai.

## Create a generation

`POST /v1/generations` requires `Content-Type: application/json` and a UUID `Idempotency-Key`. The body limit is 16 KiB.

```json
{
  "prompt": "dark knight carrying a red sword",
  "style": "pixel_art",
  "animation": "walk",
  "direction": "right",
  "frameCount": 8,
  "fps": 12,
  "frameSize": 256,
  "background": "transparent",
  "seed": null
}
```

The endpoint inserts a `QUEUED` database row, adds a BullMQ job with `jobId = generationId`, and returns HTTP 202. It does not wait for AI inference or Sharp processing.

```json
{
  "id": "01996aaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  "status": "QUEUED",
  "progress": 5,
  "creditCharged": 1,
  "creditsRemaining": 2,
  "pollAfterMs": 2000
}
```

Reusing the same idempotency key for the same user returns the original generation without another charge or queue job. A key is valid independently for each user.

One credit is reserved in the same PostgreSQL transaction that inserts the generation and charge ledger entry. A zero balance returns HTTP 402 with `INSUFFICIENT_CREDIT`. Free accounts allow one active generation and a 30-second cooldown; paid plans allow two active generations. Admission and rate limits return HTTP 429 with `RATE_LIMITED` and `Retry-After`.

## Poll a generation

`GET /v1/generations/:id` returns the stored authoritative state. Clients must not infer completion from progress.

Successful response:

```json
{
  "id": "01996aaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  "status": "SUCCEEDED",
  "progress": 100,
  "result": {
    "packageUrl": "http://localhost:3000/v1/generations/01996aaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/files/result.zip",
    "sheetUrl": "http://localhost:3000/v1/generations/01996aaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/files/sheet.png",
    "manifestUrl": "http://localhost:3000/v1/generations/01996aaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/files/manifest.json",
    "expiresIn": 900
  }
}
```

The three result URLs are local development endpoints backed by `RESULT_STORAGE_PATH` and are served for 15 minutes after completion. Signed R2 URLs are deferred.

## States

The exact states are `QUEUED`, `AI_SUBMITTED`, `AI_RUNNING`, `PROCESSING`, `UPLOADING`, `SUCCEEDED`, `FAILED`, and `CANCELED`. A structural image failure may move `PROCESSING` back to `AI_SUBMITTED` for the single strict-layout retry.

Errors use:

```json
{
  "error": {
    "code": "GENERATION_NOT_FOUND",
    "message": "Generation was not found.",
    "requestId": "req_..."
  }
}
```

Stack traces, raw API keys, hashes, and provider response bodies are not returned. Generation and result lookups are restricted to the authenticated owner.

Generate uses a Redis token bucket with 10 requests/minute and burst capacity 2 per API key. Polling and credit reads allow 60 requests/minute per API key.

# Character endpoints

All character endpoints use the existing Bearer API key and generation scopes. POST requests require a UUID `Idempotency-Key` and return HTTP 202.

- `POST /v1/characters` creates a reusable base character.
- `GET /v1/characters` lists the authenticated user's characters and animations.
- `GET /v1/characters/:id` returns one character and its animation QA state.
- `POST /v1/characters/:id/animations` queues one standard or precise animation.
- `POST /v1/characters/:id/batches` creates one normal child generation per requested animation.

Each child continues to use `GET /v1/generations/:id` for polling and result URLs. A child reserves one credit and uses the existing exactly-once failure refund.
