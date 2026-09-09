import { zipSync } from 'fflate';
import { manifestSchema, type GenerationManifest } from '@sprite/contracts';

/** Canonical files and archive; no filesystem or storage dependencies. */
export function createSpritePackage(
  result: { frames: Buffer[]; sheet: Buffer },
  settings: Pick<
    GenerationManifest,
    'generationId' | 'animation' | 'fps' | 'loop'
  >,
) {
  if (result.frames.length !== 8)
    throw new Error('A result package requires exactly eight frames.');
  const manifest = manifestSchema.parse({
    ...settings,
    version: 1,
    direction: 'right',
    frameCount: 8,
    frameSize: 256,
    pivot: { x: 0.5, y: 0 },
    frames: result.frames.map(
      (_, index) => `frames/${String(index).padStart(2, '0')}.png`,
    ),
  });
  const files: Record<string, Buffer> = {
    'manifest.json': Buffer.from(JSON.stringify(manifest, null, 2) + '\n'),
    'sheet.png': result.sheet,
  };
  manifest.frames.forEach((filename, index) => {
    files[filename] = result.frames[index]!;
  });
  return { manifest, files, zip: Buffer.from(zipSync(files, { level: 6 })) };
}
