import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AiProviderError,
  type AIOrchestrator,
  type AiProvider,
  type GeneratedSpriteResult,
  hasGeneratedFrames,
} from '@sprite/ai';
import {
  cleanupGenerationTempDirectory,
  LocalResultStorage,
  prepareGenerationTempDirectory,
} from '@sprite/core';
import type { ApiErrorCode } from '@sprite/contracts';
import type { CharacterRepository, GenerationRepository } from '@sprite/db';
import {
  createSpritePackage,
  processAnimationFrames,
  processSpriteSheet,
  normalizeFrame,
  runAnimationQa,
  SpriteProcessingError,
} from '@sprite/image';
import {
  generateWithProviderRetry,
  type RetryOptions,
} from '../services/provider-retry';

export interface GenerationProcessorDependencies {
  repository: GenerationRepository;
  provider: AiProvider;
  storage: LocalResultStorage;
  retry?: RetryOptions;
  allowStructuralRetry?: boolean;
  characters?: CharacterRepository;
  orchestrator?: AIOrchestrator;
}

function mapFailure(error: unknown): { code: ApiErrorCode; message: string } {
  if (error instanceof AiProviderError)
    return { code: 'AI_PROVIDER_ERROR', message: 'AI provider failed.' };
  if (error instanceof SpriteProcessingError)
    return {
      code:
        error.code === 'INVALID_GRID'
          ? 'SLICE_FAILED'
          : error.code === 'INSUFFICIENT_MOTION' ||
              error.code === 'INCONSISTENT_CHARACTER'
            ? error.code
            : 'PROCESSING_FAILED',
      message:
        error.code === 'INSUFFICIENT_MOTION'
          ? 'AI returned repeated poses instead of a usable animation.'
          : error.code === 'INCONSISTENT_CHARACTER'
            ? 'AI changed the character appearance between frames.'
            : 'Generated image could not be processed.',
    };
  return { code: 'INTERNAL_ERROR', message: 'Generation worker failed.' };
}

function isStructuralFailure(error: unknown) {
  return (
    error instanceof SpriteProcessingError &&
    [
      'INVALID_BACKGROUND',
      'INVALID_GRID',
      'EMPTY_FRAME',
      'INSUFFICIENT_MOTION',
      'INCONSISTENT_CHARACTER',
    ].includes(error.code)
  );
}

async function generateAndProcess(
  dependencies: GenerationProcessorDependencies,
  parameters: {
    generationId: string;
    input: Parameters<AiProvider['generate']>[0];
    temporaryDirectory: string;
  },
  strictLayoutRetry: boolean,
) {
  await dependencies.repository.transition(
    parameters.generationId,
    'AI_SUBMITTED',
    { attempt: strictLayoutRetry ? 2 : 1 },
  );
  await dependencies.repository.transition(
    parameters.generationId,
    'AI_RUNNING',
  );
  const generated = await generateWithProviderRetry(
    dependencies.provider,
    parameters.input,
    { strictLayoutRetry },
    dependencies.retry,
  );
  await dependencies.repository.transition(
    parameters.generationId,
    'PROCESSING',
    {
      provider: dependencies.provider.name,
      providerModel: generated.model,
      providerRequestId: generated.requestId,
      providerCostUsd:
        !('providerCostUsd' in generated) ||
        generated.providerCostUsd === undefined
          ? undefined
          : generated.providerCostUsd.toFixed(6),
      seed: generated.seed,
    },
  );
  // A development worker restart can clean up an in-flight temp directory
  // while the provider request is pending. Recreate it before archiving the
  // paid response so the result and provider request ID are not lost.
  await mkdir(parameters.temporaryDirectory, { recursive: true });
  await writeFile(
    path.join(
      parameters.temporaryDirectory,
      `raw-attempt-${strictLayoutRetry ? 2 : 1}.png`,
    ),
    generated.image,
  );
  if (hasGeneratedFrames(generated)) {
    const rawFramesDirectory = path.join(
      parameters.temporaryDirectory,
      `provider-frames-attempt-${strictLayoutRetry ? 2 : 1}`,
    );
    await mkdir(rawFramesDirectory, { recursive: true });
    await Promise.all(
      generated.frames.map(({ index, buffer }) =>
        writeFile(
          path.join(
            rawFramesDirectory,
            `${String(index).padStart(2, '0')}.png`,
          ),
          buffer,
        ),
      ),
    );
  }
  return {
    generated,
    processed: hasGeneratedFrames(generated)
      ? await processAnimationFrames({
          frames: generated.frames
            .slice()
            .sort((left, right) => left.index - right.index)
            .map(({ buffer }) => buffer),
          animation: parameters.input.animation,
        })
      : await processSpriteSheet({
          inputBuffer: generated.image,
          animation: parameters.input.animation,
        }),
  };
}

