/**
 * Idempotent seed: wipes all 30 tables (children first) and inserts `scenarios/<code>.json`
 * (parents first) inside ONE transaction, using batched multi-row INSERTs.
 * Canonical Phase 2 `constraint_configs` (`competition`, `default`, `teacher_first`, `room_first`)
 * are seeded from `@ptc/shared` so the live DB matches the Constraint Engine presets.
 * Usage: pnpm.cmd seed -- --scenario Q01   (default Q21)
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BUILT_IN_PROFILES,
  TABLE_NAMES,
  getProfileConfigs,
  type ConstraintConfig,
  type ScenarioDataset,
  type TableName,
} from '@ptc/shared';
import { closePool, db, testConnection } from './client';
import { resolveProjectFile } from './env';
import { stableId } from './scenario-builder';
import { SCHEMA_TABLES } from './schema';

const SUPPORTED = ['Q01', 'Q21'] as const;
export type SeedScenarioCode = (typeof SUPPORTED)[number];

/** Rows per INSERT statement (keeps placeholders far below the 65,535 limit). */
const BATCH_SIZE = 500;

export function parseScenarioArg(argv: string[]): SeedScenarioCode {
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
  return code as SeedScenarioCode;
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function insertBatched(tx: Transaction, name: TableName, rows: readonly object[]): Promise<number> {
  const table = SCHEMA_TABLES[name];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    await tx.insert(table).values(rows.slice(i, i + BATCH_SIZE) as never);
  }
  return rows.length;
}

export function buildCanonicalConstraintConfigs(scope: string): ConstraintConfig[] {
  const out: ConstraintConfig[] = [];
  for (const profile of BUILT_IN_PROFILES) {
    for (const row of getProfileConfigs(profile)) {
      out.push({
        ...row,
        id: stableId(scope, 'canonical_cc', profile, row.code),
      });
    }
  }
  return out;
}

export async function seedScenarioIntoDb(code: SeedScenarioCode): Promise<{
  scenario: ScenarioDataset;
  inserted: Record<TableName, number>;
  totalRows: number;
  durationMs: number;
}> {
  const file = resolveProjectFile('scenarios', `${code}.json`);
  const scenario = JSON.parse(await readFile(file, 'utf8')) as ScenarioDataset;
  const canonicalConfigs = buildCanonicalConstraintConfigs(code);

  const started = Date.now();
  const inserted = {} as Record<TableName, number>;
  await db.transaction(async (tx) => {
    for (const name of [...TABLE_NAMES].reverse()) await tx.delete(SCHEMA_TABLES[name]);
    for (const name of TABLE_NAMES) {
      const rows = name === 'constraint_configs' ? canonicalConfigs : (scenario.tables[name] ?? []);
      inserted[name] = await insertBatched(tx, name, rows);
    }
  });

  const totalRows = TABLE_NAMES.reduce((sum, n) => sum + inserted[n], 0);
  return { scenario, inserted, totalRows, durationMs: Date.now() - started };
}

async function main(): Promise<void> {
  const code = parseScenarioArg(process.argv.slice(2));
  const info = await testConnection();
  console.log(`Connected to ${info.database ?? '(no database)'} — server ${info.version}`);
  const { scenario, inserted, totalRows, durationMs } = await seedScenarioIntoDb(code);
  console.log(`Seeding scenario ${scenario.code}: ${scenario.name}`);
  const width = Math.max(...TABLE_NAMES.map((n) => n.length));
  for (const name of TABLE_NAMES) {
    console.log(`  ${name.padEnd(width)}  ${String(inserted[name]).padStart(6)}`);
  }
  console.log(`✔ Inserted ${totalRows} rows into ${TABLE_NAMES.length} tables in ${durationMs} ms`);
}

const isCliEntry = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCliEntry) {
  main()
    .catch((err: unknown) => {
      const e = err as { code?: string; message?: string };
      console.error(`✖ Seed failed: ${e.message ?? String(err)}`);
      if (e.code === 'ER_NO_SUCH_TABLE') console.error('  Hint: run `pnpm.cmd db:push` first.');
      if (e.code === 'ECONNREFUSED') console.error('  Hint: start MySQL or set DATABASE_URL in .env.');
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
