# Phase 03 — In-editor generation flow

Depends on: 01, 02. Blocks: 04.
The phase where the product becomes real.

## Goal

Wire provider (02) to image pipeline (01) to the existing Cocos importer, entirely inside the extension. After this phase the extension works without the backend running, even though the backend still exists.

## The flow collapses

Today:

```text
panel -> main -> HTTP 202 -> DB row -> BullMQ -> worker -> provider
      -> poll 2/4/8s -> result.zip -> download -> verify origin
      -> extract 10 files -> validate manifest -> AssetDB -> .anim
```

After:

```text
panel -> main -> provider -> normalize -> QA -> AssetDB -> .anim
```

Everything between "provider" and "AssetDB" that existed to cross a network boundary disappears: ZIP packaging, download, origin checks, the 32 MiB cap, safe extraction, path-traversal defence, manifest ownership verification.

Those were correct defences. They are not correct now — they defend a boundary that no longer exists, and keeping them would mean writing a ZIP to disk purely to read it back.

## Approach

### 3.1 Rebuild `generation-service.ts`

Currently 299 lines of submit, poll, resume, download, extract, import. It becomes: call provider, normalize frames, run QA, hand frames to the importer, report progress at each step.

Keep two existing properties:

- The operation lives in the main process, so closing the panel does not cancel it.
- A snapshot the panel reads for progress.

Drop: resume-by-generation-id, exponential backoff, terminal-vs-retryable backend states. There is no backend to resume from.

### 3.2 Manifest without a network

`manifestSchema` is still useful — the importer consumes it and `createAnimation` reads fps, order, and loop mode. Keep the shape; stop validating it as untrusted input. It is now produced and consumed in the same process.

`generationId` remains as the asset folder name. A UUID per generation still gives a unique destination.

### 3.3 Importer input

`importGenerationAssets` reads from a directory and re-validates every PNG for traversal and dimensions. Two options:

- Keep writing frames to a temp directory and reuse the importer unchanged.
- Pass buffers directly and skip the disk round trip.

Recommend keeping the temp directory initially. `cocos-3.8-adapter.ts` takes `sourceDirectory` and is the most delicate code in the repository — the only part validated against a real editor. Changing its input shape in the same phase that changes everything else means a failure could come from either. Revisit after the flow is proven.

The PNG dimension check is now redundant but harmless; the traversal check over a directory we just wrote ourselves is dead weight. Leave both until the flow works, then remove deliberately.

### 3.4 QA failure without refunds

QA FAIL previously failed the generation and refunded a credit. There is no credit. The user has already spent their PixelLab quota.

So do not silently discard the output. Report that quality checks failed, say which check, and let the user decide: keep the frames anyway, or retry with a different prompt or seed. Throwing away work the user paid for, without asking, is worse than importing something imperfect.

This is a genuine behaviour change and must be deliberate, not incidental.

### 3.5 Character batches

`character-batch-service.ts` orchestrates base creation then per-animation generation, and imports relative-path (`../../../../packages/core/src/presets`) instead of `@sprite/core` — fix that while here.

Character state lived in PostgreSQL. Now it lives in the session, or in project files. Simplest: keep the base image in a temp location for the batch's duration, since a batch is one user action. Persisting characters across editor restarts is a separate feature — do not smuggle it in.

## Files

- Rewrite `apps/cocos-plugin/src/main/generation-service.ts`.
- Modify `apps/cocos-plugin/src/main/character-batch-service.ts`.
- Modify `apps/cocos-plugin/src/main/index.ts` — command handlers.
- Modify `apps/cocos-plugin/src/panel/index.ts` — progress without polling.
- Modify `apps/cocos-plugin/src/shared/generation.ts` — command shapes.
- Modify `tests/plugin-phase4.test.ts`, `tests/import.test.ts`.

## Validation

1. End-to-end with a fake provider: prompt to imported `.anim`, no backend process running.
2. Asset paths and clip contents identical to those the current version produces.
3. Closing the panel mid-generation does not cancel it.
4. QA FAIL surfaces a choice rather than discarding output.
5. A provider failure reports a cause the user can act on.
6. Batch produces one clip per animation, correctly named.
7. Manual in Creator 3.8 — mandatory. This is the first time the full flow runs in a real editor, and nothing here has been verified in one.

## Risks

| Risk                                              | Mitigation                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| Changing importer input and flow simultaneously   | Keep the temp directory; change one thing at a time.               |
| Losing the "survives panel close" property        | Explicit test; it is easy to lose in a rewrite.                    |
| Output quietly differing from the current version | Compare produced assets against current output for the same input. |
| Long call freezing the editor                     | Main process only; verify manually in Creator.                     |
| Silently discarding output the user paid for      | QA failure asks instead of discarding.                             |

## Phase acceptance

- Prompt to `.anim` with no backend running.
- Assets match what the current version produces.
- Verified manually in Cocos Creator 3.8.
- QA failures leave the decision with the user.
