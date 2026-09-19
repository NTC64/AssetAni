import type { GenerationStatus } from '@sprite/contracts';

export const GENERATION_PROGRESS: Record<GenerationStatus, number> = {
  QUEUED: 5,
  AI_SUBMITTED: 15,
  AI_RUNNING: 35,
  PROCESSING: 70,
  UPLOADING: 90,
  SUCCEEDED: 100,
  FAILED: 100,
  CANCELED: 100,
};

const transitions: Record<GenerationStatus, readonly GenerationStatus[]> = {
  QUEUED: ['AI_SUBMITTED', 'FAILED', 'CANCELED'],
  AI_SUBMITTED: ['AI_RUNNING', 'FAILED', 'CANCELED'],
  AI_RUNNING: ['PROCESSING', 'FAILED', 'CANCELED'],
  PROCESSING: ['AI_SUBMITTED', 'UPLOADING', 'FAILED', 'CANCELED'],
  UPLOADING: ['SUCCEEDED', 'FAILED', 'CANCELED'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELED: [],
};

export function canTransition(
  current: GenerationStatus,
  next: GenerationStatus,
) {
  return transitions[current].includes(next);
}

export function assertGenerationTransition(
  current: GenerationStatus,
  next: GenerationStatus,
) {
  if (!canTransition(current, next))
    throw new Error(`Invalid generation transition: ${current} -> ${next}.`);
}

export function isTerminalStatus(status: GenerationStatus) {
  return ['SUCCEEDED', 'FAILED', 'CANCELED'].includes(status);
}
