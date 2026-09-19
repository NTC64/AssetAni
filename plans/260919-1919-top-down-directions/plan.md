# Multi-direction sprites for top-down RPG

Status: DRAFT — awaiting approval
Created: 2026-09-19
Goal: make the `top_down_rpg` preset deliver what it advertises — a character animated in the directions the user actually asked for.

## The defect

`top_down_rpg` declares eight directions in `packages/core/src/presets.ts`. The user sees "Top-down RPG" in the Cocos panel, pays six credits for a batch, and receives six animations that all face **south**. A character that cannot turn is unusable in a top-down game. Nothing warns them — unlike `precise`, which is rejected outright, this path completes "successfully".

## Findings behind it

| #   | Finding                                                                                                                                                     | Location                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1   | `resolveGamePreset` returns `preset.directions[0]` only. The other seven are decorative.                                                                    | `packages/core/src/presets.ts:71`                      |
| 2   | `generateDirections()` is dead code. It calls `/generate-8-rotations-v3` and is fully implemented and tested, but nothing in `apps/` ever invokes it.       | `packages/ai/src/orchestrator.ts:114`                  |
| 3   | A character can store exactly one base image. `characters.base_asset_key` is a single column; `persistCharacterBase` writes one `characters/{id}/base.png`. | `packages/db/src/schema.ts`, `local-storage.ts`        |
| 4   | Direction reaches PixelLab as **string replacement in a prompt**, not as a parameter.                                                                       | `packages/ai/src/pixellab-provider.ts:129`             |
| 5   | Because of 4, `idle` ignores direction entirely — its prompt `'idle breathing loop'` contains no `'right'` for `replaceAll` to substitute.                  | same                                                   |
| 6   | The panel hardcodes `direction: 'right'` for single generations. The API accepts nine directions; the UI exposes none.                                      | `apps/cocos-plugin/src/panel/index.ts:194`             |
| 7   | Import paths carry no direction: `AI_Sprites/{character}/{animation}`. Two directions of one animation would overwrite each other.                          | `apps/cocos-plugin/src/main/generation-service.ts:273` |

Findings 4 and 5 mean direction handling is unreliable even for the presets that "work" today. `side_scroller` only appears correct because its single direction happens to be the literal baked into every prompt.

## What `generateDirections` actually produces

One API call, one job, eight **static** images of the character viewed from eight angles. It rotates a character; it does not animate one. So the full pipeline is:

```text
createCharacter      -> 1 base image                    (1 provider call)
generateDirections   -> 8 rotated base images           (1 provider call)
animateWithText      -> 8 frames, per direction chosen  (1 call each)
```

A character with six animations in all eight directions is 48 animation calls. This is why the user must choose directions rather than always getting eight.

## Decisions

| Decision          | Choice                                             | Rationale                                                                                |
| ----------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Direction count   | User selects, with cost shown before committing    | User decision, 2026-09-19. 48 animations by default is unaffordable and mostly wasted.   |
| Rotation billing  | 1 credit for the rotation step                     | It is exactly one provider call, matching how every other credit is priced.              |
| Animation billing | 1 credit per animation-direction pair              | Each pair is one provider call. Keeps credit cost proportional to provider cost.         |
| Rotation trigger  | Its own generation (`generationKind='directions'`) | Reuses the proven reserve/poll/refund machinery instead of inventing a second mechanism. |

Billing a rotation inside character creation was rejected: creation would then make two provider calls for one credit, and the loss would scale with signups.

## Phases

| Phase                                       | Title                          | Depends on |
| ------------------------------------------- | ------------------------------ | ---------- |
| [01](phase-01-direction-storage.md)         | Multi-direction base storage   | —          |
| [02](phase-02-rotation-generation.md)       | Rotation generation            | 01         |
| [03](phase-03-direction-aware-animation.md) | Direction-aware animation      | 02         |
| [04](phase-04-plugin-direction-ui.md)       | Plugin direction UI and import | 03         |

Phase 03 also fixes findings 4 and 5, which are defects in the current single-direction path and are worth shipping regardless of the rest.

## Acceptance criteria

1. A user selects directions in the panel, sees the credit cost before committing, and receives one animation per animation-direction pair.
2. Selecting `idle` in two different directions produces two visibly different sprites. Today it produces two identical ones.
3. No two animation-direction pairs overwrite each other in the Cocos asset database.
4. Credits charged equal animation-direction pairs plus one for rotation, and a failure refunds exactly once per pair.
5. Existing `platformer` and `side_scroller` single-direction flows are unchanged, proven by the current tests still passing untouched.

## Risks

| Risk                                                                           | Mitigation                                                                                            |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| PixelLab may not honour diagonal directions like `south-west` in a text prompt | Phase 03 verifies against the real API before building on it; fall back to four cardinals if not.     |
| `/animate-with-text-v3` may have a proper direction parameter we are not using | Phase 03 checks the provider docs first. Prompt string replacement is a workaround, not a design.     |
| A 48-pair batch overwhelms the queue or the user's credit balance              | Cap pairs per batch; check total credits up front as `CharacterService.batch` already does.           |
| Rotation succeeds but some animations fail, leaving a half-built character     | Batch status already models `PARTIAL`; extend it to direction pairs rather than inventing new states. |
| Scope creep into the `precise` work                                            | Directions and `precise` are independent. This plan does not touch `animationMode`.                   |

## Open questions

1. Should rotation run automatically when a `top_down_rpg` character is created, or only when the user first requests a non-default direction? Automatic is simpler to explain; lazy avoids charging users who never use it.
2. If the user picks four directions, should rotation still generate all eight (one call regardless) and keep the spares for later, or discard them? Keeping them is free in provider cost but costs storage.
3. Do `platformer` and `side_scroller` gain direction choice too, or stay single-direction by design?
4. Should `death` be excluded from multi-direction batches by default, since it is rarely needed per direction?
