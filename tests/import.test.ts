import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, cp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { manifestSchema } from '../packages/contracts/src';
import {
  importTestAssets,
  TEST_DESTINATION,
} from '../apps/cocos-plugin/src/main/asset-importer';
import {
  createCocos38Adapter,
  createSceneMethods,
  type Request,
} from '../apps/cocos-plugin/src/cocos/cocos-3.8-adapter';
import type { CocosAdapter } from '../apps/cocos-plugin/src/cocos/cocos-adapter';

const directory = path.resolve('apps/cocos-plugin/test-assets');
const manifest = manifestSchema.parse(
  JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8')),
);
function fakeAdapter(): CocosAdapter {
  return {
    importGeneration: vi.fn().mockResolvedValue(undefined),
    refreshAsset: vi.fn().mockResolvedValue(undefined),
    createAnimation: vi.fn().mockResolvedValue(undefined),
  };
}

describe('manifest and local input', () => {
  it('accepts the fixture manifest and preserves explicit frame order', () => {
    const reversed = [...manifest.frames].reverse();
    expect(
      manifestSchema.parse({ ...manifest, frames: reversed }).frames,
    ).toEqual(reversed);
  });
  it.each([
    { fps: 0 },
    { fps: 31 },
    { frameCount: 7 },
    { direction: 'left' },
    { pivot: { x: 2, y: 0 } },
    { frames: Array(8).fill('frames/frame_00.png') },
    { frames: ['../escape.png', ...manifest.frames.slice(1)] },
    { frames: manifest.frames.slice(1) },
  ])('rejects invalid manifest %j', (change) => {
    expect(manifestSchema.safeParse({ ...manifest, ...change }).success).toBe(
      false,
    );
  });
  it('preflights all eight real fixtures before calling the adapter in order', async () => {
    const adapter = fakeAdapter();
    expect(await importTestAssets(adapter, directory)).toBe(
      `${TEST_DESTINATION}/walk.anim`,
    );
    expect(adapter.importGeneration).toHaveBeenCalledWith({
      manifest,
      destination: TEST_DESTINATION,
      sourceDirectory: await import('node:fs/promises').then((fs) =>
        fs.realpath(directory),
      ),
    });
    expect(adapter.refreshAsset).toHaveBeenCalledWith(TEST_DESTINATION);
    expect(adapter.createAnimation).toHaveBeenCalledWith(
      TEST_DESTINATION,
      manifest,
    );
  });
  it('does not write any project assets if a late frame is corrupt', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'sprite-test-'));
    try {
      await cp(directory, temporary, { recursive: true });
      await writeFile(path.join(temporary, manifest.frames[7]!), 'not a PNG');
      const adapter = fakeAdapter();
      await expect(importTestAssets(adapter, temporary)).rejects.toThrow(
        'Invalid 256 x 256 PNG',
      );
      expect(adapter.importGeneration).not.toHaveBeenCalled();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
  it('does not create a clip when frame import fails', async () => {
    const adapter = fakeAdapter();
    vi.mocked(adapter.importGeneration).mockRejectedValue(
      new Error('disk full'),
    );
    await expect(importTestAssets(adapter, directory)).rejects.toThrow(
      'disk full',
    );
    expect(adapter.createAnimation).not.toHaveBeenCalled();
  });
});

