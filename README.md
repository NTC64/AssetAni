# AI Sprite Sheet & Animation Generator

Phase 1's Cocos Creator 3.8.x import and AnimationClip flow has been manually verified by the owner. Phase 2 adds a standalone fal.ai/fake-provider POC and Sharp image pipeline. **Offline processing is verified; real fal.ai generation and the 20-sheet human quality review remain pending because FAL_KEY is not configured.** No backend services are implemented.

The Cocos extension still imports its local test fixture. Phase 2 runs separately on Node and does not add network calls to the plugin. Stop after Phase 2; no backend, billing, account API keys, credits, R2, or production infrastructure is included.

## Requirements and commands

Use Node.js 22 LTS and pnpm 10.28.2. Creator 3.8.x is needed only for the extension. Fake-provider runs require no credentials. Real generation requires a fal.ai account and FAL_KEY in the server-side environment.

```sh
corepack enable
corepack prepare pnpm@10.28.2 --activate
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:ai --provider fake --suite --seed 100
```

If Corepack is unavailable or a host wrapper overrides pnpm, use `npx --yes pnpm@10.28.2` in place of `pnpm`. Do not regenerate the lockfile with a different package manager.

`pnpm dev` watches source and updates `apps/cocos-plugin/dist`. `pnpm fixtures` regenerates the original eight PNG fixtures. `pnpm format` formats source and docs.

See [Phase 2 commands and acceptance procedure](docs/phase-2.md) for single-image runs, the 20-case suite, model selection, metadata, and human review. Outputs go into a unique run directory under `artifacts/ai-poc/`.

## Install and test

1. Run `pnpm build`.
2. Copy the entire `dist/ai-sprite-generator` directory to `<your Cocos project>/extensions/ai-sprite-generator`.
3. Open the project in Creator 3.8.x. Open **Extension → Extension Manager** (some builds label the menu **Extensions**), select Project, and enable/reload `ai-sprite-generator`. Restart Creator if the extension is not discovered.
4. Open a scene and wait for project asset import to finish.
5. Choose **Develop → AI Sprite Generator** and click **Test Import**.
6. Follow [PHASE_1_TEST.md](PHASE_1_TEST.md) to assign and play the resulting clip.

The standalone build contains its dependencies and fixtures. Do not install the workspace package directly into another project: it contains workspace dependency references.

## Repository tree and file inventory

```text
apps/cocos-plugin/
  package.json
  src/
    main/index.ts                   # messages, import lock, logs/errors
    main/asset-importer.ts          # preflight and import orchestration
    panel/index.ts                  # native HTML panel, no business logic
    scene/index.ts                  # scene-process entry point
    cocos/cocos-adapter.ts          # version-independent interface
    cocos/cocos-3.8-adapter.ts       # all Editor/engine calls
  test-assets/
    README.md
    manifest.json
    frames/frame_00.png … frame_07.png
  dist/                            # generated bundles
packages/contracts/
  package.json
  src/index.ts                     # Zod manifest schema and inferred type
packages/ai/
  package.json
  src/index.ts
  src/provider.ts                  # provider interface and validated input
  src/prompt.ts                    # fixed prompt template
  src/fal-provider.ts              # server-side fal SDK adapter/download
  src/fake-provider.ts             # deterministic offline provider
packages/image/
  package.json
  src/index.ts                     # Sharp processing and normalization
  src/grid.ts                      # rounded row-major slicing boundaries
  src/foreground.ts                # background and component filtering
  src/package.ts                   # canonical manifest/files/ZIP
scripts/
  build.mjs                        # bundles and stages installable extension
  create-fixtures.mjs              # deterministic original PNG fixtures
  test-ai.ts                       # standalone Phase 2 CLI
  run-ai.mjs                       # build-and-run entry point
  build-ai.mjs                     # Node 22 POC bundle
  ai-poc/cases.ts                  # 20 varied review cases
  ai-poc/runner.ts                 # generation, processing, local export
tests/import.test.ts               # input, adapter and scene tests
tests/ai.test.ts                    # prompt/provider/download tests
tests/image.test.ts                 # slicing/masking/normalization tests
tests/ai-poc.test.ts                # offline complete output package tests
docs/
  architecture.md
  api.md
  development.md
  deployment.md
  cocos-3.8-api-evidence.md
  phase-2.md
dist/ai-sprite-generator/           # generated, ready to copy into Creator
dist/ai-poc.cjs                     # generated development CLI (needs installed sharp)
artifacts/ai-poc/                   # generated runs and reviews, gitignored
PHASE_1_TEST.md
README.md
package.json
pnpm-workspace.yaml
pnpm-lock.yaml
tsconfig.base.json
tsconfig.json
eslint.config.mjs
.gitignore
.prettierignore
.prettierrc.json
.env.example
```

The panel uses native HTML for this small local test; Vue and network services are deferred. Future packages are omitted until they have an implemented responsibility. There are no Git commits: the workspace was not a Git repository.

## Verification status

Automated checks cover 23 Cocos tests (including three metadata-save regression tests) plus 41 Phase 2 tests: prompt validation, mocked fal transport, download bounds, grid coverage, background removal, connected-component filtering, normalization, canonical sheet ordering, and package ZIP contents. Twenty synthetic cases have also run through the standalone CLI successfully. See [Phase 2](docs/phase-2.md) for the verification record.

The owner has confirmed Phase 1's manual Creator test. The AI model's visual quality has not been established by synthetic tests. This is not a production SaaS deployment.
"# AssetAni"
