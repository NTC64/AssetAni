# Phase 04 — Plugin direction UI and import

Depends on: 03. Blocks: nothing.

## Problem

Even with the backend fixed, a Cocos user cannot reach any of it:

- `apps/cocos-plugin/src/panel/index.ts:194` hardcodes `direction: 'right'` for single generations. Nine directions exist in the contract; the UI offers none.
- The batch path sends no direction at all, so `resolveGamePreset` falls back to `directions[0]`.
- Import paths carry no direction. `db://assets/AI_Sprites/{character}/{animation}` and the clip `{character}_{animation}.anim` are identical for a north walk and a south walk, so **the second import silently overwrites the first**.

Finding 7 is the dangerous one: without it, a successful multi-direction batch would appear to work and quietly destroy its own output.

## Approach

### 4.1 Direction selection

Single generation: a direction control next to the animation control. Default `right` so existing behaviour is unchanged for users who ignore it.

Batch: a multi-select of directions, defaulting to the preset's declared list for `top_down_rpg` and to the single direction for the side-view presets. Offer four cardinals as a one-click preset — it is what most top-down games ship and it quarters the cost.

### 4.2 Cost must be visible before committing

The panel must show the credit cost before the user commits: `animations x directions` pairs, plus one for rotation when it is needed.

Six animations by eight directions is 49 credits against 7 for `platformer`. A user who discovers that after the fact has been ambushed. Show the arithmetic, not just the total.

Also show the user's current balance and block the action when the cost exceeds it. The API already rejects with `INSUFFICIENT_CREDIT`, but failing at the door after a long wait is a poor experience, and `GET /v1/me/credits` already exists for exactly this.

### 4.3 Import paths must include direction

Extend both paths:

- Assets: `db://assets/AI_Sprites/{character}/{direction}/{animation}`
- Clip: `{character}_{animation}_{direction}.anim`

For single-direction presets, decide deliberately whether to keep the current shape or always include direction. Consistency argues for always; not breaking existing projects argues for keeping it when there is one direction. Recommend keeping the existing shape when exactly one direction is used, so current users' asset paths do not move under them.

Sanitise `direction` the same way `safeCharacterName` is sanitised in `runBatch`. It comes from a fixed set, but the sanitiser is cheap and the asset database path is not a place to trust input.

### 4.4 Batch orchestration

`character-batch-service.ts` builds one request per animation. It becomes one per animation-direction pair, with idempotency keys extended from `${key}:${animation}` to `${key}:${animation}:${direction}` so retries stay exactly-once per pair.

Trigger rotation first when the selected directions need it, and wait for it to succeed before queueing animations — animations read the rotation images.

Progress reporting currently divides across animations; it must divide across pairs, or a 48-pair batch will appear stuck.

### 4.5 Partial failure

With 48 pairs, some will fail. `toBatchResponse` already models `PARTIAL`. Surface which pairs failed and let the user retry only those. Re-running a whole 48-pair batch to recover one failure is unacceptable, and the per-pair idempotency key from 4.4 makes selective retry work.

### 4.6 Unrelated cleanup

`character-batch-service.ts:3` imports by relative path:

```ts
import { resolveGamePreset } from '../../../../packages/core/src/presets';
```

Every other cross-package import uses the workspace alias. This file is being edited anyway; switch it to `@sprite/core`. Noted here rather than done silently.

## Files

- Modify `apps/cocos-plugin/src/panel/index.ts` — direction controls, cost display, balance check.
- Modify `apps/cocos-plugin/src/panel/bridge.ts`, `apps/cocos-plugin/src/shared/generation.ts` — command shape.
- Modify `apps/cocos-plugin/src/main/character-batch-service.ts` — pair expansion, rotation step, idempotency, import path.
- Modify `apps/cocos-plugin/src/main/generation-service.ts` — `runBatch` naming and progress.
- Modify `apps/cocos-plugin/src/main/api-client.ts` — rotation endpoint, credit read.
- Modify `tests/plugin-phase4.test.ts`, `tests/import.test.ts`.
- Modify `docs/api.md`, `README.md`.

## Validation

1. Two directions of the same animation import to distinct paths and neither overwrites the other. This fails today.
2. Displayed cost equals credits actually charged, for several animation and direction combinations.
3. A batch exceeding the balance is blocked in the panel before any request is sent.
4. Per-pair idempotency: retrying one failed pair re-queues only that pair.
5. A single-direction `platformer` batch produces the same asset paths as before this phase.
6. Progress reaches 100% for a multi-direction batch and does not stall.
7. Manual: an eight-direction character imported into Cocos, every clip present, every clip facing correctly.

## Risks

| Risk                                               | Mitigation                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------------- |
| Silent overwrite of previously imported animations | Direction in the path; explicit regression test.                        |
| Existing users' asset paths moving after an update | Keep the current shape when exactly one direction is selected.          |
| Bill shock from a 49-credit batch                  | Cost and balance shown before commit; action blocked when unaffordable. |
| A 48-pair batch appearing frozen                   | Progress divided across pairs; per-pair status surfaced.                |
| Whole batch re-run to recover one failed pair      | Per-pair idempotency keys enable selective retry.                       |
| Rotation not finished before animations start      | Explicit dependency: await rotation success before queueing.            |

## Phase acceptance

- A user selects directions, sees the exact cost, and receives one correctly-named clip per pair.
- No import overwrites another.
- Single-direction flows are visually and structurally unchanged.
- A failed pair can be retried alone.
