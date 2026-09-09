import { z } from 'zod';

export const manifestSchema = z
  .object({
    version: z.literal(1),
    generationId: z.string().uuid(),
    animation: z.enum(['idle', 'walk', 'attack']),
    direction: z.literal('right'),
    fps: z.number().int().min(4).max(30),
    loop: z.boolean(),
    frameCount: z.literal(8),
    frameSize: z.literal(256),
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
