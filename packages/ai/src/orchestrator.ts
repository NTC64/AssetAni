import { AiProviderError } from './provider';
import type {
  AnimationFramesResult,
  ConceptProvider,
  ConceptResult,
  DirectionFramesResult,
  GenerateDirectionsInput,
  SpriteAIProvider,
} from './provider';

export class AIOrchestrator {
  constructor(
    private readonly primary: SpriteAIProvider,
    private readonly conceptProvider?: ConceptProvider,
  ) {}

  get providerName() {
    return this.primary.name;
  }

  get providerModel() {
    return this.primary.model;
  }

  async createCharacter(input: {
    prompt: string;
    frameSize: number;
    seed?: number | null;
    allowFallback?: boolean;
  }) {
    try {
      return await this.primary.createBaseCharacter(input);
    } catch (error) {
      if (!input.allowFallback || !this.conceptProvider) throw error;
      const fallback = await this.conceptProvider.generateConcept(input);
      return { image: fallback.image, provider: 'fal' as const };
    }
  }

  async generateAnimation(input: {
    baseCharacter: Buffer;
    animation: 'idle' | 'walk' | 'run' | 'attack' | 'hurt' | 'death';
    direction: string;
    frameCount: 8;
    frameSize: number;
    mode: 'standard' | 'precise';
    seed?: number | null;
  }): Promise<AnimationFramesResult> {
    if (input.mode === 'standard') return this.primary.animateWithText(input);
    if (!this.primary.estimateSkeleton || !this.primary.animateWithSkeleton)
      throw new AiProviderError(
        'PROVIDER_ERROR',
        'Precise animation is unavailable for this provider.',
      );
    const skeleton = await this.primary.estimateSkeleton({
      image: input.baseCharacter,
    });
    // PLACEHOLDER: every keypoint bobs on the same sine curve, so the result
    // is identical for walk, attack and death. Real per-animation keyframes are
    // still missing, which is why animationModeSchema rejects 'precise' at the
    // API boundary. Do not re-enable that mode before replacing this.
    const poses = Array.from({ length: 9 }, (_, frameIndex) =>
      skeleton.keypoints.map((point) => ({
        ...point,
        y: point.y + Math.round(Math.sin((frameIndex / 8) * Math.PI * 2) * 2),
      })),
    );
    const windows = [poses.slice(0, 3), poses.slice(3, 6), poses.slice(6, 9)];
    const results = [];
    for (const skeletonKeypoints of windows)
      results.push(
        await this.primary.animateWithSkeleton({
          referenceImage: input.baseCharacter,
          skeletonKeypoints,
          frameSize: input.frameSize,
          seed: input.seed,
        }),
      );
    const frames = results
      .flatMap((result) => result.frames)
      .slice(0, input.frameCount)
      .map((frame, index) => ({ ...frame, index }));
    if (frames.length !== input.frameCount)
      throw new AiProviderError(
        'INVALID_OUTPUT',
        `Precise animation returned ${frames.length} frames; expected ${input.frameCount}.`,
      );
    return {
      frames,
      provider: 'pixellab',
      providerCostUsd: results.some(
        (result) => result.providerCostUsd !== undefined,
      )
        ? results.reduce(
            (sum, result) => sum + (result.providerCostUsd ?? 0),
            0,
          )
        : undefined,
    };
  }

  generateConcept(input: {
    prompt: string;
    seed?: number | null;
  }): Promise<ConceptResult> {
    if (!this.conceptProvider)
      throw new AiProviderError(
        'PROVIDER_ERROR',
        'Concept generation is unavailable.',
      );
    return this.conceptProvider.generateConcept(input);
  }

  generateDirections(
    input: GenerateDirectionsInput,
  ): Promise<DirectionFramesResult> {
    if (!this.primary.generateDirections)
      throw new AiProviderError(
        'PROVIDER_ERROR',
        'Direction generation is unavailable.',
      );
    return this.primary.generateDirections(input);
  }
}
