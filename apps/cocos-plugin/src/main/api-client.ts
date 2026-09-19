import { fetch, type RequestInit, type Response } from 'undici';
import { z } from 'zod';
import {
  creditsResponseSchema,
  batchResponseSchema,
  characterResponseSchema,
  generationResponseSchema,
  meResponseSchema,
  type GenerationRequest,
  type GenerationResponse,
  type CreateCharacterRequest,
  type CharacterAnimationRequest,
  type CharacterBatchRequest,
} from '@sprite/contracts';

const errorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        requestId: z.string(),
      })
      .strict(),
  })
  .strict();

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export class ApiClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export interface GenerationApi {
  createGeneration(
    input: GenerationRequest,
    idempotencyKey: string,
  ): Promise<GenerationResponse>;
  getGeneration(id: string): Promise<GenerationResponse>;
  getCredits?(): Promise<{ balance: number }>;
  downloadPackage(url: string): Promise<Buffer>;
}

export class ApiClient implements GenerationApi {
  private readonly base: URL;

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
    private readonly fetcher: FetchLike = fetch,
  ) {
    this.base = new URL(baseUrl);
    if (!['http:', 'https:'].includes(this.base.protocol))
      throw new Error('Backend URL must use HTTP or HTTPS.');
  }

  async createGeneration(input: GenerationRequest, idempotencyKey: string) {
    const response = await this.request('/v1/generations', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify(input),
    });
    if (response.status !== 202) await this.throwApiError(response);
    return generationResponseSchema.parse(await response.json());
  }

  async getGeneration(id: string) {
    const response = await this.request(
      `/v1/generations/${encodeURIComponent(id)}`,
    );
    if (response.status !== 200) await this.throwApiError(response);
    return generationResponseSchema.parse(await response.json());
  }

  async createCharacter(input: CreateCharacterRequest, idempotencyKey: string) {
    const response = await this.request('/v1/characters', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify(input),
    });
    if (response.status !== 202) await this.throwApiError(response);
    return characterResponseSchema.parse(await response.json());
  }

  async listCharacters() {
    const response = await this.request('/v1/characters');
    if (response.status !== 200) await this.throwApiError(response);
    return characterResponseSchema.array().parse(await response.json());
  }

  async getCharacter(id: string) {
    const response = await this.request(
      `/v1/characters/${encodeURIComponent(id)}`,
    );
    if (response.status !== 200) await this.throwApiError(response);
    return characterResponseSchema.parse(await response.json());
  }

  async createCharacterAnimation(
    characterId: string,
    input: CharacterAnimationRequest,
    idempotencyKey: string,
  ) {
    const response = await this.request(
      `/v1/characters/${encodeURIComponent(characterId)}/animations`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(input),
      },
    );
    if (response.status !== 202) await this.throwApiError(response);
    return generationResponseSchema.parse(await response.json());
  }

  async createCharacterBatch(
    characterId: string,
    input: CharacterBatchRequest,
    idempotencyKey: string,
  ) {
    const response = await this.request(
      `/v1/characters/${encodeURIComponent(characterId)}/batches`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(input),
      },
    );
    if (response.status !== 202) await this.throwApiError(response);
    return batchResponseSchema.parse(await response.json());
  }

  async getMe() {
    const response = await this.request('/v1/me');
    if (response.status !== 200) await this.throwApiError(response);
    return meResponseSchema.parse(await response.json());
  }

  async getCredits() {
    const response = await this.request('/v1/me/credits');
    if (response.status !== 200) await this.throwApiError(response);
    return creditsResponseSchema.parse(await response.json());
  }

  async downloadPackage(url: string) {
    const target = new URL(url);
    if (target.origin !== this.base.origin)
      throw new ApiClientError(
        'UNSAFE_RESULT_URL',
        'Backend returned a result URL on another origin.',
      );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await this.fetcher(target, {
        headers: { authorization: `Bearer ${this.apiKey}` },
        signal: controller.signal,
        redirect: 'error',
      });
      const body = response.body;
      if (response.status !== 200) await this.throwApiError(response);
      if (!body)
        throw new ApiClientError(
          'INVALID_RESPONSE',
          'Backend returned an empty result package.',
        );
      const maximum = 32 * 1024 * 1024;
      const declaredSize = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredSize) && declaredSize > maximum) {
        await body.cancel();
        throw new ApiClientError(
          'PACKAGE_TOO_LARGE',
          'Result package exceeds 32 MiB.',
        );
      }
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > maximum)
            throw new ApiClientError(
              'PACKAGE_TOO_LARGE',
              'Result package exceeds 32 MiB.',
            );
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      return Buffer.concat(chunks);
    } catch (error) {
      if (error instanceof ApiClientError) throw error;
      throw new ApiClientError(
        'NETWORK_ERROR',
        'Unable to download the result package.',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async request(
    pathOrUrl: string | URL,
    init: RequestInit = {},
    timeoutMs = 15_000,
  ) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetcher(
        pathOrUrl instanceof URL ? pathOrUrl : new URL(pathOrUrl, this.base),
        {
          ...init,
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            ...(init.headers as Record<string, string> | undefined),
          },
          signal: controller.signal,
          redirect: 'error',
        },
      );
    } catch (error) {
      if (error instanceof ApiClientError) throw error;
      throw new ApiClientError(
        'NETWORK_ERROR',
        'Unable to connect to the backend.',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async throwApiError(response: Response): Promise<never> {
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new ApiClientError(
        'INVALID_RESPONSE',
        `Backend returned HTTP ${response.status}.`,
      );
    }
    const parsed = errorResponseSchema.safeParse(raw);
    if (!parsed.success)
      throw new ApiClientError(
        'INVALID_RESPONSE',
        `Backend returned HTTP ${response.status}.`,
      );
    throw new ApiClientError(
      parsed.data.error.code,
      parsed.data.error.message,
      parsed.data.error.requestId,
    );
  }
}
