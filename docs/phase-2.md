# Phase 2: AI sprite POC and image processing

Scope: standalone server-side generation and local image processing only. Phase 1 was manually verified by the owner. Phase 2's implementation and offline flow are verified; **real fal.ai generation and human review of at least 20 real outputs are pending** because FAL_KEY was not configured in this workspace. Stop after Phase 2.

## Install and verify

From the repository root using Node 22 LTS and pnpm 10.28.2:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

If your shell overrides pnpm, substitute `npx --yes pnpm@10.28.2`. On this Windows host validation used `npx --yes --package=node@22 --package=pnpm@10.28.2 -- pnpm <command>` with a writable local npm cache. Native Sharp binaries are installed through pnpm. The approved dependency build list is limited to esbuild and sharp.

## Offline runs (no paid calls)

One test sheet:

```sh
pnpm test:ai --provider fake --prompt "blue knight with silver sword" --animation walk --seed 42 --fps 12
```

Twenty varied synthetic cases, suitable for checking packaging and review workflow:

```sh
pnpm test:ai --provider fake --suite --seed 100
```

`fake` is the default provider. Its original diagnostic shapes are deterministic for prompt, animation, and seed. They are not AI-generated artwork and do not establish model quality. With no seed the fake provider uses 0; fal requests omit the seed and record the provider-selected value.

## Real fal.ai commands

Configure FAL_KEY locally in the process environment. Never paste it into the Cocos plugin. `.env.example` documents the variable; `.env` is ignored by Git and is **not automatically loaded** by the runner.

PowerShell:

```powershell
$env:FAL_KEY = '<your-fal-key>'
pnpm test:ai --provider fal --model turbo --prompt "blue knight with silver sword" --animation walk --seed 42
```

Bash:

```sh
export FAL_KEY='<your-fal-key>'
pnpm test:ai --provider fal --model turbo --prompt "blue knight with silver sword" --animation walk --seed 42
```

Alternatively, place FAL_KEY in a local `.env`, run `pnpm build`, then use Node's environment-file loader:

```sh
node --env-file=.env dist/ai-poc.cjs --provider fal --model turbo --prompt "blue knight with silver sword" --animation walk --seed 42
```

The required real quality trial (20 cases, sequential):

```sh
pnpm test:ai --provider fal --model turbo --suite --seed 100
```

Schnell is an explicitly selected fallback/model comparison, and still incurs provider usage:

```sh
pnpm test:ai --provider fal --model schnell --prompt "blue knight with silver sword" --animation walk --seed 42
```

`--count N` runs 1–100 cases; suite defaults to 20 and cycles through the case list if N is larger. Without `--suite`, count repeats the supplied prompt/animation. A supplied seed increments per case modulo 2^32. `--fps` accepts integers 4–30 (default 12). `--out` changes the output root. `--help` prints all options. Do not insert an extra `--` before options when using these `pnpm test:ai` commands.

Real calls request one 1024 × 1024 PNG. The adapter uses a private `createFalClient` instance and `run()` with an AbortSignal deadline of 120 seconds. It does not automatically switch models. The installed SDK itself retries transient requests (its run implementation sets up to three retries); a timeout does not prove provider-side work was canceled. Check the fal dashboard before repeating a failed or timed-out paid case. Raw SDK error bodies and credentials are not logged.

## Outputs and metadata

Every invocation creates a unique run directory under `artifacts/ai-poc/`. Every case gets a numbered UUID directory, so previous artifacts are preserved.

```text
artifacts/ai-poc/<provider>-<timestamp>-<run-id>/
  index.json
  review.csv
  REVIEW.md
  01-<generation-uuid>/
    raw.png                       # original 1024x1024 provider output
    metadata.json
    manifest.json
    sheet.png                     # 1024x512 canonical 4x2 sheet
    frames/00.png ... 07.png       # eight 256x256 transparent frames
    result.zip                    # manifest.json, sheet.png and frames only
```

Metadata includes case number, input/effective prompt, requested/resolved seed, model, request ID, generation ID, duration/provider duration, output path, and frame diagnostics. A failure is recorded as FAILED; the process exits nonzero if any case fails. Already generated raw files are retained for diagnosis. A successful image pipeline is recorded as PROCESSED with quality review PENDING. Failures before provider output have no resolved seed or request ID. The index is updated after each completed case.