describe('scene animation construction with a fake engine', () => {
  class Frame {
    addRef = vi.fn();
    decRef = vi.fn();
  }
  function setup(failAt = -1) {
    const frames = Array.from({ length: 8 }, () => new Frame());
    const clip = { name: '', duration: 0, wrapMode: 0 };
    const create = vi.fn(() => clip);
    let loaded = 0;
    const engine = {
      SpriteFrame: Frame,
      AnimationClip: {
        createWithSpriteFrames: create,
        WrapMode: { Loop: 2, Normal: 1 },
      },
      assetManager: {
        loadAny: (
          _query: unknown,
          done: (error: Error | null, asset?: unknown) => void,
        ) => {
          const index = loaded++;
          if (index === failAt) done(new Error('asset unavailable'));
          else done(null, frames[index]);
        },
      },
    };
    // Deliberately partial fake engine: these tests do not establish real Creator compatibility.
    const serialize = vi.fn(() => JSON.stringify(clip));
    return {
      frames,
      clip,
      create,
      serialize,
      methods: createSceneMethods(
        () => engine as unknown as typeof import('cc'),
        serialize,
      ),
    };
  }
  it.each([true, false])(
    'sets 8/12 duration and manifest loop=%s, then releases frame references',
    async (loop) => {
      const fake = setup();
      const serialized = await fake.methods.buildAnimation({
        manifest: { ...manifest, loop },
        uuids: manifest.frames,
      });
      expect(fake.create).toHaveBeenCalledWith(fake.frames, 12);
      expect(JSON.parse(serialized)).toEqual({
        name: 'walk',
        duration: 8 / 12,
        wrapMode: loop ? 2 : 1,
      });
      for (const frame of fake.frames) {
        expect(frame.addRef).toHaveBeenCalledTimes(1);
        expect(frame.decRef).toHaveBeenCalledTimes(1);
      }
    },
  );
  it('holds anticipation, impact, and recovery frames in an attack clip', async () => {
    const fake = setup();
    const serialized = await fake.methods.buildAnimation({
      manifest: { ...manifest, animation: 'attack', loop: false },
      uuids: manifest.frames,
    });
    expect(fake.create).toHaveBeenCalledWith(
      [
        fake.frames[0],
        fake.frames[0],
        fake.frames[1],
        fake.frames[2],
        fake.frames[3],
        fake.frames[4],
        fake.frames[4],
        fake.frames[5],
        fake.frames[6],
        fake.frames[7],
        fake.frames[7],
      ],
      12,
    );
    expect(JSON.parse(serialized)).toMatchObject({
      name: 'attack',
      duration: 11 / 12,
      wrapMode: 1,
    });
  });
  it('releases already loaded frames on engine failure and does not serialize a partial clip', async () => {
    const fake = setup(3);
    await expect(
      fake.methods.buildAnimation({ manifest, uuids: manifest.frames }),
    ).rejects.toThrow('asset unavailable');
    expect(fake.serialize).not.toHaveBeenCalled();
    expect(fake.frames[0]!.decRef).toHaveBeenCalledOnce();
  });
});

function fakeDatabase(metaSaveResult: 'object' | boolean | null = true) {
  const assets = new Map<string, Record<string, unknown>>();
  const metas = new Map<string, unknown>();
  const request = vi.fn<Request>(async (channel, message, ...args) => {
    const url = String(args[0]);
    if (channel === 'scene')
      return JSON.stringify([{ __type__: 'cc.AnimationClip' }]);
    if (message === 'query-ready') return true;
    if (message === 'query-asset-info') return assets.get(url) ?? null;
    if (message === 'query-asset-meta') return metas.get(url);
    if (message === 'refresh-asset' || message === 'reimport-asset')
      return undefined;
    if (message === 'save-asset-meta') {
      metas.set(url, JSON.parse(String(args[1])));
      return metaSaveResult === 'object' ? assets.get(url) : metaSaveResult;
    }
    if (message === 'import-asset') {
      const destination = String(args[1]);
      const uuid = `${destination}@sprite`;
      const asset = { uuid: destination, type: 'cc.ImageAsset' };
      assets.set(destination, asset);
      assets.set(uuid, { uuid, type: 'cc.SpriteFrame' });
      metas.set(destination, {
        uuid: destination,
        userData: {},
        subMetas: {
          sprite: { uuid, importer: 'sprite-frame', userData: {} },
          texture: {
            uuid: `${destination}@texture`,
            importer: 'texture',
            userData: {},
          },
        },
      });
      return asset;
    }
    if (message === 'create-asset' || message === 'save-asset') {
      const asset = {
        uuid: url,
        isDirectory: args[1] === null,
        type: url.endsWith('.anim') ? 'cc.AnimationClip' : 'cc.JsonAsset',
      };
      assets.set(url, asset);
      return asset;
    }
    throw new Error(`Unexpected message ${message}`);
  });
  return { request, assets, metas };
}

