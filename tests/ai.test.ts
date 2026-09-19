import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import {
  buildSpritePrompt,
  createFakeProvider,
  createFalProvider,
  createOpenPoseGuide,
  createPoseGuide,
  downloadFalImage,
  type FalTransport,
} from '../packages/ai/src';

const input = {
  prompt: 'blue knight with silver sword',
  animation: 'walk',
  direction: 'right',
  frameCount: 8,
  seed: 0,
} as const;
const { seed: _seed, ...promptInput } = input;
void _seed;
describe('sprite prompt', () => {
  it('includes the subject exactly once and preserves all fixed layout constraints', () => {
    const prompt = buildSpritePrompt(promptInput);
    expect(prompt.split(input.prompt)).toHaveLength(2);
    expect(prompt).toContain(`SUBJECT:\n${input.prompt}\n\nANIMATION:\nwalk`);
    expect(prompt).toContain(
      'Exactly 8 animation frames.\n4 columns and 2 rows.',
    );
    expect(prompt).toContain('Flat solid background #F4F4F4.');
    expect(prompt).toContain('No borders.');
    expect(prompt).toContain('Arms and legs must visibly alternate.');
    expect(prompt).toContain(
      'Preserve the exact same color palette in all eight frames.',
    );
    expect(prompt).toContain(
      'Treat grid cells 1 through 8 as consecutive moments on one animation timeline',
    );
    expect(prompt).toContain('Never reorder the key poses.');
  });
  it('does not perform template substitutions within user input', () => {
    expect(
      buildSpritePrompt({ ...promptInput, prompt: '{{ANIMATION}} $& $`' }),
    ).toContain('SUBJECT:\n{{ANIMATION}} $& $`\n');
  });
  it('appends the critical instruction only for a strict retry', () => {
    const first = buildSpritePrompt(promptInput);
    const retry = buildSpritePrompt(promptInput, { strictLayoutRetry: true });
    expect(first).not.toContain('CRITICAL:');
    expect(retry).toBe(
      `${first}\n\nCRITICAL: return one 1024 x 512 image with exactly 8 isolated frames in a strict 4x2 grid. Use four columns and exactly two rows. Never add a third row. Keep all background pixels one uniform flat #F4F4F4 color.`,
    );
  });
  it('counts Unicode code points rather than bytes or UTF-16 units', () => {
    expect(() =>
      buildSpritePrompt({ ...promptInput, prompt: '🦊'.repeat(800) }),
    ).not.toThrow();
    expect(() =>
      buildSpritePrompt({ ...promptInput, prompt: '🦊'.repeat(801) }),
    ).toThrow();
  });
  it.each(['', '   ', 'x'.repeat(801), '\ud800'])(
    'rejects invalid prompt',
    (prompt) => {
      expect(() => buildSpritePrompt({ ...promptInput, prompt })).toThrow();
    },
  );
});

describe('fake provider', () => {
  it('is deterministic for input and seed and changes with a different seed', async () => {
    const provider = createFakeProvider();
    const first = await provider.generate(input);
    const second = await provider.generate(input);
    const different = await provider.generate({ ...input, seed: 1 });
    expect(first.image.equals(second.image)).toBe(true);
    expect(first.image.equals(different.image)).toBe(false);
    expect(first.model).toContain('fake/');
    expect(first.seed).toBe(0);
  });
});

describe('pose guide', () => {
  it('creates distinct 4x2 guides for each supported animation', async () => {
    const guides = await Promise.all(
      (['idle', 'walk', 'attack'] as const).map(createPoseGuide),
    );
    for (const guide of guides)
      expect(await sharp(guide).metadata()).toMatchObject({
        format: 'png',
        width: 1024,
        height: 512,
      });
    expect(new Set(guides.map((guide) => guide.toString('base64'))).size).toBe(
      3,
    );
  });
  it('creates eight distinct 512px OpenPose control maps per animation', async () => {
    const guides = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        createOpenPoseGuide('attack', index),
      ),
    );
    for (const guide of guides)
      expect(await sharp(guide).metadata()).toMatchObject({
        format: 'png',
        width: 512,
        height: 512,
      });
    expect(new Set(guides.map((guide) => guide.toString('base64'))).size).toBe(
      7,
    );
    await expect(createOpenPoseGuide('walk', 8)).rejects.toThrow('0–7');
  });
});

