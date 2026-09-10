import { z } from 'zod';

export const spritePromptSchema = z
  .object({
    prompt: z
      .string()
      .refine(
        (value) =>
          value.trim().length > 0 &&
          Array.from(value).length <= 800 &&
          Buffer.from(value, 'utf8').toString('utf8') === value,
        'Prompt must contain 1–800 valid Unicode characters.',
      ),
    animation: z.enum(['idle', 'walk', 'attack']),
    direction: z.literal('right'),
    frameCount: z.literal(8),
  })
  .strict();
export type SpritePromptInput = z.infer<typeof spritePromptSchema>;

export function buildSpritePrompt(
  input: SpritePromptInput,
  options: { strictLayoutRetry?: boolean } = {},
): string {
  const { prompt, animation, direction, frameCount } =
    spritePromptSchema.parse(input);
  return `Create a clean 2D pixel-art sprite animation sheet.

SUBJECT:
${prompt}

ANIMATION:
${animation}

DIRECTION:
${direction}

STRICT LAYOUT:
Exactly ${frameCount} animation frames.
4 columns and 2 rows.
Same character in every frame.
Same clothing.
Same body proportions.
Same camera angle.
Same character scale.
Full body visible.
Equal spacing.
No overlap between frames.

BACKGROUND:
Flat solid background #F4F4F4.
No environment.
No shadows.
No text.
No labels.
No borders.

The frames must represent consecutive poses of one smooth animation cycle.${
    options.strictLayoutRetry
      ? '\n\nCRITICAL: output exactly 8 isolated frames in a strict 4x2 grid.'
      : ''
  }`;
}
