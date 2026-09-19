import { createHash } from 'node:crypto';
import sharp from 'sharp';
import {
  generationInputSchema,
  type GenerationInput,
  type SpriteAIProvider,
} from './provider';

/** Deterministic synthetic geometry for offline tests; not evidence of AI quality. */
export function createFakeProvider(): SpriteAIProvider {
  const provider: SpriteAIProvider = {
    name: 'fake',
    model: 'fake/pixel-fixture-v1',
    async createBaseCharacter(input) {
      const generated = await provider.generate({
        prompt: input.prompt,
        animation: 'idle',
        direction: 'right',
        frameCount: 8,
        seed: input.seed ?? null,
      });
      return {
        image: await sharp(generated.image)
          .extract({ left: 0, top: 0, width: 256, height: 256 })
          .png()
          .toBuffer(),
        provider: 'pixellab',
      };
    },
    async animateWithText(input) {
      const generated = await provider.generate({
        prompt: 'reusable fake character',
        animation: input.animation,
        direction:
          (input.direction as GenerationInput['direction'] | undefined) ??
          'right',
        frameCount: 8,
        seed: input.seed ?? null,
      });
      const frames = await Promise.all(
        Array.from({ length: 8 }, async (_, index) => ({
          index,
          buffer: await sharp(generated.image)
            .extract({
              left: (index % 4) * 256,
              top: Math.floor(index / 4) * 256,
              width: 256,
              height: 256,
            })
            .png()
            .toBuffer(),
        })),
      );
      return {
        frames,
        provider: 'pixellab',
        providerJobId: generated.requestId,
      };
    },
    async generate(rawInput: GenerationInput) {
      const start = performance.now();
      const input = generationInputSchema.parse(rawInput);
      const seed = input.seed ?? 0;
      const digest = createHash('sha256')
        .update(JSON.stringify({ ...input, seed }))
        .digest();
      const pixels = Buffer.alloc(1024 * 512 * 4, 244);
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
          y = Math.floor(frame / 4) * 256;
        const attackStride = [0, -6, -12, -18, 18, 12, 6, 0][frame]!;
        const stride =
          input.animation === 'walk' || input.animation === 'run'
            ? [0, 8, 16, 8, 0, -8, -16, -8][frame]!
            : input.animation === 'attack' || input.animation === 'hurt'
              ? attackStride
              : 0;
        const bob =
          input.animation === 'idle' ? [0, -4, -8, -4, 0, 4, 8, 4][frame]! : 0;
        rect(x + 100, y + 35 + bob, 56, 48, color);
        rect(x + 92, y + 83 + bob, 64, 76, color);
        rect(x + 96 - stride, y + 155, 24, 72, [30, 40, 70]);
        rect(x + 132 + stride, y + 155, 24, 72, [50, 65, 100]);
        if (input.animation === 'attack') {
          const armY = [100, 88, 78, 94, 108, 122, 112, 100][frame]!;
          const armWidth = [24, 34, 20, 58, 86, 64, 42, 24][frame]!;
          const armHeight = frame === 2 ? 46 : 20;
          rect(x + 148, y + armY, armWidth, armHeight, color);
        } else {
          rect(x + 148, y + 100 + bob, 32, 20, color);
        }
        rect(x + 142, y + 52 + bob, 12, 8, [10, 15, 20]);
        rect(x + 96 + frame * 4, y + 116 + bob, 8, 12, [220, 170, 40]);
      }
      const image = await sharp(pixels, {
        raw: { width: 1024, height: 512, channels: 4 },
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
  return provider;
}
