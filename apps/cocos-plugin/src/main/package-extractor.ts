import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { manifestSchema, type GenerationManifest } from '@sprite/contracts';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAXIMUM_UNCOMPRESSED_BYTES = 60 * 1024 * 1024;

function assertPng(
  bytes: Uint8Array,
  width: number,
  height: number,
  filename: string,
) {
  const buffer = Buffer.from(bytes);
  if (
    buffer.length < 33 ||
    !buffer.subarray(0, 8).equals(PNG_SIGNATURE) ||
    buffer.toString('ascii', 12, 16) !== 'IHDR' ||
    buffer.readUInt32BE(16) !== width ||
    buffer.readUInt32BE(20) !== height
  )
    throw new Error(`Invalid ${width} x ${height} PNG: ${filename}`);
}

export async function extractSpritePackage(
  archive: Buffer,
  expectedGenerationId: string,
) {
  if (archive.length === 0 || archive.length > 32 * 1024 * 1024)
    throw new Error('Result ZIP must be between 1 byte and 32 MiB.');
  const discovered = new Set<string>();
  let totalSize = 0;
  const files = unzipSync(archive, {
    filter(file) {
      if (
        !(
          file.name === 'manifest.json' ||
          file.name === 'sheet.png' ||
          /^frames\/(?:frame_)?0[0-7]\.png$/.test(file.name)
        ) ||
        discovered.has(file.name)
      )
        throw new Error(`Unsafe or duplicate ZIP entry: ${file.name}`);
      discovered.add(file.name);
      totalSize += file.originalSize;
      const fileLimit =
        file.name === 'manifest.json' ? 64 * 1024 : 20 * 1024 * 1024;
      if (
        file.originalSize > fileLimit ||
        totalSize > MAXIMUM_UNCOMPRESSED_BYTES ||
        discovered.size > 10
      )
        throw new Error('Result ZIP exceeds extraction limits.');
      return true;
    },
  });
  const manifestBytes = files['manifest.json'];
  if (!manifestBytes) throw new Error('Result ZIP has no manifest.json.');
  const manifest = manifestSchema.parse(
    JSON.parse(Buffer.from(manifestBytes).toString('utf8')),
  );
  if (manifest.generationId !== expectedGenerationId)
    throw new Error(
      'Result manifest generation ID does not match the request.',
    );
  const expected = new Set(['manifest.json', 'sheet.png', ...manifest.frames]);
  if (
    Object.keys(files).length !== expected.size ||
    Object.keys(files).some((filename) => !expected.has(filename))
  )
    throw new Error('Result ZIP contents do not match its manifest.');
  const sheet = files['sheet.png'];
  if (!sheet) throw new Error('Result ZIP has no sheet.png.');
  assertPng(sheet, 1024, 512, 'sheet.png');
  for (const frame of manifest.frames) {
    const bytes = files[frame];
    if (!bytes) throw new Error(`Result ZIP is missing ${frame}.`);
    assertPng(bytes, 256, 256, frame);
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), 'sprite-plugin-'));
  try {
    for (const [filename, bytes] of Object.entries(files)) {
      const destination = path.join(directory, filename);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    directory,
    manifest,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  } satisfies {
    directory: string;
    manifest: GenerationManifest;
    cleanup: () => Promise<void>;
  };
}
