import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type {
  ApiErrorCode,
  GenerationRequest,
  GenerationStatus,
} from '@sprite/contracts';
import {
  assertGenerationTransition,
  GENERATION_PROGRESS,
  isTerminalStatus,
} from '@sprite/core';
import type { GenerationDatabase } from './client';
import { creditLedger, generations, users, type GenerationRow } from './schema';

const ACTIVE_STATUSES: GenerationStatus[] = [
  'QUEUED',
  'AI_SUBMITTED',
  'AI_RUNNING',
  'PROCESSING',
  'UPLOADING',
];

export class GenerationAdmissionError extends Error {
  constructor(
    public readonly code:
      | 'INSUFFICIENT_CREDIT'
      | 'CONCURRENCY_LIMIT'
      | 'FREE_COOLDOWN',
    message: string,
  ) {
    super(message);
    this.name = 'GenerationAdmissionError';
  }
}

export interface ReserveGenerationRecord {
  id: string;
  userId: string;
  apiKeyId: string;
  idempotencyKey: string;
  promptHash: string;
  parameters: GenerationRequest;
  characterId?: string;
  batchId?: string;
  generationKind?: 'animation' | 'character';
  animationMode?: 'standard' | 'precise';
  batchAdmission?: boolean;
  now?: Date;
}

export interface GenerationUpdate {
  provider?: string;
  providerModel?: string;
  providerRequestId?: string;
  providerCostUsd?: string;
  seed?: number;
  attempt?: number;
  rawObjectKey?: string;
  sheetObjectKey?: string;
  packageObjectKey?: string;
  manifestObjectKey?: string;
  errorCode?: ApiErrorCode;
  errorMessage?: string;
  qaStatus?: 'PENDING' | 'PASS' | 'WARN' | 'FAIL';
  qaWarnings?: string[];
}

export class GenerationRepository {
  constructor(private readonly db: GenerationDatabase) {}

