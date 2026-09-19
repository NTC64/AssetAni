# Phase 07 — Precise animation

Depends on: nothing. Blocks: nothing.
Independent feature work. Slot it wherever there is capacity.

## Problem

`mode: 'precise'` is defined in the contract and rejected at the API boundary since 2026-09-19. The rejection is correct: the implementation produces unusable output.

In `packages/ai/src/orchestrator.ts`, `generateAnimation` with `mode: 'precise'` fetches a skeleton from the provider, then derives nine poses by moving **every keypoint on one shared sine curve**:

```ts
y: point.y + Math.round(Math.sin((frameIndex / 8) * Math.PI * 2) * 2);
```

Every joint bobs vertically by at most two pixels, identically. A walk, an attack, and a death all produce the same motion. The head does not turn, limbs do not swing, nothing is animation-specific. At 128 or 256 px a two-pixel uniform offset is close to no motion at all — the existing motion QA would likely reject it anyway.

The surrounding plumbing is sound: `estimateSkeleton` and `animateWithSkeleton` are real provider capabilities, the three-window batching is reasonable, frame count is validated, cost is summed. Only pose generation is fake.

## Goal

Replace placeholder interpolation with real per-animation keyframes, then remove the API rejection.

## Approach

### 7.1 Understand the provider contract first

Before writing keyframes, establish from PixelLab's documentation and a paid probe:

- Exact keypoint names, ordering, and coordinate space returned by `estimateSkeleton`.
- Whether coordinates are absolute pixels, normalized, or relative to a bounding box.
- What `animateWithSkeleton` tolerates: how far a pose may deviate before output degrades.
- Cost per skeleton call, to price `precise` against `standard`.

Do not design keyframes against assumptions. The current placeholder exists because someone skipped this step.

### 7.2 Keyframe definitions

A data module — pose tables, not procedural math — giving per-animation, per-frame joint offsets for `idle`, `walk`, `run`, `attack`, `hurt`, `death`. Walk needs opposed arm and leg swing with a weight shift; attack needs a wind-up, strike, recovery arc; death needs a one-way collapse that does not loop.

Keep it declarative in `packages/ai/src/pose-keyframes.ts` so poses can be tuned without touching orchestration. Scale offsets relative to skeleton size, not absolute pixels, so 128 and 256 both work.

Note the structural mismatch: the current code builds **nine** poses and slices them into three windows of three, producing 8 frames after truncation. Verify that windowing is what the provider expects rather than preserving it by inheritance.

### 7.3 Re-enable the mode

Only after QA passes. Remove the `refine` in `animationModeSchema` in `packages/contracts`, delete the placeholder comment in the orchestrator, and update `docs/api.md`, `docs/architecture.md`, `README.md`, `CODEX_HANDOFF.md` — all four currently state the mode is unsupported.

### 7.4 Pricing

`precise` costs more provider calls than `standard` (one skeleton estimate plus three skeleton animations versus one text animation). `generations.credit_cost` exists and defaults to 1; if `precise` costs meaningfully more, charge more. Coordinate with Phase 08.

## Files

- Create `packages/ai/src/pose-keyframes.ts`.
- Modify `packages/ai/src/orchestrator.ts`.
- Modify `packages/contracts/src/index.ts` — remove the rejection.
- Modify `tests/character-pipeline.test.ts` — the HTTP 400 assertion must become a success assertion.
- Create `tests/pose-keyframes.test.ts`.
- Modify `README.md`, `docs/api.md`, `docs/architecture.md`, `CODEX_HANDOFF.md`.

## Validation

- Unit: each animation produces 8 distinct poses; no two frames identical; joints move in animation-appropriate directions.
- Unit: offsets scale correctly at 128 and 256.
- Unit: death does not return to its start pose; walk does loop.
- Integration: precise generations pass `runAnimationQa` at PASS, not merely not-FAIL.
- Manual, paid: generate walk and attack via PixelLab, import into Cocos, play the clip and watch it. This is the only check that actually validates the feature — automated tests cannot tell whether an animation looks like walking.
- Side-by-side against `standard` for the same character. If precise is not visibly better, it is not worth its extra cost and should stay disabled.

## Risks

| Risk                                                            | Mitigation                                                                   |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Precise output is not visibly better than standard              | Side-by-side comparison gate before re-enabling; keep it disabled otherwise. |
| Keypoint schema assumptions wrong                               | Probe the real API before writing keyframes.                                 |
| Paid probing during development costs real money                | Budget the probe; keep the fake provider as the default in tests.            |
| Re-enabling ships a billable path that produces unusable frames | QA must PASS, not merely not-FAIL, before the schema change.                 |

## Open questions

1. Is `precise` worth more credits, and how many?
2. Should all six animations ship at once, or only walk and idle first?
3. If PixelLab's skeleton API proves too limited, abandon the mode and remove `mode` entirely rather than carrying dead code?

## Phase acceptance

- Each animation produces visibly distinct, animation-appropriate motion, confirmed by watching it in Cocos.
- QA returns PASS for precise output.
- The mode is only re-enabled after the side-by-side comparison justifies it.
- All four documents updated in the same change that flips the schema.