describe('fal adapter with injected transport; no paid calls', () => {
  const response = {
    requestId: 'request-123',
    data: {
      seed: 0,
      images: [{ url: 'https://v3.fal.media/files/test.png' }],
      has_nsfw_concepts: [false],
    },
  };
  it.each(['turbo', 'schnell'] as const)(
    'selects %s and requests one 1024 x 512 PNG',
    async (model) => {
      const transport = vi.fn<FalTransport>().mockResolvedValue(response);
      const download = vi
        .fn<typeof downloadFalImage>()
        .mockResolvedValue(Buffer.from('image'));
      const result = await createFalProvider({
        key: 'test-secret',
        model,
        transport,
        download,
      }).generate(input);
      expect(transport.mock.calls[0]?.[0]).toBe(
        model === 'turbo' ? 'fal-ai/flux-2/turbo/edit' : 'fal-ai/flux/schnell',
      );
      expect(transport.mock.calls[0]?.[1]).toMatchObject({
        seed: 0,
        image_size: { width: 1024, height: 512 },
        num_images: 1,
        output_format: 'png',
        enable_safety_checker: true,
      });
      if (model === 'turbo') {
        expect(transport.mock.calls[0]?.[1]).toMatchObject({
          guidance_scale: 3.5,
          enable_prompt_expansion: false,
          image_urls: [expect.stringMatching(/^data:image\/png;base64,/)],
        });
        expect(transport.mock.calls[0]?.[1].prompt).toContain(
          'Replace all eight gray mannequins',
        );
      } else {
        expect(transport.mock.calls[0]?.[1]).not.toHaveProperty('image_urls');
      }
      expect(JSON.stringify(transport.mock.calls)).not.toContain('test-secret');
      expect(result).toMatchObject({
        requestId: 'request-123',
        seed: 0,
        image: Buffer.from('image'),
      });
    },
  );
  it('omits null seed and records the provider-selected seed', async () => {
    const transport = vi.fn<FalTransport>().mockResolvedValue({
      ...response,
      data: { ...response.data, seed: 123 },
    });
    const result = await createFalProvider({
      key: 'test',
      transport,
      download: async () => Buffer.alloc(1),
    }).generate({ ...input, seed: null });
    expect(transport.mock.calls[0]?.[1]).not.toHaveProperty('seed');
    expect(result.seed).toBe(123);
  });
  it('builds the sprite profile from eight OpenPose calls and reuses frame one as the character reference', async () => {
    const transport = vi.fn<FalTransport>().mockImplementation(async () => ({
      ...response,
      requestId: `sprite-${transport.mock.calls.length}`,
      data: {
        ...response.data,
        seed: 42,
        images: [
          {
            url: `https://v3.fal.media/files/sprite-${transport.mock.calls.length}.png`,
          },
        ],
      },
    }));
    const sourceFrame = await sharp({
      create: {
        width: 512,
        height: 512,
        channels: 4,
        background: '#F4F4F4',
      },
    })
      .composite([
        {
          input: {
            create: {
              width: 120,
              height: 260,
              channels: 4,
              background: '#2050BE',
            },
          },
          left: 196,
          top: 180,
        },
      ])
      .png()
      .toBuffer();
    const download = vi
      .fn<typeof downloadFalImage>()
      .mockResolvedValue(sourceFrame);
    const result = await createFalProvider({
      key: 'test-secret',
      model: 'sprite',
      transport,
      download,
    }).generate({ ...input, seed: null });
    expect(transport).toHaveBeenCalledTimes(8);
    expect(download).toHaveBeenCalledTimes(8);
    for (const [index, call] of transport.mock.calls.entries()) {
      expect(call[0]).toBe('fal-ai/lora');
      expect(call[1]).toMatchObject({
        model_name: 'stabilityai/stable-diffusion-xl-base-1.0',
        image_size: { width: 512, height: 512 },
        image_format: 'png',
        loras: [{ scale: 1.15 }],
        controlnets: [
          {
            path: 'thibaud/controlnet-openpose-sdxl-1.0',
            conditioning_scale: 0.95,
            image_url: expect.stringMatching(/^data:image\/png;base64,/),
          },
        ],
      });
      if (index === 0) expect(call[1]).not.toHaveProperty('ip_adapter');
      else {
        expect(call[1]).toMatchObject({
          seed: 42,
          ip_adapter: [
            {
              path: 'h94/IP-Adapter',
              scale: 0.8,
              ip_adapter_image_url: expect.stringMatching(
                /^data:image\/png;base64,/,
              ),
            },
          ],
        });
      }
    }
    expect(await sharp(result.image).metadata()).toMatchObject({
      format: 'png',
      width: 1024,
      height: 512,
    });
    expect(result).toMatchObject({
      seed: 42,
      model: 'fal-ai/lora',
    });
  });
  it('sanitizes SDK errors and does not perform application-level fallback', async () => {
    const transport = vi
      .fn<FalTransport>()
      .mockRejectedValue(new Error('secret-header-value'));
    await expect(
      createFalProvider({ key: 'test', transport }).generate(input),
    ).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: expect.not.stringContaining('secret-header-value'),
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each([
    {},
    { ...response, data: { ...response.data, images: [] } },
    { ...response, data: { ...response.data, has_nsfw_concepts: [true] } },
  ])('rejects unusable output without downloading', async (badOutput) => {
    const download = vi.fn<typeof downloadFalImage>();
    await expect(
      createFalProvider({
        key: 'test',
        transport: async () => badOutput,
        download,
      }).generate(input),
    ).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    expect(download).not.toHaveBeenCalled();
  });
  it('fails fast without credentials', () => {
    expect(() => createFalProvider({ key: '' })).toThrow('FAL_KEY');
  });
});

describe('bounded provider image download', () => {
  it.each([
    'http://fal.media/image',
    'https://localhost/image',
    'https://fal.media.attacker.test/image',
    'https://storage.googleapis.com/other-bucket/image',
    'https://user:pass@fal.media/image',
  ])('rejects unexpected URL %s', async (url) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      downloadFalImage(url, new AbortController().signal, fetcher),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('downloads without forwarding credentials or following redirects', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('png'));
    expect(
      await downloadFalImage(
        'https://fal.media/image',
        new AbortController().signal,
        fetcher,
      ),
    ).toEqual(Buffer.from('png'));
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
    expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty('headers');
  });
  it('bounds streamed data when content-length is absent', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(new Uint8Array(16 * 1024 * 1024 + 1)));
    await expect(
      downloadFalImage(
        'https://fal.media/image',
        new AbortController().signal,
        fetcher,
      ),
    ).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
  });
});
