# Standalone Cocos extension — bring your own PixelLab key

Status: DRAFT — awaiting approval
Created: 2026-09-19
Goal: turn a hosted SaaS into a self-contained Cocos Creator extension where the user supplies their own PixelLab API key.

## Why

Three findings forced this change:

1. PixelLab's terms require contacting them before "building your own service or reselling". The SaaS model needs permission that may not be granted.
2. PixelLab sells directly to the same customers, with a free tier and a $50/month plan. Reselling their API puts us in price competition with our own supplier.
3. The defensible value in this repository is not sprite generation — it is the Cocos integration: AssetDB import, SpriteFrame ordering, `.anim` creation, bottom pivot. PixelLab does not provide that.

Selling the tool instead of the credits removes the licensing risk, the infrastructure, the cost-of-goods risk, and the operational burden at once.

## Decisions

| Decision       | Choice                                            | Rationale                                                                                                               |
| -------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Model          | Sell the tool; user brings their own PixelLab key | No reselling, no credit accounting, no hosting.                                                                         |
| Architecture   | No backend. Extension calls PixelLab directly.    | The extension main process is full Node — it already uses `node:fs` and `undici`.                                       |
| Image pipeline | Pure JavaScript, replacing Sharp                  | Sharp is a native binary; its ABI compatibility inside Cocos's Electron is unverified and unverifiable on this machine. |
| Provider       | PixelLab only; drop fal.ai                        | One key to configure. Also removes grid slicing, since PixelLab returns separate frames.                                |

## What survives, what goes

**Keep — this is the product:**
`cocos-3.8-adapter.ts` (316), `asset-importer.ts`, `scene/index.ts`, panel, `presets.ts`, `pixellab-provider.ts`.

**Delete — roughly 3,900 lines:**
`apps/api` (1,091), `apps/worker` (651), `packages/db` (907), `packages/queue` (175), `fal-provider.ts` (501), `pose-guide.ts` (276, used only by fal), plus `migrations/`, `infra/`, `drizzle.config.ts`, backend scripts, and the API-key/storage parts of `packages/core`.

**Rewrite:**
`packages/image` (972 lines of Sharp) and the extension's generation flow, which currently talks HTTP and polls.

Also disappearing, because there is no longer a network boundary to defend: ZIP packaging, download origin checks, the 32 MiB cap, safe extraction, path-traversal defence, manifest ownership checks, and exponential polling. These were correct defences for a remote boundary that no longer exists.

## Phases

| Phase                                        | Title                      | Depends on |
| -------------------------------------------- | -------------------------- | ---------- |
| [01](phase-01-pure-js-image-pipeline.md)     | Pure-JS image pipeline     | —          |
| [02](phase-02-direct-provider-access.md)     | Direct provider access     | —          |
| [03](phase-03-in-editor-generation-flow.md)  | In-editor generation flow  | 01, 02     |
| [04](phase-04-remove-backend.md)             | Remove the backend         | 03         |
| [05](phase-05-packaging-and-distribution.md) | Packaging and distribution | 04         |

Phases 01 and 02 are independent and can run in either order. Nothing is deleted until Phase 04, after the replacement is proven to work.

## Sequencing principle

Build the replacement first, prove it matches, then delete. Phase 01 keeps Sharp installed and asserts the new code produces identical output on identical input. Phase 04 removes Sharp only after that evidence exists.

Deleting first and rebuilding afterwards would leave no reference to check against.

## Acceptance criteria

1. A user installs the extension, pastes a PixelLab key, enters a prompt, and gets an imported `.anim` — with no server, no Docker, no account.
2. The new image pipeline produces byte-identical output to Sharp for every existing test fixture.
3. No network call leaves the machine except to PixelLab.
4. The extension bundle contains no native binary.
5. `AI_Sprites/{...}` assets and clips are indistinguishable from those the current version produces.

## Risks

| Risk                                                              | Mitigation                                                                                               |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Pure-JS pipeline diverges subtly from Sharp                       | Phase 01 asserts equality against Sharp on the existing fixtures before removal.                         |
| Long PixelLab calls block the editor UI                           | Work stays in the main process, off the panel thread, as it already does today.                          |
| User's PixelLab key stored insecurely on disk                     | Phase 02 defines storage explicitly; key never leaves the machine except to PixelLab.                    |
| Cannot verify anything in a real editor — no Cocos installed here | Every phase lists what must be manually verified in Creator 3.8 before release.                          |
| Losing the refund safety net that credits provided                | No credits exist; a failed generation costs the user a PixelLab call directly. Surface failures clearly. |
| Throwing away working, tested code                                | Sunk cost. The deleted code only has value under a model we are abandoning.                              |

## Open questions

1. How is the tool licensed — paid one-time with a licence key, or open source with sponsorship? Phase 05 depends on the answer.
2. Distribution: Cocos Store listing, or direct download?
3. Do `hurt` and `death` stay in the preset list, given each costs the user a real PixelLab call?
4. Should the extension show the user's PixelLab quota, if their API exposes it?
