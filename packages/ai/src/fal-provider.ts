import { createFalClient } from '@fal-ai/client';
import sharp from 'sharp';
import { z } from 'zod';
import { buildSpritePrompt } from './prompt';
import { createOpenPoseGuide, createPoseGuide } from './pose-guide';
import {
  AiProviderError,
  generationInputSchema,
  type AiProvider,
  type ConceptProvider,
} from './provider';

export const FAL_MODELS = {
  sprite: 'fal-ai/lora',
  turbo: 'fal-ai/flux-2/turbo/edit',
  schnell: 'fal-ai/flux/schnell',
} as const;
const modelSchema = z.enum(['sprite', 'turbo', 'schnell']);
const PIXEL_ART_LORA =
  'https://huggingface.co/nerijs/pixel-art-xl/resolve/main/pixel-art-xl.safetensors';
const OPENPOSE_CONTROLNET = 'thibaud/controlnet-openpose-sdxl-1.0';
const IP_ADAPTER = 'h94/IP-Adapter';
export interface FalInput {
  prompt: string;
  image_size: { width: number; height: number };
  num_images: number;
  output_format?: 'png';
  image_format?: 'png';
  enable_safety_checker: true;
  enable_prompt_expansion?: false;
  guidance_scale?: number;
  image_urls?: string[];
  model_name?: string;
  negative_prompt?: string;
  num_inference_steps?: number;
  scheduler?: string;
  loras?: Array<{ path: string; scale: number }>;
  controlnets?: Array<{
    path: string;
    image_url: string;
    conditioning_scale: number;
    start_percentage: number;
    end_percentage: number;
  }>;
  ip_adapter?: Array<{
    path: string;
    model_subfolder: string;
    weight_name: string;
    ip_adapter_image_url: string;
    scale: number;
  }>;
  image_encoder_path?: string;
  image_encoder_subfolder?: string;
  image_encoder_weight_name?: string;
  seed?: number;
}
export type FalTransport = (
  model: (typeof FAL_MODELS)[keyof typeof FAL_MODELS],
  input: FalInput,
  signal: AbortSignal,
) => Promise<unknown>;

function isRetryableProviderFailure(error: unknown) {
  if (error instanceof DOMException && error.name === 'TimeoutError')
    return true;
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    name?: unknown;
  };
  const status =
    typeof candidate.status === 'number'
      ? candidate.status
      : typeof candidate.statusCode === 'number'
        ? candidate.statusCode
        : undefined;
  if (status && [429, 500, 502, 503, 504].includes(status)) return true;
  return (
    candidate.name === 'AbortError' ||
    candidate.name === 'TimeoutError' ||
    (typeof candidate.code === 'string' &&
      ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND'].includes(
        candidate.code,
      ))
  );
}
const resultSchema = z.object({
  requestId: z.string().min(1),
  data: z.object({
    seed: z.number().int().min(0).max(4294967295),
    images: z.array(z.object({ url: z.string().url() })).length(1),
    has_nsfw_concepts: z.array(z.boolean()).length(1),
  }),
});

