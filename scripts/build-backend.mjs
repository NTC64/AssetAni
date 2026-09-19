import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const external = [
  'bullmq',
  'drizzle-orm',
  'drizzle-orm/*',
  'fastify',
  'fflate',
  'ioredis',
  'pg',
  'sharp',
  'zod',
];

export async function buildBackend() {
  const outputDirectory = path.resolve('dist/backend');
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  await build({
    entryPoints: {
      api: 'apps/api/src/server.ts',
      worker: 'apps/worker/src/worker.ts',
    },
    outdir: outputDirectory,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    sourcemap: true,
    external,
  });
  return outputDirectory;
}
