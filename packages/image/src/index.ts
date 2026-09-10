import sharp from 'sharp';
import { z } from 'zod';
import { gridCells } from './grid';
import { removeBackground, cleanForeground } from './foreground';
export { gridCells } from './grid';
export { removeBackground, cleanForeground } from './foreground';
export { createSpritePackage } from './package';

export const PNG_OPTIONS = {
  compressionLevel: 9,
  adaptiveFiltering: true,
} as const;
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };
export class SpriteProcessingError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_IMAGE'
      | 'INVALID_BACKGROUND'
      | 'INVALID_GRID'
      | 'EMPTY_FRAME',
    message: string,
    public readonly details?: object,
  ) {
    super(message);
    this.name = 'SpriteProcessingError';
  }
}

export interface BackgroundDiagnostics {
  corePixelRatio: number;
  coreBorderRatio: number;
  connectedBackgroundMeanDistance: number;
  connectedBackgroundStandardDeviation: number;
  coreDistance: 18;
  connectedDistance: 60;
  borderWidth: 8;
}

/** Conservative contract check: the requested background must dominate and remain flat from the canvas edge inward. */
export function inspectBackground(
  rgba: Buffer,
  width: number,
  height: number,
): BackgroundDiagnostics {
  if (rgba.length !== width * height * 4)
    throw new Error('RGBA dimensions do not match buffer.');
  let corePixels = 0;
  let borderPixels = 0;
  let coreBorderPixels = 0;
  const borderWidth = 8;
  const pixelCount = width * height;
  const distances = new Float32Array(pixelCount);
  const connectedCandidates = new Uint8Array(pixelCount);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const transparent = rgba[offset + 3]! < 16;
      const distance = transparent
        ? 0
        : Math.hypot(
            rgba[offset]! - 244,
            rgba[offset + 1]! - 244,
            rgba[offset + 2]! - 244,
          );
      distances[y * width + x] = distance;
      const core = transparent || distance <= 18;
      if (transparent || distance <= 60) connectedCandidates[y * width + x] = 1;
      if (core) corePixels++;
      if (
        x < borderWidth ||
        y < borderWidth ||
        x >= width - borderWidth ||
        y >= height - borderWidth
      ) {
        borderPixels++;
        if (core) coreBorderPixels++;
      }
    }

  // Follow background-like pixels from the image edge. This measures variation in
  // the actual background region without counting isolated light character detail.
  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let head = 0;
  let tail = 0;
  const enqueue = (index: number) => {
    if (connectedCandidates[index] && !visited[index]) {
      visited[index] = 1;
      queue[tail++] = index;
    }
  };
  for (let x = 0; x < width; x++) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }
  let distanceSum = 0;
  let squaredDistanceSum = 0;
  while (head < tail) {
    const index = queue[head++]!;
    const x = index % width;
    const y = Math.floor(index / width);
    const distance = distances[index]!;
    distanceSum += distance;
    squaredDistanceSum += distance * distance;
    if (x > 0) enqueue(index - 1);
    if (x + 1 < width) enqueue(index + 1);
    if (y > 0) enqueue(index - width);
    if (y + 1 < height) enqueue(index + width);
  }
  const mean = tail === 0 ? Number.POSITIVE_INFINITY : distanceSum / tail;
  const variance =
    tail === 0
      ? Number.POSITIVE_INFINITY
      : Math.max(0, squaredDistanceSum / tail - mean * mean);
  return {
    corePixelRatio: corePixels / pixelCount,
    coreBorderRatio: coreBorderPixels / borderPixels,
    connectedBackgroundMeanDistance: mean,
    connectedBackgroundStandardDeviation: Math.sqrt(variance),
    coreDistance: 18,
    connectedDistance: 60,
    borderWidth,
  };
}

