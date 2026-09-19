# Phase 01 — Multi-direction base storage

Depends on: nothing. Blocks: 02.

## Problem

A character can hold exactly one base image:

- `characters.base_asset_key` — one `text` column (`packages/db/src/schema.ts`).
- `LocalResultStorage.persistCharacterBase(characterId, image)` — writes one file, `characters/{id}/base.png`.
- `readCharacterBase(key)` — regex-locked to `^characters\/([0-9a-f-]{36})\/base\.png$`, so it physically cannot address a second image.

Nothing else can be built until a character can hold eight.

## Approach

### 1.1 Schema

Add a `character_directions` table rather than widening `characters`. One row per stored direction:

- `character_id` referencing `characters.id` with cascade delete, matching `character_animations`.
- `direction` constrained to the eight `PIXELLAB_DIRECTION_ORDER` values.
- `asset_key`.
- Unique on `(character_id, direction)` — a direction is stored once.
- Index on `character_id`.

Reasons for a table over eight columns: the set of directions is provider-defined and may change; `character_animations` already establishes this shape; and a unique constraint gives idempotent writes for free, which matters because the rotation job can be retried.

Keep `characters.base_asset_key` exactly as it is. It remains the canonical single base for `platformer` and `side_scroller` and for the first frame fed to rotation. Do not migrate it into the new table — that would break every existing character and every current test for no benefit.

Migration `0003_character_directions.sql`, additive only.

### 1.2 Storage

Generalise the storage layer to address a direction:

- `persistCharacterDirection(characterId, direction, image)` writing `characters/{id}/directions/{direction}.png`.
- `readCharacterDirection(key)` with a path guard as strict as the existing one: validate the UUID **and** validate the direction against the known set, rather than accepting arbitrary path segments. The current regex is a security control, not a formality — the replacement must be no weaker.

`persistCharacterBase` and `readCharacterBase` stay untouched.

### 1.3 Repository

On `CharacterRepository`:

- `saveDirection({characterId, direction, assetKey})` — upsert on the unique constraint, so a retried rotation job does not fail.
- `directions(characterId)` — list stored directions.
- `findDirection(characterId, direction)` — resolve one asset key, returning undefined when absent so callers can fall back to the base image.

## Files

- Create `migrations/0003_character_directions.sql`.
- Modify `packages/db/src/schema.ts` — add the table and its row type.
- Modify `packages/db/src/character-repository.ts` — the three methods above.
- Modify `packages/core/src/local-storage.ts` — the two storage methods.
- Modify `packages/contracts/src/index.ts` only if the direction union needs exporting for the DB constraint. Prefer reusing `spriteDirectionSchema`; do not define a second list.

## Validation

New `tests/character-directions.test.ts`:

1. Saving the same `(character, direction)` twice leaves one row and the latest key.
2. `findDirection` returns undefined for a direction never generated.
3. Deleting a character cascades its direction rows.
4. `readCharacterDirection` rejects a traversal attempt, an invalid UUID, and an unknown direction string.
5. A round trip through persist and read returns identical bytes.

Existing character tests must pass unmodified. If any needs changing, the change is not additive and the design is wrong.

## Risks

| Risk                                                               | Mitigation                                                                  |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Path traversal through a user-influenced direction segment         | Validate against the known direction set, never interpolate raw input.      |
| Migration breaking existing characters                             | Additive only; `base_asset_key` untouched; existing tests unmodified.       |
| Storage keys diverging between local and future R2 implementations | Key format decided here and documented; both drivers use the same strings.  |
| Orphaned direction images after character deletion                 | Cascade handles rows; file cleanup follows the existing retention approach. |

## Phase acceptance

- A character can store and retrieve eight direction images independently of its base image.
- Repeated saves are idempotent.
- Path guards are provably no weaker than the existing ones.
- Every pre-existing test passes without modification.
