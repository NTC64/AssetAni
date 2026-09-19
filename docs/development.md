# Local development through Phase 5

Requirements: Node.js 22, pnpm 10.28.2, Docker Desktop (for the manual PostgreSQL 16 and Redis 7 flow), and Cocos Creator 3.8.x only when testing the extension.

## Install and verify

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` starts isolated PostgreSQL-compatible PGlite and a temporary Redis process for the backend integration flow. It uses the fake AI provider and makes no paid call. The normal runtime uses PostgreSQL through Drizzle's `node-postgres` adapter.

## Run the API and worker locally

Copy `.env.example` to `.env`. Use `AI_PROVIDER=fake` for the complete free local flow, or keep the default `AI_PROVIDER=pixellab` and set `PIXELLAB_API_TOKEN` for a real generation. Replace `API_KEY_PEPPER` with a private value of at least 32 bytes. One way to generate it is:

```sh
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

```sh
pnpm docker:dev
pnpm db:migrate
pnpm user:create --email developer@example.com --name "Local Cocos"
```

Start two terminals with the same environment loaded:

```sh
pnpm dev:api
```

```sh
pnpm dev:worker
```

After `pnpm build`, use `pnpm start:api` and `pnpm start:worker` to test the compiled bundles instead of watch mode. These scripts and `pnpm db:migrate` load the ignored local `.env` automatically.

`user:create` grants exactly three lifetime trial credits and prints the raw `spr_live_…` key once. Store it immediately. The database contains only its prefix and HMAC-SHA256 hash.

For a real provider run, keep `AI_PROVIDER=pixellab`, set `PIXELLAB_API_TOKEN` only in ignored `.env`, and restart the worker. The worker calls `create-image-pixen`, submits `animate-with-text-v3`, polls the returned background job, then feeds the eight ordered PNG frames directly into Sharp. Keep `AI_AUTO_RETRY_PAID_OUTPUT=false` so a locally rejected paid result is not regenerated automatically. `AI_PROVIDER=fal` with `FAL_KEY` remains available as a legacy rollback path.

## Manual asynchronous flow

PowerShell:

```powershell
$key = [guid]::NewGuid().ToString()
$apiKey = "spr_live_replace_with_the_key_printed_by_user_create"
$body = '{"prompt":"blue knight with silver sword","style":"pixel_art","animation":"walk","direction":"right","frameCount":8,"fps":12,"frameSize":256,"background":"transparent","seed":42}'
$headers = @{"Authorization"="Bearer $apiKey";"Idempotency-Key"=$key}
$created = Invoke-RestMethod -Method Post -Uri http://localhost:3000/v1/generations -Headers $headers -ContentType application/json -Body $body
$created
Invoke-RestMethod -Uri "http://localhost:3000/v1/generations/$($created.id)" -Headers @{"Authorization"="Bearer $apiKey"}
Invoke-RestMethod -Uri http://localhost:3000/v1/me/credits -Headers @{"Authorization"="Bearer $apiKey"}
```

Poll until the authoritative `status` is `SUCCEEDED` or `FAILED`. On success, download `result.packageUrl`. A fake-provider result is written under `artifacts/backend-results/{generationId}`.

The POST response should be HTTP 202 with `QUEUED` even while the worker's provider call is blocked. The integration test asserts this behavior and then polls through BullMQ until the ZIP can be downloaded and validated.

## Run the complete Cocos workflow

Keep the API and worker terminals running, then build the standalone extension:

```sh
pnpm build
```

In Cocos Creator 3.8.x, open **Extension > Extension Manager**, choose the project scope, import `dist/ai-sprite-generator`, enable it, and open **Develop > AI Sprite Generator**. Enter:

- Backend URL: `http://localhost:3000`
- API key: the `spr_live_…` value printed by `pnpm user:create`
- Character prompt: `blue knight with a silver sword`
- Animation: `Walk`
- FPS: `12`

Click **Generate and Import**. The panel submits the generation, polls the backend, downloads and validates `result.zip`, imports the frames to `assets/AI_Sprites/{generationId}`, and creates `walk.anim`. No package extraction or asset copying is needed. A failed or timed-out operation shows **Retry**; timeouts resume the same backend generation.

Use `AI_PROVIDER=fake` for this complete test without a paid request. To manually verify PixelLab, stop the worker, set `AI_PROVIDER=pixellab` and `PIXELLAB_API_TOKEN` in ignored `.env`, restart `pnpm dev:worker`, and repeat the same panel workflow.

## Character pipeline and batch verification

Apply the additive character migration before starting the API and worker:

```powershell
cd E:\Codex\AssetRun
pnpm.cmd install --frozen-lockfile
pnpm.cmd docker:dev
pnpm.cmd db:migrate
pnpm.cmd dev:api
```

In a second PowerShell window:

```powershell
cd E:\Codex\AssetRun
pnpm.cmd dev:worker
```

Use `AI_PROVIDER=fake` first. The following commands create one reusable character, poll it until ready, create a walk animation, and create a five-animation batch. Replace the API key value with the key printed by `pnpm.cmd user:create`.

```powershell
$apiKey = "spr_live_replace_me"
$auth = @{ Authorization = "Bearer $apiKey" }
$createHeaders = @{ Authorization = "Bearer $apiKey"; "Idempotency-Key" = [guid]::NewGuid().ToString() }
$character = Invoke-RestMethod -Method Post -Uri http://localhost:3000/v1/characters -Headers $createHeaders -ContentType application/json -Body '{"name":"Knight","prompt":"heroic blue knight with a silver sword","preset":"platformer"}'
do { Start-Sleep -Seconds 2; $character = Invoke-RestMethod -Uri "http://localhost:3000/v1/characters/$($character.id)" -Headers $auth } while ($character.status -eq "PENDING")
$walkHeaders = @{ Authorization = "Bearer $apiKey"; "Idempotency-Key" = [guid]::NewGuid().ToString() }
$walk = Invoke-RestMethod -Method Post -Uri "http://localhost:3000/v1/characters/$($character.id)/animations" -Headers $walkHeaders -ContentType application/json -Body '{"animation":"walk","mode":"standard"}'
$batchHeaders = @{ Authorization = "Bearer $apiKey"; "Idempotency-Key" = [guid]::NewGuid().ToString() }
$batch = Invoke-RestMethod -Method Post -Uri "http://localhost:3000/v1/characters/$($character.id)/batches" -Headers $batchHeaders -ContentType application/json -Body '{"preset":"platformer","animations":["idle","walk","attack","hurt","death"],"mode":"standard"}'
$batch.generations | ForEach-Object { Invoke-RestMethod -Uri "http://localhost:3000/v1/generations/$($_.id)" -Headers $auth }
```

For the real pipeline, stop the worker, set `AI_PROVIDER=pixellab` and `PIXELLAB_API_TOKEN` in `.env`, then restart `pnpm.cmd dev:worker`. Keep `FAL_KEY` optional; when present it enables fal.ai concepts and a compatible base-character fallback. Automated tests never call either paid service.

After `pnpm.cmd build`, reload the extension in Cocos Creator. Enter the backend URL, API key, character name, prompt, and preset, then click **Create Character + 6 Animations**. The extension waits for the reusable base, queues the child generations, downloads successful packages, and writes action folders plus clips under `assets/AI_Sprites/{Character}/animations` without manual file operations.
