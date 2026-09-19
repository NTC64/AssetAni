import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { z } from 'zod';
import { createDatabase } from './client';

async function main() {
  const databaseUrl = z.string().url().parse(process.env.DATABASE_URL);
  const { db, pool } = createDatabase(databaseUrl);
  try {
    await migrate(db, { migrationsFolder: 'migrations' });
    console.log('Database migrations completed.');
  } finally {
    await pool.end();
  }
}

void main();
