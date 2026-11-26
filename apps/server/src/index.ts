import { createApp } from './app';
import { closePool, testConnection } from './db/client';

const port = Number(process.env.PORT || 4000);
const app = createApp();

const server = app.listen(port, async () => {
  try {
    const info = await testConnection();
    console.log(`✔ PTC Smart Schedule V4 API listening on http://localhost:${port} (DB: ${info.database})`);
  } catch (err) {
    console.warn(`⚠ API listening on http://localhost:${port}, DB check warning:`, err instanceof Error ? err.message : err);
  }
});

process.on('SIGINT', async () => {
  server.close();
  await closePool();
  process.exit(0);
});
