# Phase 03 — Direction-aware animation

Depends on: 02. Blocks: 04.

This phase contains the two defects worth fixing even if multi-direction support were abandoned.

## Problem A — direction is passed as prompt text

`packages/ai/src/pixellab-provider.ts:129`:

```ts
return {
  idle: 'idle breathing loop',
  walk: 'walking cycle facing right',
  run: 'running cycle facing right',
  attack: 'sword attack cycle facing right',
  hurt: 'taking damage and recovering facing right',
  death: 'falling down into a final death pose facing right',
}[animation].replaceAll('right', direction);
```

Direction is injected by substring replacement on an English sentence. Three consequences:

1. **`idle` ignores direction completely.** Its prompt has no `'right'`, so `replaceAll` is a no-op. Every idle animation is identical regardless of the requested direction. This is a live defect today, not only under multi-direction.
2. Substitution is positional and fragile. Any future prompt containing the word "right" in another sense would be corrupted.
3. Whether PixelLab interprets `"walking cycle facing south-west"` usefully is unverified. Hyphenated diagonals are the least likely to work.

## Problem B — animations always read the single base

`generateCharacterAnimation` reads `character.baseAssetKey` unconditionally. Even with eight rotations stored, every animation is built from the one original base. Requesting a north-facing walk animates the south-facing sprite and asks the model to turn it — which is exactly what rotation exists to avoid.

## Approach

### 3.1 Verify the provider contract first

Before writing code, establish from PixelLab's documentation and one paid probe:

- Does `/animate-with-text-v3` accept a structured direction or view parameter? `/animate-with-skeleton` already takes `view` and `direction` as real fields, which strongly suggests the text endpoint has an equivalent that this code is not using.
- If not, does it reliably honour diagonals in the action text?

If a structured parameter exists, use it and delete the substitution. If only prompt text works, build the prompt from a per-animation, per-direction table instead of `replaceAll`. Either way the replacement hack goes.

Do not design around assumptions. Finding 5 exists because someone assumed every prompt contained the word "right".

### 3.2 Fix the prompt builder

Replace `buildPixelLabMotionPrompt` with an explicit mapping that covers every animation and every direction, including `idle`. Each entry states its direction rather than inheriting it from a substitution. Add a test asserting that for all six animations and all nine directions the resulting prompt actually names the requested direction — the assertion that would have caught the `idle` bug.

### 3.3 Select the base image by direction

In `generateCharacterAnimation`, resolve the source image as: the stored direction image when one exists for the requested direction, otherwise `character.baseAssetKey`.

The fallback keeps `platformer` and `side_scroller` working untouched, since they never generate rotations. Record which source was used on the generation row, so a support question about a wrong-facing sprite is answerable from data.

### 3.4 Preset resolution

`resolveGamePreset` returns a single `direction` from `directions[0]`. Keep that signature — many callers depend on it. Add a separate accessor returning the full declared list, used only by the batch path in Phase 04. Widening the existing return type would ripple through every caller for no gain.

## Files

- Modify `packages/ai/src/pixellab-provider.ts` — prompt construction.
- Modify `packages/ai/src/prompt.ts` if the direction table belongs beside the other prompt logic.
- Modify `apps/worker/src/jobs/process-generation.ts` — direction-aware base selection.
- Modify `packages/core/src/presets.ts` — full-direction accessor.
- Modify `packages/db/src/repository.ts` if recording the source direction needs a column.
- Modify `tests/pixellab-provider.test.ts`, `tests/character-pipeline.test.ts`.

## Validation

1. For all six animations and all nine directions, the generated prompt names that direction. This fails today for `idle`.
2. An animation requested in a direction with a stored rotation reads that rotation, not the base.
3. An animation requested in a direction without a rotation falls back to the base and still succeeds.
4. `platformer` and `side_scroller` produce byte-identical requests to before this phase, proving no regression.
5. Manual, paid: generate `idle` facing north and facing south for one character; confirm the sprites differ and face correctly. Automated tests cannot judge which way a sprite faces.

## Risks

| Risk                                                               | Mitigation                                                                     |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| PixelLab ignores diagonal directions in prompt text                | Verify before building; fall back to four cardinals and say so in the UI.      |
| Changing prompts alters output for existing single-direction users | Assert `platformer` and `side_scroller` requests are unchanged.                |
| Silent fallback to base hides a missing rotation                   | Record the source direction on the generation row so it is visible in support. |
| Paid probing costs money during development                        | One deliberate probe, budgeted; suite stays on the fake provider.              |

## Phase acceptance

- `idle` honours direction. The bug is covered by a test that fails before the fix.
- Animations use the rotation matching their direction when one exists.
- Direction reaches the provider through a documented mechanism, not string replacement.
- Single-direction presets are provably unchanged.
