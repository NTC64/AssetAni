import sharp from 'sharp';
import { z } from 'zod';
import { gridCells } from './grid';
import { removeBackground, cleanForeground } from './foreground';
export { gridCells } from './grid';
export { removeBackground, cleanForeground } from './foreground';
export { createSpritePackage } from './package';
export { runAnimationQa, type AnimationQaResult } from './qa';

export const PNG_OPTIONS = {
  compressionLevel: 9,
  adaptiveFiltering: true,
} as const;
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };
const SOURCE_WIDTH = 1024;
const SOURCE_HEIGHT = 512;
export class SpriteProcessingError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_IMAGE'
      | 'INVALID_BACKGROUND'
      | 'INVALID_GRID'
      | 'EMPTY_FRAME'
      | 'INSUFFICIENT_MOTION'
      | 'INCONSISTENT_CHARACTER',
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

export interface AnimationQualityDiagnostics {
  transitionRatios: number[];
  meanTransitionRatio: number;
  maximumTransitionRatio: number;
  maximumPaletteDrift: number;
}

/** Measures visible silhouette motion and coarse palette stability across normalized frames. */
export async function inspectAnimationQuality(
  frames: Buffer[],
): Promise<AnimationQualityDiagnostics> {
  if (frames.length !== 8)
    throw new Error('Animation quality inspection requires eight frames.');
  const decoded = await Promise.all(
    frames.map((frame) => sharp(frame).ensureAlpha().raw().toBuffer()),
  );
  const frameColors = decoded.map((rgba) => {
    let red = 0;
    let green = 0;
    let blue = 0;
    let pixels = 0;
    for (let offset = 0; offset < rgba.length; offset += 4) {
      if (rgba[offset + 3]! < 16) continue;
      red += rgba[offset]!;
      green += rgba[offset + 1]!;
      blue += rgba[offset + 2]!;
      pixels++;
    }
    if (pixels === 0) return [0, 0, 0] as const;
    return [red / pixels, green / pixels, blue / pixels] as const;
  });
  const median = [0, 1, 2].map((channel) => {
    const values = frameColors
      .map((color) => color[channel]!)
      .sort((left, right) => left - right);
    return (values[3]! + values[4]!) / 2;
  });
  const maximumPaletteDrift = Math.max(
    ...frameColors.map((color) =>
      Math.hypot(
        color[0] - median[0]!,
        color[1] - median[1]!,
        color[2] - median[2]!,
      ),
    ),
  );
  const transitionRatios = decoded.slice(1).map((rgba, index) => {
    const previous = decoded[index]!;
    let changed = 0;
    let union = 0;
    for (let offset = 3; offset < rgba.length; offset += 4) {
      const before = previous[offset]! >= 16;
      const after = rgba[offset]! >= 16;
      if (before || after) union++;
      if (before !== after) changed++;
    }
    return union === 0 ? 0 : changed / union;
  });
  return {
    transitionRatios,
    meanTransitionRatio:
      transitionRatios.reduce((sum, value) => sum + value, 0) /
      transitionRatios.length,
    maximumTransitionRatio: Math.max(...transitionRatios),
    maximumPaletteDrift,
  };
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

export async function normalizeFrame(
  inputBuffer: Buffer,
  targetFrameSize: 128 | 256 = 256,
) {
  const prepared = await prepareFrame(inputBuffer);
  const safeSize = targetFrameSize - 16;
  const scale = Math.min(
    safeSize / prepared.foreground.bounds.width,
    safeSize / prepared.foreground.bounds.height,
  );
  return renderPreparedFrame(prepared, scale, false, targetFrameSize);
}

type PreparedFrame = Awaited<ReturnType<typeof prepareFrame>>;

async function prepareFrame(inputBuffer: Buffer) {
  const { data, info } = await sharp(inputBuffer, {
    limitInputPixels: 1024 * 1024,
  })
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const hasTransparency = data.some(
    (channel, index) => index % 4 === 3 && channel < 255,
  );
  const rgba = hasTransparency
    ? Buffer.from(data)
    : removeBackground(data, info.width, info.height);
  const foreground = cleanForeground(rgba, info.width, info.height);
  return { rgba, info, foreground, preservedSourceAlpha: hasTransparency };
}

function lowerBodyAnchorX(frame: PreparedFrame): number {
  const { rgba, info, foreground } = frame;
  const { bounds } = foreground;
  // Use only the foot band so a low sword swing or trailing cape has little
  // influence on the character's horizontal anchor.
  const lowerBodyTop = bounds.top + Math.floor(bounds.height * 0.8);
  const columns: number[] = [];
  for (let y = lowerBodyTop; y < bounds.top + bounds.height; y++)
    for (let x = bounds.left; x < bounds.left + bounds.width; x++)
      if (rgba[(y * info.width + x) * 4 + 3]! >= 16) columns.push(x);
  if (columns.length === 0) return bounds.left + bounds.width / 2;
  columns.sort((left, right) => left - right);
  const middle = Math.floor(columns.length / 2);
  return columns.length % 2 === 0
    ? (columns[middle - 1]! + columns[middle]!) / 2
    : columns[middle]!;
}

async function renderPreparedFrame(
  prepared: PreparedFrame,
  scale: number,
  stableLowerBodyAnchor: boolean,
  targetFrameSize = 256,
) {
  const { rgba, info, foreground } = prepared;
  const width = Math.max(
    1,
    Math.min(targetFrameSize - 16, Math.round(foreground.bounds.width * scale)),
  );
  const height = Math.max(
    1,
    Math.min(
      targetFrameSize - 16,
      Math.round(foreground.bounds.height * scale),
    ),
  );
  const anchorX = lowerBodyAnchorX(prepared);
  const scaledAnchorX = (anchorX - foreground.bounds.left + 0.5) * scale;
  const centeredLeft = Math.floor((targetFrameSize - width) / 2);
  const left = stableLowerBodyAnchor
    ? Math.max(
        0,
        Math.min(
          targetFrameSize - width,
          Math.round(targetFrameSize / 2 - scaledAnchorX),
        ),
      )
    : centeredLeft;
  const top = targetFrameSize - height - 8;
  const sprite = await sharp(rgba, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .extract(foreground.bounds)
    .resize(width, height, { kernel: sharp.kernel.nearest })
    .png(PNG_OPTIONS)
    .toBuffer();
  const png = await sharp({
    create: {
      width: targetFrameSize,
      height: targetFrameSize,
      channels: 4,
      background: TRANSPARENT,
    },
  })
    .composite([{ input: sprite, left, top }])
    .png(PNG_OPTIONS)
    .toBuffer();
  return {
    png,
    diagnostics: {
      ...foreground,
      scale,
      lowerBodyAnchorX: anchorX,
      output: { left, top, width, height },
    },
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
    targetFrameSize: z.union([z.literal(128), z.literal(256)]).default(256),
    style: z.literal('pixel_art').default('pixel_art'),
    animation: z
      .enum(['idle', 'walk', 'run', 'attack', 'hurt', 'death'])
      .default('walk'),
  })
  .strict();

const frameProcessSchema = z
  .object({
    frames: z
      .array(
        z
          .instanceof(Buffer)
          .refine(
            (value) => value.length > 0 && value.length <= 16 * 1024 * 1024,
            'Each frame must be 1–16 MiB.',
          ),
      )
      .length(8),
    animation: z
      .enum(['idle', 'walk', 'run', 'attack', 'hurt', 'death'])
      .default('walk'),
    targetFrameSize: z.union([z.literal(128), z.literal(256)]).default(256),
    qualityGate: z.boolean().default(true),
  })
  .strict();

async function finishFrames(
  preparedFrames: PreparedFrame[],
  animation: 'idle' | 'walk' | 'run' | 'attack' | 'hurt' | 'death',
  background: BackgroundDiagnostics | null,
  targetFrameSize: 128 | 256,
  qualityGate = true,
) {
  // One scale for the entire take prevents the character from visibly growing
  // and shrinking as a weapon or limb changes the per-frame silhouette.
  const anchorExtents = preparedFrames.map((frame) => {
    const anchorX = lowerBodyAnchorX(frame);
    return {
      left: anchorX - frame.foreground.bounds.left + 0.5,
      right:
        frame.foreground.bounds.left +
        frame.foreground.bounds.width -
        anchorX -
        0.5,
    };
  });
  const commonScale = Math.min(
    (targetFrameSize - 16) /
      Math.max(
        ...preparedFrames.map(({ foreground }) => foreground.bounds.height),
      ),
    (targetFrameSize / 2 - 8) /
      Math.max(...anchorExtents.map(({ left }) => left)),
    (targetFrameSize / 2 - 8) /
      Math.max(...anchorExtents.map(({ right }) => right)),
  );
  const normalizedFrames = await Promise.all(
    preparedFrames.map((frame) =>
      renderPreparedFrame(frame, commonScale, true, targetFrameSize),
    ),
  );
  const frames = normalizedFrames.map(({ png }) => png);
  const diagnostics = normalizedFrames.map(({ diagnostics }) => diagnostics);
  const touchingFrames = diagnostics
    .map((frame, index) => (frame.touchesEdge ? index : -1))
    .filter((index) => index >= 0);
  if (touchingFrames.length > 0) {
    throw new SpriteProcessingError(
      'INVALID_GRID',
      `Foreground touches a source frame boundary in frame(s): ${touchingFrames.join(', ')}.`,
      {
        touchingFrames,
        boundaryPixels: diagnostics.map((frame) => frame.boundaryPixels),
        background,
      },
    );
  }
  const animationQuality = await inspectAnimationQuality(frames);
  const minimumMotion =
    animation === 'idle'
      ? { mean: 0.02, maximum: 0.035 }
      : animation === 'walk' || animation === 'run'
        ? { mean: 0.1, maximum: 0.12 }
        : { mean: 0.12, maximum: 0.14 };
  if (
    qualityGate &&
    (animationQuality.meanTransitionRatio < minimumMotion.mean ||
      animationQuality.maximumTransitionRatio < minimumMotion.maximum)
  ) {
    throw new SpriteProcessingError(
      'INSUFFICIENT_MOTION',
      `Frames do not show enough ${animation} motion (mean ${(animationQuality.meanTransitionRatio * 100).toFixed(1)}%, maximum ${(animationQuality.maximumTransitionRatio * 100).toFixed(1)}%).`,
      { animation, minimumMotion, animationQuality },
    );
  }
  if (qualityGate && animationQuality.maximumPaletteDrift > 35) {
    throw new SpriteProcessingError(
      'INCONSISTENT_CHARACTER',
      `Character colors change too much between frames (maximum palette drift ${animationQuality.maximumPaletteDrift.toFixed(1)}).`,
      { animation, maximumPaletteDrift: 35, animationQuality },
    );
  }
  const sheet = await sharp({
    create: {
      width: targetFrameSize * 4,
      height: targetFrameSize * 2,
      channels: 4,
      background: TRANSPARENT,
    },
  })
    .composite(
      frames.map((frame, index) => ({
        input: frame,
        left: (index % 4) * targetFrameSize,
        top: Math.floor(index / 4) * targetFrameSize,
      })),
    )
    .png(PNG_OPTIONS)
    .toBuffer();
  return { frames, sheet, diagnostics, background, animationQuality };
}

/** Processes provider-ordered source frames without inferring or slicing an AI grid. */
export async function processAnimationFrames(
  input: z.input<typeof frameProcessSchema>,
) {
  const { frames, animation, targetFrameSize, qualityGate } =
    frameProcessSchema.parse(input);
  const preparedFrames: PreparedFrame[] = [];
  for (const [index, frame] of frames.entries()) {
    try {
      preparedFrames.push(await prepareFrame(frame));
    } catch (error) {
      throw new SpriteProcessingError(
        'EMPTY_FRAME',
        `Frame ${index}: ${error instanceof Error ? error.message : 'normalization failed'}`,
      );
    }
  }
  return finishFrames(
    preparedFrames,
    animation,
    null,
    targetFrameSize,
    qualityGate,
  );
}

export async function processSpriteSheet(input: z.input<typeof processSchema>) {
  const { inputBuffer, rows, columns, animation, targetFrameSize } =
    processSchema.parse(input);
  let source: Buffer;
  try {
    const decoded = sharp(inputBuffer, {
      limitInputPixels: SOURCE_WIDTH * SOURCE_HEIGHT,
    });
    const metadata = await decoded.metadata();
    if (
      metadata.format !== 'png' ||
      metadata.width !== SOURCE_WIDTH ||
      metadata.height !== SOURCE_HEIGHT ||
      (metadata.pages ?? 1) !== 1
    ) {
      throw new Error('Expected a single 1024 x 512 PNG.');
    }
    source = await decoded.toColourspace('srgb').ensureAlpha().raw().toBuffer();
  } catch {
    throw new SpriteProcessingError(
      'INVALID_IMAGE',
      'Expected a valid single 1024 x 512 PNG.',
    );
  }
  const background = inspectBackground(source, SOURCE_WIDTH, SOURCE_HEIGHT);
  if (
    background.corePixelRatio < 0.55 ||
    background.coreBorderRatio < 0.9 ||
    background.connectedBackgroundStandardDeviation > 8
  ) {
    throw new SpriteProcessingError(
      'INVALID_BACKGROUND',
      `Background cannot be safely isolated near #F4F4F4 (core ${(background.corePixelRatio * 100).toFixed(1)}%, border ${(background.coreBorderRatio * 100).toFixed(1)}%, connected deviation ${background.connectedBackgroundStandardDeviation.toFixed(2)}).`,
      background,
    );
  }
  const preparedFrames: PreparedFrame[] = [];
  for (const [index, cell] of gridCells(
    SOURCE_WIDTH,
    SOURCE_HEIGHT,
    columns,
    rows,
  ).entries()) {
    const sliced = await sharp(inputBuffer)
      .extract(cell)
      .png(PNG_OPTIONS)
      .toBuffer();
    try {
      preparedFrames.push(await prepareFrame(sliced));
    } catch (error) {
      throw new SpriteProcessingError(
        'EMPTY_FRAME',
        `Frame ${index}: ${error instanceof Error ? error.message : 'normalization failed'}`,
      );
    }
  }
  return finishFrames(preparedFrames, animation, background, targetFrameSize);
}
