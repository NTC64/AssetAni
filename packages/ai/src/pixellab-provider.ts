import { z } from 'zod';
import {
  AiProviderError,
  PIXELLAB_DIRECTION_ORDER,
  generationInputSchema,
  type AnimateWithSkeletonInput,
  type AnimateWithTextInput,
  type AnimationFramesResult,
  type BaseCharacterResult,
  type CreateBaseCharacterInput,
  type DirectionFramesResult,
  type EstimateSkeletonInput,
  type GeneratedFrame,
  type GenerateDirectionsInput,
  type GenerationInput,
  type SkeletonResult,
  type SpriteAIProvider,
} from './provider';

const base64ImageSchema = z
  .object({
    base64: z.string().min(1),
  })
  .passthrough();
const usageSchema = z
  .object({
    type: z.enum(['usd', 'generations']).optional(),
    usd: z.number().nonnegative().nullish(),
    generations: z.number().nonnegative().nullish(),
  })
  .passthrough();
const syncImageResponseSchema = z
  .object({ image: base64ImageSchema, usage: usageSchema.nullish() })
  .passthrough();
const jobSubmissionSchema = z
  .object({ background_job_id: z.string().min(1) })
  .passthrough();
const jobResponseSchema = z
  .object({
    id: z.string().min(1),
    status: z.string().min(1),
    created_at: z.string(),
    last_response: z.record(z.unknown()).nullish(),
    usage: usageSchema.nullish(),
  })
  .passthrough();
const imagesResponseSchema = z
  .object({ images: z.array(base64ImageSchema), usage: usageSchema.nullish() })
  .passthrough();
const keypointSchema = z.object({
  x: z.number(),
  y: z.number(),
  label: z.string(),
  z_index: z.number(),
});
const skeletonResponseSchema = z
  .object({ keypoints: z.array(keypointSchema), usage: usageSchema.nullish() })
  .passthrough();

function parseProviderResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new AiProviderError(
      'INVALID_OUTPUT',
      'PixelLab returned an unexpected response.',
    );
  return parsed.data;
}

type Fetcher = typeof fetch;

export interface PixelLabProviderOptions {
  token: string;
  baseUrl?: string;
  pollIntervalMs?: number;
  jobTimeoutMs?: number;
  fetcher?: Fetcher;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

function imagePayload(image: Buffer) {
  return { type: 'base64', base64: image.toString('base64'), format: 'png' };
}

function decodeImage(value: z.infer<typeof base64ImageSchema>): Buffer {
  const encoded = value.base64.includes(',')
    ? value.base64.slice(value.base64.indexOf(',') + 1)
    : value.base64;
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.length === 0)
    throw new AiProviderError(
      'INVALID_OUTPUT',
      'PixelLab returned an empty image.',
    );
  return buffer;
}

function providerCostUsd(
  usage: z.infer<typeof usageSchema> | null | undefined,
) {
  return typeof usage?.usd === 'number' ? usage.usd : undefined;
}

function orderedFrames(
  images: z.infer<typeof base64ImageSchema>[],
): GeneratedFrame[] {
  return images.map((image, index) => ({ index, buffer: decodeImage(image) }));
}

function normalizeAnimationFrameCount(
  frames: GeneratedFrame[],
  requestedFrameCount: number,
) {
  if (frames.length === requestedFrameCount) return frames;
  // PixelLab can include one additional terminal frame even though v3 keeps
  // the supplied reference as frame one. Preserve provider order and the
  // requested eight-frame contract used by packaging and Cocos clips.
  if (frames.length === requestedFrameCount + 1)
    return frames
      .slice(0, requestedFrameCount)
      .map((frame, index) => ({ ...frame, index }));
  throw new AiProviderError(
    'INVALID_OUTPUT',
    `PixelLab returned ${frames.length} frames; expected ${requestedFrameCount}.`,
  );
}

