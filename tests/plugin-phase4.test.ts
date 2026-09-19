import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { zipSync } from 'fflate';
import sharp from 'sharp';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  GenerationRequest,
  GenerationResponse,
} from '../packages/contracts/src';
import { createSpritePackage } from '../packages/image/src';
import type { CocosAdapter } from '../apps/cocos-plugin/src/cocos/cocos-adapter';
import {
  ApiClient,
  type FetchLike,
  type GenerationApi,
} from '../apps/cocos-plugin/src/main/api-client';
import { GenerationService } from '../apps/cocos-plugin/src/main/generation-service';
import { extractSpritePackage } from '../apps/cocos-plugin/src/main/package-extractor';

const generationId = '8c21f087-bf2b-42b2-b0ec-47c221b98185';
const apiKey = `spr_live_${'a'.repeat(43)}`;
const request: GenerationRequest = {
  prompt: 'blue knight with a silver sword',
  style: 'pixel_art',
  animation: 'walk',
  direction: 'right',
  frameCount: 8,
  fps: 12,
  frameSize: 256,
  background: 'transparent',
  seed: null,
};
let validPackage: Buffer;

function httpResponse(body: string, init: ResponseInit) {
  return new Response(body, init) as unknown as Awaited<ReturnType<FetchLike>>;
}

