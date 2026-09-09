import type { GenerationManifest } from '@sprite/contracts';

export interface ImportInput {
  sourceDirectory: string;
  manifest: GenerationManifest;
  destination: string;
}
export interface CocosAdapter {
  importGeneration(input: ImportInput): Promise<void>;
  refreshAsset(url: string): Promise<void>;
  createAnimation(
    destination: string,
    manifest: GenerationManifest,
  ): Promise<void>;
}
