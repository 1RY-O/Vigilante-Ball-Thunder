import express from 'express';

import {
  buildArtifactsRouter,
  buildCapabilitiesRouter,
  buildTranscriptionsRouter,
} from './routes/transcriptions.routes.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import type { AppContext } from './appContext.js';

export function createApp(ctx: AppContext): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // Render (and any reverse proxy) terminates TLS and appends
  // X-Forwarded-For. Without this, express-rate-limit v7 refuses to run
  // (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR) or attributes every client to
  // 127.0.0.1. Must precede any rate-limit middleware.
  app.set('trust proxy', 1);
  // JSON only for small API bodies; uploads use multipart via multer.
  app.use(express.json({ limit: '64kb' }));

  app.use('/api', buildCapabilitiesRouter(ctx));
  app.use('/api/transcriptions', buildTranscriptionsRouter(ctx));
  app.use('/api/artifacts', buildArtifactsRouter(ctx));

  // API-only backend; the frontend is served separately (Vite).
  app.use('/api', notFound);
  app.use(errorHandler);
  return app;
}
