import type { FastifyReply, FastifyRequest } from 'fastify';
import { API_KEY_PATTERN, hashApiKey } from '@sprite/core';
import type {
  AccountRepository,
  ApiKeyRow,
  ApiKeyScope,
  UserRow,
} from '@sprite/db';

export interface AuthContext {
  user: UserRow;
  apiKey: ApiKeyRow;
}

function authError(
  reply: FastifyReply,
  requestId: string,
  statusCode: 401 | 403,
  code: 'INVALID_API_KEY' | 'API_KEY_EXPIRED',
  message: string,
) {
  void reply.code(statusCode).send({ error: { code, message, requestId } });
}

export function createApiKeyAuthenticator(
  repository: AccountRepository,
  pepper: string,
) {
  return async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
    requiredScope?: ApiKeyScope,
  ): Promise<AuthContext | undefined> {
    const authorization = request.headers.authorization;
    const rawKey =
      typeof authorization === 'string' && authorization.startsWith('Bearer ')
        ? authorization.slice(7)
        : '';
    if (!API_KEY_PATTERN.test(rawKey)) {
      authError(reply, request.id, 401, 'INVALID_API_KEY', 'Invalid API key.');
      return;
    }
    const authenticated = await repository.findApiKeyByHash(
      hashApiKey(rawKey, pepper),
    );
    if (!authenticated) {
      authError(reply, request.id, 401, 'INVALID_API_KEY', 'Invalid API key.');
      return;
    }
    if (
      authenticated.apiKey.expiresAt &&
      authenticated.apiKey.expiresAt.getTime() <= Date.now()
    ) {
      authError(
        reply,
        request.id,
        401,
        'API_KEY_EXPIRED',
        'API key has expired.',
      );
      return;
    }
    if (requiredScope && !authenticated.apiKey.scopes.includes(requiredScope)) {
      authError(
        reply,
        request.id,
        403,
        'INVALID_API_KEY',
        'API key does not allow this operation.',
      );
      return;
    }
    await repository.touchApiKey(authenticated.apiKey.id);
    return authenticated;
  };
}
