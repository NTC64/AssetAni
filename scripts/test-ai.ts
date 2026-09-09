import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { createFakeProvider, createFalProvider } from '@sprite/ai';
import { runPocCase } from './ai-poc/runner';
import { POC_CASES } from './ai-poc/cases';

async function main() {
  const { values } = parseArgs({
    options: {
      provider: { type: 'string', default: 'fake' },
      model: { type: 'string', default: 'turbo' },
      prompt: { type: 'string' },
      animation: { type: 'string', default: 'walk' },
      seed: { type: 'string' },
      fps: { type: 'string', default: '12' },
      count: { type: 'string' },
      suite: { type: 'boolean', default: false },
      out: { type: 'string', default: 'artifacts/ai-poc' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'pnpm test:ai [--provider fake|fal] [--model turbo|schnell] [--prompt "..."] [--animation idle|walk|attack] [--seed 0] [--fps 12] [--count 1] [--suite] [--out artifacts/ai-poc]\nDefault: fake provider, one sheet. --suite uses 20 varied cases. fal requires FAL_KEY and consumes paid calls.',
    );
    return;
  }
  const providerName = z.enum(['fake', 'fal']).parse(values.provider);
  const model = z.enum(['turbo', 'schnell']).parse(values.model);
  const animation = z.enum(['idle', 'walk', 'attack']).parse(values.animation);
  const fps = z.coerce.number().int().min(4).max(30).parse(values.fps);
  const count = z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .parse(values.count ?? (values.suite ? '20' : '1'));
  const seed =
    values.seed === undefined
      ? null
      : z.coerce.number().int().min(0).max(4294967295).parse(values.seed);
  if (values.suite && values.prompt)
    throw new Error('Use either --suite or --prompt.');
  if (providerName === 'fal' && !process.env.FAL_KEY?.trim())
    throw new Error(
      'Set FAL_KEY in the server-side environment before using --provider fal.',
    );
  const provider =
    providerName === 'fake'
      ? createFakeProvider()
      : createFalProvider({ key: process.env.FAL_KEY!, model });
  const outputRoot = path.resolve(
    values.out,
    `${providerName}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`,
  );
  await mkdir(outputRoot, { recursive: true });
  const results: Awaited<ReturnType<typeof runPocCase>>[] = [];
  for (let index = 0; index < count; index++) {
    const sample = values.suite
      ? POC_CASES[index % POC_CASES.length]!
      : ([
          values.prompt ?? 'blue knight with silver sword',
          animation,
        ] as const);
    const result = await runPocCase(
      provider,
      {
        prompt: sample[0],
        animation: sample[1],
        direction: 'right',
        frameCount: 8,
        seed: seed === null ? null : (seed + index) % 4294967296,
      },
      { outputRoot, testNumber: index + 1, fps },
    );
    results.push(result);
    await writeFile(
      path.join(outputRoot, 'index.json'),
      JSON.stringify(
        { provider: providerName, requestedModel: model, results },
        null,
        2,
      ),
    );
    console.log(`${index + 1}/${count} ${result.status}: ${result.outputPath}`);
  }
  const csv = [
    'testNumber,directory,exactlyEightFrames,correctGrid,sameCharacter,noOverlap,usefulPoses,notes',
    ...results.map(
      (result) =>
        `${result.testNumber},${path.basename(result.outputPath)},,,,,,`,
    ),
  ].join('\n');
  await writeFile(path.join(outputRoot, 'review.csv'), csv + '\n');
  await writeFile(
    path.join(outputRoot, 'REVIEW.md'),
    `# ${providerName} POC review\n\nFill review.csv after inspecting both raw and normalized sheets. PROCESSED means only that image processing succeeded. Fake sheets do not evaluate AI quality.\n\n` +
      results
        .map(
          (result) =>
            `## Case ${result.testNumber}: ${result.status}\n\n![Raw](${path.basename(result.outputPath)}/raw.png)\n\n![Normalized](${path.basename(result.outputPath)}/sheet.png)\n`,
        )
        .join('\n'),
  );
  console.log(`Review: ${path.join(outputRoot, 'REVIEW.md')}`);
  if (results.some((result) => result.status === 'FAILED'))
    process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'POC failed.');
  process.exitCode = 1;
});
