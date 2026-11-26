/**
 * Idempotent seed: wipes all 30 tables (children first) and inserts `scenarios/<code>.json`
 * (parents first) inside ONE transaction, using batched multi-row INSERTs.
 * Usage: pnpm seed -- --scenario Q01   (default Q21)
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ScenarioDataset, TableName } from '@ptc/shared';
import { TABLE_NAMES } from '@ptc/shared';
import { closePool, db, testConnection } from './client';
import { findRepoRoot } from './env';
import { SCHEMA_TABLES } from './schema';

const SUPPORTED = ['Q01', 'Q21'] as const;
type SeedScenario = (typeof SUPPORTED)[number];

/** Rows per INSERT statement (keeps placeholders far below the 65 535 limit). */
const BATCH_SIZE = 500;

export function parseScenarioArg(argv: string[]): SeedScenario {
  let value: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--scenario' || arg === '-s') value = argv[i + 1];
    else if (arg.startsWith('--scenario=')) value = arg.slice('--scenario='.length);
  }
  const code = (value ?? 'Q21').toUpperCase();
  if (!(SUPPORTED as readonly string[]).includes(code)) {
    throw new Error(`Unsupported scenario "${value}". Use --scenario ${SUPPORTED.join('|')}`);
  }
  return code as SeedScenario;
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function insertBatched(tx: Transaction, name: TableName, rows: readonly object[]): Promise<number> {
  const table = SCHEMA_TABLES[name];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    // Row shapes are verified against `$inferInsert` at compile time in schema.typecheck.ts.
    await tx.insert(table).values(rows.slice(i, i + BATCH_SIZE) as never);
  }
  return rows.length;
}

async function main(): Promise<void> {
  const code = parseScenarioArg(process.argv.slice(2));
  const file = path.join(findRepoRoot(), 'scenarios', `${code}.json`);
  const scenario = JSON.parse(await readFile(file, 'utf8')) as ScenarioDataset;

  const info = await testConnection();
  console.log(`Connected to ${info.database ?? '(no database)'} — server ${info.version}`);
  console.log(`Seeding scenario ${scenario.code}: ${scenario.name}`);

  const started = Date.now();
  const inserted = {} as Record<TableName, number>;
  await db.transaction(async (tx) => {
    for (const name of [...TABLE_NAMES].reverse()) await tx.delete(SCHEMA_TABLES[name]);
    for (const name of TABLE_NAMES) inserted[name] = await insertBatched(tx, name, scenario.tables[name] ?? []);
  });

  const width = Math.max(...TABLE_NAMES.map((n) => n.length));
  let total = 0;
  for (const name of TABLE_NAMES) {
    total += inserted[name];
    console.log(`  ${name.padEnd(width)}  ${String(inserted[name]).padStart(6)}`);
  }
  console.log(`✔ Inserted ${total} rows into ${TABLE_NAMES.length} tables in ${Date.now() - started} ms`);
}

main()
  .catch((err: unknown) => {
    const e = err as { code?: string; message?: string };
    console.error(`✖ Seed failed: ${e.message ?? String(err)}`);
    if (e.code === 'ER_NO_SUCH_TABLE') console.error('  Hint: run `pnpm db:push` (or `pnpm db:migrate`) first.');
    if (e.code === 'ECONNREFUSED') console.error('  Hint: start MySQL (`docker compose up -d`) or set DATABASE_URL in .env.');
    process.exitCode = 1;
  })
  .finally(() => closePool());
