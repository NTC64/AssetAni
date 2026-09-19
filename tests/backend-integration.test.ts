import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import RedisMemoryServer from 'redis-memory-server';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { eq } from 'drizzle-orm';
import { buildApp } from '../apps/api/src/app';
import { processGeneration } from '../apps/worker/src/jobs/process-generation';
import {
  createFakeProvider,
  type AiProvider,
  type GenerationInput,
} from '../packages/ai/src';
import { manifestSchema } from '../packages/contracts/src';
import {
  apiKeyPrefix,
  generateApiKey,
  hashApiKey,
  LocalResultStorage,
} from '../packages/core/src';
import {
  AccountRepository,
  GenerationRepository,
  type GenerationDatabase,
} from '../packages/db/src';
import * as schema from '../packages/db/src/schema';
import {
  BullGenerationQueue,
  RedisRateLimiter,
  startGenerationWorker,
} from '../packages/queue/src';

const requestBody = {
  prompt: 'blue knight with silver sword',
  style: 'pixel_art',
  animation: 'walk',
  direction: 'right',
  frameCount: 8,
  fps: 12,
  frameSize: 256,
  background: 'transparent',
  seed: 42,
} as const;
const pepper = 'phase-5-integration-pepper-32-bytes-minimum';

async function waitForStatus(
  app: ReturnType<typeof buildApp>,
  id: string,
  expected: 'SUCCEEDED' | 'FAILED',
  apiKey: string,
) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/generations/${id}`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const body = response.json<{ status: string }>();
    if (body.status === expected) return response;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${expected}.`);
}

