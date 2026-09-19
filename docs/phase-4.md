# Phase 4 completion and test procedure

Phase 4 implements the complete editor workflow:

```text
Prompt -> Generate -> Backend -> Worker -> Sprite frames
       -> result.zip -> safe extraction -> Cocos import -> AnimationClip
```

The extension contains an `ApiClient`, a stateful `GenerationService`, shared Zod contracts, exponential polling capped at eight seconds, progress display, friendly errors, and retry behavior. It validates the downloaded archive before any AssetDB write and performs every result-file operation automatically.

## Automated verification

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The tests use the fake AI provider. They cover the HTTP 202 client contract and idempotency header, unsafe result URLs, ZIP path traversal, manifest ownership, PNG dimensions, polling delays, download, import destination, and AnimationClip creation calls. They consume no fal.ai credit.

## Manual test with the fake provider

Copy `.env.example` to `.env` once, configure `API_KEY_PEPPER`, and keep `AI_PROVIDER=fake`. Start local dependencies, migrate the database, and provision a trial user:

```sh
pnpm docker:dev
pnpm db:migrate
pnpm user:create --email developer@example.com --name "Local Cocos"
pnpm build
```

Run these in separate terminals:

```sh
pnpm dev:api
```

```sh
pnpm dev:worker
```

In Cocos Creator 3.8.x:

1. Open the target project and an editable scene.
2. Open **Extension > Extension Manager** and import the folder `dist/ai-sprite-generator` at project scope. Enable or reload it after rebuilding.
3. Open **Develop > AI Sprite Generator**.
4. Keep Backend URL as `http://localhost:3000` and paste the printed `spr_live_…` API key.
5. Enter a prompt, choose `Walk`, `Idle`, or `Attack`, set FPS from 4 to 30, and click **Generate and Import**.
6. Confirm progress advances through queue, AI, processing, download, extraction, and import.
7. In Assets, confirm `AI_Sprites/{generationId}` contains eight PNGs and the selected `.anim` file. The clip must preserve manifest order, FPS, duration, loop mode, and bottom pivot.
8. Trigger a retry check by stopping the API during polling. When the panel reports the connection error, restart the API and click **Retry**. It must resume the same generation rather than submit a duplicate.

The extension performs the ZIP download, extraction, asset copy, refresh, and clip creation. Do not copy generated files into the Cocos project manually.

## Optional real fal.ai test

This step consumes provider credit. Put `FAL_KEY` only in ignored `.env`, change `AI_PROVIDER=fal`, and restart the worker:

```sh
pnpm dev:worker
```

Use the same Cocos steps. The API does not need the fal.ai key; only the worker reads it. Restore `AI_PROVIDER=fake` after the manual provider check.

Paddle, application API keys, credit accounting, R2, and production deployment remain outside Phase 4.

Stop after Phase 4.
