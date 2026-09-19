import { it, expect } from 'vitest';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { manifestSchema } from '../packages/contracts/src';
import {
  createFakeProvider,
  type AiGenerationOptions,
  type AiProvider,
  type GenerationInput,
} from '../packages/ai/src';
import sharp from 'sharp';
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
      attemptCount: 1,
      retried: false,
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

it('rejects a bad background, retries exactly once with the critical prompt, and packages only the valid attempt', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sprite-poc-'));
  try {
    const fake = createFakeProvider();
    const invalid = await sharp({
      create: {
        width: 1024,
        height: 512,
        channels: 4,
        background: '#101820',
      },
    })
      .png()
      .toBuffer();
    const calls: Array<AiGenerationOptions | undefined> = [];
    const provider: AiProvider = {
      name: 'fake',
      model: 'fake/retry',
      async generate(input: GenerationInput, options?: AiGenerationOptions) {
        calls.push(options);
        if (calls.length === 1)
          return {
            image: invalid,
            seed: 9,
            model: this.model,
            requestId: 'invalid-first',
            durationMs: 1,
          };
        return fake.generate(input, options);
      },
    };
    const result = await runPocCase(
      provider,
      {
        prompt: 'knight',
        animation: 'walk',
        direction: 'right',
        frameCount: 8,
        seed: 9,
      },
      { outputRoot: root, testNumber: 1, fps: 12 },
    );
    expect(calls).toEqual([
      { strictLayoutRetry: false },
      { strictLayoutRetry: true },
    ]);
    expect(result).toMatchObject({
      status: 'PROCESSED',
      attemptCount: 2,
      retried: true,
      attempts: [
        { status: 'REJECTED', errorCode: 'INVALID_BACKGROUND' },
        {
          status: 'ACCEPTED',
          effectivePrompt: expect.stringContaining('CRITICAL:'),
        },
      ],
    });
    expect(
      await readFile(path.join(result.outputPath, 'raw-attempt-1.png')),
    ).toEqual(invalid);
    expect(
      (await readFile(path.join(result.outputPath, 'raw.png'))).equals(invalid),
    ).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('stops after one strict retry and never writes a result package when both layouts fail', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sprite-poc-'));
  try {
    const invalid = await sharp({
      create: {
        width: 1024,
        height: 512,
        channels: 4,
        background: '#101820',
      },
    })
      .png()
      .toBuffer();
    let calls = 0;
    const provider: AiProvider = {
      name: 'fake',
      model: 'fake/always-invalid',
      async generate() {
        calls++;
        return {
          image: invalid,
          seed: calls,
          model: this.model,
          requestId: `invalid-${calls}`,
          durationMs: 1,
        };
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
      { outputRoot: root, testNumber: 1, fps: 12 },
    );
    expect(calls).toBe(2);
    expect(result).toMatchObject({
      status: 'FAILED',
      errorCode: 'INVALID_BACKGROUND',
      attemptCount: 2,
      retried: true,
    });
    expect((await readdir(result.outputPath)).sort()).toEqual([
      'metadata.json',
      'raw-attempt-1.png',
      'raw-attempt-2.png',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('does not regenerate rejected fal output without explicit paid-retry opt-in', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sprite-poc-'));
  try {
    const invalid = await sharp({
      create: {
        width: 1024,
        height: 512,
        channels: 4,
        background: '#101820',
      },
    })
      .png()
      .toBuffer();
    let calls = 0;
    const provider: AiProvider = {
      name: 'fal',
      model: 'fal/injected-no-paid-call',
      async generate() {
        calls++;
        return {
          image: invalid,
          seed: 1,
          model: this.model,
          requestId: 'injected',
          durationMs: 1,
        };
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
      { outputRoot: root, testNumber: 1, fps: 12 },
    );
    expect(calls).toBe(1);
    expect(result).toMatchObject({
      status: 'FAILED',
      attemptCount: 1,
      retried: false,
    });
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
