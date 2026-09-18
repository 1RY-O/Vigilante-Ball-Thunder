import { randomUUID } from 'node:crypto';

/** URL-safe, unguessable identifier for jobs. */
export function newId(): string {
  return randomUUID();
}

/**
 * Filesystem-safe, human-readable slug derived from an untrusted filename.
 * The raw user filename is never used on disk.
 */
export function safeBaseName(original: string): string {
  if (!original) return 'audio';
  const base = original.replace(/\\/g, '/').split('/').pop() ?? 'audio';
  const cleaned = base
    .replace(/[^A-Za-z0-9._ -]/g, '')
    .replace(/\.\./g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const final = cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'audio';
  return final.slice(0, 120) || 'audio';
}
