# Phase 1 acceptance procedure

Status: **manually verified in Cocos Creator 3.8.x by the owner**, as reported on 2026-09-09. The owner authorized Phase 2 only. The checklist and implementation-time record below are retained for regression testing; the original agent did not itself run the editor.

## Automated checks

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expected: lint and strict typecheck succeed, 20 Vitest tests pass, and `dist/ai-sprite-generator` is created. Tests cover real local fixture preflight, malformed manifests/PNGs, ordered import messages, repeat import, destination restriction, database-not-ready, missing SpriteFrames, mocked clip FPS/duration/loop and reference cleanup. They are not a Creator E2E test.

## Install

1. Record the exact Creator 3.8.x patch version and OS below. Use a disposable 2D project first.
2. Build the extension and copy the entire `dist/ai-sprite-generator` folder to `<project>/extensions/ai-sprite-generator`.
3. Open the project in Creator. Open Extension/Extensions → Extension Manager, choose Project, then enable or reload the extension. Restart Creator if it was copied while the editor was open and is not discovered.
4. Open a scene. Wait until the project's Asset Database finishes importing. Open the Console.

## Import and inspect

1. Choose Develop → AI Sprite Generator.
2. Confirm Prompt, Animation, Frame Count, and FPS fields are visible. In Phase 1 these are disabled and the panel explains that the fixture manifest supplies Walk, 8, and 12.
3. Click Test Import. The button becomes disabled while importing. Expect a success message naming `db://assets/AI_Sprites/test_walk/walk.anim` and no error in the Console.
4. Inspect `assets/AI_Sprites/test_walk/`: `manifest.json`, `walk.anim`, and a `frames` directory with `frame_00.png` through `frame_07.png` must exist.
5. Expand each PNG and confirm its SpriteFrame subasset exists. Inspect image/SpriteFrame settings: sprite-frame image type, no trim, pivot `(0.5, 0)`, 256 × 256, and nearest texture filtering. Confirm the blue knight's background is transparent.
6. Select `walk.anim`. Confirm it is recognized as an AnimationClip, uses 12 samples/FPS, has eight frame keys in manifest order, loops, and has duration approximately `8 / 12 = 0.6666667` seconds.

## Play

1. Under a Canvas create a UI Sprite node. Assign the `frame_00` SpriteFrame to its Sprite component. Set the UITransform anchor to `(0.5, 0)` for bottom alignment; use a 256 × 256 content size.
2. Add an Animation component to the **same node** as the Sprite component. This matters because the generated clip animates that node's Sprite.spriteFrame.
3. Add `walk.anim` to the Animation component's Clips list and set it as Default Clip. Enable Play On Load.
4. Save the scene and start Preview. Expect eight distinct frames to cycle repeatedly at 12 FPS, with a gold marker that advances in manifest order and transparent background. Check that the feet remain near the baseline with no cropping or unexpected displacement.
5. Stop Preview, close and reopen the project, and Preview again. The clip must retain all SpriteFrame references and play without the extension actively running.

## Repeat and failure handling

1. Click Test Import again. Expect the same folder and filenames, no suffixed duplicate assets, and a still-working clip. Check that asset UUIDs and existing scene references remain usable.
2. Click quickly twice or reopen the panel during an import. Expect no concurrent second import.
3. In a disposable copy of the extension, rename `test-assets/frames/frame_07.png`. Reload and click Test Import. Expect a clear failure in the panel, technical details in Console, and no new project mutations from this attempt. Restore the file and retry successfully.
4. Confirm project source changes are limited to `assets/AI_Sprites/test_walk` and the parent folder metadata. Cocos will update its own library/temp caches normally; the extension must not directly write into those paths.

## Implementation-time record (historical; superseded by owner verification above)

| Check                                                 | Result                                                   |
| ----------------------------------------------------- | -------------------------------------------------------- |
| Creator version / OS                                  | Not supplied; runtime not available in checked locations |
| Lint                                                  | Passed: ESLint and Prettier check                        |
| Typecheck                                             | Passed against official 3.8.8 declarations               |
| Tests                                                 | 20 passed (mocked Editor/engine plus local file reads)   |
| Standalone build                                      | Produced locally                                         |
| Extension loads / eight SpriteFrames import           | NOT RUN in Creator                                       |
| AnimationClip recognized / plays at 12 FPS            | NOT RUN in Creator                                       |
| Project reopen / repeated import preserves references | NOT RUN in Creator                                       |
| Phase 1 acceptance                                    | PENDING                                                  |

Known limitations: no live Editor verification; patch-sensitive importer metadata/serialization; diagnostic artwork; disabled future generation inputs; partial imports can remain after a mid-import failure and are repaired by retry; no automatic Sprite node or Animation component creation (assignment is the user's acceptance step). No backend, AI, billing, database, R2, or production deployment is present.

Final automated verification on 2026-09-09 used Node 22.23.2 and pnpm 10.28.2 via the documented npx workaround. Frozen-lockfile install, lint, typecheck, all 20 tests, and build passed. A separate Node packaging smoke check loaded the standalone main/scene bundles and the panel with a stubbed `Editor.Panel.define`, verified eight bundled PNGs, and confirmed the packaged manifest has no workspace dependencies. This smoke check does not execute Creator APIs. One fixture was also visually inspected as a 256 × 256 diagnostic knight sprite.
