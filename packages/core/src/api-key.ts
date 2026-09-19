import { createHmac, randomBytes } from 'node:crypto';

export const API_KEY_PREFIX = 'spr_live_';
export const API_KEY_PATTERN = /^spr_live_[A-Za-z0-9_-]{43}$/;

export function assertApiKeyPepper(pepper: string) {
  if (Buffer.byteLength(pepper, 'utf8') < 32)
    throw new Error('API_KEY_PEPPER must contain at least 32 UTF-8 bytes.');
  return pepper;
}

export function generateApiKey() {
  return `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function apiKeyPrefix(rawKey: string) {
  if (!API_KEY_PATTERN.test(rawKey)) throw new Error('Invalid API key format.');
  return rawKey.slice(0, 16);
}

export function hashApiKey(rawKey: string, pepper: string) {
  if (!API_KEY_PATTERN.test(rawKey)) throw new Error('Invalid API key format.');
  return createHmac('sha256', assertApiKeyPepper(pepper))
    .update(rawKey)
    .digest('hex');
}
