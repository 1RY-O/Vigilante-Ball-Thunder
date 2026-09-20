import multer from 'multer';
import type { NextFunction, Request, Response } from 'express';

import { ValidationError } from '../services/audio/validation.js';
import { EngineUnavailableError, NotImplementedError } from '../services/transcription/engine.js';
import { PlaybackFailedError, PlaybackUnavailableError } from '../services/playback/playbackService.js';

function send(res: Response, status: number, body: unknown): void {
  if (!res.headersSent) res.status(status).json(body);
}

/**
 * Central error mapping. Internal error text is never surfaced verbatim when
 * it could contain paths or stack details; safe, curated messages only.
 */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      send(res, 413, { error: 'File exceeds the maximum upload size.' });
      return;
    }
    send(res, 400, { error: 'The upload could not be processed.' });
    return;
  }
  if (err instanceof ValidationError) {
    send(res, err.statusCode, { error: err.message });
    return;
  }
  if (err instanceof EngineUnavailableError) {
    // Honest 503: the engine cannot run (missing deps/token/license). The
    // message is curated and safe; the code lets clients react precisely.
    send(res, 503, { error: 'engine-unavailable', code: err.code, message: err.message });
    return;
  }
  if (err instanceof NotImplementedError) {
    // Honest 501: the engine is fine, but the requested transformation is not
    // something this deployment can produce. Never downgraded silently.
    send(res, 501, { error: 'not-implemented', code: err.code, message: err.message });
    return;
  }
  if (err instanceof PlaybackUnavailableError) {
    // Honest 503: playback needs FluidSynth + a SoundFont; no fake audio.
    send(res, 503, { error: 'playback-unavailable', code: err.code, message: err.message });
    return;
  }
  if (err instanceof PlaybackFailedError) {
    send(res, 500, { error: 'playback-failed', code: 'render-failed', message: err.message });
    return;
  }
  if (err instanceof Error) {
    console.error('[api] unexpected error:', err.message);
  }
  send(res, 500, { error: 'An unexpected error occurred.' });
}

/** 404 handler for unmatched /api routes. */
export function notFound(_req: Request, res: Response): void {
  send(res, 404, { error: 'Not found.' });
}
