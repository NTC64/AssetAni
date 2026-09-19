import { buildApp } from './app';
import { loadApiConfig } from './config';
import {
  AccountRepository,
  CharacterRepository,
  createDatabase,
  GenerationRepository,
} from '@sprite/db';
import { BullGenerationQueue, RedisRateLimiter } from '@sprite/queue';
import { LocalResultStorage } from '@sprite/core';

async function main() {
  const config = loadApiConfig();
  const { db, pool } = createDatabase(config.databaseUrl);
  const repository = new GenerationRepository(db);
  const accounts = new AccountRepository(db);
  const characters = new CharacterRepository(db);
  const queue = new BullGenerationQueue(config.redisUrl);
  const rateLimiter = new RedisRateLimiter(config.redisUrl);
  const app = buildApp({
    repository,
    accounts,
    characters,
    queue,
    rateLimiter,
    apiKeyPepper: config.apiKeyPepper,
    storage: new LocalResultStorage(config.resultStoragePath),
    publicApiUrl: config.publicApiUrl,
    logger: true,
  });
  const shutdown = async () => {
    await app.close();
    await queue.close();
    await rateLimiter.close();
    await pool.end();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  await app.listen({ port: config.port, host: '127.0.0.1' });
}

void main();
