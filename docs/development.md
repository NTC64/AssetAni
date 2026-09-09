# Development

From the repository root, use Node.js 22 and pnpm 10.28.2:

```sh
pnpm install --frozen-lockfile
pnpm fixtures
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:ai --provider fake --suite --seed 100
```

Tests use Vitest and fake Editor/engine implementations. They perform actual fixture reads but cannot validate Creator's asset importer, renderer, or serialized clip deserialization. Typechecking uses the official `@cocos/creator-types@3.8.8` declarations, with a narrow verified serializer declaration because the published package omits that global. Third-party declarations are excluded from library checking with `skipLibCheck`; project code remains strict.

For source iteration, `pnpm dev` watches and rebuilds `apps/cocos-plugin/dist`. After changes, run `pnpm build`, copy the standalone directory back to the project's extension directory, and reload the extension in Creator. Watch mode does not automatically copy into another project or regenerate fixture assets.

If a host-provided pnpm wrapper uses a different major version, use `npx --yes pnpm@10.28.2 <command>`. In this restricted Windows workspace, npm needed a writable cache (`$env:npm_config_cache = "$PWD/.npm-cache"`). This is an environment workaround, not a requirement for normal machines.

The owner has verified Phase 1 and authorized Phase 2. Stop after Phase 2. No `db:migrate`, `docker:dev`, or backend `dev` command exists at this phase.

The Phase 2 command compiles `scripts/test-ai.ts` with the existing esbuild dependency and runs it in Node 22. `pnpm build` now builds both the extension and development POC. The POC bundle requires installed Sharp; it is not shipped in the extension. `pnpm typecheck` and `pnpm lint` include the new TypeScript scripts. Real fal calls are isolated from tests and require explicit `--provider fal`. See [phase-2.md](phase-2.md) for environment setup and review commands.
