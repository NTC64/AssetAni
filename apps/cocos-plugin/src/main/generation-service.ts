import { randomUUID } from 'node:crypto';
import type {
  GenerationRequest,
  GenerationResponse,
  GenerationStatus,
} from '@sprite/contracts';
import type { CocosAdapter } from '../cocos/cocos-adapter';
import type { OperationSnapshot } from '../shared/generation';
import { importGenerationAssets } from './asset-importer';
import { ApiClientError, type GenerationApi } from './api-client';
import { extractSpritePackage } from './package-extractor';

export const POLL_DELAYS_MS = [2_000, 4_000, 8_000] as const;
export const DEFAULT_GENERATION_TIMEOUT_MS = 15 * 60_000;

export class PluginGenerationError extends Error {
  constructor(
    public readonly code: string,
    public readonly userMessage: string,
    public readonly retryMode: 'new' | 'resume' | 'resubmit',
    public readonly generationId?: string,
  ) {
    super(userMessage);
    this.name = 'PluginGenerationError';
  }
}

export interface GenerationRunOptions {
  idempotencyKey?: string;
  resumeGenerationId?: string;
  timeoutMs?: number;
  onProgress?: (
    snapshot: Omit<OperationSnapshot, 'operationId' | 'state' | 'canRetry'>,
  ) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  importDestination?: string;
  animationUrl?: string;
}

function displayProgress(status: GenerationStatus, backendProgress: number) {
  if (status === 'QUEUED') return 5;
  if (status === 'AI_SUBMITTED') return 20;
  if (status === 'AI_RUNNING')
    return Math.max(25, Math.min(60, backendProgress));
  if (status === 'PROCESSING')
    return Math.max(65, Math.min(85, backendProgress));
  if (status === 'UPLOADING')
    return Math.max(86, Math.min(92, backendProgress));
  return status === 'SUCCEEDED' ? 93 : 100;
}

function statusMessage(status: GenerationStatus) {
  const messages: Record<GenerationStatus, string> = {
    QUEUED: 'Generation queued…',
    AI_SUBMITTED: 'Submitting to the AI provider…',
    AI_RUNNING: 'Generating sprite poses…',
    PROCESSING: 'Processing and normalizing frames…',
    UPLOADING: 'Preparing the result package…',
    SUCCEEDED: 'Downloading the result package…',
    FAILED: 'Generation failed.',
    CANCELED: 'Generation was canceled.',
  };
  return messages[status];
}

function backendFailure(response: GenerationResponse) {
  if (response.status === 'FAILED')
    throw new PluginGenerationError(
      response.errorCode ?? 'GENERATION_FAILED',
      response.errorCode === 'AI_PROVIDER_ERROR'
        ? 'AI generation failed. Please retry.'
        : response.errorCode === 'INSUFFICIENT_MOTION'
          ? 'The AI returned repeated poses instead of an animation. Please retry with a clearer action prompt.'
          : response.errorCode === 'INCONSISTENT_CHARACTER'
            ? 'The character changed too much between frames. Please retry with a simpler character description.'
            : 'The generated sprite sheet could not be processed. Please retry.',
      'new',
      response.id,
    );
  if (response.status === 'CANCELED')
    throw new PluginGenerationError(
      'GENERATION_CANCELED',
      'Generation was canceled. Please retry.',
      'new',
      response.id,
    );
}

export class GenerationService {
  constructor(
    private readonly api: GenerationApi,
    private readonly adapter: CocosAdapter,
  ) {}

