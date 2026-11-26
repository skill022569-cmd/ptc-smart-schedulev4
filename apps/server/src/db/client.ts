import { drizzle } from 'drizzle-orm/mysql2';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { getDatabaseUrl, shouldUseTls, stripSslParam } from './env';
import * as schema from './schema';

const databaseUrl = getDatabaseUrl();

export const pool = mysql.createPool({
  uri: stripSslParam(databaseUrl),
  ...(shouldUseTls(databaseUrl) ? { ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true } } : {}),
  waitForConnections: true,
  connectionLimit: 8,
  maxIdle: 4,
  idleTimeout: 30_000,
  connectTimeout: 10_000,
  enableKeepAlive: true,
  charset: 'utf8mb4',
  timezone: 'Z',
});

export const db = drizzle(pool, { schema, mode: 'default' });

export type Database = typeof db;

/** Single-query health check: server version, current database name, and table count. */
export async function testConnection(): Promise<{
  ok: true;
  version: string;
  database: string | null;
  tableCount: number;
}> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT VERSION() AS version, DATABASE() AS db, (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()) AS table_count',
  );
  const row = rows[0] ?? {};
  return {
    ok: true,
    version: String(row.version ?? ''),
    database: (row.db as string | null) ?? null,
    tableCount: Number(row.table_count ?? 0),
  };
}

let closed = false;

export async function closePool(): Promise<void> {
  if (closed) return;
  closed = true;
  await pool.end();
}
