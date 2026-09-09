/// <reference types="@cocos/creator-types/editor" />
/// <reference types="@cocos/creator-types/engine" />
import path from 'node:path';
import { z } from 'zod';
import { manifestSchema, type GenerationManifest } from '@sprite/contracts';
import type { CocosAdapter, ImportInput } from './cocos-adapter';

const NAME = 'ai-sprite-generator';
// The npm tarball omits this global. Narrow declaration transcribed from the
// official 3.8.8 repository's editor-extends/utils/serialize/index.d.ts.
declare const EditorExtends: { serialize(object: object): string | object };
export type Request = (
  channel: string,
  message: string,
  ...args: unknown[]
) => Promise<unknown>;
const editorRequest: Request = (channel, message, ...args) =>
  Editor.Message.request(channel, message, ...args);
const infoSchema = z
  .object({
    uuid: z.string().min(1),
    type: z.string().optional(),
    isDirectory: z.boolean().optional(),
  })
  .passthrough();
const metaSchema = z
  .object({
    uuid: z.string(),
    userData: z.record(z.unknown()),
    subMetas: z.record(
      z
        .object({
          uuid: z.string(),
          importer: z.string(),
          userData: z.record(z.unknown()),
        })
        .passthrough(),
    ),
  })
  .passthrough();

function assertDestination(destination: string) {
  if (!/^db:\/\/assets\/AI_Sprites\/[a-zA-Z0-9_-]+$/.test(destination)) {
    throw new Error(
      'Import destination must be a child of db://assets/AI_Sprites.',
    );
  }
}

/** Cocos 3.8.8 declarations verified; runtime behavior must also pass PHASE_1_TEST.md. */
export function createCocos38Adapter(
  request: Request = editorRequest,
): CocosAdapter {
  const db = (message: string, ...args: unknown[]) =>
    request('asset-db', message, ...args);
  async function folder(url: string) {
    const existing = await db('query-asset-info', url);
    if (existing) {
      if (!infoSchema.parse(existing).isDirectory)
        throw new Error(`Destination is not a folder: ${url}`);
    } else {
      infoSchema.parse(await db('create-asset', url, null));
    }
  }
  async function put(url: string, content: string) {
    const exists = await db('query-asset-info', url);
    infoSchema.parse(
      await db(exists ? 'save-asset' : 'create-asset', url, content),
    );
  }
  async function configureFrame(url: string, manifest: GenerationManifest) {
    let meta = metaSchema.parse(await db('query-asset-meta', url));
    meta.userData.type = 'sprite-frame';
    infoSchema.parse(await db('save-asset-meta', url, JSON.stringify(meta)));
    await db('reimport-asset', url);
    meta = metaSchema.parse(await db('query-asset-meta', url));
    const sprites = Object.values(meta.subMetas).filter(
      (sub) => sub.importer === 'sprite-frame',
    );
    if (sprites.length !== 1)
      throw new Error(
        `Expected one SpriteFrame subasset in ${url}. Check the image importer in this Creator version.`,
      );
    for (const sub of Object.values(meta.subMetas)) {
      if (sub.importer === 'sprite-frame') {
        Object.assign(sub.userData, {
          trimType: 'none',
          pivotX: manifest.pivot.x,
          pivotY: manifest.pivot.y,
        });
      }
      if (sub.importer === 'texture') {
        Object.assign(sub.userData, {
          minfilter: 'nearest',
          magfilter: 'nearest',
          mipfilter: 'none',
        });
      }
    }
    infoSchema.parse(await db('save-asset-meta', url, JSON.stringify(meta)));
    await db('reimport-asset', url);
  }
  return {
    async importGeneration(input: ImportInput) {
      const { destination, sourceDirectory } = input;
      assertDestination(destination);
      const manifest = manifestSchema.parse(input.manifest);
      if (!(await db('query-ready')))
        throw new Error(
          'Asset Database is not ready. Wait for project import to finish.',
        );
      await folder('db://assets/AI_Sprites');
      await folder(destination);
      await folder(`${destination}/frames`);
      for (const frame of manifest.frames) {
        const url = `${destination}/${frame}`;
        infoSchema.parse(
          await db('import-asset', path.join(sourceDirectory, frame), url, {
            overwrite: true,
            rename: false,
          }),
        );
        await configureFrame(url, manifest);
      }
      await put(
        `${destination}/manifest.json`,
        JSON.stringify(manifest, null, 2),
      );
    },
    async refreshAsset(url: string) {
      assertDestination(url);
      await db('refresh-asset', url);
    },
    async createAnimation(destination: string, input: GenerationManifest) {
      assertDestination(destination);
      const manifest = manifestSchema.parse(input);
      const uuids: string[] = [];
      for (const frame of manifest.frames) {
        const meta = metaSchema.parse(
          await db('query-asset-meta', `${destination}/${frame}`),
        );
        const sprites = Object.values(meta.subMetas).filter(
          (sub) => sub.importer === 'sprite-frame',
        );
        const sprite = sprites[0];
        if (sprites.length !== 1 || !sprite)
          throw new Error(`SpriteFrame is missing or ambiguous: ${frame}`);
        const info = infoSchema.parse(
          await db('query-asset-info', sprite.uuid),
        );
        if (info.type !== 'cc.SpriteFrame')
          throw new Error(`Imported subasset is not a SpriteFrame: ${frame}`);
        uuids.push(sprite.uuid);
      }
      const serialized = z
        .string()
        .min(1)
        .parse(
          await request('scene', 'execute-scene-script', {
            name: NAME,
            method: 'buildAnimation',
            args: [{ manifest, uuids }],
          }),
        );
      JSON.parse(serialized); // Refuse malformed scene-script output before writing an asset.
      const url = `${destination}/${manifest.animation}.anim`;
      await put(url, serialized);
      await db('refresh-asset', url);
      const clip = infoSchema.parse(await db('query-asset-info', url));
      if (clip.type !== 'cc.AnimationClip')
        throw new Error(
          'walk.anim was written but Creator did not recognize it as an AnimationClip.',
        );
    },
  };
}