The manifest controls ordering, FPS, animation, loop and pivot. Phase 2 uses `frames/00.png` … `frames/07.png` as explicitly requested. The shared validator still accepts Phase 1 names, and the Cocos fixtures remain unchanged. Idle/walk loop; attack is exported once. The pivot is `(0.5, 0)`.

## Processing details

`packages/image` uses Sharp and accepts a single 1024 × 1024 PNG up to 16 MiB. The grid helper supports non-divisible dimensions with rounded boundaries; the production-facing MVP entry point still requires the specified 1024-square input. Each 4×2 source cell is 256×512.

RGBA masking uses Euclidean distance from RGB(244,244,244): distance ≤18 removes alpha, distance ≥35 preserves source alpha, and values between interpolate multiplicatively. Source alpha below 16 becomes transparent. An 8-connected component scan removes components smaller than `max(64, cellWidth*cellHeight*0.0005)` pixels. Bounds include all remaining components. Blank cells fail rather than producing an apparently successful blank animation.

Each foreground is independently scaled by `min(240/width, 240/height)` with nearest-neighbor resizing. Rounded output dimensions remain at most 240×240. It is horizontally centered (at most one pixel imbalance from integer rounding) and placed at `y = 256 - scaledHeight - 8`. PNG compression is level 9 with adaptive filtering. The canonical sheet preserves row-major frame order.

## Human quality review and acceptance

1. Complete at least 20 real fal cases. Fake output cannot satisfy this gate. If cases fail, retain failure records and run additional explicit cases until at least 20 real sheets can be inspected.
2. Open the generated REVIEW.md and inspect both raw and normalized sheets for each case.
3. Fill each row in review.csv with yes/no for: exactly eight poses, correct 4×2 grid, same character, no overlap, useful animation poses. Add notes, especially changed clothing/proportions or missing body parts.
4. Check metadata diagnostics for multiple foreground components and cells touching an edge. Treat these as review flags, not proof of semantic grid correctness.
5. Open frames/00.png … 07.png in order; confirm transparency, 256×256 size, no clipping, horizontal centering and 8px bottom margin. Review timing at manifest FPS in an external animation viewer if useful. This phase does not connect the generated package to the Cocos panel.
6. Summarize acceptance/rejection counts and recurring failures in the run's REVIEW.md. The owner must judge whether visual consistency and poses are useful enough. No pass threshold is invented here.

Known limitations: flat-color removal can erase similarly colored character details; tiny legitimate disconnected details may be removed as noise; cell normalization can amplify inconsistent source proportions; foreground touching an edge may already be clipped. The pipeline does not detect semantic pose count or repair malformed AI layouts. There is no automatic paid regeneration or application-level retry/fallback policy in Phase 2. All model output remains untrusted input.

## Source verification

The implementation was checked against installed `@fal-ai/client@1.10.1` declarations and implementation, including `createFalClient`, typed model endpoints, `run`, AbortSignal support, and SDK retry behavior. Current official schemas confirm [FLUX.2 Turbo](https://fal.ai/models/fal-ai/flux-2/turbo/api) at `fal-ai/flux-2/turbo` and [FLUX.1 Schnell](https://fal.ai/models/fal-ai/flux/schnell/api) at `fal-ai/flux/schnell`, including custom image dimensions, seed and PNG format. Resize behavior follows [Sharp's official documentation](https://sharp.pixelplumbing.com/api-resize/).

Downloads accept HTTPS provider locations on fal.media (including subdomains) and the documented storage.googleapis.com/falserverless path. Credentials are not forwarded, redirects are rejected, and streamed bytes are capped at 16 MiB. A future provider CDN change requires an explicit allowlist update.

## Verification record

- 61 automated tests passed: 20 existing Cocos tests and 41 new Phase 2 tests. Tests use fake providers/injected transport and consume no paid calls.
- 20/20 fake-provider cases completed through the actual CLI, Sharp pipeline, manifest generation and ZIP export.
- Example retained run: `artifacts/ai-poc/fake-2026-09-09T11-14-21-600Z-374449bc/`.
- One normalized fake sheet was visually inspected; the full batch is available for review.
- Final verification passed on Node 22.23.2 / pnpm 10.28.2: frozen-lockfile install, ESLint/Prettier, strict typecheck, all 61 tests, and both extension/POC builds. The compiled CLI help and missing-FAL_KEY failure path were also checked; no real provider call was submitted.
- Real fal.ai execution: NOT RUN (FAL_KEY unavailable). Real 20-sheet model-quality acceptance: PENDING.

No Phase 3 work or excluded commercial/storage/infrastructure features have been implemented.
