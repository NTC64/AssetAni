import { randomUUID } from 'node:crypto';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { z } from 'zod';
import {
  creditsResponseSchema,
  batchResponseSchema,
  characterAnimationRequestSchema,
  characterBatchRequestSchema,
  characterResponseSchema,
  createCharacterRequestSchema,
  generationRequestSchema,
  generationResponseSchema,
  meResponseSchema,
} from '@sprite/contracts';
import { LocalResultStorage } from '@sprite/core';
import {
  GenerationAdmissionError,
  type AccountRepository,
  type CharacterRepository,
  type GenerationRepository,
} from '@sprite/db';
import type {
  GenerationQueue,
  RateLimitPolicy,
  RateLimiter,
} from '@sprite/queue';
import { createApiKeyAuthenticator } from './middleware/api-key';
import {
  GenerationService,
  resultExpiresIn,
  toGenerationResponse,
} from './services/generation-service';
import {
  CharacterService,
  toBatchResponse,
  toCharacterResponse,
} from './services/character-service';

const idempotencyKeySchema = z.string().uuid();
const generationIdSchema = z.string().uuid();
const GENERATE_LIMIT = { capacity: 2, refillPerMinute: 10 } as const;
const POLL_LIMIT = { capacity: 60, refillPerMinute: 60 } as const;

export interface AppDependencies {
  repository: GenerationRepository;
  accounts: AccountRepository;
  characters?: CharacterRepository;
  queue: GenerationQueue;
  rateLimiter: RateLimiter;
  apiKeyPepper: string;
  storage: LocalResultStorage;
  publicApiUrl: string;
  logger?: boolean | FastifyBaseLogger;
}

function errorBody(code: string, message: string, requestId: string) {
  return { error: { code, message, requestId } };
}

async function enforceRateLimit(
  limiter: RateLimiter,
  key: string,
  policy: RateLimitPolicy,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const result = await limiter.consume(key, policy);
  if (result.allowed) return true;
  void reply
    .header('retry-after', result.retryAfterSeconds)
    .code(429)
    .send(
      errorBody(
        'RATE_LIMITED',
        'Too many requests. Please retry later.',
        request.id,
      ),
    );
  return false;
}

