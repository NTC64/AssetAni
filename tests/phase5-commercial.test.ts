import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../apps/api/src/app';
import {
  apiKeyPrefix,
  generateApiKey,
  hashApiKey,
  LocalResultStorage,
} from '../packages/core/src';
import {
  AccountRepository,
  GenerationRepository,
  type ApiKeyScope,
  type GenerationDatabase,
} from '../packages/db/src';
import {
  apiKeys,
  creditLedger,
  generations,
  users,
} from '../packages/db/src/schema';
import {
  MemoryRateLimiter,
  type GenerationQueue,
  type RateLimiter,
} from '../packages/queue/src';

const pepper = 'phase-5-test-pepper-that-is-at-least-32-bytes';
const generationInput = {
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

interface TestDatabase {
  pglite: PGlite;
  db: GenerationDatabase;
  accounts: AccountRepository;
  generations: GenerationRepository;
}

const databases: TestDatabase[] = [];

async function createTestDatabase() {
  const pglite = new PGlite();
  const db = drizzle(pglite, {
    schema: await import('../packages/db/src/schema'),
  }) as unknown as GenerationDatabase;
  await pglite.exec(
    await readFile(
      path.resolve('migrations/0000_phase3_generations.sql'),
      'utf8',
    ),
  );
  await pglite.exec(
    await readFile(
      path.resolve('migrations/0001_phase5_auth_credits.sql'),
      'utf8',
    ),
  );
  await pglite.exec(
    await readFile(
      path.resolve('migrations/0002_characters_batches.sql'),
      'utf8',
    ),
  );
  const result = {
    pglite,
    db,
    accounts: new AccountRepository(db),
    generations: new GenerationRepository(db),
  };
  databases.push(result);
  return result;
}

async function provision(
  test: TestDatabase,
  options: {
    email?: string;
    plan?: string;
    balance?: number;
    scopes?: ApiKeyScope[];
    expiresAt?: Date;
  } = {},
) {
  const rawKey = generateApiKey();
  const result = await test.accounts.provisionFreeUser({
    email: options.email ?? `${randomUUID()}@example.com`,
    keyPrefix: apiKeyPrefix(rawKey),
    keyHash: hashApiKey(rawKey, pepper),
    scopes: options.scopes,
  });
  if (options.plan !== undefined || options.balance !== undefined)
    await test.db
      .update(users)
      .set({
        ...(options.plan !== undefined ? { plan: options.plan } : {}),
        ...(options.balance !== undefined
          ? { creditBalance: options.balance }
          : {}),
      })
      .where(eq(users.id, result.user.id));
  if (options.expiresAt)
    await test.db
      .update(apiKeys)
      .set({ expiresAt: options.expiresAt })
      .where(eq(apiKeys.id, result.apiKey.id));
  return { ...result, rawKey };
}

function reservation(
  identity: Awaited<ReturnType<typeof provision>>,
  idempotencyKey = randomUUID(),
) {
  return {
    id: randomUUID(),
    userId: identity.user.id,
    apiKeyId: identity.apiKey.id,
    idempotencyKey,
    promptHash: 'a'.repeat(64),
    parameters: generationInput,
  };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((test) => test.pglite.close()));
});

describe('API key security and free trial', () => {
  it('generates 32 random bytes, hashes with HMAC-SHA256, and never stores plaintext', async () => {
    const test = await createTestDatabase();
    const rawKey = generateApiKey();
    expect(rawKey).toMatch(/^spr_live_[A-Za-z0-9_-]{43}$/);
    expect(hashApiKey(rawKey, pepper)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashApiKey(rawKey, pepper)).not.toBe(
      hashApiKey(rawKey, `${pepper}-different`),
    );
    const created = await test.accounts.provisionFreeUser({
      email: 'new-user@example.com',
      keyPrefix: apiKeyPrefix(rawKey),
      keyHash: hashApiKey(rawKey, pepper),
    });
    expect(created.user.creditBalance).toBe(3);
    expect(
      created.apiKey.expiresAt!.getTime() - created.apiKey.createdAt.getTime(),
    ).toBe(180 * 24 * 60 * 60 * 1000);
    expect(JSON.stringify(created.apiKey)).not.toContain(rawKey);
    const ledger = await test.db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.userId, created.user.id));
    expect(ledger).toMatchObject([
      { delta: 3, reason: 'free_trial', balanceAfter: 3 },
    ]);
    const duplicateRawKey = generateApiKey();
    await expect(
      test.accounts.provisionFreeUser({
        email: 'new-user@example.com',
        keyPrefix: apiKeyPrefix(duplicateRawKey),
        keyHash: hashApiKey(duplicateRawKey, pepper),
      }),
    ).rejects.toThrow();
    expect((await test.accounts.findUser(created.user.id))!.creditBalance).toBe(
      3,
    );
  }, 15_000);

  it('enforces token-bucket generation burst and polling limits', async () => {
    let now = 1_000;
    const limiter = new MemoryRateLimiter(() => now);
    const generate = { capacity: 2, refillPerMinute: 10 };
    expect((await limiter.consume('key:generate', generate)).allowed).toBe(
      true,
    );
    expect((await limiter.consume('key:generate', generate)).allowed).toBe(
      true,
    );
    expect(await limiter.consume('key:generate', generate)).toMatchObject({
      allowed: false,
      retryAfterSeconds: 6,
    });
    now += 6_000;
    expect((await limiter.consume('key:generate', generate)).allowed).toBe(
      true,
    );

    const poll = { capacity: 60, refillPerMinute: 60 };
    for (let index = 0; index < 60; index++)
      expect((await limiter.consume('key:poll', poll)).allowed).toBe(true);
    expect((await limiter.consume('key:poll', poll)).allowed).toBe(false);
  });
});

