import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AIOrchestrator, createFakeProvider } from '../packages/ai/src';
import type { ConceptProvider, SpriteAIProvider } from '../packages/ai/src';
import {
  GAME_PRESETS,
  LocalResultStorage,
  resolveGamePreset,
} from '../packages/core/src';
import {
  AccountRepository,
  CharacterRepository,
  GenerationRepository,
  type GenerationDatabase,
} from '../packages/db/src';
import { generations, users } from '../packages/db/src/schema';
import { runAnimationQa, createSpritePackage } from '../packages/image/src';
import type { GenerationQueue } from '../packages/queue/src';
import { buildApp } from '../apps/api/src/app';
import { apiKeyPrefix, generateApiKey, hashApiKey } from '../packages/core/src';
import { toBatchResponse } from '../apps/api/src/services/character-service';
import { GenerationService as CocosGenerationService } from '../apps/cocos-plugin/src/main/generation-service';
import type { GenerationApi } from '../apps/cocos-plugin/src/main/api-client';
import type { CocosAdapter } from '../apps/cocos-plugin/src/cocos/cocos-adapter';
import type {
  GenerationRequest,
  GenerationResponse,
} from '../packages/contracts/src';

const databases: PGlite[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

async function png(
  size = 256,
  rect = { left: 80, top: 48, width: 96, height: 200 },
  color = '#3366cc',
) {
  const sprite = await sharp({
    create: {
      width: rect.width,
      height: rect.height,
      channels: 4,
      background: color,
    },
  })
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: sprite, left: rect.left, top: rect.top }])
    .png()
    .toBuffer();
}

describe('AI orchestration', () => {
  it('routes standard, precise, and concept work to their provider capabilities', async () => {
    const fake = createFakeProvider();
    const frame = await png();
    const primary: SpriteAIProvider = {
      ...fake,
      animateWithText: vi.fn().mockResolvedValue({
        provider: 'pixellab',
        frames: Array.from({ length: 8 }, (_, index) => ({
          index,
          buffer: frame,
        })),
      }),
      estimateSkeleton: vi.fn().mockResolvedValue({
        provider: 'pixellab',
        keypoints: [{ x: 1, y: 1, label: 'root', zIndex: 0 }],
      }),
      animateWithSkeleton: vi
        .fn()
        .mockImplementation(async ({ skeletonKeypoints }) => ({
          provider: 'pixellab',
          frames: skeletonKeypoints.map((_: unknown, index: number) => ({
            index,
            buffer: frame,
          })),
        })),
    };
    const concept: ConceptProvider = {
      generateConcept: vi.fn().mockResolvedValue({
        image: frame,
        provider: 'fal',
        requestId: 'fal-concept',
        seed: 7,
      }),
    };
    const orchestrator = new AIOrchestrator(primary, concept);
    const common = {
      baseCharacter: frame,
      animation: 'walk' as const,
      direction: 'right',
      frameCount: 8 as const,
      frameSize: 256,
      seed: 1,
    };
    await orchestrator.generateAnimation({ ...common, mode: 'standard' });
    const precise = await orchestrator.generateAnimation({
      ...common,
      mode: 'precise',
    });
    await orchestrator.generateConcept({ prompt: 'knight' });
    expect(primary.animateWithText).toHaveBeenCalledOnce();
    expect(primary.estimateSkeleton).toHaveBeenCalledOnce();
    expect(primary.animateWithSkeleton).toHaveBeenCalledTimes(3);
    expect(precise.frames).toHaveLength(8);
    expect(concept.generateConcept).toHaveBeenCalledOnce();
  });
});

