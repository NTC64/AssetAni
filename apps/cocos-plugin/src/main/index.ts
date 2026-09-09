import path from 'node:path';
import { createCocos38Adapter, openPanel } from '../cocos/cocos-3.8-adapter';
import { importTestAssets } from './asset-importer';

let importing = false;
export const methods = {
  openPanel,
  async testImport() {
    if (importing)
      return {
        ok: false,
        message: 'An import is already running. Please wait.',
      };
    importing = true;
    try {
      console.info('[sprite] Starting local eight-frame import.');
      const url = await importTestAssets(
        createCocos38Adapter(),
        path.join(__dirname, '../../test-assets'),
      );
      console.info('[sprite] Import finished:', url);
      return {
        ok: true,
        message: `Created ${url} — 8 frames, 12 FPS, 0.667 seconds.`,
      };
    } catch (error: unknown) {
      console.error('[sprite] Test Import failed:', error);
      return {
        ok: false,
        message:
          'Could not import the test animation. Open a scene, check the extension Console for details, and retry. Existing unrelated assets are preserved.',
      };
    } finally {
      importing = false;
    }
  },
};
export function load() {}
export function unload() {}