describe.sequential('Phase 3 local integration', () => {
  const outputRoot = path.join(tmpdir(), `sprite-backend-${randomUUID()}`);
  const storage = new LocalResultStorage(outputRoot);
  const pglite = new PGlite();
  const db = drizzle(pglite, { schema }) as unknown as GenerationDatabase;
  const repository = new GenerationRepository(db);
  const accounts = new AccountRepository(db);
  let redis: RedisMemoryServer;
  let redisUrl: string;
  let queue: BullGenerationQueue;
  let rateLimiter: RedisRateLimiter;
  let runningWorker: ReturnType<typeof startGenerationWorker>;
  let app: ReturnType<typeof buildApp>;
  let releaseSuccessfulProvider: () => void = () => {};
  const providerStarted = { value: false };
  let structuralFailureCalls = 0;
  let staticMotionFailureCalls = 0;
  let apiKey: string;
  let staticApiKey: string;

  beforeAll(async () => {
    const phase3Migration = await readFile(
      path.resolve('migrations/0000_phase3_generations.sql'),
      'utf8',
    );
    const phase5Migration = await readFile(
      path.resolve('migrations/0001_phase5_auth_credits.sql'),
      'utf8',
    );
    const characterMigration = await readFile(
      path.resolve('migrations/0002_characters_batches.sql'),
      'utf8',
    );
    await pglite.exec(phase3Migration);
    await pglite.exec(phase5Migration);
    await pglite.exec(characterMigration);
    apiKey = generateApiKey();
    const provisioned = await accounts.provisionFreeUser({
      email: 'integration@example.com',
      keyPrefix: apiKeyPrefix(apiKey),
      keyHash: hashApiKey(apiKey, pepper),
    });
    await db
      .update(schema.users)
      .set({ plan: 'pro' })
      .where(eq(schema.users.id, provisioned.user.id));
    staticApiKey = generateApiKey();
    const staticUser = await accounts.provisionFreeUser({
      email: 'static-integration@example.com',
      keyPrefix: apiKeyPrefix(staticApiKey),
      keyHash: hashApiKey(staticApiKey, pepper),
    });
    await db
      .update(schema.users)
      .set({ plan: 'pro' })
      .where(eq(schema.users.id, staticUser.user.id));
    if (process.platform === 'win32') {
      redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';
    } else {
      redis = new RedisMemoryServer();
      await redis.start();
      const redisInfo = redis.getInstanceInfo();
      if (!redisInfo) throw new Error('Temporary Redis did not start.');
      redisUrl = `redis://${redisInfo.ip}:${redisInfo.port}`;
    }
    const queueName = `sprite-generation-test-${randomUUID()}`;
    queue = new BullGenerationQueue(redisUrl, { queueName });
    rateLimiter = new RedisRateLimiter(redisUrl);
    const fake = createFakeProvider();
    const provider: AiProvider = {
      name: 'pixellab',
      model: 'mock-pixellab',
      async generate(input: GenerationInput, options) {
        if (input.prompt.includes('always static')) {
          staticMotionFailureCalls++;
          const cells = Array.from({ length: 8 }, (_, index) => ({
            input: {
              create: {
                width: 80,
                height: 120,
                channels: 4 as const,
                background: '#284696',
              },
            },
            left: (index % 4) * 256 + 88,
            top: Math.floor(index / 4) * 256 + 100,
          }));
          const image = await sharp({
            create: {
              width: 1024,
              height: 512,
              channels: 4,
              background: '#F4F4F4',
            },
          })
            .composite(cells)
            .png()
            .toBuffer();
          return {
            image,
            seed: input.seed ?? 0,
            model: fake.model,
            requestId: `static-${staticMotionFailureCalls}`,
            durationMs: 1,
          };
        }
        if (input.prompt.includes('always invalid')) {
          structuralFailureCalls++;
          const image = await sharp({
            create: {
              width: 1024,
              height: 512,
              channels: 4,
              background: '#101820',
            },
          })
            .png()
            .toBuffer();
          return {
            image,
            seed: input.seed ?? 0,
            model: this.model,
            requestId: `invalid-${structuralFailureCalls}`,
            durationMs: 1,
          };
        }
        providerStarted.value = true;
        await new Promise<void>((resolve) => {
          releaseSuccessfulProvider = resolve;
        });
        const generated = await fake.generate(input, options);
        const cells = Array.from({ length: 8 }, (_, index) => ({
          left: (index % 4) * 256,
          top: Math.floor(index / 4) * 256,
          width: 256,
          height: 256,
        }));
        const frames = await Promise.all(
          cells.map(async (cell, index) => ({
            index,
            buffer: await sharp(generated.image).extract(cell).png().toBuffer(),
          })),
        );
        return {
          ...generated,
          image: frames[0]!.buffer,
          frames,
          model: this.model,
          requestId: 'mock-pixellab-animation-job',
          providerCostUsd: 0.02,
        };
      },
    };
    runningWorker = startGenerationWorker(
      redisUrl,
      (generationId) =>
        processGeneration(generationId, {
          repository,
          provider,
          storage,
          retry: { sleep: async () => {}, random: () => 0.5 },
        }),
      { concurrency: 2, queueName },
    );
    app = buildApp({
      repository,
      accounts,
      queue,
      rateLimiter,
      apiKeyPepper: pepper,
      storage,
      publicApiUrl: 'http://localhost:3000',
    });
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
    if (runningWorker) await runningWorker.close();
    if (queue) await queue.close();
    if (rateLimiter) await rateLimiter.close();
    if (redis) await redis.stop();
    await pglite.close();
    await rm(outputRoot, { recursive: true, force: true });
  });

  it('runs POST -> BullMQ -> worker -> Sharp -> local result -> polling without blocking POST on AI', async () => {
    const idempotencyKey = randomUUID();
    const started = performance.now();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/generations',
      headers: {
        'idempotency-key': idempotencyKey,
        authorization: `Bearer ${apiKey}`,
      },
      payload: requestBody,
    });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(created.statusCode).toBe(202);
    expect(created.json()).toMatchObject({ status: 'QUEUED', progress: 5 });
    const id = created.json<{ id: string }>().id;

    const providerDeadline = Date.now() + 5_000;
    while (!providerStarted.value && Date.now() < providerDeadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(providerStarted.value).toBe(true);
    releaseSuccessfulProvider();

    const completed = await waitForStatus(app, id, 'SUCCEEDED', apiKey);
    expect(completed.json()).toMatchObject({
      id,
      status: 'SUCCEEDED',
      progress: 100,
      result: {
        packageUrl: `http://localhost:3000/v1/generations/${id}/files/result.zip`,
      },
    });
    const packageResponse = await app.inject({
      method: 'GET',
      url: `/v1/generations/${id}/files/result.zip`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(packageResponse.statusCode).toBe(200);
    const files = unzipSync(packageResponse.rawPayload);
    const manifest = manifestSchema.parse(
      JSON.parse(Buffer.from(files['manifest.json']!).toString('utf8')),
    );
    expect(manifest.frames).toHaveLength(8);
    expect(Object.keys(files)).toHaveLength(10);
    expect(await repository.findById(id)).toMatchObject({
      provider: 'pixellab',
      providerModel: 'mock-pixellab',
      providerRequestId: 'mock-pixellab-animation-job',
      providerCostUsd: '0.020000',
    });

    const duplicate = await app.inject({
      method: 'POST',
      url: '/v1/generations',
      headers: {
        'idempotency-key': idempotencyKey,
        authorization: `Bearer ${apiKey}`,
      },
      payload: requestBody,
    });
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json()).toMatchObject({ id, status: 'SUCCEEDED' });
  }, 30_000);

  it('retries structurally invalid AI output exactly once and publishes no package', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/generations',
      headers: {
        'idempotency-key': randomUUID(),
        authorization: `Bearer ${apiKey}`,
      },
      payload: { ...requestBody, prompt: 'always invalid sprite' },
    });
    expect(created.statusCode).toBe(202);
    const id = created.json<{ id: string }>().id;
    const failed = await waitForStatus(app, id, 'FAILED', apiKey);
    expect(failed.json()).toMatchObject({
      id,
      status: 'FAILED',
      progress: 100,
      errorCode: 'PROCESSING_FAILED',
    });
    expect(structuralFailureCalls).toBe(2);
    expect(await storage.readPublicFile(id, 'result.zip')).toBeUndefined();
    const credits = await app.inject({
      method: 'GET',
      url: '/v1/me/credits',
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(credits.json()).toEqual({ balance: 2 });
    expect((await repository.findById(id))?.status).toBe('FAILED');
    expect(
      (await accounts.creditEntriesForGeneration(id)).map(
        (entry) => entry.reason,
      ),
    ).toEqual(['generation', 'refund']);
  }, 30_000);

  it('retries static poses once, reports the cause, and refunds the credit', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/generations',
      headers: {
        'idempotency-key': randomUUID(),
        authorization: `Bearer ${staticApiKey}`,
      },
      payload: { ...requestBody, prompt: 'always static sprite' },
    });
    expect(created.statusCode).toBe(202);
    const id = created.json<{ id: string }>().id;
    const failed = await waitForStatus(app, id, 'FAILED', staticApiKey);
    expect(failed.json()).toMatchObject({
      id,
      status: 'FAILED',
      errorCode: 'INSUFFICIENT_MOTION',
    });
    expect(staticMotionFailureCalls).toBe(2);
    expect(await storage.readPublicFile(id, 'result.zip')).toBeUndefined();
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/me/credits',
          headers: { authorization: `Bearer ${staticApiKey}` },
        })
      ).json(),
    ).toEqual({ balance: 3 });
    expect(
      (await accounts.creditEntriesForGeneration(id)).map(
        (entry) => entry.reason,
      ),
    ).toEqual(['generation', 'refund']);
  }, 30_000);

  it('validates requests, returns the error contract, and reports readiness', async () => {
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/generations',
      headers: {
        'idempotency-key': randomUUID(),
        authorization: `Bearer ${apiKey}`,
      },
      payload: { ...requestBody, frameCount: 12 },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      error: {
        code: 'INVALID_PROMPT',
        requestId: expect.stringMatching(/^req_/),
      },
    });
    expect(
      (await app.inject({ method: 'GET', url: '/health' })).json(),
    ).toEqual({
      status: 'ok',
    });
    expect((await app.inject({ method: 'GET', url: '/ready' })).json()).toEqual(
      {
        status: 'ready',
      },
    );
  });
});
