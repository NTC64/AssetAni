import {
  createFakeProvider,
  createFalProvider,
  createPixelLabProvider,
  AIOrchestrator,
  type SpriteAIProvider,
} from '@sprite/ai';
import {
  cleanupAbandonedTempDirectories,
  LocalResultStorage,
} from '@sprite/core';
import {
  AccountRepository,
  CharacterRepository,
  createDatabase,
  GenerationRepository,
} from '@sprite/db';
import { startGenerationWorker } from '@sprite/queue';
import { processGeneration } from './jobs/process-generation';
import { loadWorkerConfig } from './config';

async function main() {
  const config = loadWorkerConfig();
  const { db, pool } = createDatabase(config.databaseUrl);
  const repository = new GenerationRepository(db);
  const accounts = new AccountRepository(db);
  const characters = new CharacterRepository(db);
  const paidProvider =
    config.provider === 'fake'
      ? createFakeProvider()
      : config.provider === 'fal'
        ? createFalProvider({ key: config.falKey!, model: config.falModel })
        : createPixelLabProvider({
            token: config.pixelLabToken!,
            baseUrl: config.pixelLabBaseUrl,
            pollIntervalMs: config.pixelLabPollIntervalMs,
            jobTimeoutMs: config.pixelLabJobTimeoutMs,
          });
  const freeProvider =
    config.provider === 'fal'
      ? createFalProvider({ key: config.falKey!, model: 'schnell' })
      : paidProvider;
  const storage = new LocalResultStorage(config.resultStoragePath);
  const isSpriteProvider = (
    provider: typeof paidProvider,
  ): provider is SpriteAIProvider =>
    'createBaseCharacter' in provider && 'animateWithText' in provider;
  const conceptProvider = config.falKey
    ? createFalProvider({ key: config.falKey, model: 'schnell' })
    : undefined;
  await cleanupAbandonedTempDirectories();
  const running = startGenerationWorker(
    config.redisUrl,
    async (generationId) => {
      const generation = await repository.findById(generationId);
      const user = generation
        ? await accounts.findUser(generation.userId)
        : undefined;
      const provider = user?.plan === 'free' ? freeProvider : paidProvider;
      const orchestrator = isSpriteProvider(provider)
        ? new AIOrchestrator(provider, conceptProvider)
        : undefined;
      await processGeneration(generationId, {
        repository,
        characters,
        provider,
        orchestrator,
        storage,
        allowStructuralRetry:
          provider.name === 'fake' || config.autoRetryPaidOutput,
        retry: {
          maxAttempts:
            provider.name !== 'fal' || config.autoRetryPaidOutput ? 3 : 1,
        },
      });
    },
    { concurrency: config.concurrency },
  );
  running.worker.on('completed', (job) =>
    console.log(
      JSON.stringify({
        generationId: job.data.generationId,
        event: 'job_completed',
      }),
    ),
  );
  running.worker.on('failed', (job) =>
    console.error(
      JSON.stringify({
        generationId: job?.data.generationId,
        event: 'job_failed',
      }),
    ),
  );
  const shutdown = async () => {
    await running.close();
    await pool.end();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

void main();
