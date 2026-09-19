# AssetRun — Project analysis and cleanup

Date: 2026-09-19 | Branch: `main` | Range: `ae2765e..fced3b6`

## 1. What the project is

AI sprite sheet generator for Cocos Creator 3.8. TypeScript modular monolith, pnpm workspace, ~12k LOC.

```text
Cocos plugin --Bearer key--> Fastify API :3000 --> PostgreSQL (source of truth)
                                  |
                             Redis/BullMQ --> Worker --> PixelLab / fal.ai
                                                      --> Sharp normalize + QA
                                                      --> result.zip
```

`POST /v1/generations` returns 202 immediately; worker runs async; client polls. Output: `manifest.json`, `sheet.png`, 8 PNG frames, `result.zip`. Plugin extracts and creates `.anim` clips.

Layout: `apps/{api,worker,cocos-plugin}`, `packages/{ai,contracts,core,db,image,queue}`, 3 SQL migrations, 11 test files.

## 2. Baseline assessment (before changes)

Strengths:

- Clean module boundaries, no over-engineering.
- Contract-first (Zod) shared between client and server.
- Money handling rigorous: row lock + single transaction + append-only ledger + exactly-once refund + per-user idempotency.
- ZIP extraction hardened: path traversal, 32 MiB cap, exact 10-file allowlist, PNG dimension check.
- API keys stored as HMAC-SHA256 with pepper, never plaintext.
- Tests never call paid providers.

Findings:

| #   | Severity | Finding                                                                                                                                                                                               |
| --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Critical | Phases 3/4/5 + character pipeline entirely untracked in Git. 4 commits total, messages `first commit`/`comit`/`comit`/`109`. Total loss risk.                                                         |
| 2   | High     | `.env` had duplicate `FAL_KEY` (line 5 real 69-char, line 18 junk 16-char). Last wins in Node env parsing, so fal.ai fallback was silently using a bad key.                                           |
| 3   | Medium   | `pnpm lint` failing: `packages/core/src/temp-files.ts` not Prettier-formatted.                                                                                                                        |
| 4   | Medium   | 4/138 tests failing — environment only (`redis-memory-server` unavailable, Docker down, `ECONNREFUSED 127.0.0.1:6379`). Not a code defect.                                                            |
| 5   | Medium   | Doc drift: README claimed "Phase 6 not started" while the character pipeline was implemented; `architecture.md` stopped at Phase 5.                                                                   |
| 6   | Medium   | `precise` animation mode is a placeholder. `orchestrator.ts` interpolates all skeleton keypoints on one sine curve — identical motion for walk/attack/death. Billable path producing unusable frames. |
| 7   | Low      | `pnpm` not on PATH on this machine (only `D:\node.exe`). Ran binaries directly.                                                                                                                       |

## 3. Work done

All 6 items completed, verified, pushed to `origin/main`.

### 3.1 Git hygiene (finding 1)

Split into 8 commits by phase, then 3 more for the fixes:

```text
6b0e48d chore: workspace tooling, build scripts, ignore rules
b51fed0 feat(ai): provider interface, prompt builder, shared contracts
ec38c6f feat(image): Sharp slicing, normalization, packaging
d00a491 feat(backend): Fastify API, BullMQ worker, PostgreSQL store
7b4f0f6 feat(cocos-plugin): extension, polling, safe extraction, import
7162994 feat(auth): scoped API keys, credit ledger, rate limiting
4ccbbfd feat(characters): character pipeline, presets, QA gating
fd98207 docs: architecture, API contract, phase procedures
db07f1d style: Prettier on temp file helper
f779c24 fix(contracts): reject precise animation mode at API boundary
fced3b6 docs: character pipeline and unsupported precise mode
```

Accepted tradeoff: intermediate commits do not build standalone. Shared files (`contracts/index.ts`, `app.ts`) contain multi-phase changes that cannot be split without interactive staging. Only HEAD is a valid build.

Also excluded 8 MB of debug output from Git: `.gitignore` now ignores `artifacts/` (previously only two subdirectories) and `.runtime-temp/`.

Secret scan before push: no `.env` anywhere in history; no key-shaped strings in tracked files.

### 3.2 `.env` duplicate key (finding 2)

Removed the trailing junk `FAL_KEY`. Now exactly one occurrence, the 69-char value. A temporary `.env.bak` was created and deleted immediately — it would not have been ignored, since the pattern is `.env`, not `.env*`.

### 3.3 Formatting (finding 3)

`prettier --write packages/core/src/temp-files.ts`. Repo now fully Prettier-clean.

### 3.4 Test environment (finding 4)

Docker Desktop was installed at a non-default path (`%LOCALAPPDATA%\Programs\DockerDesktop`), daemon not running. Started it, brought up `infra/docker-compose.dev.yml` (postgres:16-alpine + redis:7-alpine, both healthy).

Result: **138/138 pass**, suite time 120s to 21s. Confirms finding 4 was environmental.

### 3.5 Precise animation (finding 6)

Chosen approach: reject at the API boundary; keep the code path for future work.

- Added `animationModeSchema` in `packages/contracts` — one shared definition (DRY), rejects `precise` with a clear message, defaults to `standard`.
- Applied to `characterAnimationRequestSchema` and `characterBatchRequestSchema`; the Cocos `characterBatchCommandSchema` now imports the same schema instead of duplicating the enum.
- Annotated the placeholder interpolation in `orchestrator.ts` explaining why it is fake and the precondition for re-enabling it.
- Added an API-level assertion to `tests/character-pipeline.test.ts`: `mode: 'precise'` returns HTTP 400.

Net effect: no credit is reserved for a request that would return unusable frames. The orchestrator skeleton path is untouched and still covered by its unit test.

### 3.6 Documentation (finding 5)

- `README.md`: intro mentions the character pipeline; phase status replaces the false "Phase 6 not started" with the real state plus the `precise` caveat.
- `docs/architecture.md`: retitled from "Architecture through Phase 5"; new `## Character animation pipeline` section covering additive reuse of `generations`, `AIOrchestrator` provider routing, character reuse and per-animation credit, code-only presets, deterministic `runAnimationQa` (PASS/WARN/FAIL), and the `precise` gap.
- `docs/api.md`: removed the contradictory "standard or precise" bullet; documented the 400.
- `CODEX_HANDOFF.md`: orchestrator description synced.

## 4. Final verification

| Gate                     | Result                                      |
| ------------------------ | ------------------------------------------- |
| `tsc --noEmit`           | pass                                        |
| `eslint`                 | pass                                        |
| `prettier --check .`     | pass                                        |
| `node scripts/build.mjs` | pass (extension + ai-poc + backend bundles) |
| `vitest run`             | 138/138 pass                                |
| `git status`             | clean, `main` equals `origin/main`          |

## 5. Known gaps (not addressed — out of scope)

- Skeleton `precise` animation still unimplemented. Needs real per-animation keyframes against the PixelLab skeleton API.
- No production deployment: Paddle billing, R2 storage, signed URLs, TLS, container hardening all deferred.
- `redis-memory-server` does not work on this Windows machine; the integration test requires Docker services to be up. Not documented as a prerequisite in `docs/development.md`.
- `pnpm` missing from PATH; `corepack enable` would fix it.

## 6. Unresolved questions

1. Should `docs/development.md` state that `pnpm docker:dev` is required before `pnpm test`, or should the integration test skip itself when Redis is unreachable?
2. Is `precise` animation on the roadmap, or should the `mode` field and the orchestrator skeleton path be removed entirely?
3. The 4 pre-existing commits have non-descriptive messages (`comit`, `109`). Rewrite history, or leave as-is since it is already pushed?
