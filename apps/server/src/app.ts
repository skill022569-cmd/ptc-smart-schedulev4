import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { loadRootEnv } from './db/env';
import { attachAuth } from './middleware/auth';
import { createApiRouter } from './routes/api';

loadRootEnv();

export function createApp(): Express {
  const app = express();
  app.use(
    cors({
      origin: process.env.CORS_ORIGIN || '*',
      credentials: false,
    }),
  );
  app.use(express.json({ limit: '15mb' }));
  app.use(attachAuth);
  app.use('/api', createApiRouter());

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const causeMsg = (err as { cause?: { message?: string } } | null)?.cause?.message;
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[API Error]', err);
    res.status(500).json({ error: causeMsg ? `${causeMsg}` : message.slice(0, 300) });
  });

  return app;
}
