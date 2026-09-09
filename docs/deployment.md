# Phase 1 distribution

Run `pnpm build` to create `dist/ai-sprite-generator`. It contains a Cocos manifest without workspace dependencies, three CommonJS bundles, source maps, and eight local test PNGs with their manifest.

Copy this directory into `<project>/extensions/ai-sprite-generator`, enable it in Creator's project Extension Manager, and open it through the Develop menu. The build does not modify an installed editor or an external project. See `PHASE_1_TEST.md` for the installation and playback gate.

Bundles target Node 16 syntax for the embedded editor runtime; development tooling targets Node 22. Cocos itself supplies the external `cc` engine module only in the scene process. All other runtime dependencies are bundled.

API hosting, Docker, database, Redis, R2, Paddle, and CI image publishing are intentionally unimplemented. Phase 2's FAL_KEY is used only by the local Node POC, not by the extension or an API server. Production deployment preparation begins in later approved phases. Never describe these local proofs as a deployed or production-ready SaaS.
