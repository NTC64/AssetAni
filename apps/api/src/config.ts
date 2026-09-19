import path from 'node:path';
import { z } from 'zod';

const apiConfigSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().url(),
  RESULT_STORAGE_PATH: z.string().min(1).default('artifacts/backend-results'),
  PUBLIC_API_URL: z.string().url().default('http://localhost:3000'),
  API_KEY_PEPPER: z.string().min(32),
});

export function loadApiConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = apiConfigSchema.parse(environment);
  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.API_PORT,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    resultStoragePath: path.resolve(parsed.RESULT_STORAGE_PATH),
    publicApiUrl: parsed.PUBLIC_API_URL.replace(/\/$/, ''),
    apiKeyPepper: parsed.API_KEY_PEPPER,
  };
}