async function writeTemporaryResult(
  directory: string,
  generated: GeneratedSpriteResult,
  packaged: ReturnType<typeof createSpritePackage>,
) {
  await writeFile(path.join(directory, 'raw.png'), generated.image);
  await mkdir(path.join(directory, 'frames'), { recursive: true });
  for (const [filename, contents] of Object.entries(packaged.files))
    await writeFile(path.join(directory, filename), contents);
  await writeFile(path.join(directory, 'result.zip'), packaged.zip);
}

async function processCharacterCreation(
  generationId: string,
  dependencies: GenerationProcessorDependencies,
  temporaryDirectory: string,
) {
  if (!dependencies.characters || !dependencies.orchestrator)
    throw new Error('Character pipeline dependencies are unavailable.');
  const record = await dependencies.repository.findById(generationId);
  const character =
    await dependencies.characters.findByGenerationId(generationId);
  if (!record || !character)
    throw new Error('Character generation record is incomplete.');
  await dependencies.repository.transition(generationId, 'AI_SUBMITTED', {
    attempt: 1,
  });
  await dependencies.repository.transition(generationId, 'AI_RUNNING');
  const result = await dependencies.orchestrator.createCharacter({
    prompt: character.prompt,
    frameSize: character.frameSize,
    seed: record.parameters.seed,
    allowFallback: true,
  });
  await dependencies.repository.transition(generationId, 'PROCESSING', {
    provider: dependencies.orchestrator.providerName,
    providerModel: dependencies.orchestrator.providerModel,
    seed: record.parameters.seed ?? undefined,
  });
  const normalized = await normalizeFrame(
    result.image,
    character.frameSize as 128 | 256,
  );
  await writeFile(path.join(temporaryDirectory, 'raw.png'), result.image);
  await writeFile(path.join(temporaryDirectory, 'base.png'), normalized.png);
  await dependencies.repository.transition(generationId, 'UPLOADING');
  const baseAssetKey = await dependencies.storage.persistCharacterBase(
    character.id,
    normalized.png,
  );
  await dependencies.characters.markReady(character.id, {
    provider: result.provider,
    baseAssetKey,
  });
  await dependencies.repository.transition(generationId, 'SUCCEEDED', {
    rawObjectKey: baseAssetKey,
    qaStatus: 'PASS',
    qaWarnings: [],
  });
}

async function generateCharacterAnimation(
  generationId: string,
  dependencies: GenerationProcessorDependencies,
  temporaryDirectory: string,
) {
  if (!dependencies.characters || !dependencies.orchestrator)
    throw new Error('Character pipeline dependencies are unavailable.');
  const record = await dependencies.repository.findById(generationId);
  if (!record?.characterId)
    throw new Error('Character animation is missing its character.');
  const character = await dependencies.characters.findById(record.characterId);
  if (!character?.baseAssetKey || character.status !== 'READY')
    throw new Error('Character base asset is not ready.');
  const baseCharacter = await dependencies.storage.readCharacterBase(
    character.baseAssetKey,
  );
  await dependencies.repository.transition(generationId, 'AI_SUBMITTED', {
    attempt: 1,
  });
  await dependencies.characters.updateAnimation(generationId, {
    status: 'AI_SUBMITTED',
  });
  await dependencies.repository.transition(generationId, 'AI_RUNNING');
  await dependencies.characters.updateAnimation(generationId, {
    status: 'AI_RUNNING',
  });
  const generated = await dependencies.orchestrator.generateAnimation({
    baseCharacter,
    animation: record.parameters.animation,
    direction: record.parameters.direction,
    frameCount: 8,
    frameSize: record.parameters.frameSize,
    mode: record.animationMode as 'standard' | 'precise',
    seed: record.parameters.seed,
  });
  await dependencies.repository.transition(generationId, 'PROCESSING', {
    provider: dependencies.orchestrator.providerName,
    providerModel: dependencies.orchestrator.providerModel,
    providerRequestId: generated.providerJobId,
    providerCostUsd:
      generated.providerCostUsd === undefined
        ? undefined
        : generated.providerCostUsd.toFixed(6),
    seed: record.parameters.seed ?? undefined,
  });
  await dependencies.characters.updateAnimation(generationId, {
    status: 'PROCESSING',
  });
  await writeFile(path.join(temporaryDirectory, 'raw.png'), baseCharacter);
  const processed = await processAnimationFrames({
    frames: generated.frames
      .slice()
      .sort((left, right) => left.index - right.index)
      .map(({ buffer }) => buffer),
    animation: record.parameters.animation,
    targetFrameSize: record.parameters.frameSize,
    qualityGate: false,
  });
  return {
    generated: {
      ...generated,
      image: baseCharacter,
      seed: record.parameters.seed ?? 0,
      model: dependencies.orchestrator.providerModel,
      requestId: generated.providerJobId ?? `character-${generationId}`,
      durationMs: 0,
    } satisfies GeneratedSpriteResult,
    processed,
  };
}

