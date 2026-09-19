import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { manifestSchema, type GenerationManifest } from '@sprite/contracts';
import type { CocosAdapter } from '../cocos/cocos-adapter';

export const TEST_DESTINATION = 'db://assets/AI_Sprites/test_walk';

async function preflightFrames(
  directory: string,
  manifest: GenerationManifest,
) {
  const root = await realpath(directory);
  for (const frame of manifest.frames) {
    const resolved = await realpath(path.join(root, frame));
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('Test frame escapes its source directory.');
    const bytes = await readFile(resolved);
    if (
      bytes.length < 33 ||
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.toString('ascii', 12, 16) !== 'IHDR' ||
      bytes.readUInt32BE(16) !== manifest.frameSize ||
      bytes.readUInt32BE(20) !== manifest.frameSize
    ) {
      throw new Error(`Invalid 256 x 256 PNG: ${frame}`);
    }
  }
  return root;
}

/** Validate a downloaded package before touching the project's Asset Database. */
export async function importGenerationAssets(
  adapter: CocosAdapter,
  directory: string,
  inputManifest?: GenerationManifest,
  options: { destination?: string; animationUrl?: string } = {},
): Promise<string> {
  const diskManifest = manifestSchema.parse(
    JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')),
  );
  const manifest = manifestSchema.parse(inputManifest ?? diskManifest);
  if (JSON.stringify(diskManifest) !== JSON.stringify(manifest))
    throw new Error('Extracted manifest changed before asset import.');
  const root = await preflightFrames(directory, manifest);
  const destination =
    options.destination ?? `db://assets/AI_Sprites/${manifest.generationId}`;
  await adapter.importGeneration({
    sourceDirectory: root,
    manifest,
    destination,
  });
  await adapter.refreshAsset(destination);
  if (options.animationUrl)
    await adapter.createAnimation(destination, manifest, options.animationUrl);
  else await adapter.createAnimation(destination, manifest);
  return options.animationUrl ?? `${destination}/${manifest.animation}.anim`;
}

/** Phase 1 regression helper retained for the manually verified local fixture. */
export async function importTestAssets(
  adapter: CocosAdapter,
  directory: string,
): Promise<string> {
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')),
  );
  const root = await preflightFrames(directory, manifest);
  await adapter.importGeneration({
    sourceDirectory: root,
    manifest,
    destination: TEST_DESTINATION,
  });
  await adapter.refreshAsset(TEST_DESTINATION);
  await adapter.createAnimation(TEST_DESTINATION, manifest);
  return `${TEST_DESTINATION}/${manifest.animation}.anim`;
}