describe('Cocos message adapter (mocked Editor)', () => {
  it('accepts the declared AssetInfo metadata-save response as well as runtime true', async () => {
    const { request } = fakeDatabase('object');
    await expect(
      importTestAssets(createCocos38Adapter(request), directory),
    ).resolves.toBe(`${TEST_DESTINATION}/walk.anim`);
  });
  it.each([false, null])(
    'rejects metadata-save failure %s before creating an animation',
    async (result) => {
      const { request } = fakeDatabase(result);
      await expect(
        importTestAssets(createCocos38Adapter(request), directory),
      ).rejects.toThrow('save-asset-meta failed');
      expect(request.mock.calls.some((call) => call[0] === 'scene')).toBe(
        false,
      );
    },
  );
  it('imports eight assets, updates pivot, resolves UUIDs in manifest order, and saves a clip', async () => {
    const { request, metas } = fakeDatabase();
    await importTestAssets(createCocos38Adapter(request), directory);
    const imports = request.mock.calls.filter(
      (call) => call[1] === 'import-asset',
    );
    expect(imports).toHaveLength(8);
    expect(imports.map((call) => call[3])).toEqual(
      manifest.frames.map((frame) => `${TEST_DESTINATION}/${frame}`),
    );
    const scene = request.mock.calls.find((call) => call[0] === 'scene');
    expect(scene?.[2]).toEqual({
      name: 'ai-sprite-generator',
      method: 'buildAnimation',
      args: [
        {
          manifest,
          uuids: manifest.frames.map(
            (frame) => `${TEST_DESTINATION}/${frame}@sprite`,
          ),
        },
      ],
    });
    expect(JSON.stringify([...metas.values()])).toContain('"pivotY":0');
    expect(
      request.mock.calls.some(
        (call) =>
          call[1] === 'create-asset' &&
          call[2] === `${TEST_DESTINATION}/walk.anim`,
      ),
    ).toBe(true);
  });
  it('reimports into the same destination without duplicate folders or clip', async () => {
    const { request, assets } = fakeDatabase();
    const adapter = createCocos38Adapter(request);
    await importTestAssets(adapter, directory);
    const count = assets.size;
    await importTestAssets(adapter, directory);
    expect(assets.size).toBe(count);
    expect(
      request.mock.calls.some(
        (call) =>
          call[1] === 'save-asset' &&
          call[2] === `${TEST_DESTINATION}/walk.anim`,
      ),
    ).toBe(true);
  });
  it('rejects destinations outside project sprite assets before sending messages', async () => {
    const { request } = fakeDatabase();
    await expect(
      createCocos38Adapter(request).importGeneration({
        sourceDirectory: directory,
        manifest,
        destination: 'db://assets/../library',
      }),
    ).rejects.toThrow('destination');
    expect(request).not.toHaveBeenCalled();
  });
  it('stops before writing when Asset Database is not ready', async () => {
    const request = vi.fn<Request>().mockResolvedValue(false);
    await expect(
      importTestAssets(createCocos38Adapter(request), directory),
    ).rejects.toThrow('not ready');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('rejects missing SpriteFrame metadata instead of guessing subasset UUIDs', async () => {
    const { request } = fakeDatabase();
    await expect(
      createCocos38Adapter(request).createAnimation(TEST_DESTINATION, manifest),
    ).rejects.toThrow();
    expect(request.mock.calls.some((call) => call[0] === 'scene')).toBe(false);
  });
});
