import { z } from 'zod';

export const animationTypeSchema = z.enum([
  'idle',
  'walk',
  'run',
  'attack',
  'hurt',
  'death',
]);
export type AnimationType = z.infer<typeof animationTypeSchema>;
export const spriteDirectionSchema = z.enum([
  'right',
  'south',
  'south-west',
  'west',
  'north-west',
  'north',
  'north-east',
  'east',
  'south-east',
]);
export type SpriteDirection = z.infer<typeof spriteDirectionSchema>;
export const gamePresetSchema = z.enum([
  'platformer',
  'side_scroller',
  'top_down_rpg',
]);
export type GamePresetName = z.infer<typeof gamePresetSchema>;

export const manifestSchema = z
  .object({
    version: z.literal(1),
    generationId: z.string().uuid(),
    animation: animationTypeSchema,
    direction: spriteDirectionSchema,
    fps: z.number().int().min(4).max(30),
    loop: z.boolean(),
    frameCount: z.literal(8),
    frameSize: z.union([z.literal(128), z.literal(256)]),
    pivot: z
      .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
      .strict(),
    frames: z
      .array(z.string().regex(/^frames\/(?:frame_)?\d{2}\.png$/))
      .length(8),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.frames).size !== value.frameCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['frames'],
        message: 'Frame paths must be unique.',
      });
    }
  });
export type GenerationManifest = z.infer<typeof manifestSchema>;

export const GENERATION_STATUSES = [
  'QUEUED',
  'AI_SUBMITTED',
  'AI_RUNNING',
  'PROCESSING',
  'UPLOADING',
  'SUCCEEDED',
  'FAILED',
  'CANCELED',
] as const;
export const generationStatusSchema = z.enum(GENERATION_STATUSES);
export type GenerationStatus = z.infer<typeof generationStatusSchema>;

export const generationRequestSchema = z
  .object({
    prompt: z.string().trim().min(1).max(800),
    style: z.literal('pixel_art'),
    animation: animationTypeSchema,
    direction: spriteDirectionSchema,
    frameCount: z.literal(8),
    fps: z.number().int().min(4).max(30),
    frameSize: z.union([z.literal(128), z.literal(256)]),
    background: z.literal('transparent'),
    seed: z.number().int().min(0).max(4294967295).nullable(),
  })
  .strict();
export type GenerationRequest = z.infer<typeof generationRequestSchema>;

export const createCharacterRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    prompt: z.string().trim().min(1).max(800),
    style: z.literal('pixel_art').default('pixel_art'),
    preset: gamePresetSchema.default('side_scroller'),
    frameSize: z.union([z.literal(128), z.literal(256)]).optional(),
    seed: z.number().int().min(0).max(4294967295).nullable().default(null),
  })
  .strict();
export type CreateCharacterRequest = z.infer<
  typeof createCharacterRequestSchema
>;

export const characterAnimationRequestSchema = z
  .object({
    animation: animationTypeSchema,
    mode: z.enum(['standard', 'precise']).default('standard'),
    direction: spriteDirectionSchema.optional(),
    fps: z.number().int().min(4).max(30).optional(),
    frameCount: z.literal(8).default(8),
    frameSize: z.union([z.literal(128), z.literal(256)]).optional(),
    seed: z.number().int().min(0).max(4294967295).nullable().default(null),
  })
  .strict();
export type CharacterAnimationRequest = z.infer<
  typeof characterAnimationRequestSchema
>;

export const characterBatchRequestSchema = z
  .object({
    preset: gamePresetSchema,
    animations: z.array(animationTypeSchema).min(1).max(6),
    mode: z.enum(['standard', 'precise']).default('standard'),
    direction: spriteDirectionSchema.optional(),
    frameSize: z.union([z.literal(128), z.literal(256)]).optional(),
    fps: z.number().int().min(4).max(30).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.animations).size !== value.animations.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['animations'],
        message: 'Batch animations must be unique.',
      });
  });
export type CharacterBatchRequest = z.infer<typeof characterBatchRequestSchema>;

export const characterResponseSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    prompt: z.string(),
    style: z.string(),
    preset: gamePresetSchema,
    frameSize: z.union([z.literal(128), z.literal(256)]),
    status: z.enum(['PENDING', 'READY', 'FAILED']),
    generationId: z.string().uuid(),
    animations: z.array(
      z.object({
        id: z.string().uuid(),
        generationId: z.string().uuid(),
        animation: animationTypeSchema,
        direction: spriteDirectionSchema,
        fps: z.number().int(),
        frameCount: z.number().int(),
        status: generationStatusSchema,
        qaStatus: z.enum(['PENDING', 'PASS', 'WARN', 'FAIL']),
        qaWarnings: z.array(z.string()),
      }),
    ),
  })
  .strict();
export type CharacterResponse = z.infer<typeof characterResponseSchema>;

export const batchResponseSchema = z
  .object({
    id: z.string().uuid(),
    characterId: z.string().uuid(),
    status: z.enum(['PROCESSING', 'SUCCEEDED', 'PARTIAL', 'FAILED']),
    generations: z.array(
      z.object({
        id: z.string().uuid(),
        animation: animationTypeSchema,
        status: generationStatusSchema,
      }),
    ),
  })
  .strict();
export type BatchResponse = z.infer<typeof batchResponseSchema>;

export const generationResultSchema = z
  .object({
    packageUrl: z.string().url(),
    sheetUrl: z.string().url(),
    manifestUrl: z.string().url(),
    expiresIn: z.number().int().nonnegative(),
  })
  .strict();

export const generationResponseSchema = z
  .object({
    id: z.string().uuid(),
    status: generationStatusSchema,
    progress: z.number().int().min(0).max(100),
    pollAfterMs: z.number().int().positive().optional(),
    result: generationResultSchema.optional(),
    errorCode: z.string().optional(),
    errorMessage: z.string().optional(),
    creditCharged: z.literal(1).optional(),
    creditsRemaining: z.number().int().nonnegative().optional(),
  })
  .strict();
export type GenerationResponse = z.infer<typeof generationResponseSchema>;

export const meResponseSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().email(),
    plan: z.string(),
    subscriptionStatus: z.string(),
    apiKey: z.object({
      id: z.string().uuid(),
      name: z.string().nullable(),
      prefix: z.string(),
      scopes: z.array(
        z.enum(['generation:create', 'generation:read', 'credit:read']),
      ),
      expiresAt: z.string().datetime().nullable(),
    }),
  })
  .strict();
export type MeResponse = z.infer<typeof meResponseSchema>;

export const creditsResponseSchema = z
  .object({
    balance: z.number().int().nonnegative(),
  })
  .strict();
export type CreditsResponse = z.infer<typeof creditsResponseSchema>;

export const apiErrorCodeSchema = z.enum([
  'INVALID_API_KEY',
  'API_KEY_EXPIRED',
  'RATE_LIMITED',
  'INSUFFICIENT_CREDIT',
  'INVALID_PROMPT',
  'GENERATION_NOT_FOUND',
  'AI_PROVIDER_ERROR',
  'SLICE_FAILED',
  'INSUFFICIENT_MOTION',
  'INCONSISTENT_CHARACTER',
  'PROCESSING_FAILED',
  'INTERNAL_ERROR',
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
