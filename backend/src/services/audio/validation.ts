import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Upload validation. Advertised formats are exactly what the real pipeline
 * (muscriptor -> soundfile/libsndfile) decodes reliably on this deployment:
 * WAV, MP3, FLAC. Magic-byte sniffing is authoritative; extension and MIME
 * are advisory and must agree with the content when present.
 */

export const SUPPORTED_FORMATS = ['wav', 'mp3', 'flac'] as const;
export type SupportedFormat = (typeof SUPPORTED_FORMATS)[number];

const EXTENSION_SET = new Set<string>(SUPPORTED_FORMATS);

const MIME_ALLOWLIST = new Set([
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/vnd.wave',
  'audio/mpeg',
  'audio/mp3',
  'audio/x-mpeg',
  'audio/flac',
  'audio/x-flac',
]);

/** Canonical extension for a filename, or null if unsupported. */
export function canonicalExtension(fileName: string): SupportedFormat | null {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  return EXTENSION_SET.has(ext) ? (ext as SupportedFormat) : null;
}

export function isSupportedMime(mime: string | undefined): boolean {
  return !!mime && MIME_ALLOWLIST.has((mime.split(';')[0] ?? '').trim().toLowerCase());
}

export class ValidationError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 415) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = statusCode;
  }
}

const HEADER_READ = 4096;

/**
 * Sniff the actual content from magic bytes; never trusts extension or MIME.
 * Returns the canonical format or null if unrecognized.
 */
export async function sniffFormat(absPath: string): Promise<SupportedFormat | null> {
  const buf = Buffer.alloc(HEADER_READ);
  const fh = await fs.open(absPath, 'r');
  let n = 0;
  try {
    n = (await fh.read(buf, 0, HEADER_READ, 0)).bytesRead;
  } finally {
    await fh.close();
  }
  const head = buf.subarray(0, n);
  if (head.length < 4) return null;
  // WAV / RIFF
  if (head.subarray(0, 4).toString('ascii') === 'RIFF') {
    return head.subarray(8, 12).toString('ascii') === 'WAVE' ? 'wav' : null;
  }
  // FLAC
  if (head.subarray(0, 4).toString('ascii') === 'fLaC') return 'flac';
  // MP3: ID3 tag or MPEG frame sync
  if (head.subarray(0, 3).toString('ascii') === 'ID3') return 'mp3';
  if (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) return 'mp3';
  return null;
}

export interface ValidatedUpload {
  format: SupportedFormat;
  sizeBytes: number;
}

/**
 * Validate a file already staged on disk. Throws ValidationError on any
 * mismatch; callers must delete the staged file on failure.
 */
export async function validateStagedUpload(
  absPath: string,
  mime: string,
  fileName: string,
  maxBytes: number,
): Promise<ValidatedUpload> {
  let sizeBytes: number;
  try {
    sizeBytes = (await fs.stat(absPath)).size;
  } catch {
    throw new ValidationError('Upload could not be read.');
  }
  if (sizeBytes === 0) throw new ValidationError('Uploaded file is empty.', 415);
  if (sizeBytes > maxBytes) {
    throw new ValidationError(`File exceeds the maximum upload size of ${Math.floor(maxBytes / (1024 * 1024))} MB.`, 413);
  }
  const extFormat = canonicalExtension(fileName);
  const sniffed = await sniffFormat(absPath);
  if (extFormat === null && !isSupportedMime(mime)) {
    throw new ValidationError('Unsupported file type. Use WAV, MP3 or FLAC.');
  }
  if (sniffed === null) {
    throw new ValidationError('Could not recognize the audio content.');
  }
  if (extFormat !== null && sniffed !== extFormat) {
    throw new ValidationError('File extension does not match its actual content.');
  }
  return { format: sniffed, sizeBytes };
}

/**
 * Read the duration (seconds) of a canonical PCM WAV from its header.
 * Returns null for non-WAV or malformed headers; callers treat that as
 * "unknown duration" and let the worker enforce any hard limit.
 */
export async function wavDurationFromHeader(absPath: string): Promise<number | null> {
  try {
    const fh = await fs.open(absPath, 'r');
    try {
      const head = Buffer.alloc(12);
      await fh.read(head, 0, 12, 0);
      if (head.subarray(0, 4).toString('ascii') !== 'RIFF') return null;
      if (head.subarray(8, 12).toString('ascii') !== 'WAVE') return null;
      const stat = await fh.stat();
      let offset = 12;
      let byteRate = 0;
      let dataSize = 0;
      const chunkHeader = Buffer.alloc(8);
      while (offset + 8 <= stat.size) {
        await fh.read(chunkHeader, 0, 8, offset);
        const id = chunkHeader.subarray(0, 4).toString('ascii');
        const size = chunkHeader.readUInt32LE(4);
        if (id === 'fmt ' && size >= 16) {
          const fmt = Buffer.alloc(16);
          await fh.read(fmt, 0, 16, offset + 8);
          byteRate = fmt.readUInt32LE(8); // fmt.byteRate
        } else if (id === 'data') {
          dataSize = size;
        }
        offset += 8 + size + (size % 2);
      }
      if (byteRate <= 0 || dataSize <= 0) return null;
      return dataSize / byteRate;
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}
