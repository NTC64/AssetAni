import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import path from 'node:path';

const outfile = path.resolve('dist/reprocess-ai.cjs');
await build({
  entryPoints: ['scripts/reprocess-ai.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['sharp'],
});
await import(pathToFileURL(outfile).href);