/** Executed exclusively in the scene process, where cc and EditorExtends exist. */
export function createSceneMethods(
  loadEngine: () => typeof import('cc'),
  serialize: (clip: import('cc').AnimationClip) => unknown,
) {
  return {
    async buildAnimation(input: unknown): Promise<string> {
      const { manifest, uuids } = z
        .object({
          manifest: manifestSchema,
          uuids: z.array(z.string().min(1)).length(8),
        })
        .strict()
        .parse(input);
      // Lazy require keeps the engine out of the extension main and panel processes.
      const { AnimationClip, SpriteFrame, assetManager } = loadEngine();
      const frames: import('cc').SpriteFrame[] = [];
      try {
        for (const uuid of uuids) {
          const frame = await new Promise<import('cc').SpriteFrame>(
            (resolve, reject) => {
              assetManager.loadAny(
                { uuid },
                (error: Error | null, asset: unknown) => {
                  if (error) reject(error);
                  else if (!(asset instanceof SpriteFrame))
                    reject(new Error(`Unable to load SpriteFrame ${uuid}`));
                  else resolve(asset);
                },
              );
            },
          );
          frame.addRef();
          frames.push(frame);
        }
        const clip = AnimationClip.createWithSpriteFrames(frames, manifest.fps);
        clip.name = manifest.animation;
        clip.wrapMode = manifest.loop
          ? AnimationClip.WrapMode.Loop
          : AnimationClip.WrapMode.Normal;
        clip.duration = manifest.frameCount / manifest.fps;
        const serialized = serialize(clip);
        return z
          .string()
          .min(1)
          .parse(
            typeof serialized === 'string'
              ? serialized
              : JSON.stringify(serialized),
          );
      } finally {
        for (const frame of frames) frame.decRef();
      }
    },
  };
}
export const sceneMethods = createSceneMethods(
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- cc exists only in the scene process.
  () => require('cc') as typeof import('cc'),
  (clip) => {
    if (
      typeof EditorExtends === 'undefined' ||
      typeof EditorExtends.serialize !== 'function'
    ) {
      throw new Error(
        'Creator scene serializer is unavailable. Open a scene and verify Cocos Creator 3.8.x.',
      );
    }
    return EditorExtends.serialize(clip);
  },
);

export function openPanel() {
  return Editor.Panel.open(NAME);
}
export function definePanel(
  options: Parameters<typeof Editor.Panel.define>[0],
) {
  return Editor.Panel.define(options);
}
export async function requestTestImport() {
  return z
    .object({ ok: z.boolean(), message: z.string() })
    .parse(await editorRequest(NAME, 'test-import'));
}
