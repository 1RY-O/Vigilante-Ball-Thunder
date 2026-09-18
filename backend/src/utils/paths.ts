import path from 'node:path';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { newId } from './id.js';

/**
 * Safe filesystem helpers. Uploads/artifacts live under a dedicated transient
 * root; user-controlled path segments are never trusted.
 */

/** Join `name` onto `root`, refusing anything escaping `root` (traversal). */
export function safeJoin(root: string, name: string): string {
  if (name.length === 0) throw new Error('empty path component');
  const resolved = path.resolve(root, name);
  const resolvedRoot = path.resolve(root);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error('path escapes root');
  }
  return resolved;
}

/** Create a fresh, unguessable directory beneath `root`. */
export async function makeIsolatedDir(root: string): Promise<string> {
  await fs.mkdir(root, { recursive: true });
  const dir = safeJoin(root, `${Date.now()}-${randomBytes(8).toString('hex')}-${newId()}`);
  await fs.mkdir(dir);
  return dir;
}

/** Random on-disk filename for staged uploads (never the user's name). */
export function randomFileName(ext: string): string {
  const safeExt = ext.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 8);
  return `${Date.now()}-${randomBytes(12).toString('hex')}${safeExt ? '.' + safeExt : ''}`;
}

/** Best-effort recursive removal; ignores missing paths and races. */
export async function removeTree(p: string | null | undefined): Promise<void> {
  if (!p) return;
  try {
    await fs.rm(p, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}
