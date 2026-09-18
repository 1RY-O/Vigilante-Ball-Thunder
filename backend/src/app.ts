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
