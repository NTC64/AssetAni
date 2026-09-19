import {
  AiProviderError,
  type AiProvider,
  type GenerationInput,
} from '@sprite/ai';

export interface RetryOptions {
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  maxAttempts?: 1 | 2 | 3;
}

export async function generateWithProviderRetry(
  provider: AiProvider,
  input: GenerationInput,
  generationOptions: { strictLayoutRetry?: boolean },
  options: RetryOptions = {},
) {
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const random = options.random ?? Math.random;
  const maxAttempts = options.maxAttempts ?? 3;
  const delays = [2_000, 8_000];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await provider.generate(input, generationOptions);
    } catch (error) {
      if (
        !(error instanceof AiProviderError) ||
        !error.retryable ||
        attempt === maxAttempts - 1
      )
        throw error;
      const jitter = 0.8 + random() * 0.4;
      await sleep(Math.round(delays[attempt]! * jitter));
    }
  }
  throw new Error('Unreachable provider retry state.');
}
