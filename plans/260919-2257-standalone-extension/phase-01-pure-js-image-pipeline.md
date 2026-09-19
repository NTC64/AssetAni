# Phase 01 — Pure-JS image pipeline

Depends on: nothing. Blocks: 03.
Sharp stays installed throughout this phase. It is the reference implementation.

## Problem

`packages/image` is 972 lines built on Sharp, a native binary. Inside Cocos's Electron runtime its ABI compatibility is unknown, and cannot be tested on this machine — `docs/cocos-3.8-api-evidence.md` records that no Creator installation was found here. Shipping a native dependency that may not load, across three operating systems, is a risk with no upside.

## What makes this tractable

`packages/image/src/index.ts:289` resizes with `kernel: sharp.kernel.nearest`. Nearest-neighbour is a lookup, not an interpolation: for each destination pixel, copy the nearest source pixel. It is exactly reproducible in JavaScript. There is no filter kernel, no gamma handling, no colour management to replicate.

Dropping fal.ai removes more: `gridCells` and `processSpriteSheet` exist to slice a 4×2 grid image, which only fal returns. PixelLab returns separate frames. Both can go.

`createSpritePackage` builds a ZIP for network transfer. With no network boundary, frames go straight from memory to the AssetDB. It goes too.

## Approach

### 1.1 Decoding and encoding

Use `pngjs` — pure JavaScript, no build step. PixelLab returns PNG; Cocos consumes PNG. No other format is involved.

### 1.2 Operations to port

| Operation                | Source                   | Notes                                                                                  |
| ------------------------ | ------------------------ | -------------------------------------------------------------------------------------- |
| Nearest-neighbour resize | `index.ts:289`           | Integer lookup; exactly reproducible.                                                  |
| Trim to content bbox     | `normalizeFrame`         | Scan alpha channel for bounds.                                                         |
| Composite onto square    | `normalizeFrame`         | Bottom-anchored with the documented 8px margin.                                        |
| Shared scale across 8    | `processAnimationFrames` | One scale for all frames — this is what keeps a character from pulsing between frames. |
| Foreground cleanup       | `foreground.ts`          | Verify still needed: PixelLab is called with `no_background: true`.                    |
| QA metrics               | `qa.ts`                  | Pure pixel arithmetic already; the Sharp use is only decoding.                         |

`qa.ts` is the easiest port — its logic is already plain arithmetic over a raw buffer. Only the decode call changes.

### 1.3 Proving equivalence

This is the point of the phase, not an afterthought.

For every fixture in `tests/image.test.ts` — which already covers 33 cases including bottom-margin placement at several aspect ratios, shared-scale stability, and motion rejection — run both pipelines and assert **byte-identical PNG output**.

Where bytes differ only due to PNG encoder metadata, compare decoded pixel buffers instead, and state in the test why bytes were not comparable. Do not silently relax to a tolerance: a tolerance would hide exactly the kind of drift this phase exists to rule out.

Keep this comparison suite until Phase 04 removes Sharp.

## Files

- Create `packages/image/src/png.ts` — decode, encode, raw pixel access.
- Create `packages/image/src/transform.ts` — resize, trim, composite.
- Modify `packages/image/src/index.ts` — re-implement `normalizeFrame`, `processAnimationFrames`; drop `processSpriteSheet`.
- Modify `packages/image/src/qa.ts` — swap the decoder.
- Delete `packages/image/src/grid.ts`, `packages/image/src/package.ts` (Phase 04 — keep until the flow no longer imports them).
- Create `tests/image-equivalence.test.ts`.
- Modify `package.json` — add `pngjs`.

## Validation

1. Byte-identical (or pixel-identical, justified) output against Sharp for all existing fixtures.
2. `tests/image.test.ts` passes unmodified against the new implementation. If a test needs changing, behaviour changed — investigate rather than edit the test.
3. Performance is acceptable: eight 256×256 frames is roughly 0.5 MB of pixels. Measure; do not assume. If it is slow enough to feel in the editor, say so rather than shipping it.
4. No native module is imported by the new code path.

## Risks

| Risk                                                      | Mitigation                                                              |
| --------------------------------------------------------- | ----------------------------------------------------------------------- |
| Subtle drift in edge pixels or alpha handling             | Byte-level equality against Sharp; no tolerances.                       |
| Pure JS too slow for the editor                           | Measure in this phase, while Sharp is still available for comparison.   |
| Removing foreground cleanup that is quietly load-bearing  | Verify against real PixelLab output before deleting, not by assumption. |
| PNG encoder metadata differences masking real differences | Fall back to pixel-buffer comparison and document why.                  |

## Phase acceptance

- New pipeline provably matches Sharp on every existing fixture.
- Existing image tests pass unmodified.
- No native dependency on the new path.
- Sharp still installed — removal is Phase 04.
