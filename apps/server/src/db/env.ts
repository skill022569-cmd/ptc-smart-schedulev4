import { existsSync } from 'node:fs';
import path from 'node:path';
import { config } from 'dotenv';

export const DEFAULT_DATABASE_URL = 'mysql://root:ptc1234@127.0.0.1:3306/ptc_smart_schedulev4';

/**
 * Locate the monorepo root (directory containing `pnpm-workspace.yaml`) by walking up from
 * `startDir`. Works the same whether invoked from the repo root, `apps/server`, ESM (tsx) or
 * the CJS loader drizzle-kit uses for `drizzle.config.ts` (so no `import.meta` here).
 */
export function findRepoRoot(startDir: string = process.cwd()): string {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir);
    dir = parent;
  }
}

let loaded = false;

/** Load the root `.env` once (existing `process.env` values win). Returns the resolved path. */
export function loadRootEnv(): string {
  const envPath = path.join(findRepoRoot(), '.env');
  if (!loaded) {
    loaded = true;
    if (existsSync(envPath)) config({ path: envPath, quiet: true });
  }
  return envPath;
}

export function getDatabaseUrl(): string {
  loadRootEnv();
  return process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
}

/** TLS is required for TiDB Serverless; enabled by `DB_SSL=true` or a `tidbcloud.com` host. */
export function shouldUseTls(url: string = getDatabaseUrl()): boolean {
  return process.env.DB_SSL === 'true' || url.includes('tidbcloud.com');
}