describe('atomic credit reservation and refund', () => {
  it('never lets credit_balance become negative under concurrent reservations', async () => {
    const test = await createTestDatabase();
    const identity = await provision(test, { plan: 'pro', balance: 1 });
    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        test.generations.reserve(reservation(identity)),
      ),
    );
    expect(
      attempts.filter((attempt) => attempt.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      (await test.accounts.findUser(identity.user.id))!.creditBalance,
    ).toBe(0);
    const rows = await test.db
      .select()
      .from(generations)
      .where(eq(generations.userId, identity.user.id));
    expect(rows).toHaveLength(1);
    const charges = await test.db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.userId, identity.user.id));
    expect(
      charges.filter((entry) => entry.reason === 'generation'),
    ).toHaveLength(1);
  });

  it('charges a concurrent idempotent request exactly once', async () => {
    const test = await createTestDatabase();
    const identity = await provision(test, { plan: 'pro' });
    const key = randomUUID();
    const attempts = await Promise.all(
      Array.from({ length: 12 }, () =>
        test.generations.reserve(reservation(identity, key)),
      ),
    );
    expect(new Set(attempts.map((attempt) => attempt.record.id)).size).toBe(1);
    expect(attempts.filter((attempt) => attempt.created)).toHaveLength(1);
    expect(
      (await test.accounts.findUser(identity.user.id))!.creditBalance,
    ).toBe(2);
  });

  it('refunds a permanently failed generation exactly once across retries', async () => {
    const test = await createTestDatabase();
    const identity = await provision(test, { plan: 'pro' });
    const created = await test.generations.reserve(reservation(identity));
    expect(
      (await test.accounts.findUser(identity.user.id))!.creditBalance,
    ).toBe(2);
    const refunds = await Promise.all(
      Array.from({ length: 20 }, () =>
        test.generations.failAndRefund(created.record.id, {
          errorCode: 'AI_PROVIDER_ERROR',
          errorMessage: 'AI provider failed.',
        }),
      ),
    );
    expect(refunds.filter((refund) => refund.refunded)).toHaveLength(1);
    expect(
      (await test.accounts.findUser(identity.user.id))!.creditBalance,
    ).toBe(3);
    const ledger = await test.accounts.creditEntriesForGeneration(
      created.record.id,
    );
    expect(ledger.map((entry) => entry.reason).sort()).toEqual([
      'generation',
      'refund',
    ]);
  });

  it('enforces free/pro concurrency and the free 30 second cooldown', async () => {
    const test = await createTestDatabase();
    const identity = await provision(test);
    const first = await test.generations.reserve(reservation(identity));
    await expect(
      test.generations.reserve(reservation(identity)),
    ).rejects.toMatchObject({
      code: 'CONCURRENCY_LIMIT',
    });
    await test.generations.failAndRefund(first.record.id, {
      errorCode: 'INTERNAL_ERROR',
      errorMessage: 'failed',
    });
    await expect(
      test.generations.reserve(reservation(identity)),
    ).rejects.toMatchObject({
      code: 'FREE_COOLDOWN',
    });

    const paid = await provision(test, { plan: 'pro' });
    await test.generations.reserve(reservation(paid));
    await test.generations.reserve(reservation(paid));
    await expect(
      test.generations.reserve(reservation(paid)),
    ).rejects.toMatchObject({ code: 'CONCURRENCY_LIMIT' });
  });
});

