import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

import { wavDurationFromHeader } from '../audio/validation.js';
import { safeMessage } from '../../utils/messages.js';

/**
 * Server-side playback (MIDI → WAV) via FluidSynth.
 *
 * Honesty contract:
 *  - FluidSynth is an OS-level dependency (never bundled as an npm package).
 *    When the executable or the SoundFont is missing, `probe()` says so and
 *    the endpoint refuses with 503 — no fake audio, no synthesized silence.
 *  - The render command mirrors muscriptor's own auralization invocation
 *    (`fluidsynth -ni -F <out> -r 44100 <soundfont> <midi>`): options MUST
 *    precede the positional soundfont/MIDI arguments, because fluidsynth >= 2.5
 *    silently ignores trailing options and exits 0 without writing a file.
 *    A render that does not produce a readable WAV is a failure, never a
 *    silently-empty success.
 */

export type PlaybackUnavailableCode = 'fluidsynth-missing' | 'soundfont-missing';

export interface PlaybackAvailability {
  available: boolean;
  code?: PlaybackUnavailableCode;
  reason?: string;
}

/** 503-class: playback genuinely cannot run in this deployment. */
export class PlaybackUnavailableError extends Error {
  readonly code: PlaybackUnavailableCode;
  constructor(message: string, code: PlaybackUnavailableCode) {
    super(message);
    this.name = 'PlaybackUnavailableError';
    this.code = code;
  }
}

/** 500-class: playback ran but genuinely failed (no silent fallback). */
export class PlaybackFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaybackFailedError';
  }
}

export const PLAYBACK_MISSING_MESSAGE =
  'Audio playback is unavailable on this deployment: FluidSynth is not installed on the server. Rendering a transcription to audio requires the fluidsynth executable.';
export const SOUNDFONT_MISSING_MESSAGE =
  'Audio playback is unavailable on this deployment: no SoundFont is configured. Set SOUNDFONT_PATH to a .sf2/.sf3 file on the server.';

/** Cache window for the (cheap) binary + soundfont probe. */
const PROBE_TTL_MS = 60_000;
/** Budget for the `fluidsynth --version` probe itself. */
const VERSION_PROBE_TIMEOUT_MS = 5_000;

export class PlaybackService {
  private readonly fluidsynthBin: string;
  private readonly soundfontPath: string;
  private readonly timeoutMs: number;
  private cached: { at: number; value: PlaybackAvailability } | null = null;

  constructor(opts: { fluidsynthBin: string; soundfontPath: string; timeoutMs: number }) {
    this.fluidsynthBin = opts.fluidsynthBin;
    this.soundfontPath = opts.soundfontPath;
    this.timeoutMs = opts.timeoutMs;
  }

  /**
   * Real probe of the OS dependency: run the binary and require a zero exit,
   * then require a configured + readable SoundFont. Cached briefly because it
   * is cheap (unlike the torch-based engine probe) but still a real check.
   */
  async probe(forceRefresh = false): Promise<PlaybackAvailability> {
    if (!forceRefresh && this.cached && Date.now() - this.cached.at < PROBE_TTL_MS) {
      return this.cached.value;
    }
    const value = await this.runProbe();
    this.cached = { at: Date.now(), value };
    return value;
  }

  private async runProbe(): Promise<PlaybackAvailability> {
    const binaryOk = await this.binaryResponds();
    if (!binaryOk) {
      return { available: false, code: 'fluidsynth-missing', reason: PLAYBACK_MISSING_MESSAGE };
    }
    if (!this.soundfontPath) {
      return { available: false, code: 'soundfont-missing', reason: SOUNDFONT_MISSING_MESSAGE };
    }
    try {
      const stat = await fs.stat(this.soundfontPath);
      if (!stat.isFile() || stat.size === 0) {
        return { available: false, code: 'soundfont-missing', reason: SOUNDFONT_MISSING_MESSAGE };
      }
    } catch {
      return { available: false, code: 'soundfont-missing', reason: SOUNDFONT_MISSING_MESSAGE };
    }
    return { available: true };
  }

  private binaryResponds(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      let child;
      try {
        child = spawn(this.fluidsynthBin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        finish(false);
        return;
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(false);
      }, VERSION_PROBE_TIMEOUT_MS);
      timer.unref();
      child.on('error', () => finish(false)); // ENOENT etc.
      child.on('close', (code) => finish(code === 0));
    });
  }

  /**
   * Render `midiPath` to `wavPath` with FluidSynth and return the measured
   * duration of the produced WAV (read from that file's own header).
   *
   * Throws PlaybackUnavailableError when the dependency is missing (callers
   * answer 503 with the precise code) and PlaybackFailedError when the render
   * genuinely failed — never returning a placeholder.
   */
  async renderMidiToWav(midiPath: string, wavPath: string): Promise<number> {
    const availability = await this.probe();
    if (!availability.available) {
      throw new PlaybackUnavailableError(
        availability.reason ?? 'Audio playback is unavailable on this deployment.',
        availability.code ?? 'fluidsynth-missing',
      );
    }
    await fs.rm(wavPath, { force: true }); // never reuse a stale render
    const args = ['-ni', '-F', wavPath, '-r', '44100', this.soundfontPath, midiPath];

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const child = spawn(this.fluidsynthBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      const finish = (err: Error | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new PlaybackFailedError('Audio rendering timed out on the server.'));
      }, this.timeoutMs);
      timer.unref();

      let stderr = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', (e: NodeJS.ErrnoException) => {
        finish(
          e.code === 'ENOENT'
            ? new PlaybackUnavailableError(PLAYBACK_MISSING_MESSAGE, 'fluidsynth-missing')
            : new PlaybackFailedError('Audio rendering could not start on the server.'),
        );
      });
      child.on('close', (code) => {
        if (code !== 0) {
          // stderr stays server-side; clients get a curated message only.
          if (stderr.trim()) {
            console.error('[playback] fluidsynth stderr tail:', safeMessage(stderr.trim().slice(-400)));
          }
          finish(new PlaybackFailedError('Audio rendering failed on the server.'));
          return;
        }
        finish(null);
      });
    });

    const durationSec = await wavDurationFromHeader(wavPath);
    if (durationSec === null || !Number.isFinite(durationSec) || durationSec <= 0) {
      // fluidsynth can exit 0 without writing usable output; that is a failure.
      throw new PlaybackFailedError('Audio rendering produced no readable audio.');
    }
    return durationSec;
  }
}

