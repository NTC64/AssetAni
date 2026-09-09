# Architecture through Phase 2

## Standalone AI POC

`scripts/test-ai.ts` → `AiProvider` → 1024 × 1024 PNG → Sharp slicing/masking/normalization → local result files and ZIP. The fake provider and fal provider implement the same small interface. Neither is imported by the Cocos extension. No application server, infrastructure queue, or storage service is added.

Each run uses a unique output directory. Per-case metadata records provider/model, requested and resolved seed, request ID, prompt, duration, diagnostic geometry, output path, and pending human review fields. Successful processing means a usable image package was produced, not that the model drew a correct eight-frame animation. See `phase-2.md` for limitations and acceptance.

## Cocos local import

Panel → extension message → main import orchestrator → CocosAdapter → Asset Database and scene process.

The panel only starts the import and displays a result. A main-process lock prevents simultaneous Test Import operations even if the panel is reopened. The importer validates the Zod manifest, checks source real paths remain inside the fixture directory, and checks PNG signatures and 256 × 256 dimensions before any project mutation.

`cocos-adapter.ts` defines the version-independent interface. All Cocos Editor calls, engine loading, serialization, and metadata configuration live in `cocos-3.8-adapter.ts`. The main process does not load `cc`; the scene process loads the engine lazily. The three bundles share source, not process memory.

Import order is manifest order. AssetDB imports each PNG and configures the image as a SpriteFrame. SpriteFrame subasset UUIDs are read from imported metadata and checked through AssetDB, never constructed using assumed suffixes. Texture filters use nearest sampling; SpriteFrames disable trimming and use the manifest pivot. The scene process loads the UUIDs, creates the clip at the requested FPS, sets loop mode and duration, serializes it, and returns JSON text across IPC. AssetDB creates/saves the `.anim` file.

The importer writes only below `db://assets/AI_Sprites/{folder}`. It never directly writes project filesystem assets, `library/`, or `temp/`. Repeating Test Import overwrites fixture assets in the same folder and saves the existing clip. Unrelated assets are untouched. A failure may leave partially imported test assets; retry is the recovery procedure. Import is not a transaction and no destructive rollback is attempted.

Real Creator runtime validation is separate from the mock tests. The scene must be available, the database must be ready, and version-specific importer behavior must pass the manual test before the phase is accepted.
