# Phase 2: AI sprite POC and image processing

Scope: standalone server-side generation and local image processing only. Phase 1 was manually verified by the owner. The active real-provider proof of concept now uses PixelLab-generated frames; fal remains a legacy rollback option.

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

## Real PixelLab command

PixelLab calls consume provider credit. Start with one case and inspect the result before running a suite.

PowerShell:

```powershell
$env:PIXELLAB_API_TOKEN = '<your-pixellab-token>'
pnpm test:ai --provider pixellab --prompt "blue knight with silver sword" --animation walk --seed 42 --fps 12
```

With the token and PixelLab settings in ignored `.env`, the compiled runner can load them directly:

```sh
pnpm build
node --env-file=.env dist/ai-poc.cjs --provider pixellab --prompt "blue knight with silver sword" --animation walk --seed 42 --fps 12
```

This calls `create-image-pixen` once and `animate-with-text-v3` once, then polls the animation job. It does not ask AI to draw a grid and Sharp does not slice a grid on this path. Run `--suite` only when you intentionally accept the cost of every case.

## Legacy fal.ai command

Configure FAL_KEY locally in the process environment. Never paste it into the Cocos plugin. `.env.example` documents the variable; `.env` is ignored by Git and is **not automatically loaded** by the runner.

PowerShell:

```powershell
$env:FAL_KEY = '<your-fal-key>'
pnpm test:ai --provider fal --model sprite --prompt "blue knight with silver sword" --animation walk --seed 42
```

Bash:

```sh
export FAL_KEY='<your-fal-key>'
pnpm test:ai --provider fal --model sprite --prompt "blue knight with silver sword" --animation walk --seed 42
```

Alternatively, place FAL_KEY in a local `.env`, run `pnpm build`, then use Node's environment-file loader:

```sh
node --env-file=.env dist/ai-poc.cjs --provider fal --model sprite --prompt "blue knight with silver sword" --animation walk --seed 42
```

The sprite profile performs eight billed frame requests for one animation. Start with one case. Run the 20-case quality suite only after reviewing that result because the suite performs up to 160 billed frame requests:

```sh
pnpm test:ai --provider fal --model sprite --suite --seed 100
```

Schnell is an explicitly selected fallback/model comparison, and still incurs provider usage:

```sh
pnpm test:ai --provider fal --model schnell --prompt "blue knight with silver sword" --animation walk --seed 42
```

`--count N` runs 1–100 cases; suite defaults to 20 and cycles through the case list if N is larger. Without `--suite`, count repeats the supplied prompt/animation. A supplied seed increments per case modulo 2^32. `--fps` accepts integers 4–30 (default 12). `--out` changes the output root. Paid fal output is not regenerated automatically. `--auto-retry-paid-output` explicitly permits the one additional billed generation for an intentional batch. `--help` prints all options. Do not insert an extra `--` before options when using these `pnpm test:ai` commands.

The sprite profile uses `fal-ai/lora` with SDXL Base, Pixel Art XL LoRA, one explicit OpenPose control map per frame, and a fixed seed. Frame 1 establishes the character reference; frames 2–8 receive that image through IP-Adapter. Each 512 × 512 result is reduced to a 64 × 64 logical pixel grid, enlarged to 256 × 256 with nearest-neighbor, and assembled into the canonical 1024 × 512 sheet. Turbo and Schnell remain explicit regression comparisons. The adapter uses a private `createFalClient` instance and `run()` with a 300-second deadline per sprite frame to allow model cold starts. It does not automatically switch models. A timeout does not prove provider-side work was canceled. Check the fal dashboard before repeating a failed or timed-out paid case. Raw SDK error bodies and credentials are not logged.

## Outputs and metadata

Every invocation creates a unique run directory under `artifacts/ai-poc/`. Every case gets a numbered UUID directory, so previous artifacts are preserved.

```text
artifacts/ai-poc/<provider>-<timestamp>-<run-id>/
  index.json
  review.csv
  REVIEW.md
  01-<generation-uuid>/
    raw.png                       # original 1024x512 provider output
    metadata.json
    manifest.json
    sheet.png                     # 1024x512 canonical 4x2 sheet
    frames/00.png ... 07.png       # eight 256x256 transparent frames
    result.zip                    # manifest.json, sheet.png and frames only
```

Metadata includes case number, input/effective prompt, requested/resolved seed, model, request ID, generation ID, duration/provider duration, output path, and frame diagnostics. A failure is recorded as FAILED; the process exits nonzero if any case fails. Already generated raw files are retained for diagnosis. A successful image pipeline is recorded as PROCESSED with quality review PENDING. Failures before provider output have no resolved seed or request ID. The index is updated after each completed case.

The manifest controls ordering, FPS, animation, loop and pivot. Phase 2 uses `frames/00.png` … `frames/07.png` as explicitly requested. The shared validator still accepts Phase 1 names, and the Cocos fixtures remain unchanged. Idle/walk loop; attack is exported once. The pivot is `(0.5, 0)`.

An already-paid raw provider image can be processed again after a local pipeline fix without calling fal.ai:

```sh
pnpm reprocess:ai --input artifacts/backend-results/<generation-id>/raw-attempt-1.png --animation attack --fps 12 --generation-id <generation-id> --out artifacts/reprocessed/<generation-id>
```

This writes a new local package and diagnostics only. It does not change the generation row or import into Cocos automatically.

## Processing details

