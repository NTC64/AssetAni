import { Job, Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { z } from 'zod';

export const GENERATION_QUEUE_NAME = 'sprite-generation';
export const generationJobSchema = z
  .object({ generationId: z.string().uuid() })
  .strict();
export type GenerationJob = z.infer<typeof generationJobSchema>;

export interface GenerationQueue {
  enqueue(generationId: string): Promise<void>;
  health(): Promise<void>;
  close(): Promise<void>;
}

function createConnection(redisUrl: string) {
  return new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

export interface RateLimitPolicy {
  capacity: number;
  refillPerMinute: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  consume(key: string, policy: RateLimitPolicy): Promise<RateLimitResult>;
  close(): Promise<void>;
}

const TOKEN_BUCKET_SCRIPT = `
local values = redis.call('HMGET', KEYS[1], 'tokens', 'updated')
local capacity = tonumber(ARGV[1])
local refillPerMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local tokens = tonumber(values[1]) or capacity
local updated = tonumber(values[2]) or now
tokens = math.min(capacity, tokens + math.max(0, now - updated) * refillPerMs)
local allowed = 0
local retryMs = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retryMs = math.ceil((1 - tokens) / refillPerMs)
end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'updated', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / refillPerMs) + 60000)
return {allowed, retryMs}
`;

export class RedisRateLimiter implements RateLimiter {
  private readonly connection: IORedis;

  constructor(redisUrl: string) {
    this.connection = createConnection(redisUrl);
  }

  async consume(key: string, policy: RateLimitPolicy) {
    const result = (await this.connection.eval(
      TOKEN_BUCKET_SCRIPT,
      1,
      `sprite:rate:${key}`,
      policy.capacity,
      policy.refillPerMinute / 60_000,
      Date.now(),
    )) as [number, number];
    return {
      allowed: result[0] === 1,
      retryAfterSeconds: Math.max(1, Math.ceil(result[1] / 1000)),
    };
  }

  async close() {
    await this.connection.quit();
  }
}

export class MemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<
    string,
    { tokens: number; updated: number }
  >();

  constructor(private readonly now: () => number = Date.now) {}

  async consume(key: string, policy: RateLimitPolicy) {
    const now = this.now();
    const refillPerMs = policy.refillPerMinute / 60_000;
    const current = this.buckets.get(key) ?? {
      tokens: policy.capacity,
      updated: now,
    };
    const tokens = Math.min(
      policy.capacity,
      current.tokens + Math.max(0, now - current.updated) * refillPerMs,
    );
    if (tokens >= 1) {
      this.buckets.set(key, { tokens: tokens - 1, updated: now });
      return { allowed: true, retryAfterSeconds: 1 };
    }
    this.buckets.set(key, { tokens, updated: now });
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((1 - tokens) / refillPerMs / 1000),
      ),
    };
  }

  async close() {}
}

export class BullGenerationQueue implements GenerationQueue {
  private readonly connection: IORedis;
  private readonly queue: Queue<GenerationJob>;

  constructor(redisUrl: string, options: { queueName?: string } = {}) {
    this.connection = createConnection(redisUrl);
    this.queue = new Queue(options.queueName ?? GENERATION_QUEUE_NAME, {
      connection: this.connection,
    });
  }

  async enqueue(generationId: string) {
    const data = generationJobSchema.parse({ generationId });
    await this.queue.add('generate', data, {
      jobId: generationId,
      attempts: 1,
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 24 * 3600, count: 1000 },
    });
  }

  async health() {
    await this.connection.ping();
  }

  async close() {
    await this.queue.close();
    await this.connection.quit();
  }
}

export function startGenerationWorker(
  redisUrl: string,
  processor: (generationId: string) => Promise<void>,
  options: { concurrency?: number; queueName?: string } = {},
) {
  const connection = createConnection(redisUrl);
  const worker = new Worker<GenerationJob>(
    options.queueName ?? GENERATION_QUEUE_NAME,
    async (job: Job<GenerationJob>) => {
      const { generationId } = generationJobSchema.parse(job.data);
      await processor(generationId);
    },
    { connection, concurrency: options.concurrency ?? 2 },
  );
  return {
    worker,
    async close() {
      await worker.close();
      await connection.quit();
    },
  };
}
