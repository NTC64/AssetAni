import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { manifestSchema } from '@sprite/contracts';
import type { CocosAdapter } from '../cocos/cocos-adapter';

export const TEST_DESTINATION = 'db://assets/AI_Sprites/test_walk';

/** Validate the entire local input before touching the project's Asset Database. */
export async function importTestAssets(
  adapter: CocosAdapter,
  directory: string,
): Promise<string> {
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')),
  );
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
  await adapter.importGeneration({
    sourceDirectory: root,
    manifest,
    destination: TEST_DESTINATION,
  });
  await adapter.refreshAsset(TEST_DESTINATION);
  await adapter.createAnimation(TEST_DESTINATION, manifest);
  return `${TEST_DESTINATION}/${manifest.animation}.anim`;
}
