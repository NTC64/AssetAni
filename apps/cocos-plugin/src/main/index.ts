import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCocos38Adapter, openPanel } from '../cocos/cocos-3.8-adapter';
import { importTestAssets } from './asset-importer';
import { ApiClient } from './api-client';
import { GenerationService, PluginGenerationError } from './generation-service';
import { runCharacterBatchPipeline } from './character-batch-service';
import {
  generationCommandSchema,
  characterBatchCommandSchema,
  operationSnapshotSchema,
  type GenerationCommand,
  type OperationSnapshot,
} from '../shared/generation';
import { loadApiKey, saveApiKey } from './key-storage';

let importing = false;
let snapshot: OperationSnapshot = {
  operationId: null,
  state: 'IDLE',
  progress: 0,
  message: 'Ready to generate.',
  canRetry: false,
};
let retryPlan:
  | {
      command: GenerationCommand;
      idempotencyKey: string;
      resumeGenerationId?: string;
    }
  | undefined;

function startOperation(
  command: GenerationCommand,
  options: { idempotencyKey?: string; resumeGenerationId?: string } = {},
) {
  if (snapshot.state === 'RUNNING') return snapshot;
  const operationId = randomUUID();
  const idempotencyKey = options.idempotencyKey ?? randomUUID();
  snapshot = {
    operationId,
    state: 'RUNNING',
    progress: options.resumeGenerationId ? 5 : 1,
    message: options.resumeGenerationId
      ? 'Resuming generation…'
      : 'Submitting generation…',
    ...(options.resumeGenerationId
      ? { generationId: options.resumeGenerationId }
      : {}),
    canRetry: false,
  };
  const { backendUrl, apiKey, ...request } = command;
  const service = new GenerationService(
    new ApiClient(backendUrl, apiKey),
    createCocos38Adapter(),
  );
  void service
    .run(request, {
      idempotencyKey,
      resumeGenerationId: options.resumeGenerationId,
      onProgress(progress) {
        if (snapshot.operationId !== operationId) return;
        snapshot = {
          ...snapshot,
          ...progress,
          state: 'RUNNING',
          canRetry: false,
        };
      },
    })
    .then((result) => {
      if (snapshot.operationId !== operationId) return;
      retryPlan = undefined;
      snapshot = {
        operationId,
        state: 'SUCCEEDED',
        progress: 100,
        message: `Created ${result.animationUrl}`,
        generationId: result.generationId,
        animationUrl: result.animationUrl,
        ...(result.creditsRemaining !== undefined
          ? { creditsRemaining: result.creditsRemaining }
          : {}),
        canRetry: false,
      };
      console.info('[sprite] Generation imported:', result.animationUrl);
    })
    .catch((error: unknown) => {
      if (snapshot.operationId !== operationId) return;
      console.error('[sprite] Generate/import failed:', error);
      const failure =
        error instanceof PluginGenerationError
          ? error
          : new PluginGenerationError(
              'UNKNOWN_ERROR',
              'Generation failed. Check the extension Console and retry.',
              'resubmit',
            );
      retryPlan = {
        command,
        idempotencyKey:
          failure.retryMode === 'new' ? randomUUID() : idempotencyKey,
        ...(failure.retryMode === 'resume' && failure.generationId
          ? { resumeGenerationId: failure.generationId }
          : {}),
      };
      snapshot = {
        operationId,
        state: 'FAILED',
        progress: snapshot.progress,
        message: failure.userMessage,
        ...(failure.generationId ? { generationId: failure.generationId } : {}),
        ...(snapshot.creditsRemaining !== undefined
          ? { creditsRemaining: snapshot.creditsRemaining }
          : {}),
        canRetry: true,
      };
    });
  return snapshot;
}

export const methods = {
  openPanel,
  async startGeneration(input: unknown) {
    const command = generationCommandSchema.parse(input);
    await saveApiKey(command.apiKey);
    return operationSnapshotSchema.parse(startOperation(command));
  },
  async startCharacterBatch(input: unknown) {
    const command = characterBatchCommandSchema.parse(input);
    await saveApiKey(command.apiKey);
    if (snapshot.state === 'RUNNING')
      return operationSnapshotSchema.parse(snapshot);
    const operationId = randomUUID();
    snapshot = {
      operationId,
      state: 'RUNNING',
      progress: 1,
      message: 'Starting character batch…',
      canRetry: false,
    };
    void runCharacterBatchPipeline(command, createCocos38Adapter(), {
      onProgress(progress, message) {
        if (snapshot.operationId !== operationId) return;
        snapshot = { ...snapshot, progress, message };
      },
    })
      .then((result) => {
        if (snapshot.operationId !== operationId) return;
        snapshot = {
          operationId,
          state: 'SUCCEEDED',
          progress: 100,
          message: `Created ${result.animationUrls.length} AnimationClips.`,
          animationUrls: result.animationUrls,
          canRetry: false,
        };
      })
      .catch((error: unknown) => {
        if (snapshot.operationId !== operationId) return;
        console.error('[sprite] Character batch failed:', error);
        snapshot = {
          operationId,
          state: 'FAILED',
          progress: snapshot.progress,
          message:
            error instanceof PluginGenerationError
              ? error.userMessage
              : 'Character batch failed. Successful animations remain imported; retry failed actions individually.',
          canRetry: false,
        };
      });
    return operationSnapshotSchema.parse(snapshot);
  },
  async loadApiKey() {
    return { apiKey: await loadApiKey() };
  },
  retryGeneration() {
    if (snapshot.state === 'RUNNING') return snapshot;
    if (!retryPlan)
      return operationSnapshotSchema.parse({
        ...snapshot,
        message: 'Nothing is available to retry.',
        canRetry: false,
      });
    return operationSnapshotSchema.parse(
      startOperation(retryPlan.command, retryPlan),
    );
  },
  generationProgress() {
    return operationSnapshotSchema.parse(snapshot);
  },
  async testImport() {
    if (importing)
      return {
        ok: false,
        message: 'An import is already running. Please wait.',
      };
    importing = true;
    try {
      console.info('[sprite] Starting local eight-frame import.');
      const url = await importTestAssets(
        createCocos38Adapter(),
        path.join(__dirname, '../../test-assets'),
      );
      console.info('[sprite] Import finished:', url);
      return {
        ok: true,
        message: `Created ${url} — 8 frames, 12 FPS, 0.667 seconds.`,
      };
    } catch (error: unknown) {
      console.error('[sprite] Test Import failed:', error);
      return {
        ok: false,
        message:
          'Could not import the test animation. Open a scene, check the extension Console for details, and retry. Existing unrelated assets are preserved.',
      };
    } finally {
      importing = false;
    }
  },
};
export function load() {}
export function unload() {}
