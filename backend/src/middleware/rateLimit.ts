import { rateLimit } from 'express-rate-limit';

import type { Config } from '../config.js';

/** Per-IP limiter for the expensive transcription endpoint. */
export function buildRateLimiter(cfg: Pick<Config, 'rateLimitWindowMs' | 'rateLimitMax'>) {
  return rateLimit({
    windowMs: cfg.rateLimitWindowMs,
    limit: cfg.rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again later.' },
  });
}