export function buildApp(dependencies: AppDependencies) {
  const app = Fastify({
    logger: dependencies.logger ?? false,
    bodyLimit: 16 * 1024,
    genReqId: () => `req_${randomUUID()}`,
  });
  const service = new GenerationService(
    dependencies.repository,
    dependencies.accounts,
    dependencies.queue,
  );
  const authenticate = createApiKeyAuthenticator(
    dependencies.accounts,
    dependencies.apiKeyPepper,
  );
  const characterService = dependencies.characters
    ? new CharacterService(dependencies.characters, service)
    : undefined;

  app.setErrorHandler((error, request, reply) => {
    const statusCode =
      error &&
      typeof error === 'object' &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : undefined;
    const invalidRequest = statusCode === 400 || statusCode === 413;
    if (!invalidRequest) request.log.error({ err: error }, 'request failed');
    return reply
      .code(invalidRequest ? 400 : 500)
      .send(
        errorBody(
          invalidRequest ? 'INVALID_PROMPT' : 'INTERNAL_ERROR',
          invalidRequest
            ? 'Request body is invalid.'
            : 'Internal server error.',
          request.id,
        ),
      );
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/ready', async (_request, reply) => {
    try {
      await Promise.all([
        dependencies.repository.health(),
        dependencies.queue.health(),
      ]);
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'not_ready' });
    }
  });

  app.get('/v1/me', async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (!auth) return reply;
    return meResponseSchema.parse({
      id: auth.user.id,
      email: auth.user.email,
      plan: auth.user.plan,
      subscriptionStatus: auth.user.subscriptionStatus,
      apiKey: {
        id: auth.apiKey.id,
        name: auth.apiKey.name,
        prefix: auth.apiKey.keyPrefix,
        scopes: auth.apiKey.scopes,
        expiresAt: auth.apiKey.expiresAt?.toISOString() ?? null,
      },
    });
  });

  app.get('/v1/me/credits', async (request, reply) => {
    const auth = await authenticate(request, reply, 'credit:read');
    if (!auth) return reply;
    if (
      !(await enforceRateLimit(
        dependencies.rateLimiter,
        `${auth.apiKey.id}:poll`,
        POLL_LIMIT,
        request,
        reply,
      ))
    )
      return reply;
    return creditsResponseSchema.parse({
      balance: await service.credits(auth.user.id),
    });
  });

  app.post('/v1/generations', async (request, reply) => {
    const auth = await authenticate(request, reply, 'generation:create');
    if (!auth) return reply;
    const body = generationRequestSchema.safeParse(request.body);
    const idempotencyKey = idempotencyKeySchema.safeParse(
      request.headers['idempotency-key'],
    );
    if (!body.success || !idempotencyKey.success)
      return reply
        .code(400)
        .send(
          errorBody(
            'INVALID_PROMPT',
            'Request body or Idempotency-Key is invalid.',
            request.id,
          ),
        );
    const existing = await service.findIdempotent(
      auth.user.id,
      idempotencyKey.data,
    );
    if (existing) {
      const creditsRemaining = await service.credits(auth.user.id);
      return reply.code(202).send(
        generationResponseSchema.parse(
          toGenerationResponse(existing, dependencies.publicApiUrl, {
            creditsRemaining,
          }),
        ),
      );
    }
    if (
      !(await enforceRateLimit(
        dependencies.rateLimiter,
        `${auth.apiKey.id}:generate`,
        GENERATE_LIMIT,
        request,
        reply,
      ))
    )
      return reply;
    try {
      const created = await service.create(body.data, idempotencyKey.data, {
        userId: auth.user.id,
        apiKeyId: auth.apiKey.id,
      });
      return reply.code(202).send(
        generationResponseSchema.parse(
          toGenerationResponse(created.record, dependencies.publicApiUrl, {
            creditsRemaining: created.creditsRemaining,
          }),
        ),
      );
    } catch (error) {
      if (error instanceof GenerationAdmissionError) {
        if (error.code === 'INSUFFICIENT_CREDIT')
          return reply
            .code(402)
            .send(
              errorBody(
                'INSUFFICIENT_CREDIT',
                'Not enough credits.',
                request.id,
              ),
            );
        return reply
          .header('retry-after', error.code === 'FREE_COOLDOWN' ? 30 : 2)
          .code(429)
          .send(errorBody('RATE_LIMITED', error.message, request.id));
      }
      request.log.error({ err: error }, 'generation enqueue failed');
      return reply
        .code(500)
        .send(
          errorBody(
            'INTERNAL_ERROR',
            'Could not create generation.',
            request.id,
          ),
        );
    }
  });

  app.get<{ Params: { id: string } }>(
    '/v1/generations/:id',
    async (request, reply) => {
      const auth = await authenticate(request, reply, 'generation:read');
      if (!auth) return reply;
      if (
        !(await enforceRateLimit(
          dependencies.rateLimiter,
          `${auth.apiKey.id}:poll`,
          POLL_LIMIT,
          request,
          reply,
        ))
      )
        return reply;
      const id = generationIdSchema.safeParse(request.params.id);
      const record = id.success
        ? await service.find(id.data, auth.user.id)
        : undefined;
      if (!record)
        return reply
          .code(404)
          .send(
            errorBody(
              'GENERATION_NOT_FOUND',
              'Generation was not found.',
              request.id,
            ),
          );
      return generationResponseSchema.parse(
        toGenerationResponse(record, dependencies.publicApiUrl),
      );
    },
  );

  app.get<{ Params: { id: string; filename: string } }>(
    '/v1/generations/:id/files/:filename',
    async (request, reply) => {
      const auth = await authenticate(request, reply, 'generation:read');
      if (!auth) return reply;
      if (
        !(await enforceRateLimit(
          dependencies.rateLimiter,
          `${auth.apiKey.id}:poll`,
          POLL_LIMIT,
          request,
          reply,
        ))
      )
        return reply;
      const id = generationIdSchema.safeParse(request.params.id);
      const record = id.success
        ? await service.find(id.data, auth.user.id)
        : undefined;
      if (
        !record ||
        record.status !== 'SUCCEEDED' ||
        resultExpiresIn(record) === 0
      )
        return reply
          .code(404)
          .send(
            errorBody(
              'GENERATION_NOT_FOUND',
              'Generation result was not found.',
              request.id,
            ),
          );
      const file = await dependencies.storage.readPublicFile(
        record.id,
        request.params.filename,
      );
      if (!file)
        return reply
          .code(404)
          .send(
            errorBody(
              'GENERATION_NOT_FOUND',
              'Generation result was not found.',
              request.id,
            ),
          );
      return reply.type(file.contentType).send(file.body);
    },
  );

  if (characterService && dependencies.characters) {
    app.post('/v1/characters', async (request, reply) => {
      const auth = await authenticate(request, reply, 'generation:create');
      if (!auth) return reply;
      const body = createCharacterRequestSchema.safeParse(request.body);
      const key = idempotencyKeySchema.safeParse(
        request.headers['idempotency-key'],
      );
      if (!body.success || !key.success)
        return reply
          .code(400)
          .send(
            errorBody(
              'INVALID_PROMPT',
              'Request body or Idempotency-Key is invalid.',
              request.id,
            ),
          );
      if (
        !(await enforceRateLimit(
          dependencies.rateLimiter,
          `${auth.apiKey.id}:generate`,
          GENERATE_LIMIT,
          request,
          reply,
        ))
      )
        return reply;
      try {
        const character = await characterService.create(body.data, key.data, {
          userId: auth.user.id,
          apiKeyId: auth.apiKey.id,
        });
        if (!character)
          throw new Error('Character idempotency record is incomplete.');
        return reply
          .code(202)
          .send(
            characterResponseSchema.parse(
              toCharacterResponse(
                character,
                await dependencies.characters!.animations(character.id),
              ),
            ),
          );
      } catch (error) {
        if (error instanceof GenerationAdmissionError)
          return reply
            .code(error.code === 'INSUFFICIENT_CREDIT' ? 402 : 429)
            .send(errorBody(error.code, error.message, request.id));
        throw error;
      }
    });

    app.get('/v1/characters', async (request, reply) => {
      const auth = await authenticate(request, reply, 'generation:read');
      if (!auth) return reply;
      const rows = await characterService.list(auth.user.id);
      return Promise.all(
        rows.map(async (character) =>
          characterResponseSchema.parse(
            toCharacterResponse(
              character,
              await dependencies.characters!.animations(character.id),
            ),
          ),
        ),
      );
    });

    app.get<{ Params: { id: string } }>(
      '/v1/characters/:id',
      async (request, reply) => {
        const auth = await authenticate(request, reply, 'generation:read');
        if (!auth) return reply;
        const id = generationIdSchema.safeParse(request.params.id);
        const found = id.success
          ? await characterService.find(id.data, auth.user.id)
          : undefined;
        if (!found)
          return reply
            .code(404)
            .send(
              errorBody(
                'GENERATION_NOT_FOUND',
                'Character was not found.',
                request.id,
              ),
            );
        return characterResponseSchema.parse(
          toCharacterResponse(found.character, found.animations),
        );
      },
    );

    app.post<{ Params: { id: string } }>(
      '/v1/characters/:id/animations',
      async (request, reply) => {
        const auth = await authenticate(request, reply, 'generation:create');
        if (!auth) return reply;
        const id = generationIdSchema.safeParse(request.params.id);
        const body = characterAnimationRequestSchema.safeParse(request.body);
        const key = idempotencyKeySchema.safeParse(
          request.headers['idempotency-key'],
        );
        const character = id.success
          ? await dependencies.characters!.find(id.data, auth.user.id)
          : undefined;
        if (!character)
          return reply
            .code(404)
            .send(
              errorBody(
                'GENERATION_NOT_FOUND',
                'Character was not found.',
                request.id,
              ),
            );
        if (!body.success || !key.success)
          return reply
            .code(400)
            .send(
              errorBody(
                'INVALID_PROMPT',
                'Request body or Idempotency-Key is invalid.',
                request.id,
              ),
            );
        if (
          !(await enforceRateLimit(
            dependencies.rateLimiter,
            `${auth.apiKey.id}:generate`,
            GENERATE_LIMIT,
            request,
            reply,
          ))
        )
          return reply;
        try {
          const created = await characterService.animate(
            character,
            body.data,
            key.data,
            {
              userId: auth.user.id,
              apiKeyId: auth.apiKey.id,
            },
          );
          return reply.code(202).send(
            generationResponseSchema.parse(
              toGenerationResponse(created.record, dependencies.publicApiUrl, {
                creditsRemaining: created.creditsRemaining,
              }),
            ),
          );
        } catch (error) {
          if (error instanceof GenerationAdmissionError)
            return reply
              .code(error.code === 'INSUFFICIENT_CREDIT' ? 402 : 429)
              .send(errorBody(error.code, error.message, request.id));
          if (error instanceof Error && error.message === 'CHARACTER_NOT_READY')
            return reply
              .code(409)
              .send(
                errorBody(
                  'PROCESSING_FAILED',
                  'Character base is not ready.',
                  request.id,
                ),
              );
          throw error;
        }
      },
    );

    app.post<{ Params: { id: string } }>(
      '/v1/characters/:id/batches',
      async (request, reply) => {
        const auth = await authenticate(request, reply, 'generation:create');
        if (!auth) return reply;
        const id = generationIdSchema.safeParse(request.params.id);
        const body = characterBatchRequestSchema.safeParse(request.body);
        const key = idempotencyKeySchema.safeParse(
          request.headers['idempotency-key'],
        );
        const character = id.success
          ? await dependencies.characters!.find(id.data, auth.user.id)
          : undefined;
        if (!character)
          return reply
            .code(404)
            .send(
              errorBody(
                'GENERATION_NOT_FOUND',
                'Character was not found.',
                request.id,
              ),
            );
        if (!body.success || !key.success)
          return reply
            .code(400)
            .send(
              errorBody(
                'INVALID_PROMPT',
                'Request body or Idempotency-Key is invalid.',
                request.id,
              ),
            );
        if (
          !(await enforceRateLimit(
            dependencies.rateLimiter,
            `${auth.apiKey.id}:generate`,
            GENERATE_LIMIT,
            request,
            reply,
          ))
        )
          return reply;
        try {
          const created = await characterService.batch(
            character,
            body.data,
            key.data,
            {
              userId: auth.user.id,
              apiKeyId: auth.apiKey.id,
            },
          );
          return reply
            .code(202)
            .send(
              batchResponseSchema.parse(
                toBatchResponse(created.batch, created.children),
              ),
            );
        } catch (error) {
          if (error instanceof GenerationAdmissionError)
            return reply
              .code(error.code === 'INSUFFICIENT_CREDIT' ? 402 : 429)
              .send(errorBody(error.code, error.message, request.id));
          throw error;
        }
      },
    );
  }

  return app;
}
