import { build } from 'esbuild';
import path from 'node:path';

export async function buildAiPoc() {
  const outfile = path.resolve('dist/ai-poc.cjs');
  await build({
    entryPoints: ['scripts/test-ai.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['sharp'],
    sourcemap: true,
  });
  return outfile;
}
