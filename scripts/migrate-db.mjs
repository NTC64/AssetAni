import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required.');

const pool = new pg.Pool({ connectionString: databaseUrl });
try {
  await migrate(drizzle(pool), { migrationsFolder: 'migrations' });
  console.log('Database migrations completed.');
} finally {
  await pool.end();
}
