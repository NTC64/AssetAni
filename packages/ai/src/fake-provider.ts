import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { generationInputSchema, type AiProvider } from './provider';

/** Deterministic synthetic geometry for offline tests; not evidence of AI quality. */
export function createFakeProvider(): AiProvider {
  return {
    name: 'fake',
    model: 'fake/pixel-fixture-v1',
    async generate(rawInput) {
      const start = performance.now();
      const input = generationInputSchema.parse(rawInput);
      const seed = input.seed ?? 0;
      const digest = createHash('sha256')
        .update(JSON.stringify({ ...input, seed }))
        .digest();
      const pixels = Buffer.alloc(1024 * 1024 * 4, 244);
      for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
      const color = [
        32 + (digest[0]! % 150),
        32 + (digest[1]! % 150),
        32 + (digest[2]! % 150),
      ];
      function rect(
        x: number,
        y: number,
        width: number,
        height: number,
        rgb: number[],
      ) {
        for (let row = y; row < y + height; row++)
          for (let column = x; column < x + width; column++) {
            const offset = (row * 1024 + column) * 4;
            pixels[offset] = rgb[0]!;
            pixels[offset + 1] = rgb[1]!;
            pixels[offset + 2] = rgb[2]!;
          }
      }
      for (let frame = 0; frame < 8; frame++) {
        const x = (frame % 4) * 256,
          y = Math.floor(frame / 4) * 512;
        const stride =
          input.animation === 'walk'
            ? [0, 8, 16, 8, 0, -8, -16, -8][frame]!
            : 0;
        const bob = input.animation === 'idle' ? (frame % 2) * 4 : 0;
        rect(x + 100, y + 140 + bob, 56, 60, color);
        rect(x + 92, y + 200 + bob, 64, 120, color);
        rect(x + 96 - stride, y + 312, 24, 80, [30, 40, 70]);
        rect(x + 132 + stride, y + 312, 24, 80, [50, 65, 100]);
        rect(
          x + 148,
          y + 220 + bob,
          input.animation === 'attack' ? 24 + frame * 6 : 32,
          20,
          color,
        );
        rect(x + 142, y + 160 + bob, 12, 8, [10, 15, 20]);
        rect(x + 96 + frame * 4, y + 240 + bob, 8, 12, [220, 170, 40]);
      }
      const image = await sharp(pixels, {
        raw: { width: 1024, height: 1024, channels: 4 },
      })
        .png()
        .toBuffer();
      return {
        image,
        seed,
        model: 'fake/pixel-fixture-v1',
        requestId: `fake-${digest.toString('hex').slice(0, 16)}`,
        durationMs: performance.now() - start,
      };
    },
  };
}
