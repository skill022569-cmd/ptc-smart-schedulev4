import { drizzle } from 'drizzle-orm/mysql2';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { getDatabaseUrl, shouldUseTls } from './env';
import * as schema from './schema';

const databaseUrl = getDatabaseUrl();

export const pool = mysql.createPool({
  uri: databaseUrl,
  ...(shouldUseTls(databaseUrl) ? { ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true } } : {}),
  waitForConnections: true,
  connectionLimit: 10,
  maxIdle: 10,
  idleTimeout: 60_000,
  enableKeepAlive: true,
  charset: 'utf8mb4',
  timezone: 'Z',
});

export const db = drizzle(pool, { schema, mode: 'default' });

export type Database = typeof db;

/** Ping the database; returns server version and current database name. */
export async function testConnection(): Promise<{ ok: true; version: string; database: string | null }> {
  const conn = await pool.getConnection();
  try {
    await conn.ping();
    const [rows] = await conn.query<RowDataPacket[]>(
      'SELECT VERSION() AS version, DATABASE() AS db',
    );
    const row = rows[0] ?? {};
    return { ok: true, version: String(row.version ?? ''), database: (row.db as string | null) ?? null };
  } finally {
    conn.release();
  }
}

let closed = false;

export async function closePool(): Promise<void> {
  if (closed) return;
  closed = true;
  await pool.end();
}
