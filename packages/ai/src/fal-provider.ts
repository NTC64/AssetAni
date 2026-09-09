import { createFalClient } from '@fal-ai/client';
import { z } from 'zod';
import { buildSpritePrompt } from './prompt';
import {
  AiProviderError,
  generationInputSchema,
  type AiProvider,
} from './provider';

export const FAL_MODELS = {
  turbo: 'fal-ai/flux-2/turbo',
  schnell: 'fal-ai/flux/schnell',
} as const;
const modelSchema = z.enum(['turbo', 'schnell']);
export interface FalInput {
  prompt: string;
  image_size: { width: number; height: number };
  num_images: number;
  output_format: 'png';
  enable_safety_checker: true;
  seed?: number;
}
export type FalTransport = (
  model: (typeof FAL_MODELS)[keyof typeof FAL_MODELS],
  input: FalInput,
  signal: AbortSignal,
) => Promise<unknown>;
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
  model?: 'turbo' | 'schnell';
  transport?: FalTransport;
  download?: typeof downloadFalImage;
}): AiProvider {
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
    async generate(rawInput) {
      const { seed, ...promptInput } = generationInputSchema.parse(rawInput);
      const start = performance.now();
      const signal = AbortSignal.timeout(120_000);
      let rawResult: unknown;
      try {
        rawResult = await transport(
          model,
          {
            prompt: buildSpritePrompt(promptInput),
            image_size: { width: 1024, height: 1024 },
            num_images: 1,
            output_format: 'png',
            enable_safety_checker: true,
            ...(seed === null ? {} : { seed }),
          },
          signal,
        );
      } catch {
        // Do not propagate SDK bodies/headers that could contain credentials.
        throw new AiProviderError(
          'PROVIDER_ERROR',
          'fal.ai request failed or timed out. Check the fal dashboard before retrying; a timed-out request may still incur cost.',
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
