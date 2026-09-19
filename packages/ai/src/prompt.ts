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
    animation: z.enum(['idle', 'walk', 'run', 'attack', 'hurt', 'death']),
    direction: z.enum([
      'right',
      'south',
      'south-west',
      'west',
      'north-west',
      'north',
      'north-east',
      'east',
      'south-east',
    ]),
    frameCount: z.literal(8),
  })
  .strict();
export type SpritePromptInput = z.infer<typeof spritePromptSchema>;

const poseDirections = {
  idle: `POSE ORDER, LEFT TO RIGHT THEN TOP TO BOTTOM:
1 neutral; 2 inhale and rise; 3 chest expanded; 4 exhale; 5 neutral; 6 slight settle; 7 lowest settle; 8 return to neutral.`,
  walk: `POSE ORDER, LEFT TO RIGHT THEN TOP TO BOTTOM:
1 left-foot contact; 2 recoil; 3 passing pose; 4 high point; 5 right-foot contact; 6 recoil; 7 passing pose; 8 high point. Arms and legs must visibly alternate.`,
  run: `POSE ORDER, LEFT TO RIGHT THEN TOP TO BOTTOM:
1 left-foot contact; 2 compression; 3 passing; 4 airborne; 5 right-foot contact; 6 compression; 7 passing; 8 airborne.`,
  attack: `POSE ORDER, LEFT TO RIGHT THEN TOP TO BOTTOM:
1 ready; 2 anticipation; 3 wind-up; 4 early swing; 5 impact; 6 follow-through; 7 recovery; 8 return to ready. The weapon must visibly travel through the arc.`,
  hurt: `POSE ORDER, LEFT TO RIGHT THEN TOP TO BOTTOM:
1 neutral; 2 impact; 3 recoil; 4 maximum recoil; 5 stagger; 6 recover; 7 settle; 8 neutral.`,
  death: `POSE ORDER, LEFT TO RIGHT THEN TOP TO BOTTOM:
1 standing; 2 hit; 3 buckle; 4 falling; 5 impact; 6 collapsed; 7 still; 8 final still pose.`,
} as const;

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

CANVAS:
One wide 2:1 image, exactly 1024 x 512 pixels.

STRICT LAYOUT:
Exactly ${frameCount} animation frames.
4 columns and 2 rows.
Exactly two rows; never add a third row.
Each frame occupies one 256 x 256 area.
Same character in every frame.
Same clothing.
Same body proportions.
Same camera angle.
Same character scale.
Preserve the exact same color palette in all eight frames.
Full body visible.
Equal spacing.
No overlap between frames.

${poseDirections[animation]}

TEMPORAL CONTINUITY:
Treat grid cells 1 through 8 as consecutive moments on one animation timeline, not as eight independent pose ideas.
Preserve the supplied mannequin pose in every corresponding cell.
Between adjacent cells, move limbs and the weapon by one small, physically plausible step.
Keep the head, torso, hips, feet baseline, character size, and camera position stable unless the named action explicitly moves them.
Never reorder the key poses.
Never replace the requested sequence with a collection of unrelated action poses.

BACKGROUND:
Flat solid background #F4F4F4.
Every background area must be the same uniform RGB(244, 244, 244) color.
No gradient or texture.
No environment.
No shadows.
No text.
No labels.
No borders.
No motion trails, speed lines, action arcs, or ghost images.
No glow or white fringe around the character.
Hard crisp pixel edges with no blur or antialiasing.

The frames must represent consecutive poses of one smooth animation cycle.${
    options.strictLayoutRetry
      ? '\n\nCRITICAL: return one 1024 x 512 image with exactly 8 isolated frames in a strict 4x2 grid. Use four columns and exactly two rows. Never add a third row. Keep all background pixels one uniform flat #F4F4F4 color.'
      : ''
  }`;
}
