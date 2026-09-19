import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createSpritePackage, processSpriteSheet } from '@sprite/image';
import { z } from 'zod';

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: 'string' },
      animation: { type: 'string' },
      fps: { type: 'string', default: '12' },
      out: { type: 'string' },
      'generation-id': { type: 'string' },
    },
  });
  const inputPath = path.resolve(z.string().min(1).parse(values.input));
  const animation = z.enum(['idle', 'walk', 'attack']).parse(values.animation);
  const fps = z.coerce.number().int().min(4).max(30).parse(values.fps);
  const generationId = z
    .string()
    .uuid()
    .parse(values['generation-id'] ?? randomUUID());
  const outputPath = path.resolve(
    values.out ?? path.join(path.dirname(inputPath), 'reprocessed'),
  );
  const processed = await processSpriteSheet({
    inputBuffer: await readFile(inputPath),
    animation,
  });
  const packaged = createSpritePackage(processed, {
    generationId,
    animation,
    fps,
    loop: animation !== 'attack',
  });
  await mkdir(outputPath, { recursive: true });
  await mkdir(path.join(outputPath, 'frames'), { recursive: true });
  for (const [filename, contents] of Object.entries(packaged.files))
    await writeFile(path.join(outputPath, filename), contents);
  await writeFile(path.join(outputPath, 'result.zip'), packaged.zip);
  await writeFile(
    path.join(outputPath, 'diagnostics.json'),
    JSON.stringify(
      {
        generationId,
        source: inputPath,
        animation,
        background: processed.background,
        animationQuality: processed.animationQuality,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`Reprocessed package: ${outputPath}`);
}

void main();
