import { build, context } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { buildAiPoc } from './build-ai.mjs';
import { buildBackend } from './build-backend.mjs';
const root = 'apps/cocos-plugin';
const options = {
  entryPoints: {
    'main/index': `${root}/src/main/index.ts`,
    'panel/index': `${root}/src/panel/index.ts`,
    'scene/index': `${root}/src/scene/index.ts`,
  },
  outdir: `${root}/dist`,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node16',
  external: ['cc'],
  sourcemap: true,
};
if (process.argv.includes('--watch')) {
  const watcher = await context(options);
  await watcher.watch();
  console.log(
    'Watching extension source. Reload the extension in Creator after changes.',
  );
} else {
  await build(options);
  const destination = 'dist/ai-sprite-generator';
  await mkdir(destination, { recursive: true });
  await cp(`${root}/dist`, `${destination}/dist`, { recursive: true });
  await cp(`${root}/test-assets`, `${destination}/test-assets`, {
    recursive: true,
  });
  const manifest = JSON.parse(await readFile(`${root}/package.json`, 'utf8'));
  delete manifest.dependencies;
  delete manifest.private;
  await writeFile(
    `${destination}/package.json`,
    JSON.stringify(manifest, null, 2),
  );
  console.log(`Standalone extension ready: ${destination}`);
  console.log(`Standalone development POC ready: ${await buildAiPoc()}`);
  console.log(`Phase 5 backend ready: ${await buildBackend()}`);
}
