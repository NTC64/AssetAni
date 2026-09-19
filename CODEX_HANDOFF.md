# Current handoff

The repository now contains the additive Character Animation Pipeline on top of the verified Phase 5 and PixelLab implementation.

- `characters`, `character_animations`, and `generation_batches` are added by migration `0002_characters_batches.sql`.
- `AIOrchestrator` routes PixelLab base creation, text animation, skeleton animation, and rotations; fal.ai remains the concept and compatible base fallback.
- Character creation and animation reuse the existing generations table, BullMQ queue, credit reservation, polling, failure, and exactly-once refund paths.
- Provider frames pass through Sharp normalization and deterministic PASS/WARN/FAIL QA before packaging.
- Presets are code-only: `platformer`, `side_scroller`, and `top_down_rpg`.
- Cocos retains the single-generation path and adds named batch folders plus `{character}_{animation}.anim` clips.
- Automated tests use PGlite, mocks, and the fake provider. They make no paid PixelLab or fal.ai calls.

Manual commands and API examples are in `docs/development.md`. Start with `AI_PROVIDER=fake`; switch the worker to PixelLab only for a deliberate paid verification.
