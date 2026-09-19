import {
  generationCommandSchema,
  characterBatchCommandSchema,
  operationSnapshotSchema,
  type GenerationCommand,
  type CharacterBatchCommand,
} from '../shared/generation';
import { z } from 'zod';

const NAME = 'ai-sprite-generator';

export async function requestStartGeneration(input: GenerationCommand) {
  return operationSnapshotSchema.parse(
    await Editor.Message.request(
      NAME,
      'start-generation',
      generationCommandSchema.parse(input),
    ),
  );
}

export async function requestStartCharacterBatch(input: CharacterBatchCommand) {
  return operationSnapshotSchema.parse(
    await Editor.Message.request(
      NAME,
      'start-character-batch',
      characterBatchCommandSchema.parse(input),
    ),
  );
}

export async function requestRetryGeneration() {
  return operationSnapshotSchema.parse(
    await Editor.Message.request(NAME, 'retry-generation'),
  );
}

export async function requestGenerationProgress() {
  return operationSnapshotSchema.parse(
    await Editor.Message.request(NAME, 'generation-progress'),
  );
}

export async function requestApiKey() {
  return z
    .object({ apiKey: z.string() })
    .strict()
    .parse(await Editor.Message.request(NAME, 'load-api-key'));
}