/** Only provider-owned output locations, bounded download, and no redirect following. */
export async function downloadFalImage(
  url: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<Buffer> {
  const parsed = new URL(url);
  const allowed =
    parsed.hostname === 'fal.media' ||
    parsed.hostname.endsWith('.fal.media') ||
    (parsed.hostname === 'storage.googleapis.com' &&
      parsed.pathname.startsWith('/falserverless/'));
  if (
    !allowed ||
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== '443')
  ) {
    throw new AiProviderError(
      'DOWNLOAD_FAILED',
      'Unexpected provider image location.',
    );
  }
  const response = await fetcher(url, { signal, redirect: 'error' });
  const maximum = 16 * 1024 * 1024;
  if (
    !response.ok ||
    !response.body ||
    Number(response.headers.get('content-length')) > maximum
  ) {
    await response.body?.cancel();
    throw new AiProviderError(
      'DOWNLOAD_FAILED',
      'Provider image download failed or exceeded 16 MiB.',
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum)
        throw new AiProviderError(
          'DOWNLOAD_FAILED',
          'Provider image exceeded 16 MiB.',
        );
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export function createFalProvider(options: {
  key: string;
  model?: 'sprite' | 'turbo' | 'schnell';
  transport?: FalTransport;
  download?: typeof downloadFalImage;
}): AiProvider & ConceptProvider {
  const key = z
    .string()
    .trim()
    .min(1, 'FAL_KEY is required for the fal provider.')
    .parse(options.key);
  const model = FAL_MODELS[modelSchema.parse(options.model ?? 'turbo')];
  const client = createFalClient({ credentials: key });
  const transport: FalTransport =
    options.transport ??
    ((endpoint, input, signal) =>
      client.run(endpoint, { input, abortSignal: signal }));
  const download = options.download ?? downloadFalImage;
  return {
    name: 'fal',
    model,
    async generateConcept(input) {
      const signal = AbortSignal.timeout(120_000);
      let rawResult: unknown;
      try {
        rawResult = await transport(
          FAL_MODELS.schnell,
          {
            prompt: `Pixel art game character concept, full body, ${input.prompt}. Single character, centered, clear silhouette, plain #F4F4F4 background, no text, no scenery.`,
            image_size: { width: 512, height: 512 },
            num_images: 1,
            output_format: 'png',
            enable_safety_checker: true,
            ...(input.seed == null ? {} : { seed: input.seed }),
          },
          signal,
        );
      } catch (error) {
        throw new AiProviderError(
          'PROVIDER_ERROR',
          'fal.ai concept request failed.',
          isRetryableProviderFailure(error),
        );
      }
      const parsed = resultSchema.safeParse(rawResult);
      if (!parsed.success || parsed.data.data.has_nsfw_concepts.some(Boolean))
        throw new AiProviderError(
          'INVALID_OUTPUT',
          'fal.ai concept output was unusable.',
        );
      return {
        image: await download(parsed.data.data.images[0]!.url, signal),
        provider: 'fal',
        requestId: parsed.data.requestId,
        seed: parsed.data.data.seed,
      };
    },
    async generate(rawInput, generationOptions = {}) {
      const parsedInput = generationInputSchema.parse(rawInput);
      const { seed, ...promptInput } = parsedInput;
      const start = performance.now();
      if (model === FAL_MODELS.sprite) {
        const result = await generatePoseControlledSpriteSheet({
          input: parsedInput,
          transport,
          download,
        });
        return { ...result, model, durationMs: performance.now() - start };
      }
      const signal = AbortSignal.timeout(120_000);
      const usesPoseGuide = model === FAL_MODELS.turbo;
      const basePrompt = buildSpritePrompt(promptInput, generationOptions);
      const prompt = usesPoseGuide
        ? `${basePrompt}\n\nPOSE GUIDE INPUT:\nReplace all eight gray mannequins in the input image with the same character described above. Preserve each mannequin's distinct limb pose and its exact cell position. Remove the mannequins completely. Do not copy their gray color.`
        : basePrompt;
      let rawResult: unknown;
      try {
        const poseGuide = usesPoseGuide
          ? await createPoseGuide(promptInput.animation)
          : undefined;
        rawResult = await transport(
          model,
          {
            prompt,
            image_size: { width: 1024, height: 512 },
            num_images: 1,
            output_format: 'png',
            enable_safety_checker: true,
            ...(poseGuide
              ? {
                  image_urls: [
                    `data:image/png;base64,${poseGuide.toString('base64')}`,
                  ],
                  guidance_scale: 3.5,
                  enable_prompt_expansion: false as const,
                }
              : {}),
            ...(seed === null ? {} : { seed }),
          },
          signal,
        );
      } catch (error: unknown) {
        // Do not propagate SDK bodies/headers that could contain credentials.
        throw new AiProviderError(
          'PROVIDER_ERROR',
          'fal.ai request failed or timed out. Check the fal dashboard before retrying; a timed-out request may still incur cost.',
          isRetryableProviderFailure(error),
        );
      }
      const parsed = resultSchema.safeParse(rawResult);
      if (!parsed.success || parsed.data.data.has_nsfw_concepts.some(Boolean)) {
        throw new AiProviderError(
          'INVALID_OUTPUT',
          'fal.ai did not return one usable image with seed metadata.',
        );
      }
      const result = parsed.data;
      let image: Buffer;
      try {
        image = await download(result.data.images[0]!.url, signal);
      } catch {
        throw new AiProviderError(
          'DOWNLOAD_FAILED',
          `Could not download the fal.ai image for request ${result.requestId}.`,
        );
      }
      return {
        image,
        seed: result.data.seed,
        model,
        requestId: result.requestId,
        durationMs: performance.now() - start,
      };
    },
  };
}

const framePhases = {
  idle: [
    'neutral',
    'inhale and rise',
    'chest expanded',
    'exhale',
    'neutral',
    'slight settle',
    'lowest settle',
    'return to neutral',
  ],
  walk: [
    'left-foot contact',
    'recoil',
    'passing pose',
    'high point',
    'right-foot contact',
    'recoil',
    'passing pose',
    'high point',
  ],
  attack: [
    'ready',
    'anticipation',
    'wind-up',
    'early swing',
    'impact',
    'follow-through',
    'recovery',
    'return to ready',
  ],
  run: [
    'left-foot contact',
    'deep recoil',
    'fast passing pose',
    'high point',
    'right-foot contact',
    'deep recoil',
    'fast passing pose',
    'high point',
  ],
  hurt: [
    'neutral',
    'impact',
    'recoil',
    'maximum recoil',
    'stagger',
    'recover',
    'settle',
    'neutral',
  ],
  death: [
    'neutral',
    'hit',
    'lose balance',
    'falling',
    'ground contact',
    'collapse',
    'settled',
    'final pose',
  ],
} as const;

function buildFramePrompt(
  input: z.infer<typeof generationInputSchema>,
  frameIndex: number,
) {
  return `pixel art sprite, ${input.prompt}, game asset, transparent background. Full-body side-view character facing right. ${input.animation} animation, frame ${frameIndex + 1} of 8, ${framePhases[input.animation][frameIndex]}. Preserve exactly the same character design, clothing, weapon, proportions, outline thickness, scale, lighting, and color palette in every frame. Follow the supplied OpenPose skeleton exactly. Centered character, feet on one fixed baseline. Crisp 16-bit pixel art, hard square pixels, limited palette. Flat solid #F4F4F4 background. No scenery, floor, shadow, text, border, motion trail, blur, glow, extra limb, duplicate character, or cropped body.`;
}

function spriteFalInput(
  input: z.infer<typeof generationInputSchema>,
  frameIndex: number,
  poseGuide: Buffer,
  seed: number | null,
  reference?: Buffer,
): FalInput {
  return {
    model_name: 'stabilityai/stable-diffusion-xl-base-1.0',
    prompt: buildFramePrompt(input, frameIndex),
    negative_prompt:
      'photograph, 3d render, painterly, smooth shading, antialiasing, blurry, gradient, environment, floor, shadow, text, border, motion trail, speed lines, extra limbs, duplicate character, inconsistent clothes, inconsistent colors',
    image_size: { width: 512, height: 512 },
    num_images: 1,
    image_format: 'png',
    enable_safety_checker: true,
    num_inference_steps: 30,
    guidance_scale: 7,
    scheduler: 'DPM++ 2M Karras',
    loras: [{ path: PIXEL_ART_LORA, scale: 1.15 }],
    controlnets: [
      {
        path: OPENPOSE_CONTROLNET,
        image_url: `data:image/png;base64,${poseGuide.toString('base64')}`,
        conditioning_scale: 0.95,
        start_percentage: 0,
        end_percentage: 1,
      },
    ],
    ...(reference
      ? {
          ip_adapter: [
            {
              path: IP_ADAPTER,
              model_subfolder: 'sdxl_models',
              weight_name: 'ip-adapter-plus_sdxl_vit-h.safetensors',
              ip_adapter_image_url: `data:image/png;base64,${reference.toString('base64')}`,
              scale: 0.8,
            },
          ],
          image_encoder_path: IP_ADAPTER,
          image_encoder_subfolder: 'models/image_encoder',
          image_encoder_weight_name: 'model.safetensors',
        }
      : {}),
    ...(seed === null ? {} : { seed }),
  };
}

async function generatePoseControlledSpriteSheet(options: {
  input: z.infer<typeof generationInputSchema>;
  transport: FalTransport;
  download: typeof downloadFalImage;
}) {
  const generated: Array<{ image: Buffer; requestId: string; seed: number }> =
    [];
  let sharedSeed = options.input.seed;
  for (let frameIndex = 0; frameIndex < 8; frameIndex++) {
    const signal = AbortSignal.timeout(300_000);
    let rawResult: unknown;
    try {
      rawResult = await options.transport(
        FAL_MODELS.sprite,
        spriteFalInput(
          options.input,
          frameIndex,
          await createOpenPoseGuide(options.input.animation, frameIndex),
          sharedSeed,
          generated[0]?.image,
        ),
        signal,
      );
    } catch (error: unknown) {
      throw new AiProviderError(
        'PROVIDER_ERROR',
        `fal.ai pose-controlled sprite frame ${frameIndex + 1}/8 failed. Completed frames may already have incurred cost.`,
        isRetryableProviderFailure(error),
      );
    }
    const parsed = resultSchema.safeParse(rawResult);
    if (!parsed.success || parsed.data.data.has_nsfw_concepts.some(Boolean))
      throw new AiProviderError(
        'INVALID_OUTPUT',
        `fal.ai returned an unusable pose-controlled sprite frame ${frameIndex + 1}/8.`,
      );
    sharedSeed ??= parsed.data.data.seed;
    let image: Buffer;
    try {
      image = await options.download(parsed.data.data.images[0]!.url, signal);
    } catch {
      throw new AiProviderError(
        'DOWNLOAD_FAILED',
        `Could not download pose-controlled sprite frame ${frameIndex + 1}/8 for request ${parsed.data.requestId}.`,
      );
    }
    generated.push({
      image,
      requestId: parsed.data.requestId,
      seed: parsed.data.data.seed,
    });
  }
  const cells = await Promise.all(
    generated.map(({ image }) =>
      sharp(image, { limitInputPixels: 2048 * 2048 })
        .toColourspace('srgb')
        .ensureAlpha()
        .resize(64, 64, { fit: 'fill', kernel: sharp.kernel.nearest })
        .resize(256, 256, { fit: 'fill', kernel: sharp.kernel.nearest })
        .flatten({ background: '#F4F4F4' })
        .png()
        .toBuffer(),
    ),
  );
  const image = await sharp({
    create: {
      width: 1024,
      height: 512,
      channels: 4,
      background: '#F4F4F4',
    },
  })
    .composite(
      cells.map((cell, index) => ({
        input: cell,
        left: (index % 4) * 256,
        top: Math.floor(index / 4) * 256,
      })),
    )
    .png()
    .toBuffer();
  return {
    image,
    seed: sharedSeed!,
    // The generation schema has a 128-character provider request field. Keep
    // the first request as the trace root for this eight-frame batch.
    requestId: generated[0]!.requestId,
  };
}
