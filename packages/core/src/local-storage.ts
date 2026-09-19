import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const resultFiles = {
  'result.zip': 'application/zip',
  'sheet.png': 'image/png',
  'manifest.json': 'application/json; charset=utf-8',
} as const;
export type PublicResultFilename = keyof typeof resultFiles;

export class LocalResultStorage {
  constructor(public readonly root: string) {}

  async persist(generationId: string, sourceDirectory: string) {
    const destination = this.generationDirectory(generationId);
    await rm(destination, { recursive: true, force: true });
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(sourceDirectory, destination, { recursive: true });
    return {
      rawKey: `${generationId}/raw.png`,
      sheetKey: `${generationId}/sheet.png`,
      packageKey: `${generationId}/result.zip`,
      manifestKey: `${generationId}/manifest.json`,
    };
  }

  async persistDiagnostics(generationId: string, sourceDirectory: string) {
    const destination = this.generationDirectory(generationId);
    await rm(destination, { recursive: true, force: true });
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(sourceDirectory, destination, { recursive: true });
    return destination;
  }

  async persistCharacterBase(characterId: string, image: Buffer) {
    const destination = this.characterBasePath(characterId);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, image);
    return `characters/${characterId}/base.png`;
  }

  async readCharacterBase(key: string) {
    const match = /^characters\/([0-9a-f-]{36})\/base\.png$/i.exec(key);
    if (!match) throw new Error('Invalid character storage key.');
    return readFile(this.characterBasePath(match[1]!));
  }

  async readPublicFile(generationId: string, filename: string) {
    if (!(filename in resultFiles)) return undefined;
    const typedFilename = filename as PublicResultFilename;
    const file = path.join(
      this.generationDirectory(generationId),
      typedFilename,
    );
    try {
      const details = await stat(file);
      if (!details.isFile()) return undefined;
      return {
        body: await readFile(file),
        contentType: resultFiles[typedFilename],
      };
    } catch {
      return undefined;
    }
  }

  private generationDirectory(generationId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(generationId))
      throw new Error('Invalid generation storage identifier.');
    return path.resolve(this.root, generationId);
  }

  private characterBasePath(characterId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(characterId))
      throw new Error('Invalid character storage identifier.');
    return path.resolve(this.root, 'characters', characterId, 'base.png');
  }
}
