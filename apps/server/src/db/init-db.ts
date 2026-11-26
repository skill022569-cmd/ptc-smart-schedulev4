import mysql, { type RowDataPacket } from 'mysql2/promise';
import { getDatabaseUrl, shouldUseTls, stripSslParam } from './env';

const DEFAULT_DB_NAME = 'ptc_smart_schedulev4';

async function main(): Promise<void> {
  const rawUrl = getDatabaseUrl();
  const parsed = new URL(stripSslParam(rawUrl));
  const pathDb = parsed.pathname.replace(/^\/+/, '').trim();
  const dbName = pathDb || DEFAULT_DB_NAME;

  if (!/^[a-zA-Z0-9_]+$/.test(dbName)) {
    throw new Error(`Invalid database name "${dbName}" — expected alphanumeric/underscore only.`);
  }

  parsed.pathname = '/';
  const serverUri = parsed.toString();

  const conn = await mysql.createConnection({
    uri: serverUri,
    ...(shouldUseTls(rawUrl) ? { ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true } } : {}),
    charset: 'utf8mb4',
  });

  try {
    const [rows] = await conn.query<RowDataPacket[]>('SELECT VERSION() AS version');
    const version = String(rows[0]?.version ?? '');
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    console.log(`✔ Connected (${version || 'MySQL/TiDB'}) — database "${dbName}" is ready.`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('✖ db:init failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
