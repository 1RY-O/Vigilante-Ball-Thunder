import { safeMessage } from '../../utils/messages.js';
import type { EngineAvailability, TranscriptionEngine } from './engine.js';

/**
 * Non-blocking engine readiness tracker (cold-start warm-up).
 *
 * A MuScriptor availability check spawns a Python process that imports torch
 * (and probes the gated weights). On an 8GB CPU-only laptop the FIRST check
 * takes 45-60s while later checks are fast — so no HTTP request may await one:
 *
 *  - `snapshot()` returns the last completed probe immediately and NEVER
 *    blocks. Before the first probe finishes there is no state yet (`null`),
 *    which callers report honestly as "warming up".
 *  - `start()` fires that first probe in the background (warm-up) and keeps
 *    re-probing every `pollIntervalMs` until the engine is available, then
 *    stops polling.
 *
 * Previously /api/capabilities awaited a live check, so a cold start stalled
 * the request for the whole timeout; it now answers from the snapshot.
 *
 * Honesty: only a completed probe sets the state, and its code/reason are
 * forwarded verbatim. Nothing here invents readiness, and no progress or
 * result is ever derived from this state.
 */
export interface AvailabilitySnapshot {
  /** Last completed probe, or null before the first one finishes. */
  value: EngineAvailability | null;
  /** True while a probe is in flight (warm-up). */
  checking: boolean;
}

export class AvailabilityMonitor {
  private readonly engine: TranscriptionEngine;
  private readonly pollIntervalMs: number;
  private readonly listeners = new Set<(availability: EngineAvailability) => void>();
  private value: EngineAvailability | null = null;
  private inFlight: Promise<EngineAvailability> | null = null;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(engine: TranscriptionEngine, pollIntervalMs: number) {
    this.engine = engine;
    this.pollIntervalMs = Math.max(250, pollIntervalMs);
  }

  /**
   * Last known state. Never awaits a probe and never re-probes a settled
   * state, so readers always get the cached answer immediately — and an idle
   * server never spawns a python process just because someone polled.
   *
   * Only an UNKNOWN state (no completed probe yet) lazily kicks off one probe,
   * so a request arriving before the warm-up loop produced anything still gets
   * an honest "warming up" answer that self-heals.
   */
  snapshot(): AvailabilitySnapshot {
    if (!this.stopped && !this.value && !this.inFlight) void this.refresh();
    return { value: this.value, checking: this.inFlight !== null };
  }

  /**
   * Non-blocking warm-up: probe now, keep re-probing every `pollIntervalMs`
   * while the engine is NOT available, and stop for good as soon as it is —
   * so a warm server costs nothing (no periodic torch imports on a CPU-only
   * laptop). Idempotent; `dispose`/`stop` tears the timer down.
   */
  start(): void {
    if (this.stopped || this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
    this.timer.unref();
  }

  private poll(): void {
    if (this.value?.ok) {
      this.clearTimer(); // warm — nothing left to poll (see class docs)
      return;
    }
    void this.refresh();
  }

  private clearTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  /** Subscribe to completed probes (used for the startup log). */
  onResult(listener: (availability: EngineAvailability) => void): void {
    this.listeners.add(listener);
  }

  /** Run one real probe (deduplicated). Never rejects. */
  refresh(): Promise<EngineAvailability> {
    if (this.inFlight) return this.inFlight;
    const probe = this.engine
      .available(true) // bypass the engine cache: a poll must be a real check
      .catch(
        (e: unknown): EngineAvailability => ({
          ok: false,
          code: 'engine-unavailable',
          reason: e instanceof Error ? safeMessage(e.message) : 'The engine availability check failed.',
        }),
      )
      .then((value: EngineAvailability): EngineAvailability => {
        this.value = value;
        this.inFlight = null;
        if (value.ok) this.clearTimer(); // warm: polling has nothing left to do
        for (const listener of this.listeners) listener(value);
        return value;
      });
    this.inFlight = probe;
    return probe;
  }
}