export async function processGeneration(
  generationId: string,
  dependencies: GenerationProcessorDependencies,
) {
  const record = await dependencies.repository.findById(generationId);
  if (!record) throw new Error(`Generation ${generationId} was not found.`);
  if (record.status === 'FAILED') {
    await dependencies.repository.failAndRefund(generationId, {
      errorCode: 'INTERNAL_ERROR',
      errorMessage: record.errorMessage ?? 'Generation worker failed.',
    });
    return;
  }
  if (record.status === 'SUCCEEDED' || record.status === 'CANCELED') return;
  if (record.status !== 'QUEUED') {
    await dependencies.repository.failAndRefund(generationId, {
      errorCode: 'INTERNAL_ERROR',
      errorMessage: 'Interrupted generation was safely closed.',
    });
    throw new Error(
      `Generation ${generationId} resumed from ${record.status}.`,
    );
  }
  const input = {
    prompt: record.parameters.prompt,
    animation: record.parameters.animation,
    direction: record.parameters.direction,
    frameCount: record.parameters.frameCount,
    seed: record.parameters.seed,
  } as const;
  const temporaryDirectory = await prepareGenerationTempDirectory(generationId);
  try {
    if (record.generationKind === 'character') {
      await processCharacterCreation(
        generationId,
        dependencies,
        temporaryDirectory,
      );
      return;
    }
    let result;
    if (record.characterId) {
      result = await generateCharacterAnimation(
        generationId,
        dependencies,
        temporaryDirectory,
      );
    } else
      try {
        result = await generateAndProcess(
          dependencies,
          { generationId, input, temporaryDirectory },
          false,
        );
      } catch (error) {
        if (
          !isStructuralFailure(error) ||
          dependencies.allowStructuralRetry === false
        )
          throw error;
        result = await generateAndProcess(
          dependencies,
          { generationId, input, temporaryDirectory },
          true,
        );
      }
    if (record.characterId) {
      const qa = await runAnimationQa(
        result.processed.frames,
        record.parameters.frameSize,
        record.parameters.frameCount,
      );
      await dependencies.repository.updateQa(
        generationId,
        qa.status,
        qa.warnings,
      );
      await dependencies.characters?.updateAnimation(generationId, {
        status: 'PROCESSING',
        qaStatus: qa.status,
        qaWarnings: qa.warnings,
      });
      if (qa.status === 'FAIL')
        throw new SpriteProcessingError(
          'INVALID_IMAGE',
          `Animation QA failed: ${qa.failures.join('; ')}`,
          qa,
        );
    }
    const packaged = createSpritePackage(result.processed, {
      generationId,
      animation: record.parameters.animation,
      fps: record.parameters.fps,
      loop: record.parameters.animation !== 'attack',
      direction: record.parameters.direction,
      frameSize: record.parameters.frameSize,
      pivot: { x: 0.5, y: 0 },
    });
    await writeTemporaryResult(temporaryDirectory, result.generated, packaged);
    await dependencies.repository.transition(generationId, 'UPLOADING');
    if (record.characterId)
      await dependencies.characters?.updateAnimation(generationId, {
        status: 'UPLOADING',
      });
    const stored = await dependencies.storage.persist(
      generationId,
      temporaryDirectory,
    );
    await dependencies.repository.transition(generationId, 'SUCCEEDED', {
      rawObjectKey: stored.rawKey,
      sheetObjectKey: stored.sheetKey,
      packageObjectKey: stored.packageKey,
      manifestObjectKey: stored.manifestKey,
    });
    if (record.characterId) {
      const completed = await dependencies.repository.findById(generationId);
      await dependencies.characters?.updateAnimation(generationId, {
        status: 'SUCCEEDED',
        qaStatus: completed?.qaStatus as 'PASS' | 'WARN' | 'FAIL' | undefined,
        qaWarnings: completed?.qaWarnings,
      });
    }
    if (record.batchId)
      await dependencies.characters?.refreshBatchStatus(record.batchId);
  } catch (error) {
    const failure = mapFailure(error);
    await writeFile(
      path.join(temporaryDirectory, 'failure.json'),
      JSON.stringify(
        {
          generationId,
          errorCode:
            error instanceof SpriteProcessingError ? error.code : failure.code,
          error: error instanceof Error ? error.message : failure.message,
          details:
            error instanceof SpriteProcessingError ? error.details : undefined,
          recordedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    ).catch(() => undefined);
    await dependencies.storage
      .persistDiagnostics(generationId, temporaryDirectory)
      .catch(() => undefined);
    await dependencies.repository.failAndRefund(generationId, {
      errorCode: failure.code,
      errorMessage: failure.message,
    });
    if (record.generationKind === 'character' && record.characterId)
      await dependencies.characters?.markFailed(record.characterId);
    if (record.characterId && record.generationKind !== 'character')
      await dependencies.characters?.updateAnimation(generationId, {
        status: 'FAILED',
        qaStatus: 'FAIL',
      });
    if (record.batchId)
      await dependencies.characters?.refreshBatchStatus(record.batchId);
    throw error;
  } finally {
    await cleanupGenerationTempDirectory(generationId);
  }
}
