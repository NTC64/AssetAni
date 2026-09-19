# Phase 02 — Rotation generation

Depends on: 01. Blocks: 03.

## Problem

`AIOrchestrator.generateDirections()` and `pixellabProvider.generateDirections()` are implemented, tested, and unreachable. The worker calls exactly two orchestrator methods — `createCharacter` and `generateAnimation`. There is no route, no generation kind, and no job that reaches rotation.

## What the call does

`POST /generate-8-rotations-v3` with the base image and prompt, returning one job whose result is eight static images in `PIXELLAB_DIRECTION_ORDER`. The provider already throws `INVALID_OUTPUT` if it returns other than eight. One call, one credit.

## Approach

### 2.1 A new generation kind

`generations.generation_kind` is a `varchar(16)` defaulting to `'animation'`, with `'character'` already in use. Add `'directions'`.

This deliberately reuses everything: admission reserves one credit atomically, the row is polled through `GET /v1/generations/:id`, failure refunds exactly once, and the Phase 01 reconciler from the SaaS plan will recover it if the API dies mid-enqueue. No new status protocol, no new billing path.

### 2.2 API surface

`POST /v1/characters/:id/directions`, matching the existing character routes: Bearer key, `generation:create` scope, UUID `Idempotency-Key`, HTTP 202, owner-scoped.

Reject when the character is not `READY` — rotation needs a finished base image. `CharacterService.animate` already enforces exactly this with `CHARACTER_NOT_READY`; reuse that check rather than writing a second one.

Reject when directions already exist, unless the caller explicitly asks to regenerate. Silently re-charging for images the user already owns is the kind of thing that generates chargebacks.

### 2.3 Worker handler

A `generateCharacterDirections` branch beside `createCharacterBase` and `generateCharacterAnimation`, following the same shape those two already use:

1. Load the character, require `READY` and a `base_asset_key`.
2. Transition `AI_SUBMITTED` then `AI_RUNNING`.
3. Read the base image via `readCharacterBase`.
4. Call `orchestrator.generateDirections({baseCharacter, prompt, seed})`.
5. Transition `PROCESSING`, recording provider, model, job id, and `providerCostUsd` exactly as the animation path does.
6. Normalize each of the eight frames through `normalizeFrame` at the character's frame size. Rotations must match the base image's geometry or animations built from them will not align.
7. Persist each through `persistCharacterDirection` and `saveDirection`.
8. Transition `SUCCEEDED`.

Persist all eight or none. A partial set produces characters that animate in some directions and silently fall back in others — worse than a clean failure the user can retry.

### 2.4 QA

`runAnimationQa` checks motion between adjacent frames. Rotations are eight different poses, not a motion sequence, so that gate does not apply. Apply only the structural checks that do: frame count is eight, dimensions match the frame size, and each image has visible foreground. Do not run the motion or palette-consistency gates — they would reject correct output.

If that split is not cleanly available in `packages/image/src/qa.ts`, extract the structural checks rather than duplicating them.

## Files

- Modify `packages/contracts/src/index.ts` — request and response schemas for the new route.
- Modify `apps/api/src/app.ts` — register the route.
- Modify `apps/api/src/services/character-service.ts` — a `generateDirections` method.
- Modify `apps/worker/src/jobs/process-generation.ts` — the new branch and its dispatch.
- Modify `packages/image/src/qa.ts` — expose structural-only checks if needed.
- Modify `docs/api.md`, `docs/architecture.md`.

## Validation

Extend `tests/character-pipeline.test.ts` and add `tests/character-directions-generation.test.ts`:

1. The route returns 202, reserves exactly one credit, and enqueues one job.
2. A successful job stores eight direction rows and eight images.
3. A provider returning seven images fails the generation, refunds once, and stores **zero** rows.
4. A non-`READY` character is rejected before any credit is reserved.
5. A repeated idempotency key charges once and enqueues once, matching existing behaviour.
6. Rotation output passes structural QA and is not rejected by the motion gate.
7. A second rotation request without an explicit regenerate flag is rejected.

Use the fake provider. Extend it to serve eight rotation frames so no paid call enters the suite.

## Risks

| Risk                                                                       | Mitigation                                                                  |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Partial persistence leaving a half-rotated character                       | Write all eight or fail; tested explicitly.                                 |
| Motion QA rejecting valid rotation output                                  | Structural checks only; tested explicitly.                                  |
| Rotations at a different scale than the base, misaligning later animations | Normalize every frame to the character's frame size, as the base path does. |
| Users re-charged for rotations they already own                            | Reject duplicate requests unless regeneration is explicit.                  |
| `generation_kind` string drifting between API, worker and DB               | Derive it from one exported union, not from string literals at each site.   |

## Phase acceptance

- One rotation request produces eight stored, normalized direction images for one credit.
- Provider failure leaves no rows and refunds exactly once.
- No paid provider call is made by the automated suite.
- Polling, idempotency and refund behave identically to every other generation kind.
