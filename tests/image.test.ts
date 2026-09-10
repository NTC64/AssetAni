import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  gridCells,
  removeBackground,
  cleanForeground,
  normalizeFrame,
  processSpriteSheet,
  inspectBackground,
} from '../packages/image/src';
import { createFakeProvider } from '../packages/ai/src/fake-provider';

async function rectangleImage(
  width: number,
  height: number,
  left: number,
  top: number,
  w: number,
  h: number,
) {
  const rgba = Buffer.alloc(width * height * 4, 244);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  for (let y = top; y < top + h; y++)
    for (let x = left; x < left + w; x++) {
      rgba.set([180, 20, 40, 255], (y * width + x) * 4);
    }
  return sharp(rgba, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

describe('grid slicing', () => {
  it('slices the 1024 square in row-major 256 x 512 cells', () => {
    const cells = gridCells(1024, 1024);
    expect(cells).toHaveLength(8);
    expect(cells[0]).toEqual({ left: 0, top: 0, width: 256, height: 512 });
    expect(cells[4]).toEqual({ left: 0, top: 512, width: 256, height: 512 });
    expect(cells[7]).toEqual({ left: 768, top: 512, width: 256, height: 512 });
  });
  it('covers non-divisible dimensions exactly once with rounded boundaries', async () => {
    const width = 1025,
      height = 1027;
    const coverage = new Uint8Array(width * height);
    const source = await rectangleImage(width, height, 0, 0, width, height);
    for (const cell of gridCells(width, height)) {
      const extracted = await sharp(source)
        .extract(cell)
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(extracted.info.width).toBe(cell.width);
      expect(extracted.info.height).toBe(cell.height);
      for (let y = cell.top; y < cell.top + cell.height; y++)
        for (let x = cell.left; x < cell.left + cell.width; x++)
          coverage[y * width + x] = coverage[y * width + x]! + 1;
    }
    expect(coverage.every((count) => count === 1)).toBe(true);
    expect(gridCells(width, height)[0]!.height).toBe(514);
  });
  it.each([
    [0, 1024],
    [1, 1],
    [1024.5, 1024],
    [-1, 1024],
  ])('rejects unusable geometry %j', (width, height) => {
    expect(() => gridCells(width, height)).toThrow();
  });
});

describe('flat-background removal and noise', () => {
  it('measures both whole-image and border adherence to #F4F4F4', () => {
    const rgba = Buffer.alloc(20 * 20 * 4, 244);
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    expect(inspectBackground(rgba, 20, 20)).toMatchObject({
      corePixelRatio: 1,
      coreBorderRatio: 1,
      connectedBackgroundMeanDistance: 0,
      connectedBackgroundStandardDeviation: 0,
      coreDistance: 18,
      connectedDistance: 60,
      borderWidth: 8,
    });
  });
  it('removes #F4F4F4, interpolates edge alpha, and preserves foreground alpha', () => {
    const source = Buffer.from([
      244, 244, 244, 255, 226, 244, 244, 255, 219, 244, 244, 255, 209, 244, 244,
      128, 10, 20, 30, 15,
    ]);
    const output = removeBackground(source);
    expect([output[3], output[7], output[11], output[15], output[19]]).toEqual([
      0, 0, 105, 128, 0,
    ]);
    expect(source[3]).toBe(255);
  });
  it('removes specks while retaining significant detached character parts', () => {
    const rgba = Buffer.alloc(100 * 100 * 4);
    function square(x: number, y: number, size: number) {
      for (let yy = y; yy < y + size; yy++)
        for (let xx = x; xx < x + size; xx++)
          rgba[(yy * 100 + xx) * 4 + 3] = 255;
    }
    square(20, 20, 10);
    square(50, 40, 8);
    square(0, 0, 2);
    const clean = cleanForeground(rgba, 100, 100);
    expect(clean.bounds).toEqual({ left: 20, top: 20, width: 38, height: 28 });
    expect(clean.components).toBe(2);
    expect(clean.removedComponents).toBe(1);
    expect(rgba[3]).toBe(0);
  });
  it('treats diagonally touching pixels as connected', () => {
    const rgba = Buffer.alloc(100 * 100 * 4);
    for (let i = 0; i < 80; i++) rgba[(i * 100 + i) * 4 + 3] = 255;
    expect(cleanForeground(rgba, 100, 100).components).toBe(1);
  });
  it('rejects empty foreground rather than silently exporting a blank frame', () => {
    expect(() => cleanForeground(Buffer.alloc(40 * 40 * 4), 40, 40)).toThrow(
      'No foreground',
    );
  });
});

describe('normalization', () => {
  it.each([
    [40, 120],
    [120, 40],
    [240, 400],
  ])(
    'fits %i x %i into 240 square with exactly 8px bottom margin',
    async (width, height) => {
      const input = await rectangleImage(256, 512, 8, 10, width, height);
      const result = await normalizeFrame(input);
      const { data, info } = await sharp(result.png)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(info.width).toBe(256);
      expect(info.height).toBe(256);
      const { bounds } = cleanForeground(Buffer.from(data), 256, 256);
      expect(bounds.top + bounds.height).toBe(248);
      expect(bounds.width).toBeLessThanOrEqual(240);
      expect(bounds.height).toBeLessThanOrEqual(240);
      expect(
        Math.abs(bounds.left - (256 - bounds.width - bounds.left)),
      ).toBeLessThanOrEqual(1);
      for (let y = 248; y < 256; y++)
        for (let x = 0; x < 256; x++)
          expect(data[(y * 256 + x) * 4 + 3]).toBe(0);
      // Nearest-neighbor output has no new opaque colors or antialiased edge alpha.
      for (let i = 0; i < data.length; i += 4)
        if (data[i + 3]) {
          expect(Array.from(data.subarray(i, i + 4))).toEqual([
            180, 20, 40, 255,
          ]);
        }
    },
  );
  it('produces eight RGBA PNGs and the canonical 1024 x 512 sheet', async () => {
    const source = await createFakeProvider().generate({
      prompt: 'blue knight',
      animation: 'walk',
      direction: 'right',
      frameCount: 8,
      seed: 3,
    });
    const result = await processSpriteSheet({ inputBuffer: source.image });
    expect(result.frames).toHaveLength(8);
    expect(await sharp(result.sheet).metadata()).toMatchObject({
      width: 1024,
      height: 512,
      format: 'png',
      hasAlpha: true,
    });
    for (const [index, frame] of result.frames.entries()) {
      const raw = await sharp(frame).raw().toBuffer();
      const slice = await sharp(result.sheet)
        .extract({
          left: (index % 4) * 256,
          top: Math.floor(index / 4) * 256,
          width: 256,
          height: 256,
        })
        .raw()
        .toBuffer();
      expect(slice.equals(raw)).toBe(true);
    }
    expect(
      new Set(result.frames.map((frame) => frame.toString('base64'))).size,
    ).toBe(8);
  });
  it('rejects incorrect dimensions and corrupt PNGs', async () => {
    await expect(
      processSpriteSheet({
        inputBuffer: await rectangleImage(100, 100, 10, 10, 20, 20),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    await expect(
      processSpriteSheet({ inputBuffer: Buffer.from('bad') }),
    ).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
  });
  it('rejects an empty cell with its frame index', async () => {
    const blank = await sharp({
      create: { width: 1024, height: 1024, channels: 4, background: '#F4F4F4' },
    })
      .png()
      .toBuffer();
    await expect(
      processSpriteSheet({ inputBuffer: blank }),
    ).rejects.toMatchObject({
      code: 'EMPTY_FRAME',
      message: expect.stringContaining('Frame 0'),
    });
  });
  it('rejects a non-flat provider background before normalization', async () => {
    const gradientLike = await sharp({
      create: {
        width: 1024,
        height: 1024,
        channels: 4,
        background: { r: 226, g: 232, b: 236, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    await expect(
      processSpriteSheet({ inputBuffer: gradientLike }),
    ).rejects.toMatchObject({
      code: 'INVALID_BACKGROUND',
      details: {
        corePixelRatio: 0,
        coreBorderRatio: 0,
      },
    });
  });
  it('rejects subtle interior background variation even when the border and core ratios pass', async () => {
    const width = 1024;
    const height = 1024;
    const rgba = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const border = x < 8 || y < 8 || x >= width - 8 || y >= height - 8;
        const value = border ? 244 : 232 + Math.round((12 * y) / (height - 1));
        rgba.set([value, value, value, 255], (y * width + x) * 4);
      }
    const subtleGradient = await sharp(rgba, {
      raw: { width, height, channels: 4 },
    })
      .png()
      .toBuffer();
    await expect(
      processSpriteSheet({ inputBuffer: subtleGradient }),
    ).rejects.toMatchObject({
      code: 'INVALID_BACKGROUND',
      details: {
        corePixelRatio: expect.any(Number),
        coreBorderRatio: 1,
        connectedBackgroundStandardDeviation: expect.any(Number),
      },
    });
  });
  it('rejects foreground crossing fixed 4x2 cell boundaries', async () => {
    const rectangles = Array.from({ length: 4 }, (_, column) => ({
      input: {
        create: {
          width: 80,
          height: 120,
          channels: 4 as const,
          background: { r: 180, g: 20, b: 40, alpha: 1 },
        },
      },
      left: column * 256 + 88,
      top: 452,
    }));
    const crossing = await sharp({
      create: {
        width: 1024,
        height: 1024,
        channels: 4,
        background: '#F4F4F4',
      },
    })
      .composite(rectangles)
      .png()
      .toBuffer();
    await expect(
      processSpriteSheet({ inputBuffer: crossing }),
    ).rejects.toMatchObject({
      code: 'INVALID_GRID',
      details: { touchingFrames: expect.arrayContaining([0, 4]) },
    });
  });
});
