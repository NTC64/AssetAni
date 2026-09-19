# Phase 03 — Production packaging and deploy

Depends on: 02. Blocks: 04, 06.
First phase where a real user could reach the system.

## Context

- `docs/deployment.md` states there is no production configuration and names the intended pieces: Caddy, production Dockerfiles, GHCR publishing, managed PostgreSQL, secret provisioning.
- `infra/docker-compose.dev.yml` is development-only and binds to `127.0.0.1`.
- `scripts/build.mjs` already produces `dist/backend/api.cjs` and `dist/backend/worker.cjs` — bundled CJS, so the runtime image needs no `node_modules` except native deps.

## Hard constraint

Sharp ships platform-specific native binaries. The build host and the runtime image must agree on libc. Build inside the image on `node:22-bookworm-slim`, or install the matching optional dependency explicitly. Do not copy a Windows-built `node_modules` into a Linux image.

## Approach

### 3.1 Runtime images

Two images from one multi-stage Dockerfile, differing only in entrypoint:

- builder stage: `pnpm install --frozen-lockfile`, `pnpm build`.
- runtime stage: `node:22-bookworm-slim`, non-root user, copy `dist/backend`, copy the Sharp native dependency, `NODE_ENV=production`.
- `api` target runs `dist/backend/api.cjs`; `worker` target runs `dist/backend/worker.cjs`.

Pin the base image by digest. Add `.dockerignore` covering `node_modules`, `dist`, `artifacts`, `.git`, `.env`.

### 3.2 Migrations on deploy

`pnpm db:migrate` is currently manual. In production it must run exactly once per deploy, before the API starts, and never concurrently from two containers. Run it as a one-shot job that both services wait on. Do not run migrations from the API entrypoint — two replicas would race.

### 3.3 Compose for production

`infra/docker-compose.prod.yml`, separate from the dev file:

- `api`, `worker`, `migrate` (one-shot), `postgres`, `redis`, `caddy`.
- Explicit `mem_limit` on `worker` — Sharp is memory-hungry and `WORKER_CONCURRENCY` multiplies it. Start with concurrency 2 and measure.
- `restart: unless-stopped` everywhere.
- Healthchecks: API on `/ready` (already checks PostgreSQL and Redis), Postgres on `pg_isready`, Redis on `redis-cli ping`.
- No published port except Caddy's 80/443. Postgres and Redis stay on the internal network with no host binding.

### 3.4 Caddy and TLS

`infra/Caddyfile`. Caddy obtains and renews Let's Encrypt certificates automatically. Route the apex or `app.` host to `apps/web` (Phase 04) and `api.` to the Fastify API. Until Phase 04 exists, route everything to the API.

Add security headers: HSTS, `X-Content-Type-Options`, a restrictive `Referrer-Policy`. Do not put a CSP on the API; add it in Phase 04 where HTML is served.

### 3.5 Secrets

No secrets in the repo, in the image, or in compose files. Coolify holds them as environment variables per service. `API_KEY_PEPPER` is the critical one: **changing it invalidates every existing API key**, because keys are stored as HMAC digests with no way to rehash. Document it as permanent and back it up separately from the database.

### 3.6 Registry and deploy

Extend `.github/workflows/ci.yml` from Phase 01, or add `release.yml`: on a tag, build both images and push to GHCR. Coolify pulls by tag. Deploy by moving the tag, roll back by moving it back.

## Files

- Create `Dockerfile`, `.dockerignore`, `infra/docker-compose.prod.yml`, `infra/Caddyfile`.
- Create `.github/workflows/release.yml`.
- Rewrite `docs/deployment.md` — it currently says no production configuration exists.
- Modify `.env.example` — mark production-only variables.

## Validation

1. `docker compose -f infra/docker-compose.prod.yml up` on a clean Linux host, with fake provider, completes a generation end-to-end.
2. `docker image inspect` confirms non-root user.
3. Confirm Postgres and Redis are unreachable from outside the host.
4. `curl https://api.<domain>/health` returns 200 over valid TLS.
5. Kill the worker container mid-generation; confirm Phase 01's reconciler recovers or refunds it.
6. Redeploy and confirm no result files are lost (they are in R2 after Phase 02).

## Risks

| Risk                                                 | Mitigation                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------- |
| Sharp native mismatch between build and runtime      | Build inside the image; smoke-test image generation in CI before release. |
| Concurrent migrations from parallel containers       | One-shot migrate job as a dependency of both services.                    |
| `API_KEY_PEPPER` lost or rotated, bricking every key | Documented as permanent, backed up separately, never rotated casually.    |
| VPS out of memory under concurrent Sharp jobs        | Explicit memory limits, conservative `WORKER_CONCURRENCY`, alert in 06.   |
| Exposing the service before observability exists     | Do not point DNS at the host until Phase 06 is done.                      |

## Phase acceptance

- Both images build reproducibly from a clean checkout on Linux.
- A full generation succeeds against the production compose stack.
- TLS valid, only 80/443 exposed, database and cache unreachable externally.
- Migrations run exactly once per deploy.
- Rollback to the previous tag is tested, not assumed.