export async function normalizeFrame(inputBuffer: Buffer) {
  const { data, info } = await sharp(inputBuffer, {
    limitInputPixels: 1024 * 1024,
  })
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgba = removeBackground(data);
  const foreground = cleanForeground(rgba, info.width, info.height);
  const scale = Math.min(
    240 / foreground.bounds.width,
    240 / foreground.bounds.height,
  );
  const width = Math.max(
    1,
    Math.min(240, Math.round(foreground.bounds.width * scale)),
  );
  const height = Math.max(
    1,
    Math.min(240, Math.round(foreground.bounds.height * scale)),
  );
  const left = Math.floor((256 - width) / 2);
  const top = 256 - height - 8;
  const sprite = await sharp(rgba, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .extract(foreground.bounds)
    .resize(width, height, { kernel: sharp.kernel.nearest })
    .png(PNG_OPTIONS)
    .toBuffer();
  const png = await sharp({
    create: { width: 256, height: 256, channels: 4, background: TRANSPARENT },
  })
    .composite([{ input: sprite, left, top }])
    .png(PNG_OPTIONS)
    .toBuffer();
  return {
    png,
    diagnostics: { ...foreground, scale, output: { left, top, width, height } },
  };
}

const processSchema = z
  .object({
    inputBuffer: z
      .instanceof(Buffer)
      .refine(
        (value) => value.length > 0 && value.length <= 16 * 1024 * 1024,
        'Input must be 1–16 MiB.',
      ),
    rows: z.literal(2).default(2),
    columns: z.literal(4).default(4),
    targetFrameSize: z.literal(256).default(256),
    style: z.literal('pixel_art').default('pixel_art'),
  })
  .strict();

export async function processSpriteSheet(input: z.input<typeof processSchema>) {
  const { inputBuffer, rows, columns } = processSchema.parse(input);
  let source: Buffer;
  try {
    const decoded = sharp(inputBuffer, {
      limitInputPixels: 1024 * 1024,
    });
    const metadata = await decoded.metadata();
    if (
      metadata.format !== 'png' ||
      metadata.width !== 1024 ||
      metadata.height !== 1024 ||
      (metadata.pages ?? 1) !== 1
    ) {
      throw new Error('Expected a single 1024 x 1024 PNG.');
    }
    source = await decoded.toColourspace('srgb').ensureAlpha().raw().toBuffer();
  } catch {
    throw new SpriteProcessingError(
      'INVALID_IMAGE',
      'Expected a valid single 1024 x 1024 PNG.',
    );
  }
  const background = inspectBackground(source, 1024, 1024);
  if (
    background.corePixelRatio < 0.55 ||
    background.coreBorderRatio < 0.9 ||
    background.connectedBackgroundStandardDeviation > 3
  ) {
    throw new SpriteProcessingError(
      'INVALID_BACKGROUND',
      `Background is not sufficiently flat near #F4F4F4 (core ${(background.corePixelRatio * 100).toFixed(1)}%, border ${(background.coreBorderRatio * 100).toFixed(1)}%, connected deviation ${background.connectedBackgroundStandardDeviation.toFixed(2)}).`,
      background,
    );
  }
  const frames: Buffer[] = [];
  const diagnostics: Awaited<
    ReturnType<typeof normalizeFrame>
  >['diagnostics'][] = [];
  for (const [index, cell] of gridCells(1024, 1024, columns, rows).entries()) {
    const sliced = await sharp(inputBuffer)
      .extract(cell)
      .png(PNG_OPTIONS)
      .toBuffer();
    try {
      const normalized = await normalizeFrame(sliced);
      frames.push(normalized.png);
      diagnostics.push(normalized.diagnostics);
    } catch (error) {
      throw new SpriteProcessingError(
        'EMPTY_FRAME',
        `Frame ${index}: ${error instanceof Error ? error.message : 'normalization failed'}`,
      );
    }
  }
  const touchingFrames = diagnostics
    .map((frame, index) => (frame.touchesEdge ? index : -1))
    .filter((index) => index >= 0);
  if (touchingFrames.length > 0) {
    throw new SpriteProcessingError(
      'INVALID_GRID',
      `Foreground touches a fixed 4x2 cell boundary in frame(s): ${touchingFrames.join(', ')}.`,
      { touchingFrames, background },
    );
  }
  const sheet = await sharp({
    create: { width: 1024, height: 512, channels: 4, background: TRANSPARENT },
  })
    .composite(
      frames.map((frame, index) => ({
        input: frame,
        left: (index % 4) * 256,
        top: Math.floor(index / 4) * 256,
      })),
    )
    .png(PNG_OPTIONS)
    .toBuffer();
  return { frames, sheet, diagnostics, background };
}