beforeAll(async () => {
  const frame = await sharp({
    create: {
      width: 256,
      height: 256,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toBuffer();
  const sheet = await sharp({
    create: {
      width: 1024,
      height: 512,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toBuffer();
  validPackage = createSpritePackage(
    { frames: Array.from({ length: 8 }, () => frame), sheet },
    { generationId, animation: 'walk', fps: 12, loop: true },
  ).zip;
});

function response(status: GenerationResponse['status'], progress: number) {
  return {
    id: generationId,
    status,
    progress,
    ...(status === 'SUCCEEDED'
      ? {
          result: {
            packageUrl: `http://localhost:3000/v1/generations/${generationId}/result.zip`,
            sheetUrl: `http://localhost:3000/v1/generations/${generationId}/sheet.png`,
            manifestUrl: `http://localhost:3000/v1/generations/${generationId}/manifest.json`,
            expiresIn: 900,
          },
        }
      : {}),
  } satisfies GenerationResponse;
}

function adapter(): CocosAdapter {
  return {
    importGeneration: vi.fn().mockResolvedValue(undefined),
    refreshAsset: vi.fn().mockResolvedValue(undefined),
    createAnimation: vi.fn().mockResolvedValue(undefined),
  };
}

describe('Phase 4 ApiClient', () => {
  it('POSTs the shared contract with idempotency and accepts only HTTP 202', async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(
      httpResponse(JSON.stringify(response('QUEUED', 0)), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const result = await new ApiClient(
      'http://localhost:3000',
      apiKey,
      fetcher,
    ).createGeneration(request, 'phase-4-test');
    expect(result.status).toBe('QUEUED');
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('http://localhost:3000/v1/generations');
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': 'phase-4-test',
      },
      body: JSON.stringify(request),
      redirect: 'error',
    });
  });

  it('turns backend errors into typed errors without exposing arbitrary bodies', async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(
      httpResponse(
        JSON.stringify({
          error: {
            code: 'INVALID_PROMPT',
            message: 'Prompt rejected.',
            requestId: 'req-1',
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    );
    await expect(
      new ApiClient('http://localhost:3000', apiKey, fetcher).createGeneration(
        request,
        'key',
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_PROMPT',
      message: 'Prompt rejected.',
      requestId: 'req-1',
    });
  });

  it('rejects cross-origin package URLs before making a request', async () => {
    const fetcher = vi.fn<FetchLike>();
    await expect(
      new ApiClient('http://localhost:3000', apiKey, fetcher).downloadPackage(
        'https://example.com/result.zip',
      ),
    ).rejects.toMatchObject({ code: 'UNSAFE_RESULT_URL' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('downloads a same-origin package as bytes', async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(
      httpResponse('zip bytes', {
        status: 200,
        headers: { 'content-length': '9' },
      }),
    );
    await expect(
      new ApiClient('http://localhost:3000', apiKey, fetcher).downloadPackage(
        'http://localhost:3000/v1/generations/result.zip',
      ),
    ).resolves.toEqual(Buffer.from('zip bytes'));
  });
});

describe('safe result package extraction', () => {
  it('extracts exactly the manifest, sheet, and eight validated frames', async () => {
    const extracted = await extractSpritePackage(validPackage, generationId);
    try {
      expect(extracted.manifest.generationId).toBe(generationId);
      expect(
        await readFile(path.join(extracted.directory, 'frames/07.png')),
      ).not.toHaveLength(0);
    } finally {
      await extracted.cleanup();
    }
    await expect(access(extracted.directory)).rejects.toThrow();
  });

  it('rejects path traversal and unrelated archive entries', async () => {
    const malicious = Buffer.from(
      zipSync({ '../escape.txt': Buffer.from('outside') }),
    );
    await expect(extractSpritePackage(malicious, generationId)).rejects.toThrow(
      'Unsafe or duplicate ZIP entry',
    );
  });

  it('rejects a package belonging to another generation', async () => {
    await expect(
      extractSpritePackage(
        validPackage,
        'af895623-d888-41bd-a364-095a32e16fa9',
      ),
    ).rejects.toThrow('generation ID does not match');
  });
});

describe('GenerationService', () => {
  it('polls exponentially up to eight seconds, downloads, imports, and creates the clip', async () => {
    const statuses = [
      response('AI_SUBMITTED', 15),
      response('AI_RUNNING', 35),
      response('PROCESSING', 72),
      response('UPLOADING', 88),
      response('SUCCEEDED', 100),
    ];
    const api: GenerationApi = {
      createGeneration: vi.fn().mockResolvedValue(response('QUEUED', 0)),
      getGeneration: vi.fn().mockImplementation(async () => statuses.shift()!),
      downloadPackage: vi.fn().mockResolvedValue(validPackage),
    };
    const cocos = adapter();
    const sleeps: number[] = [];
    const progress: number[] = [];
    const result = await new GenerationService(api, cocos).run(request, {
      idempotencyKey: 'phase-4-key',
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      onProgress: (snapshot) => progress.push(snapshot.progress),
    });
    const destination = `db://assets/AI_Sprites/${generationId}`;
    expect(sleeps).toEqual([2_000, 4_000, 8_000, 8_000, 8_000]);
    expect(Math.max(...sleeps)).toBe(8_000);
    expect(api.downloadPackage).toHaveBeenCalledOnce();
    expect(cocos.importGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ destination }),
    );
    expect(cocos.refreshAsset).toHaveBeenCalledWith(destination);
    expect(cocos.createAnimation).toHaveBeenCalledWith(
      destination,
      expect.objectContaining({ generationId }),
    );
    expect(progress.at(-1)).toBe(100);
    expect(result).toEqual({
      generationId,
      animationUrl: `${destination}/walk.anim`,
      idempotencyKey: 'phase-4-key',
    });
  });

  it('offers a fresh generation after a terminal backend failure', async () => {
    const failed = {
      ...response('FAILED', 100),
      errorCode: 'AI_PROVIDER_ERROR',
      errorMessage: 'provider detail',
    } satisfies GenerationResponse;
    const api: GenerationApi = {
      createGeneration: vi.fn().mockResolvedValue(failed),
      getGeneration: vi.fn(),
      getCredits: vi.fn().mockResolvedValue({ balance: 3 }),
      downloadPackage: vi.fn(),
    };
    const progress: Array<{ creditsRemaining?: number }> = [];
    await expect(
      new GenerationService(api, adapter()).run(request, {
        onProgress: (snapshot) => progress.push(snapshot),
      }),
    ).rejects.toMatchObject({
      code: 'AI_PROVIDER_ERROR',
      retryMode: 'new',
      userMessage: 'AI generation failed. Please retry.',
    });
    expect(api.getCredits).toHaveBeenCalledOnce();
    expect(progress.at(-1)?.creditsRemaining).toBe(3);
  });

  it('explains when generated frames contain no usable action', async () => {
    const failed = {
      ...response('FAILED', 100),
      errorCode: 'INSUFFICIENT_MOTION',
      errorMessage: 'internal diagnostic',
    } satisfies GenerationResponse;
    const api: GenerationApi = {
      createGeneration: vi.fn().mockResolvedValue(failed),
      getGeneration: vi.fn(),
      getCredits: vi.fn().mockResolvedValue({ balance: 3 }),
      downloadPackage: vi.fn(),
    };
    await expect(
      new GenerationService(api, adapter()).run(request),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_MOTION',
      retryMode: 'new',
      userMessage: expect.stringContaining('repeated poses'),
    });
  });

  it('offers to resume the same generation after the client polling timeout', async () => {
    const api: GenerationApi = {
      createGeneration: vi.fn().mockResolvedValue(response('QUEUED', 0)),
      getGeneration: vi.fn(),
      downloadPackage: vi.fn(),
    };
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(2);
    await expect(
      new GenerationService(api, adapter()).run(request, {
        timeoutMs: 1,
        now,
      }),
    ).rejects.toMatchObject({
      code: 'CLIENT_TIMEOUT',
      retryMode: 'resume',
      generationId,
    });
    expect(api.getGeneration).not.toHaveBeenCalled();
  });

  it('continues polling past two minutes for slow PixelLab jobs', async () => {
    const api: GenerationApi = {
      createGeneration: vi.fn().mockResolvedValue(response('AI_RUNNING', 35)),
      getGeneration: vi.fn().mockResolvedValue(response('SUCCEEDED', 100)),
      downloadPackage: vi.fn().mockResolvedValue(validPackage),
    };
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(121_000);

    const result = await new GenerationService(api, adapter()).run(request, {
      now,
      sleep: async () => {},
    });

    expect(api.getGeneration).toHaveBeenCalledOnce();
    expect(result.generationId).toBe(generationId);
  });

  it('rejects a corrupt package before AssetDB and offers a fresh generation', async () => {
    const api: GenerationApi = {
      createGeneration: vi.fn().mockResolvedValue(response('SUCCEEDED', 100)),
      getGeneration: vi.fn(),
      downloadPackage: vi.fn().mockResolvedValue(Buffer.from('bad zip')),
    };
    const cocos = adapter();
    await expect(
      new GenerationService(api, cocos).run(request),
    ).rejects.toMatchObject({
      code: 'INVALID_RESULT_PACKAGE',
      retryMode: 'new',
    });
    expect(cocos.importGeneration).not.toHaveBeenCalled();
  });
});
