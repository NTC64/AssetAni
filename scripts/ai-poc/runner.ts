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
import {
  createSpritePackage,
  processSpriteSheet,
  SpriteProcessingError,
} from '@sprite/image';
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
  const attempts: Array<Record<string, unknown>> = [];
  let selected:
    | {
        generated: GeneratedSpriteSheet;
        result: Awaited<ReturnType<typeof processSpriteSheet>>;
      }
    | undefined;
  let lastGenerated: GeneratedSpriteSheet | undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const strictLayoutRetry = attempt === 2;
    const effectivePrompt = buildSpritePrompt(
      {
        prompt: parsedInput.prompt,
        animation: parsedInput.animation,
        direction: 'right',
        frameCount: 8,
      },
      { strictLayoutRetry },
    );
    try {
      const generated = await provider.generate(parsedInput, {
        strictLayoutRetry,
      });
      lastGenerated = generated;
      await writeFile(
        path.join(outputPath, `raw-attempt-${attempt}.png`),
        generated.image,
      );
      try {
        const result = await processSpriteSheet({
          inputBuffer: generated.image,
        });
        attempts.push({
          attempt,
          strictLayoutRetry,
          status: 'ACCEPTED',
          seed: generated.seed,
          model: generated.model,
          requestId: generated.requestId,
          providerDurationMs: generated.durationMs,
          effectivePrompt,
          validation: { background: result.background },
        });
        selected = { generated, result };
        break;
      } catch (error: unknown) {
        lastError = error;
        attempts.push({
          attempt,
          strictLayoutRetry,
          status: 'REJECTED',
          seed: generated.seed,
          model: generated.model,
          requestId: generated.requestId,
          providerDurationMs: generated.durationMs,
          effectivePrompt,
          errorCode:
            error instanceof SpriteProcessingError
              ? error.code
              : 'PROCESSING_FAILED',
          error: error instanceof Error ? error.message : 'Processing failed.',
          validation:
            error instanceof SpriteProcessingError ? error.details : undefined,
        });
        const retryableStructureFailure =
          error instanceof SpriteProcessingError &&
          ['INVALID_BACKGROUND', 'INVALID_GRID', 'EMPTY_FRAME'].includes(
            error.code,
          );
        if (attempt === 1 && retryableStructureFailure) continue;
        break;
      }
    } catch (error: unknown) {
      lastError = error;
      attempts.push({
        attempt,
        strictLayoutRetry,
        status: 'FAILED',
        seed: null,
        model: provider.model,
        requestId: null,
        effectivePrompt,
        error: error instanceof Error ? error.message : 'Provider failed.',
      });
      break;
    }
  }
  if (selected) {
    const { generated, result } = selected;
    await writeFile(path.join(outputPath, 'raw.png'), generated.image);
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
      background: result.background,
      attemptCount: attempts.length,
      retried: attempts.length === 2,
      attempts,
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
  }
  const metadata = {
    ...base,
    status: 'FAILED',
    seed: lastGenerated?.seed ?? null,
    model: lastGenerated?.model ?? provider.model,
    requestId: lastGenerated?.requestId ?? null,
    durationMs: performance.now() - started,
    attemptCount: attempts.length,
    retried: attempts.length === 2,
    attempts,
    errorCode:
      lastError instanceof SpriteProcessingError
        ? lastError.code
        : 'GENERATION_FAILED',
    error:
      lastError instanceof Error ? lastError.message : 'Unknown POC failure',
  };
  await writeFile(
    path.join(outputPath, 'metadata.json'),
    JSON.stringify(metadata, null, 2),
  );
  return metadata;
}