describe('animation QA and presets', () => {
  it('returns PASS for valid distinct normalized frames', async () => {
    const frames = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        png(
          256,
          { left: 48 + index * 12, top: 48, width: 96, height: 200 },
          `rgb(${20 + index * 28},80,180)`,
        ),
      ),
    );
    expect((await runAnimationQa(frames, 256)).status).toBe('PASS');
  });

  it('warns for bbox drift and duplicate adjacent frames', async () => {
    const normal = await png();
    const short = await png(256, {
      left: 80,
      top: 108,
      width: 96,
      height: 140,
    });
    const qa = await runAnimationQa(
      [normal, normal, normal, short, normal, normal, normal, normal],
      256,
    );
    expect(qa.status).toBe('WARN');
    expect(
      qa.warnings.some((warning) => warning.startsWith('BOUNDING_BOX_DRIFT')),
    ).toBe(true);
    expect(
      qa.warnings.some((warning) => warning.startsWith('DUPLICATE_FRAME')),
    ).toBe(true);
  });

  it('fails an empty frame and preserves a Cocos-compatible 128px manifest', async () => {
    const empty = await sharp({
      create: {
        width: 128,
        height: 128,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();
    expect((await runAnimationQa(Array(8).fill(empty), 128)).status).toBe(
      'FAIL',
    );
    const manifest = createSpritePackage(
      { frames: Array(8).fill(empty), sheet: empty },
      {
        generationId: randomUUID(),
        animation: 'idle',
        fps: 8,
        loop: true,
        frameSize: 128,
        direction: 'south',
        pivot: { x: 0.5, y: 0 },
      },
    ).manifest;
    expect(manifest).toMatchObject({
      frameSize: 128,
      direction: 'south',
      frameCount: 8,
    });
  });

  it('resolves exactly three overridable game presets', () => {
    expect(Object.keys(GAME_PRESETS)).toEqual([
      'platformer',
      'side_scroller',
      'top_down_rpg',
    ]);
    expect(
      resolveGamePreset('platformer', {
        frameSize: 256,
        fps: 14,
        animation: 'attack',
      }),
    ).toMatchObject({
      frameSize: 256,
      fps: 14,
      animation: 'attack',
      direction: 'right',
    });
    expect(GAME_PRESETS.top_down_rpg.directions).toHaveLength(8);
  });
});

describe('character API and batches', () => {
  it('creates one character, reuses it for animations, and enqueues one job per batch child', async () => {
    const pglite = new PGlite();
    databases.push(pglite);
    for (const migration of [
      '0000_phase3_generations.sql',
      '0001_phase5_auth_credits.sql',
      '0002_characters_batches.sql',
    ])
      await pglite.exec(
        await readFile(path.resolve('migrations', migration), 'utf8'),
      );
    const db = drizzle(pglite, {
      schema: await import('../packages/db/src/schema'),
    }) as unknown as GenerationDatabase;
    const accounts = new AccountRepository(db);
    const repository = new GenerationRepository(db);
    const characters = new CharacterRepository(db);
    const pepper = 'character-tests-pepper-at-least-thirty-two-bytes';
    const rawKey = generateApiKey();
    const account = await accounts.provisionFreeUser({
      email: `${randomUUID()}@example.com`,
      keyPrefix: apiKeyPrefix(rawKey),
      keyHash: hashApiKey(rawKey, pepper),
    });
    await db
      .update(users)
      .set({ plan: 'pro', creditBalance: 20 })
      .where(eq(users.id, account.user.id));
    const jobs: string[] = [];
    const queue: GenerationQueue = {
      enqueue: async (id) => void jobs.push(id),
      health: async () => undefined,
      close: async () => undefined,
    };
    const app = buildApp({
      repository,
      accounts,
      characters,
      queue,
      rateLimiter: {
        consume: async () => ({
          allowed: true,
          remaining: 99,
          retryAfterSeconds: 0,
        }),
        close: async () => undefined,
      },
      apiKeyPepper: pepper,
      storage: new LocalResultStorage(
        path.resolve('artifacts/test-character-api'),
      ),
      publicApiUrl: 'http://localhost:3000',
    });
    const headers = (key = randomUUID()) => ({
      authorization: `Bearer ${rawKey}`,
      'idempotency-key': key,
    });
    const created = await app.inject({
      method: 'POST',
      url: '/v1/characters',
      headers: headers(),
      payload: { name: 'Knight', prompt: 'blue knight', preset: 'platformer' },
    });
    expect(created.statusCode).toBe(202);
    const character = created.json();
    await characters.markReady(character.id, {
      provider: 'fake',
      baseAssetKey: `characters/${character.id}/base.png`,
    });
    await db
      .update(generations)
      .set({ status: 'SUCCEEDED' })
      .where(eq(generations.id, character.generationId));

    for (const animation of ['idle', 'walk'] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/characters/${character.id}/animations`,
        headers: headers(),
        payload: { animation, mode: 'standard' },
      });
      expect(response.statusCode).toBe(202);
      await db
        .update(generations)
        .set({ status: 'SUCCEEDED' })
        .where(eq(generations.id, response.json().id));
    }
    const batch = await app.inject({
      method: 'POST',
      url: `/v1/characters/${character.id}/batches`,
      headers: headers(),
      payload: {
        preset: 'platformer',
        animations: ['attack', 'hurt', 'death'],
      },
    });
    expect(batch.statusCode).toBe(202);
    expect(batch.json().generations).toHaveLength(3);
    expect(jobs).toHaveLength(6);
    const rows = await repository.findById(batch.json().generations[0].id);
    expect(rows?.characterId).toBe(character.id);
    for (const [index, child] of batch.json().generations.entries())
      await db
        .update(generations)
        .set({ status: index === 0 ? 'SUCCEEDED' : 'FAILED' })
        .where(eq(generations.id, child.id));
    expect(await characters.refreshBatchStatus(batch.json().id)).toBe(
      'PARTIAL',
    );
    expect(
      (await characters.batch(batch.json().id, account.user.id))?.batch.status,
    ).toBe('PARTIAL');
    expect(
      toBatchResponse(batch.json(), [
        {
          id: randomUUID(),
          status: 'SUCCEEDED',
          parameters: { ...rows!.parameters, animation: 'attack' },
        },
        {
          id: randomUUID(),
          status: 'FAILED',
          parameters: { ...rows!.parameters, animation: 'hurt' },
        },
      ]).status,
    ).toBe('PARTIAL');
    await app.close();
  }, 10_000);
});

describe('Cocos batch import', () => {
  it('imports named action folders and writes clips into the character animations folder', async () => {
    const frame = await png();
    const sheet = await sharp({
      create: {
        width: 1024,
        height: 512,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();
    const children = ['idle', 'walk'].map((animation) => ({
      generationId: randomUUID(),
      input: {
        prompt: 'knight',
        style: 'pixel_art',
        animation,
        direction: 'right',
        frameCount: 8,
        fps: 10,
        frameSize: 256,
        background: 'transparent',
        seed: null,
      } as GenerationRequest,
    }));
    const archives = new Map(
      children.map(({ generationId, input }) => [
        generationId,
        createSpritePackage(
          { frames: Array(8).fill(frame), sheet },
          {
            generationId,
            animation: input.animation,
            fps: input.fps,
            loop: true,
          },
        ).zip,
      ]),
    );
    const succeeded = (id: string): GenerationResponse => ({
      id,
      status: 'SUCCEEDED',
      progress: 100,
      result: {
        packageUrl: `http://localhost:3000/v1/generations/${id}/files/result.zip`,
        sheetUrl: `http://localhost:3000/v1/generations/${id}/files/sheet.png`,
        manifestUrl: `http://localhost:3000/v1/generations/${id}/files/manifest.json`,
        expiresIn: 900,
      },
    });
    const api: GenerationApi = {
      createGeneration: vi.fn(),
      getGeneration: vi.fn(async (id) => succeeded(id)),
      downloadPackage: vi.fn(
        async (url) => archives.get(url.split('/').at(-3)!)!,
      ),
    };
    const cocos: CocosAdapter = {
      importGeneration: vi.fn().mockResolvedValue(undefined),
      refreshAsset: vi.fn().mockResolvedValue(undefined),
      createAnimation: vi.fn().mockResolvedValue(undefined),
    };
    await new CocosGenerationService(api, cocos).runBatch(
      'Blue Knight',
      children,
      {
        sleep: async () => undefined,
      },
    );
    expect(cocos.importGeneration).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        destination: 'db://assets/AI_Sprites/Blue_Knight/idle',
      }),
    );
    expect(cocos.createAnimation).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.any(Object),
      'db://assets/AI_Sprites/Blue_Knight/animations/blue_knight_walk.anim',
    );
  });
});
