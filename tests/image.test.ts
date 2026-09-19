import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  gridCells,
  removeBackground,
  cleanForeground,
  normalizeFrame,
  processAnimationFrames,
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
  it('slices the 1024 x 512 sheet in row-major 256 x 256 cells', () => {
    const cells = gridCells(1024, 512);
    expect(cells).toHaveLength(8);
    expect(cells[0]).toEqual({ left: 0, top: 0, width: 256, height: 256 });
    expect(cells[4]).toEqual({ left: 0, top: 256, width: 256, height: 256 });
    expect(cells[7]).toEqual({ left: 768, top: 256, width: 256, height: 256 });
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
  it('flood-fills light matte from the edge without deleting enclosed highlights', () => {
    const width = 7;
    const height = 7;
    const rgba = Buffer.alloc(width * height * 4);
    for (let pixel = 0; pixel < width * height; pixel++)
      rgba.set([250, 250, 250, 255], pixel * 4);
    for (let y = 1; y <= 5; y++)
      for (let x = 1; x <= 5; x++)
        rgba.set([10, 15, 20, 255], (y * width + x) * 4);
    rgba.set([244, 244, 244, 255], (3 * width + 3) * 4);
    const output = removeBackground(rgba, width, height);
    expect(output[3]).toBe(0);
    expect(output[(1 * width + 1) * 4 + 3]).toBe(255);
    expect(output[(3 * width + 3) * 4 + 3]).toBe(255);
  });
  it('removes neutral floor shading while preserving colored feet', () => {
    const width = 10;
    const height = 10;
    const rgba = Buffer.alloc(width * height * 4);
    for (let pixel = 0; pixel < width * height; pixel++)
      rgba.set([244, 244, 244, 255], pixel * 4);
    for (let y = 4; y < 10; y++)
      for (let x = 3; x < 7; x++)
        rgba.set([30, 60, 120, 255], (y * width + x) * 4);
    rgba.set([195, 193, 196, 255], (8 * width + 1) * 4);
    const output = removeBackground(rgba, width, height);
    expect(output[(8 * width + 1) * 4 + 3]).toBe(0);
    expect(output[(8 * width + 4) * 4 + 3]).toBe(255);
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
  it('removes a secondary effect touching the cell boundary', () => {
    const rgba = Buffer.alloc(100 * 100 * 4);
    for (let y = 20; y < 70; y++)
      for (let x = 25; x < 75; x++) rgba[(y * 100 + x) * 4 + 3] = 255;
    for (let y = 30; y < 50; y++)
      for (let x = 0; x < 5; x++) rgba[(y * 100 + x) * 4 + 3] = 255;
    const clean = cleanForeground(rgba, 100, 100);
    expect(clean.bounds).toEqual({ left: 25, top: 20, width: 50, height: 50 });
    expect(clean.touchesEdge).toBe(false);
    expect(clean.removedComponents).toBe(1);
    expect(rgba[30 * 100 * 4 + 3]).toBe(0);
  });
  it('tolerates a few connected antialias pixels at a cell boundary', () => {
    const rgba = Buffer.alloc(100 * 100 * 4);
    for (let y = 30; y < 70; y++)
      for (let x = 30; x < 70; x++) rgba[(y * 100 + x) * 4 + 3] = 255;
    for (let x = 70; x < 100; x++) rgba[(50 * 100 + x) * 4 + 3] = 255;
    rgba[(51 * 100 + 99) * 4 + 3] = 255;
    const clean = cleanForeground(rgba, 100, 100);
    expect(clean.boundaryPixels).toBe(2);
    expect(clean.touchesEdge).toBe(false);
  });
  it('removes a detached flat ground shadow below the character', () => {
    const rgba = Buffer.alloc(100 * 100 * 4);
    for (let y = 15; y < 80; y++)
      for (let x = 35; x < 65; x++) rgba[(y * 100 + x) * 4 + 3] = 255;
    for (let y = 82; y < 87; y++)
      for (let x = 15; x < 85; x++) rgba[(y * 100 + x) * 4 + 3] = 180;
    const clean = cleanForeground(rgba, 100, 100);
    expect(clean.bounds).toEqual({ left: 35, top: 15, width: 30, height: 65 });
    expect(clean.removedComponents).toBe(1);
    expect(rgba[(82 * 100 + 15) * 4 + 3]).toBe(0);
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
  it('preserves source alpha instead of applying opaque matte removal', async () => {
    const rgba = Buffer.alloc(64 * 64 * 4);
    for (let y = 10; y < 54; y++)
      for (let x = 20; x < 44; x++)
        rgba.set([244, 244, 244, 128], (y * 64 + x) * 4);
    const source = await sharp(rgba, {
      raw: { width: 64, height: 64, channels: 4 },
    })
      .png()
      .toBuffer();
    const result = await normalizeFrame(source);
    const output = await sharp(result.png).ensureAlpha().raw().toBuffer();
    expect(
      output.some((channel, index) => index % 4 === 3 && channel === 128),
    ).toBe(true);
  });

  it('normalizes eight provider frames and composes a 1024 x 512 sheet', async () => {
    const generated = await createFakeProvider().generate({
      prompt: 'blue knight',
      animation: 'walk',
      direction: 'right',
      frameCount: 8,
      seed: 23,
    });
    const cells = gridCells(1024, 512);
    const sourceFrames = await Promise.all(
      cells.map((cell) =>
        sharp(generated.image).extract(cell).png().toBuffer(),
      ),
    );
    const result = await processAnimationFrames({
      frames: sourceFrames,
      animation: 'walk',
    });
    expect(result.frames).toHaveLength(8);
    expect(result.background).toBeNull();
    expect(await sharp(result.sheet).metadata()).toMatchObject({
      width: 1024,
      height: 512,
      hasAlpha: true,
    });
    for (const [index, frame] of result.frames.entries()) {
      const fromSheet = await sharp(result.sheet)
        .extract(cells[index]!)
        .raw()
        .toBuffer();
      expect(fromSheet.equals(await sharp(frame).raw().toBuffer())).toBe(true);
    }
  });

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
  it('uses one scale and a stable lower-body anchor across all eight frames', async () => {
    const cells = Array.from({ length: 8 }, (_, index) => {
      const cellLeft = (index % 4) * 256;
      const cellTop = Math.floor(index / 4) * 256;
      const bodyLeft = cellLeft + 70 + (index % 3) * 11;
      const bodyTop = cellTop + 112;
      const swordWidth = 30 + index * 8;
      return [
        {
          input: {
            create: {
              width: 60,
              height: 112,
              channels: 4 as const,
              background: { r: 30, g: 80, b: 190, alpha: 1 },
            },
          },
          left: bodyLeft,
          top: bodyTop,
        },
        {
          input: {
            create: {
              width: swordWidth,
              height: 12,
              channels: 4 as const,
              background: { r: 190, g: 40, b: 45, alpha: 1 },
            },
          },
          left: bodyLeft + 55,
          top: bodyTop + 20 + (index % 4) * 16,
        },
      ];
    }).flat();
    const source = await sharp({
      create: {
        width: 1024,
        height: 512,
        channels: 4,
        background: '#F4F4F4',
      },
    })
      .composite(cells)
      .png()
      .toBuffer();
    const result = await processSpriteSheet({
      inputBuffer: source,
      animation: 'attack',
    });
    expect(new Set(result.diagnostics.map(({ scale }) => scale)).size).toBe(1);
    const bodyCenters: number[] = [];
    const bodyWidths: number[] = [];
    for (const frame of result.frames) {
      const data = await sharp(frame).ensureAlpha().raw().toBuffer();
      let left = 256;
      let right = -1;
      for (let y = 0; y < 256; y++)
        for (let x = 0; x < 256; x++) {
          const offset = (y * 256 + x) * 4;
          if (
            data[offset]! === 30 &&
            data[offset + 1]! === 80 &&
            data[offset + 2]! === 190 &&
            data[offset + 3]! === 255
          ) {
            left = Math.min(left, x);
            right = Math.max(right, x);
          }
        }
      bodyWidths.push(right - left + 1);
      bodyCenters.push((left + right) / 2);
    }
    expect(
      Math.max(...bodyWidths) - Math.min(...bodyWidths),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.max(...bodyCenters) - Math.min(...bodyCenters),
    ).toBeLessThanOrEqual(1);
  });
  it.each(['idle', 'walk', 'attack'] as const)(
    'accepts the offline fixture when it contains visible %s poses',
    async (animation) => {
      const source = await createFakeProvider().generate({
        prompt: 'blue knight',
        animation,
        direction: 'right',
        frameCount: 8,
        seed: 7,
      });
      const result = await processSpriteSheet({
        inputBuffer: source.image,
        animation,
      });
      expect(result.animationQuality.meanTransitionRatio).toBeGreaterThan(0);
    },
  );
  it('rejects eight valid cells that repeat a static pose', async () => {
    const cells = Array.from({ length: 8 }, (_, index) => ({
      input: {
        create: {
          width: 80,
          height: 120,
          channels: 4 as const,
          background: { r: 40, g: 70, b: 150, alpha: 1 },
        },
      },
      left: (index % 4) * 256 + 88,
      top: Math.floor(index / 4) * 256 + 100,
    }));
    const staticSheet = await sharp({
      create: {
        width: 1024,
        height: 512,
        channels: 4,
        background: '#F4F4F4',
      },
    })
      .composite(cells)
      .png()
      .toBuffer();
    await expect(
      processSpriteSheet({ inputBuffer: staticSheet, animation: 'walk' }),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_MOTION',
      details: {
        animation: 'walk',
        animationQuality: { meanTransitionRatio: 0 },
      },
    });
  });
  it('rejects a character whose average palette changes in one frame', async () => {
    const source = await createFakeProvider().generate({
      prompt: 'blue knight',
      animation: 'walk',
      direction: 'right',
      frameCount: 8,
      seed: 9,
    });
    const { data, info } = await sharp(source.image)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (let y = 0; y < 256; y++)
      for (let x = 0; x < 256; x++) {
        const offset = (y * info.width + x) * 4;
        if (
          Math.hypot(
            data[offset]! - 244,
            data[offset + 1]! - 244,
            data[offset + 2]! - 244,
          ) > 60
        )
          data.set([220, 20, 30], offset);
      }
    const changed = await sharp(data, {
      raw: { width: info.width, height: info.height, channels: 4 },
    })
      .png()
      .toBuffer();
    await expect(
      processSpriteSheet({ inputBuffer: changed, animation: 'walk' }),
    ).rejects.toMatchObject({ code: 'INCONSISTENT_CHARACTER' });
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
      create: { width: 1024, height: 512, channels: 4, background: '#F4F4F4' },
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
        height: 512,
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
  it('rejects strong interior background variation even when the border is flat', async () => {
    const width = 1024;
    const height = 512;
    const rgba = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const border = x < 8 || y < 8 || x >= width - 8 || y >= height - 8;
        const value = border ? 244 : 226 + Math.round((18 * y) / (height - 1));
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
      top: 220,
    }));
    const crossing = await sharp({
      create: {
        width: 1024,
        height: 512,
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