`packages/image` uses Sharp and accepts a single 1024 × 512 PNG up to 16 MiB. The production entry point requires this exact 4×2 canvas, so every source cell is 256×256.

Before masking, validation requires at least 55% of all pixels and 90% of the outer eight-pixel border to be within distance 18 of RGB(244,244,244), or already transparent. It also flood-fills background-like pixels (distance at most 60) from the canvas edge and requires their RGB-distance standard deviation to be at most 8. Mild provider shading is repaired locally; stronger variation that cannot be isolated safely returns `INVALID_BACKGROUND`.

RGBA masking flood-fills pixels within Euclidean distance 60 of RGB(244,244,244) from the edge of each cell. This removes connected light matte and fringes while preserving enclosed light highlights on the character. Source alpha below 16 is background. An 8-connected component scan removes components smaller than `max(64, cellWidth*cellHeight*0.0005)` pixels, secondary effects that touch a cell boundary, and detached flat ground shadows below the main character. Bounds include all remaining components. Blank cells fail. More than twelve surviving boundary pixels returns `INVALID_GRID`; this catches material overlap and clipping while tolerating a short antialiased weapon tip at a boundary.

After normalization, the pipeline compares consecutive alpha silhouettes and the average foreground palette. A static or barely changing sequence returns `INSUFFICIENT_MOTION`; a large per-frame palette shift returns `INCONSISTENT_CHARACTER`. These failures, `INVALID_BACKGROUND`, `INVALID_GRID`, and an empty frame receive exactly one additional provider call using the same generation input and seed plus the strict layout instruction. Both raw attempts and validation details are retained. A second validation failure ends as FAILED and no manifest, normalized sheet, frames, or ZIP are written. Provider/network failures are not generation-level retried by the runner. The fal SDK may still perform its own transport retries.

Each foreground is independently scaled by `min(240/width, 240/height)` with nearest-neighbor resizing. Rounded output dimensions remain at most 240×240. It is horizontally centered (at most one pixel imbalance from integer rounding) and placed at `y = 256 - scaledHeight - 8`. PNG compression is level 9 with adaptive filtering. The canonical sheet preserves row-major frame order.

## Human quality review and acceptance

1. Complete at least 20 real fal cases. Fake output cannot satisfy this gate. If cases fail, retain failure records and run additional explicit cases until at least 20 real sheets can be inspected.
2. Open the generated REVIEW.md and inspect both raw and normalized sheets for each case.
3. Fill each row in review.csv with yes/no for: exactly eight poses, correct 4×2 grid, same character, no overlap, useful animation poses. Add notes, especially changed clothing/proportions or missing body parts.
4. Check metadata diagnostics for multiple foreground components and cells touching an edge. Treat these as review flags, not proof of semantic grid correctness.
5. Open frames/00.png … 07.png in order; confirm transparency, 256×256 size, no clipping, horizontal centering and 8px bottom margin. Review timing at manifest FPS in an external animation viewer if useful. This phase does not connect the generated package to the Cocos panel.
6. Summarize acceptance/rejection counts and recurring failures in the run's REVIEW.md. The owner must judge whether visual consistency and poses are useful enough. No pass threshold is invented here.

Known limitations: light character details connected to the outer matte can be removed; tiny legitimate detached details may be treated as noise; cell normalization can amplify inconsistent source proportions; foreground touching an edge may already be clipped. Silhouette motion proves visible change, but cannot prove that every pose is anatomically correct for the requested action. The pose guide supplies stronger structure and human review remains required for real model quality. The pipeline rejects malformed output and retries it once; it does not repair output or switch models. All model output remains untrusted input.

## Source verification

The implementation was checked against installed `@fal-ai/client@1.10.1` declarations and implementation, including `createFalClient`, `run`, AbortSignal support, and SDK retry behavior. The official schema confirms [FLUX.2 Turbo Edit](https://fal.ai/models/fal-ai/flux-2/turbo/edit/api) accepts `image_urls`, base64 data URIs, custom image dimensions, guidance, seed, and PNG output. [FLUX.1 Schnell](https://fal.ai/models/fal-ai/flux/schnell/api) remains available as the text-to-image comparison. Resize behavior follows [Sharp's official documentation](https://sharp.pixelplumbing.com/api-resize/).

Downloads accept HTTPS provider locations on fal.media (including subdomains) and the documented storage.googleapis.com/falserverless path. Credentials are not forwarded, redirects are rejected, and streamed bytes are capped at 16 MiB. A future provider CDN change requires an explicit allowlist update.

## Verification record

- The current repository test suite passes 114 automated tests. Tests use fake providers/injected transport and consume no paid calls.
- 20/20 fake-provider cases completed through the actual CLI, Sharp pipeline, manifest generation and ZIP export.
- Example retained run: `artifacts/ai-poc/fake-2026-09-09T11-14-21-600Z-374449bc/`.
- One normalized fake sheet was visually inspected; the full batch is available for review.
- Final verification passed on the local Node/pnpm toolchain: ESLint/Prettier, strict typecheck, all 71 tests, and both extension/POC builds.
- The earlier text-to-image fal.ai preflight passed 0/3 animation gates after six paid calls. That evidence remains in `artifacts/ai-poc/professional-gate-v2/PHASE_2_GATE_REPORT.md`. The newer pose-guided Turbo Edit path has passed offline adapter, image-quality, retry, refund, and end-to-end queue tests; it still requires one deliberate paid manual case before a new 20-sheet acceptance run.
