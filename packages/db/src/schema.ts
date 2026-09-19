import {
  bigint,
  bigserial,
  char,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  GENERATION_STATUSES,
  type AnimationType,
  type GenerationRequest,
  type SpriteDirection,
} from '@sprite/contracts';

export const API_KEY_SCOPES = [
  'generation:create',
  'generation:read',
  'credit:read',
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    email: varchar('email', { length: 320 }).notNull().unique(),
    paddleCustomerId: varchar('paddle_customer_id', { length: 64 }).unique(),
    plan: varchar('plan', { length: 32 }).notNull().default('free'),
    subscriptionStatus: varchar('subscription_status', { length: 32 })
      .notNull()
      .default('none'),
    creditBalance: integer('credit_balance').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check('users_credit_balance_nonnegative', sql`${table.creditBalance} >= 0`),
  ],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }),
    keyPrefix: varchar('key_prefix', { length: 16 }).notNull(),
    keyHash: char('key_hash', { length: 64 }).notNull().unique(),
    scopes: jsonb('scopes').$type<ApiKeyScope[]>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('api_keys_user_idx').on(table.userId)],
);

export const characters = pgTable(
  'characters',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    generationId: uuid('generation_id').notNull(),
    name: varchar('name', { length: 80 }).notNull(),
    prompt: text('prompt').notNull(),
    style: varchar('style', { length: 32 }).notNull().default('pixel_art'),
    preset: varchar('preset', { length: 32 }).notNull(),
    provider: varchar('provider', { length: 32 }),
    providerCharacterId: varchar('provider_character_id', { length: 128 }),
    baseAssetKey: text('base_asset_key'),
    frameSize: smallint('frame_size').notNull(),
    status: varchar('status', { length: 16 }).notNull().default('PENDING'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('characters_user_created_idx').on(table.userId, table.createdAt),
  ],
);

export const generationBatches = pgTable(
  'generation_batches',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    characterId: uuid('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    status: varchar('status', { length: 16 }).notNull().default('PROCESSING'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('generation_batches_character_idx').on(table.characterId)],
);

export const generations = pgTable(
  'generations',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    apiKeyId: uuid('api_key_id').references(() => apiKeys.id),
    characterId: uuid('character_id').references(() => characters.id),
    batchId: uuid('batch_id').references(() => generationBatches.id),
    generationKind: varchar('generation_kind', { length: 16 })
      .notNull()
      .default('animation'),
    animationMode: varchar('animation_mode', { length: 16 })
      .notNull()
      .default('standard'),
    idempotencyKey: varchar('idempotency_key', { length: 64 }).notNull(),
    prompt: text('prompt').notNull(),
    promptHash: char('prompt_hash', { length: 64 }).notNull(),
    parameters: jsonb('parameters').$type<GenerationRequest>().notNull(),
    status: varchar('status', {
      length: 32,
      enum: GENERATION_STATUSES,
    }).notNull(),
    progress: smallint('progress').notNull().default(0),
    provider: varchar('provider', { length: 32 }),
    providerModel: varchar('provider_model', { length: 128 }),
    providerRequestId: varchar('provider_request_id', { length: 128 }),
    seed: bigint('seed', { mode: 'number' }),
    creditCost: integer('credit_cost').notNull().default(1),
    providerCostUsd: numeric('provider_cost_usd', { precision: 10, scale: 6 }),
    attempt: smallint('attempt').notNull().default(0),
    rawObjectKey: text('raw_object_key'),
    sheetObjectKey: text('sheet_object_key'),
    packageObjectKey: text('package_object_key'),
    manifestObjectKey: text('manifest_object_key'),
    errorCode: varchar('error_code', { length: 64 }),
    errorMessage: text('error_message'),
    qaStatus: varchar('qa_status', { length: 16 }).notNull().default('PENDING'),
    qaWarnings: jsonb('qa_warnings').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => [
    unique('generations_user_idempotency_unique').on(
      table.userId,
      table.idempotencyKey,
    ),
    index('generations_status_created_idx').on(table.status, table.createdAt),
    index('generations_user_status_idx').on(table.userId, table.status),
  ],
);

export const characterAnimations = pgTable(
  'character_animations',
  {
    id: uuid('id').primaryKey(),
    characterId: uuid('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    generationId: uuid('generation_id')
      .notNull()
      .references(() => generations.id, { onDelete: 'cascade' })
      .unique(),
    animation: varchar('animation', { length: 16 })
      .$type<AnimationType>()
      .notNull(),
    direction: varchar('direction', { length: 24 })
      .$type<SpriteDirection>()
      .notNull(),
    fps: smallint('fps').notNull(),
    frameCount: smallint('frame_count').notNull(),
    status: varchar('status', { length: 32 }).notNull().default('QUEUED'),
    qaStatus: varchar('qa_status', { length: 16 }).notNull().default('PENDING'),
    qaWarnings: jsonb('qa_warnings').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('character_animations_character_idx').on(table.characterId),
  ],
);

export const creditLedger = pgTable(
  'credit_ledger',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    generationId: uuid('generation_id').references(() => generations.id),
    delta: integer('delta').notNull(),
    reason: varchar('reason', { length: 32 }).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 128 })
      .notNull()
      .unique(),
    paddleTransactionId: varchar('paddle_transaction_id', { length: 64 }),
    balanceAfter: integer('balance_after').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('credit_ledger_user_created_idx').on(table.userId, table.createdAt),
    check(
      'credit_ledger_balance_after_nonnegative',
      sql`${table.balanceAfter} >= 0`,
    ),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type GenerationRow = typeof generations.$inferSelect;
export type CharacterRow = typeof characters.$inferSelect;
export type CharacterAnimationRow = typeof characterAnimations.$inferSelect;
export type GenerationBatchRow = typeof generationBatches.$inferSelect;
export type CreditLedgerRow = typeof creditLedger.$inferSelect;
