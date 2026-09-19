import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { GenerationDatabase } from './client';
import {
  API_KEY_SCOPES,
  apiKeys,
  creditLedger,
  users,
  type ApiKeyScope,
} from './schema';

export const FREE_TRIAL_CREDITS = 3;
export const DEFAULT_API_KEY_LIFETIME_DAYS = 180;

export interface ProvisionUserInput {
  email: string;
  keyName?: string;
  keyPrefix: string;
  keyHash: string;
  scopes?: ApiKeyScope[];
  now?: Date;
}

export class AccountRepository {
  constructor(private readonly db: GenerationDatabase) {}

  async provisionFreeUser(input: ProvisionUserInput) {
    const now = input.now ?? new Date();
    const userId = randomUUID();
    const apiKeyId = randomUUID();
    const expiresAt = new Date(
      now.getTime() + DEFAULT_API_KEY_LIFETIME_DAYS * 24 * 60 * 60 * 1000,
    );
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(users)
        .values({
          id: userId,
          email: input.email.trim().toLowerCase(),
          plan: 'free',
          subscriptionStatus: 'none',
          creditBalance: FREE_TRIAL_CREDITS,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const user = inserted[0];
      if (!user) throw new Error('Could not create user.');
      await tx.insert(creditLedger).values({
        userId,
        delta: FREE_TRIAL_CREDITS,
        reason: 'free_trial',
        idempotencyKey: `user:${userId}:free-trial`,
        balanceAfter: FREE_TRIAL_CREDITS,
        createdAt: now,
      });
      const keys = await tx
        .insert(apiKeys)
        .values({
          id: apiKeyId,
          userId,
          name: input.keyName ?? 'Cocos Creator',
          keyPrefix: input.keyPrefix,
          keyHash: input.keyHash,
          scopes: input.scopes ?? [...API_KEY_SCOPES],
          expiresAt,
          createdAt: now,
        })
        .returning();
      if (!keys[0]) throw new Error('Could not create API key.');
      return { user, apiKey: keys[0] };
    });
  }

  async findApiKeyByHash(keyHash: string) {
    const rows = await this.db
      .select({ apiKey: apiKeys, user: users })
      .from(apiKeys)
      .innerJoin(users, eq(apiKeys.userId, users.id))
      .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
      .limit(1);
    return rows[0];
  }

  async touchApiKey(id: string, usedAt = new Date()) {
    await this.db
      .update(apiKeys)
      .set({ lastUsedAt: usedAt })
      .where(eq(apiKeys.id, id));
  }

  async findUser(id: string) {
    return (
      await this.db.select().from(users).where(eq(users.id, id)).limit(1)
    )[0];
  }

  async creditEntriesForGeneration(generationId: string) {
    return this.db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.generationId, generationId));
  }
}
