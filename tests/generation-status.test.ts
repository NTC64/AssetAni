import { describe, expect, it } from 'vitest';
import {
  assertGenerationTransition,
  canTransition,
  GENERATION_PROGRESS,
  isTerminalStatus,
} from '../packages/core/src';
import { generationRequestSchema } from '../packages/contracts/src';

describe('generation status machine', () => {
  it('supports the worker lifecycle and one structural regeneration cycle', () => {
    expect(canTransition('QUEUED', 'AI_SUBMITTED')).toBe(true);
    expect(canTransition('AI_SUBMITTED', 'AI_RUNNING')).toBe(true);
    expect(canTransition('AI_RUNNING', 'PROCESSING')).toBe(true);
    expect(canTransition('PROCESSING', 'AI_SUBMITTED')).toBe(true);
    expect(canTransition('PROCESSING', 'UPLOADING')).toBe(true);
    expect(canTransition('UPLOADING', 'SUCCEEDED')).toBe(true);
    expect(GENERATION_PROGRESS.SUCCEEDED).toBe(100);
  });

  it('forbids leaving terminal states or skipping directly to success', () => {
    expect(() => assertGenerationTransition('QUEUED', 'SUCCEEDED')).toThrow(
      'Invalid generation transition',
    );
    expect(canTransition('SUCCEEDED', 'FAILED')).toBe(false);
    expect(isTerminalStatus('FAILED')).toBe(true);
  });
});

describe('generation API contract', () => {
  it('accepts only the Phase 3 MVP shape', () => {
    const valid = {
      prompt: 'dark knight carrying a red sword',
      style: 'pixel_art',
      animation: 'walk',
      direction: 'right',
      frameCount: 8,
      fps: 12,
      frameSize: 256,
      background: 'transparent',
      seed: null,
    };
    expect(generationRequestSchema.parse(valid).prompt).toBe(valid.prompt);
    expect(
      generationRequestSchema.safeParse({ ...valid, frameCount: 12 }).success,
    ).toBe(false);
    expect(
      generationRequestSchema.safeParse({ ...valid, extra: true }).success,
    ).toBe(false);
  });
});
