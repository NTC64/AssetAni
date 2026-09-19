import path from 'node:path';
import { z } from 'zod';

const workerConfigSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().url(),
    AI_PROVIDER: z.enum(['fake', 'fal', 'pixellab']).default('pixellab'),
    FAL_KEY: z.string().optional(),
    FAL_MODEL: z.enum(['sprite', 'turbo', 'schnell']).default('sprite'),
    PIXELLAB_API_TOKEN: z.string().optional(),
    PIXELLAB_BASE_URL: z.string().url().default('https://api.pixellab.ai/v2'),
    PIXELLAB_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2500),
    PIXELLAB_JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(180000),
    AI_AUTO_RETRY_PAID_OUTPUT: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    RESULT_STORAGE_PATH: z.string().min(1).default('artifacts/backend-results'),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(2),
  })
  .superRefine((value, context) => {
    if (value.AI_PROVIDER === 'fal' && !value.FAL_KEY?.trim())
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FAL_KEY'],
        message: 'FAL_KEY is required when AI_PROVIDER=fal.',
      });
    if (value.AI_PROVIDER === 'pixellab' && !value.PIXELLAB_API_TOKEN?.trim())
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PIXELLAB_API_TOKEN'],
        message: 'PIXELLAB_API_TOKEN is required when AI_PROVIDER=pixellab.',
      });
  });

export function loadWorkerConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = workerConfigSchema.parse(environment);
  return {
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    provider: parsed.AI_PROVIDER,
    falKey: parsed.FAL_KEY?.trim(),
    falModel: parsed.FAL_MODEL,
    pixelLabToken: parsed.PIXELLAB_API_TOKEN?.trim(),
    pixelLabBaseUrl: parsed.PIXELLAB_BASE_URL,
    pixelLabPollIntervalMs: parsed.PIXELLAB_POLL_INTERVAL_MS,
    pixelLabJobTimeoutMs: parsed.PIXELLAB_JOB_TIMEOUT_MS,
    autoRetryPaidOutput: parsed.AI_AUTO_RETRY_PAID_OUTPUT,
    resultStoragePath: path.resolve(parsed.RESULT_STORAGE_PATH),
    concurrency: parsed.WORKER_CONCURRENCY,
  };
}
