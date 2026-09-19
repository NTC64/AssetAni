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
export interface GeneratedFrame {
  index: number;
  buffer: Buffer;
}
export interface GeneratedSpriteFrames extends GeneratedSpriteSheet {
  frames: GeneratedFrame[];
  providerCostUsd?: number;
}
export type GeneratedSpriteResult =
  | GeneratedSpriteSheet
  | GeneratedSpriteFrames;

export interface CreateBaseCharacterInput {
  prompt: string;
  frameSize: number;
  seed?: number | null;
}
export interface BaseCharacterResult {
  image: Buffer;
  provider: 'pixellab' | 'fal';
  providerCostUsd?: number;
}
export interface AnimateWithTextInput {
  baseCharacter: Buffer;
  animation: 'idle' | 'walk' | 'run' | 'attack' | 'hurt' | 'death';
  direction?: string;
  frameCount: 8;
  seed?: number | null;
}
export interface AnimationFramesResult {
  frames: GeneratedFrame[];
  provider: 'pixellab';
  providerJobId?: string;
  providerCostUsd?: number;
}
export interface SkeletonPoint {
  x: number;
  y: number;
  label: string;
  zIndex: number;
}
export interface SkeletonResult {
  keypoints: SkeletonPoint[];
  provider: 'pixellab';
  providerCostUsd?: number;
}
export interface EstimateSkeletonInput {
  image: Buffer;
}
export interface AnimateWithSkeletonInput {
  referenceImage: Buffer;
  skeletonKeypoints: SkeletonPoint[][];
  frameSize: number;
  seed?: number | null;
}
export interface GenerateDirectionsInput {
  baseCharacter: Buffer;
  prompt?: string;
  seed?: number | null;
}
export interface ConceptResult {
  image: Buffer;
  provider: 'fal';
  requestId: string;
  seed: number;
}
export interface ConceptProvider {
  generateConcept(input: {
    prompt: string;
    seed?: number | null;
  }): Promise<ConceptResult>;
}
export const PIXELLAB_DIRECTION_ORDER = [
  'south',
  'south-west',
  'west',
  'north-west',
  'north',
  'north-east',
  'east',
  'south-east',
] as const;
export type PixelLabDirection = (typeof PIXELLAB_DIRECTION_ORDER)[number];
export interface DirectionFramesResult extends AnimationFramesResult {
  directions: PixelLabDirection[];
}
export interface AiGenerationOptions {
  /** Adds the one permitted corrective layout instruction after validation failure. */
  strictLayoutRetry?: boolean;
}
export interface AiProvider {
  readonly name: 'fake' | 'fal' | 'pixellab';
  readonly model: string;
  generate(
    input: GenerationInput,
    options?: AiGenerationOptions,
  ): Promise<GeneratedSpriteResult>;
}
export interface SpriteAIProvider extends AiProvider {
  createBaseCharacter(
    input: CreateBaseCharacterInput,
  ): Promise<BaseCharacterResult>;
  animateWithText(input: AnimateWithTextInput): Promise<AnimationFramesResult>;
  estimateSkeleton?(input: EstimateSkeletonInput): Promise<SkeletonResult>;
  animateWithSkeleton?(
    input: AnimateWithSkeletonInput,
  ): Promise<AnimationFramesResult>;
  generateDirections?(
    input: GenerateDirectionsInput,
  ): Promise<DirectionFramesResult>;
}

export function hasGeneratedFrames(
  result: GeneratedSpriteResult,
): result is GeneratedSpriteFrames {
  return 'frames' in result;
}
export class AiProviderError extends Error {
  constructor(
    public readonly code:
      | 'PROVIDER_ERROR'
      | 'INVALID_OUTPUT'
      | 'DOWNLOAD_FAILED',
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}
