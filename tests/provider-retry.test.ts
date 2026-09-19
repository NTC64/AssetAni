import { describe, expect, it, vi } from 'vitest';
import { AiProviderError, type AiProvider } from '../packages/ai/src';
import { generateWithProviderRetry } from '../apps/worker/src/services/provider-retry';
import { loadWorkerConfig } from '../apps/worker/src/config';

const input = {
  prompt: 'knight',
  animation: 'walk' as const,
  direction: 'right' as const,
  frameCount: 8 as const,
  seed: 1,
};

describe('provider retry policy', () => {
  it('defaults runtime generation to PixelLab with documented polling values', () => {
    const config = loadWorkerConfig({
      DATABASE_URL: 'postgresql://localhost/test',
      REDIS_URL: 'redis://localhost:6379',
      PIXELLAB_API_TOKEN: 'test-token',
    });
    expect(config).toMatchObject({
      provider: 'pixellab',
      pixelLabBaseUrl: 'https://api.pixellab.ai/v2',
      pixelLabPollIntervalMs: 2_500,
      pixelLabJobTimeoutMs: 180_000,
    });
  });

  it('disables automatic paid-output retries by default', () => {
    const config = loadWorkerConfig({
      DATABASE_URL: 'postgresql://localhost/test',
      REDIS_URL: 'redis://localhost:6379',
      AI_PROVIDER: 'fake',
    });
    expect(config.autoRetryPaidOutput).toBe(false);
    expect(config.falModel).toBe('sprite');
  });
  it('retries retryable failures at most three total attempts with jittered delays', async () => {
    let calls = 0;
    const delays: number[] = [];
    const provider: AiProvider = {
      name: 'fake',
      model: 'retry-test',
      async generate() {
        calls++;
        if (calls < 3)
          throw new AiProviderError('PROVIDER_ERROR', 'temporary', true);
        return {
          image: Buffer.from('png'),
          seed: 1,
          model: this.model,
          requestId: 'request',
          durationMs: 1,
        };
      },
    };
    await generateWithProviderRetry(
      provider,
      input,
      {},
      {
        random: () => 0.5,
        sleep: async (milliseconds) => void delays.push(milliseconds),
      },
    );
    expect(calls).toBe(3);
    expect(delays).toEqual([2_000, 8_000]);
  });

  it('does not retry invalid output or other permanent provider errors', async () => {
    let calls = 0;
    const provider: AiProvider = {
      name: 'fake',
      model: 'permanent-test',
      async generate() {
        calls++;
        throw new AiProviderError('INVALID_OUTPUT', 'permanent');
      },
    };
    await expect(
      generateWithProviderRetry(provider, input, {}, { sleep: async () => {} }),
    ).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    expect(calls).toBe(1);
  });

  it('can disable automatic retries for a paid provider call', async () => {
    const provider: AiProvider = {
      name: 'fal',
      model: 'paid-test',
      generate: vi
        .fn()
        .mockRejectedValue(
          new AiProviderError('PROVIDER_ERROR', 'timeout', true),
        ),
    };
    await expect(
      generateWithProviderRetry(provider, input, {}, { maxAttempts: 1 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(provider.generate).toHaveBeenCalledOnce();
  });
});