describe('authenticated commercial API', () => {
  it('requires valid scoped keys and exposes /v1/me plus credits', async () => {
    const test = await createTestDatabase();
    const identity = await provision(test);
    const limited = await provision(test, { scopes: ['generation:read'] });
    const expired = await provision(test, {
      expiresAt: new Date(Date.now() - 1_000),
    });
    const queue: GenerationQueue = {
      enqueue: vi.fn().mockResolvedValue(undefined),
      health: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    let denyRate = false;
    const rateLimiter: RateLimiter = {
      consume: vi.fn(async () => ({
        allowed: !denyRate,
        retryAfterSeconds: 7,
      })),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const output = path.join(tmpdir(), `phase5-api-${randomUUID()}`);
    const app = buildApp({
      repository: test.generations,
      accounts: test.accounts,
      queue,
      rateLimiter,
      apiKeyPepper: pepper,
      storage: new LocalResultStorage(output),
      publicApiUrl: 'http://localhost:3000',
    });
    try {
      expect(
        (await app.inject({ method: 'GET', url: '/v1/me' })).statusCode,
      ).toBe(401);
      const me = await app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: { authorization: `Bearer ${identity.rawKey}` },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({
        email: identity.user.email,
        plan: 'free',
        apiKey: {
          prefix: apiKeyPrefix(identity.rawKey),
          scopes: ['generation:create', 'generation:read', 'credit:read'],
        },
      });
      const credits = await app.inject({
        method: 'GET',
        url: '/v1/me/credits',
        headers: { authorization: `Bearer ${identity.rawKey}` },
      });
      expect(credits.json()).toEqual({ balance: 3 });
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/v1/me/credits',
            headers: { authorization: `Bearer ${limited.rawKey}` },
          })
        ).statusCode,
      ).toBe(403);
      const missingCreateScope = await app.inject({
        method: 'POST',
        url: '/v1/generations',
        headers: {
          authorization: `Bearer ${limited.rawKey}`,
          'idempotency-key': randomUUID(),
        },
        payload: generationInput,
      });
      expect(missingCreateScope.statusCode).toBe(403);
      const expiredResponse = await app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: { authorization: `Bearer ${expired.rawKey}` },
      });
      expect(expiredResponse.statusCode).toBe(401);
      expect(expiredResponse.json()).toMatchObject({
        error: { code: 'API_KEY_EXPIRED' },
      });
      denyRate = true;
      const limitedResponse = await app.inject({
        method: 'GET',
        url: '/v1/me/credits',
        headers: { authorization: `Bearer ${identity.rawKey}` },
      });
      expect(limitedResponse.statusCode).toBe(429);
      expect(limitedResponse.headers['retry-after']).toBe('7');
      expect(limitedResponse.json()).toMatchObject({
        error: { code: 'RATE_LIMITED' },
      });
    } finally {
      await app.close();
      await rm(output, { recursive: true, force: true });
    }
  });

  it('charges once for idempotent POSTs and returns HTTP 402 at zero balance', async () => {
    const test = await createTestDatabase();
    const identity = await provision(test, { plan: 'pro', balance: 1 });
    const empty = await provision(test, { plan: 'pro', balance: 0 });
    const queue: GenerationQueue = {
      enqueue: vi.fn().mockResolvedValue(undefined),
      health: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const output = path.join(tmpdir(), `phase5-api-${randomUUID()}`);
    const app = buildApp({
      repository: test.generations,
      accounts: test.accounts,
      queue,
      rateLimiter: new MemoryRateLimiter(),
      apiKeyPepper: pepper,
      storage: new LocalResultStorage(output),
      publicApiUrl: 'http://localhost:3000',
    });
    const key = randomUUID();
    const create = (rawKey: string, idempotencyKey: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/generations',
        headers: {
          authorization: `Bearer ${rawKey}`,
          'idempotency-key': idempotencyKey,
        },
        payload: generationInput,
      });
    try {
      const first = await create(identity.rawKey, key);
      expect(first.statusCode).toBe(202);
      expect(first.json()).toMatchObject({
        status: 'QUEUED',
        creditCharged: 1,
        creditsRemaining: 0,
      });
      const duplicate = await create(identity.rawKey, key);
      expect(duplicate.statusCode).toBe(202);
      expect(duplicate.json<{ id: string }>().id).toBe(
        first.json<{ id: string }>().id,
      );
      expect(queue.enqueue).toHaveBeenCalledOnce();
      expect(
        (await test.accounts.findUser(identity.user.id))!.creditBalance,
      ).toBe(0);

      const denied = await create(empty.rawKey, randomUUID());
      expect(denied.statusCode).toBe(402);
      expect(denied.json()).toMatchObject({
        error: { code: 'INSUFFICIENT_CREDIT' },
      });
      const hidden = await app.inject({
        method: 'GET',
        url: `/v1/generations/${first.json<{ id: string }>().id}`,
        headers: { authorization: `Bearer ${empty.rawKey}` },
      });
      expect(hidden.statusCode).toBe(404);
    } finally {
      await app.close();
      await rm(output, { recursive: true, force: true });
    }
  });
});
