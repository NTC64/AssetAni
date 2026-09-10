import { z } from 'zod';
import { spritePromptSchema } from './prompt';

export const generationInputSchema = spritePromptSchema.extend({
  seed: z.number().int().min(0).max(4294967295).nullable().default(null),
});
export type GenerationInput = z.input<typeof generationInputSchema>;
export interface GeneratedSpriteSheet {
  image: Buffer;
  seed: number;
  model: string;
  requestId: string;
  durationMs: number;
}
export interface AiGenerationOptions {
  /** Adds the one permitted corrective layout instruction after validation failure. */
  strictLayoutRetry?: boolean;
}
export interface AiProvider {
  readonly name: 'fake' | 'fal';
  readonly model: string;
  generate(
    input: GenerationInput,
    options?: AiGenerationOptions,
  ): Promise<GeneratedSpriteSheet>;
}
export class AiProviderError extends Error {
  constructor(
    public readonly code:
      | 'PROVIDER_ERROR'
      | 'INVALID_OUTPUT'
      | 'DOWNLOAD_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}