  async run(input: GenerationRequest, options: GenerationRunOptions = {}) {
    const sleep =
      options.sleep ??
      ((milliseconds: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    const now = options.now ?? Date.now;
    const startedAt = now();
    const timeoutMs = options.timeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS;
    const idempotencyKey = options.idempotencyKey ?? randomUUID();
    let generationId = options.resumeGenerationId;
    let creditsRemaining: number | undefined;
    try {
      let response: GenerationResponse;
      if (generationId) response = await this.api.getGeneration(generationId);
      else {
        response = await this.api.createGeneration(input, idempotencyKey);
        generationId = response.id;
        creditsRemaining = response.creditsRemaining;
      }
      options.onProgress?.({
        progress: displayProgress(response.status, response.progress),
        message: statusMessage(response.status),
        generationId,
        ...(creditsRemaining !== undefined ? { creditsRemaining } : {}),
      });
      let pollIndex = 0;
      while (response.status !== 'SUCCEEDED') {
        if (response.status === 'FAILED' && this.api.getCredits) {
          try {
            creditsRemaining = (await this.api.getCredits()).balance;
            options.onProgress?.({
              progress: displayProgress(response.status, response.progress),
              message: statusMessage(response.status),
              generationId,
              creditsRemaining,
            });
          } catch {
            // Preserve the generation failure when the balance refresh fails.
          }
        }
        backendFailure(response);
        if (now() - startedAt >= timeoutMs)
          throw new PluginGenerationError(
            'CLIENT_TIMEOUT',
            'Generation is still running. Retry to continue polling it.',
            'resume',
            generationId,
          );
        const delay = POLL_DELAYS_MS[pollIndex] ?? 8_000;
        pollIndex++;
        await sleep(delay);
        response = await this.api.getGeneration(generationId);
        options.onProgress?.({
          progress: displayProgress(response.status, response.progress),
          message: statusMessage(response.status),
          generationId,
        });
      }
      if (!response.result || response.result.expiresIn === 0)
        throw new PluginGenerationError(
          'RESULT_UNAVAILABLE',
          'The generated package is no longer available. Please generate again.',
          'new',
          generationId,
        );
      const archive = await this.api.downloadPackage(
        response.result.packageUrl,
      );
      options.onProgress?.({
        progress: 96,
        message: 'Validating and extracting the package…',
        generationId,
      });
      let extracted: Awaited<ReturnType<typeof extractSpritePackage>>;
      try {
        extracted = await extractSpritePackage(archive, generationId);
      } catch {
        throw new PluginGenerationError(
          'INVALID_RESULT_PACKAGE',
          'The downloaded sprite package failed validation. Please generate again.',
          'new',
          generationId,
        );
      }
      try {
        options.onProgress?.({
          progress: 98,
          message: 'Importing SpriteFrames and creating AnimationClip…',
          generationId,
        });
        const animationUrl = await importGenerationAssets(
          this.adapter,
          extracted.directory,
          extracted.manifest,
          {
            destination: options.importDestination,
            animationUrl: options.animationUrl,
          },
        );
        options.onProgress?.({
          progress: 100,
          message: `Created ${animationUrl}`,
          generationId,
          animationUrl,
        });
        return {
          generationId,
          animationUrl,
          idempotencyKey,
          ...(creditsRemaining !== undefined ? { creditsRemaining } : {}),
        };
      } finally {
        await extracted.cleanup();
      }
    } catch (error) {
      if (error instanceof PluginGenerationError) throw error;
      if (error instanceof ApiClientError) {
        const invalidPrompt = error.code === 'INVALID_PROMPT';
        const missingResult =
          generationId !== undefined && error.code === 'GENERATION_NOT_FOUND';
        const publicMessages: Record<string, string> = {
          INVALID_API_KEY:
            'The API key is invalid or revoked. Enter a valid key and generate again.',
          API_KEY_EXPIRED:
            'The API key has expired. Enter a new key and generate again.',
          INSUFFICIENT_CREDIT: 'No generation credits remain for this account.',
          RATE_LIMITED:
            'The generation service is busy. Wait briefly and retry.',
          INTERNAL_ERROR:
            'The backend reported an internal error. Check the API terminal, apply database migrations, and retry.',
        };
        throw new PluginGenerationError(
          error.code,
          invalidPrompt
            ? 'Check the prompt and generation settings, then retry.'
            : missingResult
              ? 'The generated package is no longer available. Please generate again.'
              : (publicMessages[error.code] ??
                'Unable to connect to the generation service. Please retry.'),
          missingResult ? 'new' : generationId ? 'resume' : 'resubmit',
          generationId,
        );
      }
      throw new PluginGenerationError(
        'IMPORT_FAILED',
        generationId
          ? 'Could not import the generated animation. Open a scene, check the extension Console, and retry.'
          : 'Could not start generation. Please retry.',
        generationId ? 'resume' : 'resubmit',
        generationId,
      );
    }
  }

  async runBatch(
    characterName: string,
    children: Array<{ generationId: string; input: GenerationRequest }>,
    options: Omit<
      GenerationRunOptions,
      'resumeGenerationId' | 'importDestination' | 'animationUrl'
    > = {},
  ) {
    const safeCharacterName =
      characterName
        .normalize('NFC')
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 64) || 'character';
    const results = [];
    const failures: PluginGenerationError[] = [];
    for (const child of children) {
      const { animation } = child.input;
      try {
        results.push(
          await this.run(child.input, {
            ...options,
            resumeGenerationId: child.generationId,
            importDestination: `db://assets/AI_Sprites/${safeCharacterName}/${animation}`,
            animationUrl: `db://assets/AI_Sprites/${safeCharacterName}/animations/${safeCharacterName.toLowerCase()}_${animation}.anim`,
          }),
        );
      } catch (error) {
        failures.push(
          error instanceof PluginGenerationError
            ? error
            : new PluginGenerationError(
                'IMPORT_FAILED',
                `Could not import ${animation}.`,
                'resume',
                child.generationId,
              ),
        );
      }
    }
    if (failures.length)
      throw new PluginGenerationError(
        'PARTIAL_BATCH',
        `${results.length} animation(s) imported; ${failures.length} failed. Successful clips were preserved.`,
        'resume',
        failures[0]?.generationId,
      );
    return results;
  }
}
