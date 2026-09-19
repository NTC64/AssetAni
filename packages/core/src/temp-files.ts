import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function spriteTempRoot() {
  const configured = process.env.SPRITE_TEMP_PATH?.trim();
  return configured ? path.resolve(configured) : path.join(os.tmpdir(), 'sprite');
}

export function generationTempDirectory(generationId: string) {
  return path.join(spriteTempRoot(), generationId);
}

export async function prepareGenerationTempDirectory(generationId: string) {
  const directory = generationTempDirectory(generationId);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  return directory;
}

export async function cleanupGenerationTempDirectory(generationId: string) {
  await rm(generationTempDirectory(generationId), {
    recursive: true,
    force: true,
  });
}

export async function cleanupAbandonedTempDirectories(
  maximumAgeMs = 2 * 60 * 60 * 1000,
) {
  const root = spriteTempRoot();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    const details = await stat(directory);
    if (Date.now() - details.mtimeMs > maximumAgeMs) {
      await rm(directory, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}
