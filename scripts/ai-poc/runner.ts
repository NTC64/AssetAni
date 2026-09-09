import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type AiProvider,
  type GenerationInput,
  type GeneratedSpriteSheet,
  buildSpritePrompt,
  generationInputSchema,
} from '@sprite/ai';
import { createSpritePackage, processSpriteSheet } from '@sprite/image';
import { z } from 'zod';

export async function runPocCase(
  provider: AiProvider,
  input: GenerationInput,
  options: {
    outputRoot: string;
    testNumber: number;
    fps: number;
  },
) {
  const settings = z
    .object({
      outputRoot: z.string().min(1),
      testNumber: z.number().int().positive(),
      fps: z.number().int().min(4).max(30),
    })
    .parse(options);
  const parsedInput = generationInputSchema.parse(input);
  const generationId = randomUUID();
  const outputPath = path.join(
    settings.outputRoot,
    `${String(settings.testNumber).padStart(2, '0')}-${generationId}`,
  );
  await mkdir(outputPath, { recursive: true });
  const started = performance.now();
  let generated: GeneratedSpriteSheet | undefined;
  const base = {
    testNumber: settings.testNumber,
    generationId,
    provider: provider.name,
    prompt: parsedInput.prompt,
    animation: parsedInput.animation,
    requestedSeed: parsedInput.seed,
    effectivePrompt: buildSpritePrompt({
      prompt: parsedInput.prompt,
      animation: parsedInput.animation,
      direction: 'right',
      frameCount: 8,
    }),
    outputPath,
    createdAt: new Date().toISOString(),
  };
  try {
    generated = await provider.generate(parsedInput);
    await writeFile(path.join(outputPath, 'raw.png'), generated.image);
    const result = await processSpriteSheet({ inputBuffer: generated.image });
    const packaged = createSpritePackage(result, {
      generationId,
      animation: input.animation,
      fps: settings.fps,
      loop: input.animation !== 'attack',
    });
    await mkdir(path.join(outputPath, 'frames'));
    for (const [filename, buffer] of Object.entries(packaged.files))
      await writeFile(path.join(outputPath, filename), buffer);
    await writeFile(path.join(outputPath, 'result.zip'), packaged.zip);
    const metadata = {
      ...base,
      status: 'PROCESSED',
      seed: generated.seed,
      model: generated.model,
      requestId: generated.requestId,
      durationMs: performance.now() - started,
      providerDurationMs: generated.durationMs,
      diagnostics: result.diagnostics,
      qualityReview: {
        status: 'PENDING',
        exactlyEightFrames: null,
        correctGrid: null,
        sameCharacter: null,
        noOverlap: null,
        usefulPoses: null,
      },
    };
    await writeFile(
      path.join(outputPath, 'metadata.json'),
      JSON.stringify(metadata, null, 2),
    );
    return metadata;
  } catch (error: unknown) {
    const metadata = {
      ...base,
      status: 'FAILED',
      seed: generated?.seed ?? null,
      model: generated?.model ?? provider.model,
      requestId: generated?.requestId ?? null,
      durationMs: performance.now() - started,
      error: error instanceof Error ? error.message : 'Unknown POC failure',
    };
    await writeFile(
      path.join(outputPath, 'metadata.json'),
      JSON.stringify(metadata, null, 2),
    );
    return metadata;
  }
}
