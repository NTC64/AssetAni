import { randomUUID } from 'node:crypto';
import type { AnimationType, GenerationRequest } from '@sprite/contracts';
import { resolveGamePreset } from '../../../../packages/core/src/presets';
import type { CocosAdapter } from '../cocos/cocos-adapter';
import type { CharacterBatchCommand } from '../shared/generation';
import { ApiClient } from './api-client';
import {
  DEFAULT_GENERATION_TIMEOUT_MS,
  GenerationService,
  PluginGenerationError,
  POLL_DELAYS_MS,
} from './generation-service';

export async function runCharacterBatchPipeline(
  command: CharacterBatchCommand,
  adapter: CocosAdapter,
  options: {
    onProgress?: (progress: number, message: string) => void;
    sleep?: (milliseconds: number) => Promise<void>;
    timeoutMs?: number;
    now?: () => number;
  } = {},
) {
  const api = new ApiClient(command.backendUrl, command.apiKey);
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const startedAt = now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS;
  let character = await api.createCharacter(
    {
      name: command.name,
      prompt: command.prompt,
      style: 'pixel_art',
      preset: command.preset,
      seed: null,
    },
    randomUUID(),
  );
  options.onProgress?.(5, 'Creating reusable base character…');
  let poll = 0;
  while (character.status === 'PENDING') {
    if (now() - startedAt >= timeoutMs)
      throw new PluginGenerationError(
        'CLIENT_TIMEOUT',
        'Character creation is still running. Open the character list and retry later.',
        'resume',
      );
    await sleep(POLL_DELAYS_MS[poll] ?? 8_000);
    poll++;
    character = await api.getCharacter(character.id);
  }
  if (character.status !== 'READY')
    throw new PluginGenerationError(
      'CHARACTER_FAILED',
      'The base character could not be created. Its credit was refunded.',
      'new',
    );
  options.onProgress?.(15, 'Base character ready. Queueing animations…');
  const batch = await api.createCharacterBatch(
    character.id,
    {
      preset: command.preset,
      animations: command.animations,
      mode: command.mode,
    },
    randomUUID(),
  );
  const requests = new Map<AnimationType, GenerationRequest>();
  for (const animation of command.animations) {
    const preset = resolveGamePreset(command.preset, { animation });
    requests.set(animation, {
      prompt: command.prompt,
      style: 'pixel_art',
      animation,
      direction: preset.direction,
      frameCount: 8,
      fps: preset.fps,
      frameSize: preset.frameSize,
      background: 'transparent',
      seed: null,
    });
  }
  const generationService = new GenerationService(api, adapter);
  const results = await generationService.runBatch(
    command.name,
    batch.generations.map((child) => ({
      generationId: child.id,
      input: requests.get(child.animation)!,
    })),
    {
      onProgress: (snapshot) =>
        options.onProgress?.(
          15 + Math.round(snapshot.progress * 0.85),
          `${snapshot.message} (${snapshot.generationId ?? ''})`,
        ),
    },
  );
  return {
    characterId: character.id,
    batchId: batch.id,
    animationUrls: results.map(({ animationUrl }) => animationUrl),
  };
}
