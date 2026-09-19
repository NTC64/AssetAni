import { z } from 'zod';
import { apiKeyPrefix, generateApiKey, hashApiKey } from '../packages/core/src';
import { AccountRepository, createDatabase } from '../packages/db/src';

const argumentsSchema = z.object({
  email: z.string().email(),
  name: z.string().trim().min(1).max(100).default('Cocos Creator'),
});

function parseArguments(argv: string[]) {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined)
      throw new Error('Use --email <address> [--name <key name>].');
    values[flag.slice(2)] = value;
  }
  return argumentsSchema.parse(values);
}

async function main() {
  const input = parseArguments(process.argv.slice(2));
  const databaseUrl = z.string().min(1).parse(process.env.DATABASE_URL);
  const pepper = z.string().min(32).parse(process.env.API_KEY_PEPPER);
  const rawKey = generateApiKey();
  const { db, pool } = createDatabase(databaseUrl);
  try {
    const created = await new AccountRepository(db).provisionFreeUser({
      email: input.email,
      keyName: input.name,
      keyPrefix: apiKeyPrefix(rawKey),
      keyHash: hashApiKey(rawKey, pepper),
    });
    console.log(
      JSON.stringify(
        {
          userId: created.user.id,
          email: created.user.email,
          credits: created.user.creditBalance,
          apiKey: rawKey,
          expiresAt: created.apiKey.expiresAt?.toISOString(),
          warning: 'Store this API key now. It cannot be retrieved later.',
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

void main();
