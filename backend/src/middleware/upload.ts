import multer from 'multer';
import path from 'node:path';

import { canonicalExtension, isSupportedMime, ValidationError } from '../services/audio/validation.js';
import { randomFileName } from '../utils/paths.js';

/**
 * Multer staging: uploads land in an isolated temp root under a random name —
 * the user-provided filename is never used on disk. Authoritative validation
 * (magic bytes, size, ext/MIME agreement) happens after staging in the route.
 */
export function buildUploadMiddleware(uploadDir: string, maxBytes: number): multer.Multer {
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      cb(null, randomFileName(path.extname(file.originalname || '').slice(1)));
    },
  });
  const fileFilter: multer.Options['fileFilter'] = (_req, file, cb) => {
    // Lenient pre-filter only: reject when BOTH extension and MIME are
    // unsupported. Magic-byte validation is the authoritative step later.
    const extOk = canonicalExtension(file.originalname || '') !== null;
    const mimeOk = isSupportedMime(file.mimetype);
    if (!extOk && !mimeOk) {
      cb(new ValidationError('Unsupported file type. Use WAV, MP3 or FLAC.'));
      return;
    }
    cb(null, true);
  };
  return multer({ storage, limits: { fileSize: maxBytes, files: 1 }, fileFilter });
}
