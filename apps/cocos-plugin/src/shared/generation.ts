import { z } from 'zod';
import {
  animationTypeSchema,
  gamePresetSchema,
  generationRequestSchema,
} from '@sprite/contracts';

export const generationCommandSchema = generationRequestSchema.extend({
  backendUrl: z
    .string()
    .url()
    .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol)),
  apiKey: z.string().regex(/^spr_live_[A-Za-z0-9_-]{43}$/),
});
export type GenerationCommand = z.infer<typeof generationCommandSchema>;

export const characterBatchCommandSchema = z
  .object({
    backendUrl: z.string().url(),
    apiKey: z.string().regex(/^spr_live_[A-Za-z0-9_-]{43}$/),
    name: z.string().trim().min(1).max(80),
    prompt: z.string().trim().min(1).max(800),
    preset: gamePresetSchema,
    animations: z.array(animationTypeSchema).min(1).max(6),
    mode: z.enum(['standard', 'precise']).default('standard'),
  })
  .strict();
export type CharacterBatchCommand = z.infer<typeof characterBatchCommandSchema>;

export const operationSnapshotSchema = z
  .object({
    operationId: z.string().uuid().nullable(),
    state: z.enum(['IDLE', 'RUNNING', 'SUCCEEDED', 'FAILED']),
    progress: z.number().int().min(0).max(100),
    message: z.string(),
    generationId: z.string().uuid().optional(),
    animationUrl: z.string().optional(),
    animationUrls: z.array(z.string()).optional(),
    creditsRemaining: z.number().int().nonnegative().optional(),
    canRetry: z.boolean(),
  })
  .strict();
export type OperationSnapshot = z.infer<typeof operationSnapshotSchema>;
