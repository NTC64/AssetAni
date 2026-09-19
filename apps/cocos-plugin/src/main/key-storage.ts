import { z } from 'zod';

const NAME = 'ai-sprite-generator';
const keySchema = z.string().regex(/^spr_live_[A-Za-z0-9_-]{43}$/);

export async function loadApiKey() {
  const stored = await Editor.Profile.getConfig(NAME, 'apiKey', 'local');
  return typeof stored === 'string' && keySchema.safeParse(stored).success
    ? stored
    : '';
}

export async function saveApiKey(apiKey: string) {
  await Editor.Profile.setConfig(
    NAME,
    'apiKey',
    keySchema.parse(apiKey),
    'local',
  );
}
