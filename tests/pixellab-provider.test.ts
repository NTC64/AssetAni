import { describe, expect, it, vi } from 'vitest';
import {
  AiProviderError,
  PIXELLAB_DIRECTION_ORDER,
  createPixelLabProvider,
} from '../packages/ai/src';
import { generateWithProviderRetry } from '../apps/worker/src/services/provider-retry';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function encoded(value: string) {
  return { type: 'base64', base64: Buffer.from(value).toString('base64') };
}

const input = {
  prompt: 'blue knight with silver sword',
  animation: 'walk' as const,
  direction: 'right' as const,
  frameCount: 8 as const,
  seed: 42,
};

describe('PixelLab provider', () => {
  it('authenticates create-image-pixen and normalizes its response', async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        image: encoded('base-sprite'),
        usage: { type: 'usd', usd: 0.01 },
      }),
    ) as unknown as typeof fetch;
    const provider = createPixelLabProvider({ token: 'secret-token', fetcher });
    const result = await provider.createBaseCharacter({
      prompt: 'blue knight',
      frameSize: 256,
      seed: 42,
    });

    expect(result.image.toString()).toBe('base-sprite');
    expect(result).toMatchObject({
      provider: 'pixellab',
      providerCostUsd: 0.01,
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.pixellab.ai/v2/create-image-pixen',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer secret-token',
          'Content-Type': 'application/json',
        }),
      }),
    );
    const body = JSON.parse(
      (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1].body,
    );
    expect(body).toMatchObject({
      image_size: { width: 256, height: 256 },
      direction: 'east',
      no_background: true,
      seed: 42,
    });
    expect(body.description).not.toContain('4 columns');
  });

  it('accepts subscription generation usage with a null USD cost', async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        image: encoded('subscription-base-sprite'),
        usage: { type: 'generations', usd: null, generations: 1 },
      }),
    ) as unknown as typeof fetch;
    const provider = createPixelLabProvider({ token: 'secret-token', fetcher });

    const result = await provider.createBaseCharacter({
      prompt: 'blue knight',
      frameSize: 256,
      seed: 42,
    });

    expect(result.image.toString()).toBe('subscription-base-sprite');
    expect(result.providerCostUsd).toBeUndefined();
  });

  it('keeps the requested frame count when v3 returns one extra frame', async () => {
    const responses = [
      jsonResponse({ image: encoded('base') }),
      jsonResponse({ background_job_id: 'nine-frame-job' }),
      jsonResponse({
        id: 'nine-frame-job',
        status: 'completed',
        created_at: '2026-01-01T00:00:00Z',
        last_response: {
          images: Array.from({ length: 9 }, (_, index) =>
            encoded(`frame-${index}`),
          ),
        },
      }),
    ];
    const provider = createPixelLabProvider({
      token: 'token',
      fetcher: vi.fn(async () => responses.shift()!) as unknown as typeof fetch,
    });

    const result = await provider.generate(input);

    expect('frames' in result && result.frames).toHaveLength(8);
    expect(
      'frames' in result
        ? result.frames.map(({ buffer }) => buffer.toString())
        : [],
    ).toEqual(Array.from({ length: 8 }, (_, index) => `frame-${index}`));
    expect(result.requestId).toBe('nine-frame-job');
  });

  it('polls animate-with-text-v3 and preserves provider frame order', async () => {
    const responses = [
      jsonResponse({
        background_job_id: 'animation-job',
        status: 'processing',
      }),
      jsonResponse({
        id: 'animation-job',
        status: 'processing',
        created_at: '2026-01-01T00:00:00Z',
        last_response: null,
      }),
      jsonResponse({
        id: 'animation-job',
        status: 'completed',
        created_at: '2026-01-01T00:00:00Z',
        last_response: {
          images: Array.from({ length: 8 }, (_, index) =>
            encoded(`frame-${index}`),
          ),
        },
      }),
    ];
    const fetcher = vi.fn(
      async () => responses.shift()!,
    ) as unknown as typeof fetch;
    const sleep = vi.fn(async () => {});
    const provider = createPixelLabProvider({ token: 'token', fetcher, sleep });
    const result = await provider.animateWithText({
      baseCharacter: Buffer.from('base'),
      animation: 'walk',
      frameCount: 8,
      seed: 42,
    });

    expect(result.providerJobId).toBe('animation-job');
    expect(result.frames.map(({ index }) => index)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(result.frames.map(({ buffer }) => buffer.toString())).toEqual(
      Array.from({ length: 8 }, (_, index) => `frame-${index}`),
    );
    expect(sleep).toHaveBeenCalledWith(2_500);
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://api.pixellab.ai/v2/background-jobs/animation-job',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token' }),
      }),
    );
  });

  it('maps a failed background job to a permanent provider error', async () => {
    const responses = [
      jsonResponse({ background_job_id: 'failed-job' }),
      jsonResponse({
        id: 'failed-job',
        status: 'failed',
        created_at: '2026-01-01T00:00:00Z',
        last_response: { detail: 'motion could not be generated' },
      }),
    ];
    const provider = createPixelLabProvider({
      token: 'token',
      fetcher: vi.fn(async () => responses.shift()!) as unknown as typeof fetch,
    });
    await expect(
      provider.animateWithText({
        baseCharacter: Buffer.from('base'),
        animation: 'idle',
        frameCount: 8,
      }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      retryable: false,
      message: expect.stringContaining('motion could not be generated'),
    });
  });

  it('lets the existing backoff policy retry HTTP 429', async () => {
    const responses = [
      jsonResponse({}, 429),
      jsonResponse({ image: encoded('base') }),
      jsonResponse({ background_job_id: 'job' }),
      jsonResponse({
        id: 'job',
        status: 'completed',
        created_at: '2026-01-01T00:00:00Z',
        last_response: {
          images: Array.from({ length: 8 }, (_, index) => encoded(`f${index}`)),
        },
      }),
    ];
    const fetcher = vi.fn(
      async () => responses.shift()!,
    ) as unknown as typeof fetch;
    const provider = createPixelLabProvider({ token: 'token', fetcher });
    const delays: number[] = [];
    const result = await generateWithProviderRetry(
      provider,
      input,
      {},
      {
        maxAttempts: 2,
        random: () => 0.5,
        sleep: async (milliseconds) => void delays.push(milliseconds),
      },
    );

    expect('frames' in result && result.frames).toHaveLength(8);
    expect(delays).toEqual([2_000]);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('supports skeleton estimation and synchronous skeleton animation', async () => {
    const responses = [
      jsonResponse({
        keypoints: [{ x: 1, y: 2, label: 'head', z_index: 3 }],
      }),
      jsonResponse({ images: [encoded('a'), encoded('b'), encoded('c')] }),
    ];
    const fetcher = vi.fn(
      async () => responses.shift()!,
    ) as unknown as typeof fetch;
    const provider = createPixelLabProvider({ token: 'token', fetcher });
    const skeleton = await provider.estimateSkeleton!({
      image: Buffer.from('base'),
    });
    expect(skeleton.keypoints).toEqual([
      { x: 1, y: 2, label: 'head', zIndex: 3 },
    ]);
    const animation = await provider.animateWithSkeleton!({
      referenceImage: Buffer.from('base'),
      frameSize: 64,
      skeletonKeypoints: Array.from({ length: 3 }, () => skeleton.keypoints),
      seed: 7,
    });
    expect(animation.frames.map(({ buffer }) => buffer.toString())).toEqual([
      'a',
      'b',
      'c',
    ]);
    const body = JSON.parse(
      (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[1]![1].body,
    );
    expect(body.skeleton_keypoints).toEqual(
      Array.from({ length: 3 }, () => [
        { x: 1, y: 2, label: 'head', z_index: 3 },
      ]),
    );
  });

  it('normalizes eight rotations to the documented direction order', async () => {
    const responses = [
      jsonResponse({ background_job_id: 'directions-job' }),
      jsonResponse({
        id: 'directions-job',
        status: 'completed',
        created_at: '2026-01-01T00:00:00Z',
        last_response: {
          images: Array.from({ length: 8 }, (_, index) =>
            encoded(`direction-${index}`),
          ),
        },
      }),
    ];
    const provider = createPixelLabProvider({
      token: 'token',
      fetcher: vi.fn(async () => responses.shift()!) as unknown as typeof fetch,
    });
    const result = await provider.generateDirections!({
      baseCharacter: Buffer.from('base'),
      prompt: 'blue knight',
      seed: 11,
    });
    expect(result.directions).toEqual(PIXELLAB_DIRECTION_ORDER);
    expect(result.frames.map(({ buffer }) => buffer.toString())).toEqual(
      Array.from({ length: 8 }, (_, index) => `direction-${index}`),
    );
  });

  it('marks a failure while submitting retryable', async () => {
    const networkProvider = createPixelLabProvider({
      token: 'token',
      fetcher: vi.fn(async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
    });
    await expect(
      networkProvider.createBaseCharacter({ prompt: 'knight', frameSize: 64 }),
    ).rejects.toEqual(expect.objectContaining({ retryable: true }));
  });

  it('does not mark a job timeout retryable, so the job is billed once', async () => {
    let time = 0;
    const timeoutProvider = createPixelLabProvider({
      token: 'token',
      jobTimeoutMs: 1,
      now: () => time++,
      sleep: async () => {},
      fetcher: vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ background_job_id: 'job' }))
        .mockResolvedValue(
          jsonResponse({
            id: 'job',
            status: 'processing',
            created_at: '2026-01-01T00:00:00Z',
          }),
        ) as unknown as typeof fetch,
    });
    await expect(
      timeoutProvider.animateWithText({
        baseCharacter: Buffer.from('base'),
        animation: 'attack',
        frameCount: 8,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: AiProviderError.name,
        retryable: false,
      }),
    );
  });

  it('does not mark a polling failure retryable once the job was accepted', async () => {
    let call = 0;
    const pollingProvider = createPixelLabProvider({
      token: 'token',
      sleep: async () => {},
      fetcher: vi.fn(async () => {
        call += 1;
        if (call === 1) return jsonResponse({ background_job_id: 'job' });
        throw new Error('offline while polling');
      }) as unknown as typeof fetch,
    });
    await expect(
      pollingProvider.animateWithText({
        baseCharacter: Buffer.from('base'),
        animation: 'walk',
        frameCount: 8,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: AiProviderError.name,
        retryable: false,
      }),
    );
  });
});
