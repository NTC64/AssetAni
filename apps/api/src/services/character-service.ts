import { randomUUID } from 'node:crypto';
import type {
  CharacterAnimationRequest,
  CharacterBatchRequest,
  CreateCharacterRequest,
  GenerationRequest,
} from '@sprite/contracts';
import { resolveGamePreset } from '@sprite/core';
import type { CharacterRepository, CharacterRow } from '@sprite/db';
import { GenerationAdmissionError } from '@sprite/db';
import { GenerationService } from './generation-service';

type Identity = { userId: string; apiKeyId: string };

export class CharacterService {
  constructor(
    private readonly characters: CharacterRepository,
    private readonly generations: GenerationService,
  ) {}

  async create(
    input: CreateCharacterRequest,
    idempotencyKey: string,
    identity: Identity,
  ) {
    const existing = await this.generations.findIdempotent(
      identity.userId,
      idempotencyKey,
    );
    if (existing) return this.characters.findByGenerationId(existing.id);
    const generationId = randomUUID();
    const character = await this.characters.create({
      userId: identity.userId,
      generationId,
      name: input.name,
      prompt: input.prompt,
      style: input.style,
      preset: input.preset,
      frameSize: input.frameSize ?? resolveGamePreset(input.preset).frameSize,
    });
    const preset = resolveGamePreset(input.preset, {
      animation: 'idle',
      frameSize: character.frameSize as 128 | 256,
    });
    try {
      await this.generations.create(
        generationParameters(character.prompt, preset),
        idempotencyKey,
        identity,
        {
          id: generationId,
          characterId: character.id,
          generationKind: 'character',
        },
      );
      return character;
    } catch (error) {
      await this.characters.markFailed(character.id);
      throw error;
    }
  }

  list(userId: string) {
    return this.characters.list(userId);
  }

  async find(id: string, userId: string) {
    const character = await this.characters.find(id, userId);
    if (!character) return undefined;
    return { character, animations: await this.characters.animations(id) };
  }

  async animate(
    character: CharacterRow,
    input: CharacterAnimationRequest,
    idempotencyKey: string,
    identity: Identity,
    batch?: { id: string; admission: boolean },
  ) {
    if (character.status !== 'READY') throw new Error('CHARACTER_NOT_READY');
    const resolved = resolveGamePreset(character.preset as never, {
      animation: input.animation,
      direction: input.direction,
      fps: input.fps,
      frameSize: input.frameSize,
    });
    const created = await this.generations.create(
      generationParameters(character.prompt, {
        ...resolved,
        seed: input.seed,
      }),
      idempotencyKey,
      identity,
      {
        characterId: character.id,
        batchId: batch?.id,
        animationMode: input.mode,
        batchAdmission: batch?.admission,
      },
    );
    if (created.created)
      await this.characters.createAnimation({
        characterId: character.id,
        generationId: created.record.id,
        animation: resolved.animation,
        direction: resolved.direction,
        fps: resolved.fps,
        frameCount: 8,
      });
    return created;
  }

  async batch(
    character: CharacterRow,
    input: CharacterBatchRequest,
    idempotencyKey: string,
    identity: Identity,
  ) {
    const credits = await this.generations.credits(identity.userId);
    if (credits < input.animations.length)
      throw new GenerationAdmissionError(
        'INSUFFICIENT_CREDIT',
        'Not enough credits.',
      );
    const batch = await this.characters.createBatch(
      identity.userId,
      character.id,
    );
    const children = [];
    for (const animation of input.animations) {
      const child = await this.animate(
        character,
        {
          animation,
          mode: input.mode,
          direction: input.direction,
          fps: input.fps,
          frameCount: 8,
          frameSize: input.frameSize,
          seed: null,
        },
        `${idempotencyKey}:${animation}`,
        identity,
        { id: batch.id, admission: true },
      );
      children.push(child.record);
    }
    return { batch, children };
  }
}

function generationParameters(
  prompt: string,
  input: {
    animation: GenerationRequest['animation'];
    direction: GenerationRequest['direction'];
    fps: number;
    frameSize: 128 | 256;
    seed?: number | null;
  },
): GenerationRequest {
  return {
    prompt,
    style: 'pixel_art',
    animation: input.animation,
    direction: input.direction,
    frameCount: 8,
    fps: input.fps,
    frameSize: input.frameSize,
    background: 'transparent',
    seed: input.seed ?? null,
  };
}

export function toCharacterResponse(
  character: CharacterRow,
  animations: Awaited<ReturnType<CharacterRepository['animations']>>,
) {
  return {
    id: character.id,
    name: character.name,
    prompt: character.prompt,
    style: character.style,
    preset: character.preset,
    frameSize: character.frameSize,
    status: character.status,
    generationId: character.generationId,
    animations: animations.map((animation) => ({
      id: animation.id,
      generationId: animation.generationId,
      animation: animation.animation,
      direction: animation.direction,
      fps: animation.fps,
      frameCount: animation.frameCount,
      status: animation.status,
      qaStatus: animation.qaStatus,
      qaWarnings: animation.qaWarnings,
    })),
  };
}

export function toBatchResponse(
  batch: { id: string; characterId: string },
  children: Array<{
    id: string;
    status: string;
    parameters: GenerationRequest;
  }>,
) {
  const terminal = children.every(({ status }) =>
    ['SUCCEEDED', 'FAILED', 'CANCELED'].includes(status),
  );
  const succeeded = children.filter(
    ({ status }) => status === 'SUCCEEDED',
  ).length;
  const status = !terminal
    ? 'PROCESSING'
    : succeeded === children.length
      ? 'SUCCEEDED'
      : succeeded === 0
        ? 'FAILED'
        : 'PARTIAL';
  return {
    id: batch.id,
    characterId: batch.characterId,
    status,
    generations: children.map((child) => ({
      id: child.id,
      animation: child.parameters.animation,
      status: child.status,
    })),
  };
}