  async reserve(input: ReserveGenerationRecord) {
    const now = input.now ?? new Date();
    return this.db.transaction(async (tx) => {
      const user = (
        await tx
          .select()
          .from(users)
          .where(eq(users.id, input.userId))
          .for('update')
          .limit(1)
      )[0];
      if (!user) throw new Error('Generation user does not exist.');

      const existing = (
        await tx
          .select()
          .from(generations)
          .where(
            and(
              eq(generations.userId, input.userId),
              eq(generations.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1)
      )[0];
      if (existing)
        return {
          record: existing,
          created: false,
          creditsRemaining: user.creditBalance,
        };

      const activeCounts = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(generations)
        .where(
          and(
            eq(generations.userId, input.userId),
            inArray(generations.status, ACTIVE_STATUSES),
          ),
        );
      const concurrencyLimit = user.plan === 'free' ? 1 : 2;
      if (
        !input.batchAdmission &&
        (activeCounts[0]?.count ?? 0) >= concurrencyLimit
      )
        throw new GenerationAdmissionError(
          'CONCURRENCY_LIMIT',
          `This plan allows ${concurrencyLimit} concurrent generation${concurrencyLimit === 1 ? '' : 's'}.`,
        );

      if (user.plan === 'free' && !input.batchAdmission) {
        const latest = (
          await tx
            .select({ createdAt: generations.createdAt })
            .from(generations)
            .where(eq(generations.userId, input.userId))
            .orderBy(desc(generations.createdAt))
            .limit(1)
        )[0];
        if (latest && now.getTime() - latest.createdAt.getTime() < 30_000)
          throw new GenerationAdmissionError(
            'FREE_COOLDOWN',
            'Free generations have a 30 second cooldown.',
          );
      }

      const inserted = await tx
        .insert(generations)
        .values({
          id: input.id,
          userId: input.userId,
          apiKeyId: input.apiKeyId,
          idempotencyKey: input.idempotencyKey,
          prompt: input.parameters.prompt,
          promptHash: input.promptHash,
          parameters: input.parameters,
          characterId: input.characterId,
          batchId: input.batchId,
          generationKind: input.generationKind ?? 'animation',
          animationMode: input.animationMode ?? 'standard',
          status: 'QUEUED',
          progress: GENERATION_PROGRESS.QUEUED,
          creditCost: 1,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const record = inserted[0];
      if (!record) throw new Error('Could not create generation.');

      const debited = await tx
        .update(users)
        .set({
          creditBalance: sql`${users.creditBalance} - 1`,
          updatedAt: now,
        })
        .where(and(eq(users.id, input.userId), gte(users.creditBalance, 1)))
        .returning({ creditBalance: users.creditBalance });
      const balance = debited[0]?.creditBalance;
      if (balance === undefined)
        throw new GenerationAdmissionError(
          'INSUFFICIENT_CREDIT',
          'Not enough credits.',
        );

      await tx.insert(creditLedger).values({
        userId: input.userId,
        generationId: input.id,
        delta: -1,
        reason: 'generation',
        idempotencyKey: `generation:${input.id}:charge`,
        balanceAfter: balance,
        createdAt: now,
      });
      return { record, created: true, creditsRemaining: balance };
    });
  }

  async findById(id: string) {
    return (
      await this.db
        .select()
        .from(generations)
        .where(eq(generations.id, id))
        .limit(1)
    )[0];
  }

  async findForUser(id: string, userId: string) {
    return (
      await this.db
        .select()
        .from(generations)
        .where(and(eq(generations.id, id), eq(generations.userId, userId)))
        .limit(1)
    )[0];
  }

  async findByUserIdempotencyKey(userId: string, idempotencyKey: string) {
    return (
      await this.db
        .select()
        .from(generations)
        .where(
          and(
            eq(generations.userId, userId),
            eq(generations.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1)
    )[0];
  }

  async transition(
    id: string,
    next: GenerationStatus,
    patch: GenerationUpdate = {},
  ) {
    const current = await this.findById(id);
    if (!current) throw new Error(`Generation ${id} does not exist.`);
    assertGenerationTransition(current.status, next);
    const now = new Date();
    const values = {
      ...patch,
      status: next,
      progress: GENERATION_PROGRESS[next],
      updatedAt: now,
      ...(next === 'AI_SUBMITTED' && !current.startedAt
        ? { startedAt: now }
        : {}),
      ...(isTerminalStatus(next) ? { completedAt: now } : {}),
    };
    const updated = await this.db
      .update(generations)
      .set(values)
      .where(
        and(eq(generations.id, id), eq(generations.status, current.status)),
      )
      .returning();
    if (!updated[0])
      throw new Error(`Concurrent generation transition for ${id}.`);
    return updated[0];
  }

  async updateQa(
    id: string,
    qaStatus: 'PASS' | 'WARN' | 'FAIL',
    qaWarnings: string[],
  ) {
    await this.db
      .update(generations)
      .set({ qaStatus, qaWarnings, updatedAt: new Date() })
      .where(eq(generations.id, id));
  }

  async failAndRefund(
    id: string,
    patch: Pick<GenerationUpdate, 'errorCode' | 'errorMessage'>,
  ) {
    return this.db.transaction(async (tx) => {
      const current = (
        await tx
          .select()
          .from(generations)
          .where(eq(generations.id, id))
          .for('update')
          .limit(1)
      )[0];
      if (!current) throw new Error(`Generation ${id} does not exist.`);
      if (current.status === 'SUCCEEDED' || current.status === 'CANCELED')
        return { refunded: false, record: current };

      let record = current;
      if (current.status !== 'FAILED') {
        assertGenerationTransition(current.status, 'FAILED');
        const failed = await tx
          .update(generations)
          .set({
            ...patch,
            status: 'FAILED',
            progress: GENERATION_PROGRESS.FAILED,
            updatedAt: new Date(),
            completedAt: new Date(),
          })
          .where(eq(generations.id, id))
          .returning();
        record = failed[0]!;
      }

      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, current.userId))
        .for('update');
      const refundKey = `generation:${id}:refund`;
      const existingRefund = (
        await tx
          .select({ id: creditLedger.id })
          .from(creditLedger)
          .where(eq(creditLedger.idempotencyKey, refundKey))
          .limit(1)
      )[0];
      if (existingRefund) return { refunded: false, record };

      const balances = await tx
        .update(users)
        .set({
          creditBalance: sql`${users.creditBalance} + ${current.creditCost}`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, current.userId))
        .returning({ creditBalance: users.creditBalance });
      const balance = balances[0]?.creditBalance;
      if (balance === undefined) throw new Error('Refund user does not exist.');
      await tx.insert(creditLedger).values({
        userId: current.userId,
        generationId: id,
        delta: current.creditCost,
        reason: 'refund',
        idempotencyKey: refundKey,
        balanceAfter: balance,
      });
      return { refunded: true, record };
    });
  }

  async health() {
    await this.db.execute(sql`select 1`);
  }
}

export type { GenerationRow };
