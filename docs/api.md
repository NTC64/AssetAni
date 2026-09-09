# Contracts and local APIs

There is no HTTP API yet.

Extension messages declared in `apps/cocos-plugin/package.json`:

| Message       | Handler      | Result                             |
| ------------- | ------------ | ---------------------------------- |
| `open-panel`  | `openPanel`  | Opens the default panel            |
| `test-import` | `testImport` | `{ ok: boolean, message: string }` |

The private scene method `buildAnimation` receives `{ manifest, uuids }` and returns serialized animation JSON text. Objects such as SpriteFrames and AnimationClips never cross process boundaries.

Manifest version 1 requires a UUID generation ID, `idle|walk|attack`, direction `right`, integer FPS 4–30, boolean loop, exactly eight unique relative PNG paths, frame size 256, and normalized pivot coordinates. Phase 2 writes `frames/00.png` through `frames/07.png`, as requested. The schema also accepts Phase 1's `frames/frame_NN.png` names for compatibility. Unknown fields and traversal paths are rejected. Manifest order remains authoritative.

Test Import always uses the bundled manifest and destination `db://assets/AI_Sprites/test_walk`. Panel inputs are disabled to make their current behavior explicit; they do not override the fixture. The Cocos extension has no provider keys or network code.

Phase 2 exports `buildSpritePrompt(input)`, `AiProvider.generate(input)`, `processSpriteSheet({ inputBuffer, rows: 2, columns: 4, targetFrameSize: 256, style: 'pixel_art' })`, and `createSpritePackage(result, settings)`. `processSpriteSheet` returns eight PNG buffers, a 1024 × 512 sheet buffer, and per-frame diagnostics. Packaging returns the validated manifest, a filename-to-buffer map, and ZIP buffer. The CLI handles filesystem writes. See `phase-2.md` for exact usage.
