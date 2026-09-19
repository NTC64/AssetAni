import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type {
  AnimationType,
  GamePresetName,
  GenerationStatus,
  SpriteDirection,
} from '@sprite/contracts';
import type { GenerationDatabase } from './client';
import {
  characterAnimations,
  characters,
  generationBatches,
  generations,
} from './schema';

export class CharacterRepository {
  constructor(private readonly db: GenerationDatabase) {}

  async create(input: {
    id?: string;
    userId: string;
    generationId: string;
    name: string;
    prompt: string;
    style: string;
    preset: GamePresetName;
    frameSize: 128 | 256;
  }) {
    const rows = await this.db
      .insert(characters)
      .values({ id: input.id ?? randomUUID(), ...input })
      .returning();
    return rows[0]!;
  }

  list(userId: string) {
    return this.db
      .select()
      .from(characters)
      .where(eq(characters.userId, userId))
      .orderBy(asc(characters.createdAt));
  }

  async find(id: string, userId: string) {
    return (
      await this.db
        .select()
        .from(characters)
        .where(and(eq(characters.id, id), eq(characters.userId, userId)))
        .limit(1)
    )[0];
  }

  findById(id: string) {
    return this.db
      .select()
      .from(characters)
      .where(eq(characters.id, id))
      .limit(1)
      .then((rows) => rows[0]);
  }

  findByGenerationId(generationId: string) {
    return this.db
      .select()
      .from(characters)
      .where(eq(characters.generationId, generationId))
      .limit(1)
      .then((rows) => rows[0]);
  }

  animations(characterId: string) {
    return this.db
      .select()
      .from(characterAnimations)
      .where(eq(characterAnimations.characterId, characterId))
      .orderBy(asc(characterAnimations.createdAt));
  }

  async markReady(
    id: string,
    input: {
      provider: string;
      baseAssetKey: string;
      providerCharacterId?: string;
    },
  ) {
    await this.db
      .update(characters)
      .set({ ...input, status: 'READY', updatedAt: new Date() })
      .where(eq(characters.id, id));
  }

  async markFailed(id: string) {
    await this.db
      .update(characters)
      .set({ status: 'FAILED', updatedAt: new Date() })
      .where(eq(characters.id, id));
  }

  async createAnimation(input: {
    characterId: string;
    generationId: string;
    animation: AnimationType;
    direction: SpriteDirection;
    fps: number;
    frameCount: number;
  }) {
    const rows = await this.db
      .insert(characterAnimations)
      .values({ id: randomUUID(), ...input })
      .returning();
    return rows[0]!;
  }

  async updateAnimation(
    generationId: string,
    input: {
      status: GenerationStatus;
      qaStatus?: 'PENDING' | 'PASS' | 'WARN' | 'FAIL';
      qaWarnings?: string[];
    },
  ) {
    await this.db
      .update(characterAnimations)
      .set(input)
      .where(eq(characterAnimations.generationId, generationId));
  }

  async createBatch(userId: string, characterId: string) {
    const rows = await this.db
      .insert(generationBatches)
      .values({ id: randomUUID(), userId, characterId })
      .returning();
    return rows[0]!;
  }

  async batch(id: string, userId: string) {
    const batch = (
      await this.db
        .select()
        .from(generationBatches)
        .where(eq(generationBatches.id, id))
        .limit(1)
    )[0];
    if (!batch || batch.userId !== userId) return undefined;
    const children = await this.db
      .select()
      .from(generations)
      .where(eq(generations.batchId, id));
    return { batch, children };
  }

  async refreshBatchStatus(id: string) {
    const children = await this.db
      .select({ status: generations.status })
      .from(generations)
      .where(eq(generations.batchId, id));
    if (!children.length) return 'PROCESSING' as const;
    const terminal = children.every(({ status }) =>
      ['SUCCEEDED', 'FAILED', 'CANCELED'].includes(status),
    );
    const successes = children.filter(
      ({ status }) => status === 'SUCCEEDED',
    ).length;
    const status = !terminal
      ? ('PROCESSING' as const)
      : successes === children.length
        ? ('SUCCEEDED' as const)
        : successes === 0
          ? ('FAILED' as const)
          : ('PARTIAL' as const);
    await this.db
      .update(generationBatches)
      .set({ status })
      .where(eq(generationBatches.id, id));
    return status;
  }
}
