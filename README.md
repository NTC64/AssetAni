# AI Sprite Sheet & Animation Generator

A Cocos Creator 3.8.x sprite workflow backed by a TypeScript modular monolith. Phase 5 adds scoped API-key authentication, atomic credit accounting, a three-credit free trial, concurrency controls, and Redis-backed rate limiting.

## Current architecture

```text
Cocos extension -- Bearer API key --> Fastify API :3000 --> PostgreSQL 16+
      ^                    |
      |                    +--> Redis 7 / BullMQ --> Worker
      |                                              --> fake or fal.ai
      |                                              --> Sharp processing
      +-- result.zip <-- local result filesystem <---+
```

`POST /v1/generations` validates and enqueues a generation, then returns HTTP 202 without waiting for AI inference. `GET /v1/generations/:id` polls the authoritative PostgreSQL status. The worker creates `manifest.json`, `sheet.png`, eight normalized PNG frames and `result.zip`.

The extension submits work without blocking the editor, polls with exponential delays capped at eight seconds, downloads only same-origin packages, safely extracts the expected ten files, and imports the generated animation under `assets/AI_Sprites/{generationId}`. Each accepted generation atomically reserves one credit. Permanent failure writes one idempotent refund.

Phase 5 intentionally excludes Paddle, R2 and production deployment.

## Requirements

- Node.js 22
- pnpm 10.28.2
- Docker Desktop for the manual PostgreSQL/Redis development flow
- Cocos Creator 3.8.x for plugin testing only

## Install and verify

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Tests use the fake AI provider and never consume fal.ai credit. The backend integration test starts a temporary Redis process, runs a real BullMQ queue/worker, uses Drizzle with a PostgreSQL-compatible embedded engine, and validates the final ZIP.

## Run Phase 5 locally

Copy `.env.example` to ignored `.env`, set a private `API_KEY_PEPPER` and `PIXELLAB_API_TOKEN`, then run:

```sh
pnpm docker:dev
pnpm db:migrate
pnpm user:create --email developer@example.com --name "Local Cocos"
```

Start the API and worker in separate terminals:

```sh
pnpm dev:api
pnpm dev:worker
```

Copy the newly printed API key into the Cocos panel. See the [Phase 5 procedure](docs/phase-5.md), [API contract](docs/api.md), and [development commands](docs/development.md).

## Repository structure

```text
apps/
  api/                         Fastify application and generation service
  worker/                      BullMQ worker and generation processor
  cocos-plugin/                Cocos Creator 3.8 extension
packages/
  ai/                          shared fake/PixelLab/fal provider interface
  contracts/                   Zod manifests and HTTP contracts
  core/                        status machine, temp files, local storage
  db/                          Drizzle schema, client and repository
  image/                       Sharp slicing and normalization
  queue/                       BullMQ queue and worker adapters
migrations/                    PostgreSQL SQL migrations
infra/docker-compose.dev.yml   local PostgreSQL and Redis only
scripts/                       build and Phase 2 POC scripts
tests/                         unit and integration tests
docs/                          API, architecture and test procedures
```

## Phase status

- Phase 1: manually verified in Cocos Creator 3.8.x.
- Phase 2: manually verified.
- Phase 3: manually verified.
- Phase 4: implemented with automated client, polling, extraction, and import coverage.
- Phase 5: implemented with concurrent credit and retry/refund coverage.
- Phase 6 and later: not started.

The local backend is authenticated but is still a development service without TLS or production hardening.
