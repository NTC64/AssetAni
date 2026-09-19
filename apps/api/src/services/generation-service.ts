import { createHash, randomUUID } from 'node:crypto';
import type { GenerationRequest } from '@sprite/contracts';
import type {
  AccountRepository,
  GenerationRepository,
  GenerationRow,
} from '@sprite/db';
import type { GenerationQueue } from '@sprite/queue';

export class GenerationService {
  constructor(
    private readonly repository: GenerationRepository,
    private readonly accounts: AccountRepository,
    private readonly queue: GenerationQueue,
  ) {}

  findIdempotent(userId: string, idempotencyKey: string) {
    return this.repository.findByUserIdempotencyKey(userId, idempotencyKey);
  }

  async create(
    parameters: GenerationRequest,
    idempotencyKey: string,
    identity: { userId: string; apiKeyId: string },
    metadata: {
      id?: string;
      characterId?: string;
      batchId?: string;
      generationKind?: 'animation' | 'character';
      animationMode?: 'standard' | 'precise';
      batchAdmission?: boolean;
    } = {},
  ) {
    const id = metadata.id ?? randomUUID();
    const promptHash = createHash('sha256')
      .update(parameters.prompt.normalize('NFC'))
      .digest('hex');
    const created = await this.repository.reserve({
      id,
      userId: identity.userId,
      apiKeyId: identity.apiKeyId,
      idempotencyKey,
      promptHash,
      parameters,
      characterId: metadata.characterId,
      batchId: metadata.batchId,
      generationKind: metadata.generationKind,
      animationMode: metadata.animationMode,
      batchAdmission: metadata.batchAdmission,
    });
    if (!created.created) return created;
    try {
      await this.queue.enqueue(created.record.id);
      return created;
    } catch {
      await this.repository.failAndRefund(created.record.id, {
        errorCode: 'INTERNAL_ERROR',
        errorMessage: 'Could not enqueue generation.',
      });
      throw new Error('Could not enqueue generation.');
    }
  }

  find(id: string, userId: string) {
    return this.repository.findForUser(id, userId);
  }

  async credits(userId: string) {
    const user = await this.accounts.findUser(userId);
    if (!user) throw new Error('Authenticated user no longer exists.');
    return user.creditBalance;
  }
}

export const RESULT_TTL_SECONDS = 900;

export function resultExpiresIn(record: GenerationRow) {
  if (!record.completedAt) return RESULT_TTL_SECONDS;
  const elapsed = Math.floor(
    (Date.now() - record.completedAt.getTime()) / 1000,
  );
  return Math.max(0, RESULT_TTL_SECONDS - elapsed);
}

export function toGenerationResponse(
  record: GenerationRow,
  publicApiUrl: string,
  commerce?: { creditsRemaining: number },
) {
  const base = {
    id: record.id,
    status: record.status,
    progress: record.progress,
    ...(commerce
      ? {
          creditCharged: 1 as const,
          creditsRemaining: commerce.creditsRemaining,
        }
      : {}),
  };
  if (record.status === 'SUCCEEDED') {
    return {
      ...base,
      result: {
        packageUrl: `${publicApiUrl}/v1/generations/${record.id}/files/result.zip`,
        sheetUrl: `${publicApiUrl}/v1/generations/${record.id}/files/sheet.png`,
        manifestUrl: `${publicApiUrl}/v1/generations/${record.id}/files/manifest.json`,
        expiresIn: resultExpiresIn(record),
      },
    };
  }
  if (record.status === 'FAILED')
    return {
      ...base,
      errorCode: record.errorCode ?? 'INTERNAL_ERROR',
      errorMessage: record.errorMessage ?? 'Generation failed.',
    };
  return { ...base, pollAfterMs: 2000 };
}