export function buildPixelLabMotionPrompt(
  animation: AnimateWithTextInput['animation'],
  direction = 'right',
): string {
  return {
    idle: 'idle breathing loop',
    walk: 'walking cycle facing right',
    run: 'running cycle facing right',
    attack: 'sword attack cycle facing right',
    hurt: 'taking damage and recovering facing right',
    death: 'falling down into a final death pose facing right',
  }[animation].replaceAll('right', direction);
}

/**
 * PixelLab bills a background job from the moment it is accepted. The worker's
 * provider-level retry re-runs the whole call, which submits a *second* paid
 * job, so any failure raised after acceptance must be reported as
 * non-retryable. Only failures while submitting are safe to retry.
 */
function afterJobAccepted(error: unknown): never {
  if (error instanceof AiProviderError)
    throw error.retryable
      ? new AiProviderError(error.code, error.message, false)
      : error;
  throw new AiProviderError('PROVIDER_ERROR', 'PixelLab job failed.', false);
}

export function createPixelLabProvider(
  options: PixelLabProviderOptions,
): SpriteAIProvider {
  const token = options.token.trim();
  if (!token) throw new Error('PixelLab API token is required.');
  const baseUrl = (options.baseUrl ?? 'https://api.pixellab.ai/v2').replace(
    /\/$/,
    '',
  );
  const pollIntervalMs = options.pollIntervalMs ?? 2_500;
  const jobTimeoutMs = options.jobTimeoutMs ?? 180_000;
  const fetcher = options.fetcher ?? fetch;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;

  async function request(path: string, init: RequestInit = {}) {
    let response: Response;
    try {
      response = await fetcher(`${baseUrl}${path}`, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(jobTimeoutMs),
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
      });
    } catch {
      throw new AiProviderError(
        'PROVIDER_ERROR',
        'PixelLab request failed.',
        true,
      );
    }
    if (!response.ok) {
      throw new AiProviderError(
        'PROVIDER_ERROR',
        `PixelLab request failed with HTTP ${response.status}.`,
        response.status === 429 || response.status >= 500,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new AiProviderError(
        'INVALID_OUTPUT',
        'PixelLab returned invalid JSON.',
      );
    }
  }

  async function post(path: string, body: object) {
    return request(path, { method: 'POST', body: JSON.stringify(body) });
  }

  async function pollJob(jobId: string) {
    const startedAt = now();
    while (now() - startedAt <= jobTimeoutMs) {
      const job = parseProviderResponse(
        jobResponseSchema,
        await request(`/background-jobs/${encodeURIComponent(jobId)}`),
      );
      if (job.status === 'completed') return job;
      if (job.status === 'failed') {
        const detail = job.last_response?.detail;
        throw new AiProviderError(
          'PROVIDER_ERROR',
          typeof detail === 'string'
            ? `PixelLab job failed: ${detail}`
            : 'PixelLab job failed.',
        );
      }
      if (job.status !== 'processing')
        throw new AiProviderError(
          'INVALID_OUTPUT',
          `PixelLab returned unknown job status: ${job.status}.`,
        );
      await sleep(pollIntervalMs);
    }
    throw new AiProviderError(
      'PROVIDER_ERROR',
      'PixelLab job timed out.',
      true,
    );
  }

  async function framesFromJob(jobId: string) {
    try {
      const job = await pollJob(jobId);
      const result = parseProviderResponse(
        imagesResponseSchema,
        job.last_response,
      );
      return {
        frames: orderedFrames(result.images),
        provider: 'pixellab' as const,
        providerJobId: jobId,
        providerCostUsd:
          providerCostUsd(job.usage) ?? providerCostUsd(result.usage),
      };
    } catch (error) {
      afterJobAccepted(error);
    }
  }

  const provider: SpriteAIProvider = {
    name: 'pixellab',
    model: 'create-image-pixen+animate-with-text-v3',

    async createBaseCharacter(
      input: CreateBaseCharacterInput,
    ): Promise<BaseCharacterResult> {
      const result = parseProviderResponse(
        syncImageResponseSchema,
        await post('/create-image-pixen', {
          description: `${input.prompt.trim()}, game-ready 2D pixel art character, full body, side view, facing right`,
          image_size: { width: input.frameSize, height: input.frameSize },
          outline: 'single color outline',
          detail: 'medium detail',
          view: 'side',
          direction: 'east',
          no_background: true,
          background_removal_task: 'remove_complex_background',
          seed: input.seed ?? 0,
          enhance_prompt: false,
        }),
      );
      return {
        image: decodeImage(result.image),
        provider: 'pixellab',
        providerCostUsd: providerCostUsd(result.usage),
      };
    },

    async animateWithText(
      input: AnimateWithTextInput,
    ): Promise<AnimationFramesResult> {
      const submitted = parseProviderResponse(
        jobSubmissionSchema,
        await post('/animate-with-text-v3', {
          first_frame: imagePayload(input.baseCharacter),
          action: buildPixelLabMotionPrompt(input.animation, input.direction),
          frame_count: input.frameCount,
          seed: input.seed ?? 0,
          no_background: true,
        }),
      );
      return framesFromJob(submitted.background_job_id);
    },

    async estimateSkeleton(
      input: EstimateSkeletonInput,
    ): Promise<SkeletonResult> {
      const result = parseProviderResponse(
        skeletonResponseSchema,
        await post('/estimate-skeleton', { image: imagePayload(input.image) }),
      );
      return {
        keypoints: result.keypoints.map(({ x, y, label, z_index }) => ({
          x,
          y,
          label,
          zIndex: z_index,
        })),
        provider: 'pixellab',
        providerCostUsd: providerCostUsd(result.usage),
      };
    },

    async animateWithSkeleton(
      input: AnimateWithSkeletonInput,
    ): Promise<AnimationFramesResult> {
      const skeletonKeypoints = input.skeletonKeypoints.map((frame) =>
        frame.map(({ x, y, label, zIndex }) => ({
          x,
          y,
          label,
          z_index: zIndex,
        })),
      );
      const result = parseProviderResponse(
        imagesResponseSchema,
        await post('/animate-with-skeleton', {
          image_size: { width: input.frameSize, height: input.frameSize },
          view: 'side',
          direction: 'east',
          skeleton_keypoints: skeletonKeypoints,
          reference_image: imagePayload(input.referenceImage),
          seed: input.seed ?? 0,
        }),
      );
      return {
        frames: orderedFrames(result.images),
        provider: 'pixellab',
        providerCostUsd: providerCostUsd(result.usage),
      };
    },

    async generateDirections(
      input: GenerateDirectionsInput,
    ): Promise<DirectionFramesResult> {
      const submitted = parseProviderResponse(
        jobSubmissionSchema,
        await post('/generate-8-rotations-v3', {
          first_frame: imagePayload(input.baseCharacter),
          description: input.prompt,
          no_background: true,
          seed: input.seed ?? 0,
        }),
      );
      const result = await framesFromJob(submitted.background_job_id);
      if (result.frames.length !== PIXELLAB_DIRECTION_ORDER.length)
        throw new AiProviderError(
          'INVALID_OUTPUT',
          'PixelLab did not return eight direction frames.',
        );
      return { ...result, directions: [...PIXELLAB_DIRECTION_ORDER] };
    },

    async generate(input: GenerationInput) {
      const parsed = generationInputSchema.parse(input);
      const startedAt = now();
      const base = await provider.createBaseCharacter({
        prompt: parsed.prompt,
        frameSize: 256,
        seed: parsed.seed,
      });
      const animation = await provider.animateWithText({
        baseCharacter: base.image,
        animation: parsed.animation,
        frameCount: parsed.frameCount,
        seed: parsed.seed,
      });
      const frames = normalizeAnimationFrameCount(
        animation.frames,
        parsed.frameCount,
      );
      return {
        image: base.image,
        frames,
        seed: parsed.seed ?? 0,
        model: provider.model,
        requestId: animation.providerJobId ?? 'pixellab-sync',
        durationMs: now() - startedAt,
        providerCostUsd:
          base.providerCostUsd === undefined &&
          animation.providerCostUsd === undefined
            ? undefined
            : (base.providerCostUsd ?? 0) + (animation.providerCostUsd ?? 0),
      };
    },
  };
  return provider;
}
