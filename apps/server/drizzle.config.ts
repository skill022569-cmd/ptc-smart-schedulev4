import { defineConfig } from 'drizzle-kit';
import { getDrizzleDatabaseUrl } from './src/db/env';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: '../../drizzle',
  dialect: 'mysql',
  dbCredentials: {
    url: getDrizzleDatabaseUrl(),
  },
  strict: true,
  verbose: true,
});
