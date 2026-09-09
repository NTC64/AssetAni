import { it, expect } from 'vitest';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { manifestSchema } from '../packages/contracts/src';
import { createFakeProvider, type AiProvider } from '../packages/ai/src';
import { runPocCase } from '../scripts/ai-poc/runner';

it('runs fake provider through Sharp and exports a self-contained manifest, sheet, eight frames and ZIP', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sprite-poc-'));
  try {
    const result = await runPocCase(
      createFakeProvider(),
      {
        prompt: 'blue knight',
        animation: 'attack',
        direction: 'right',
        frameCount: 8,
        seed: 42,
      },
      { outputRoot: root, testNumber: 1, fps: 16 },
    );
    expect(result.status).toBe('PROCESSED');
    expect(result).toMatchObject({
      seed: 42,
      model: 'fake/pixel-fixture-v1',
      testNumber: 1,
      qualityReview: { status: 'PENDING' },
    });
    const manifest = manifestSchema.parse(
      JSON.parse(
        await readFile(path.join(result.outputPath, 'manifest.json'), 'utf8'),
      ),
    );
    expect(manifest).toMatchObject({
      animation: 'attack',
      fps: 16,
      loop: false,
      pivot: { x: 0.5, y: 0 },
    });
    expect(manifest.frames).toEqual(
      Array.from({ length: 8 }, (_, i) => `frames/0${i}.png`),
    );
    const zip = unzipSync(
      await readFile(path.join(result.outputPath, 'result.zip')),
    );
    expect(Object.keys(zip).sort()).toEqual(
      ['manifest.json', 'sheet.png', ...manifest.frames].sort(),
    );
    for (const filename of Object.keys(zip))
      expect(
        Buffer.from(zip[filename]!).equals(
          await readFile(path.join(result.outputPath, filename)),
        ),
      ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('records failed provider attempts without claiming a successful package', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sprite-poc-'));
  try {
    const provider: AiProvider = {
      name: 'fake',
      model: 'fake/failure',
      generate: async () => {
        throw new Error('deliberate failure');
      },
    };
    const result = await runPocCase(
      provider,
      {
        prompt: 'knight',
        animation: 'walk',
        direction: 'right',
        frameCount: 8,
      },
      { outputRoot: root, testNumber: 2, fps: 12 },
    );
    expect(result).toMatchObject({
      status: 'FAILED',
      seed: null,
      model: 'fake/failure',
    });
    expect(await readdir(result.outputPath)).toEqual(['metadata.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
