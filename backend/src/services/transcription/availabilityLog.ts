import type { Config } from '../../config.js';
import { SELF_CHECK_TIMEOUT_CODE } from './engine.js';
import type { EngineAvailability } from './engine.js';

export interface AvailabilityLogLine {
  level: 'info' | 'warn';
  text: string;
}

/**
 * Honest startup wording, branched on the machine-readable CODE (never on the
 * message text): a cold-start timeout means "warming up, will retry in the
 * background", while every other code is a real blocker that stays
 * unavailable until an operator fixes it.
 *
 * Returned instead of printed so the exact copy is unit-tested.
 */
export function availabilityLogLine(
  config: Pick<Config, 'selfCheckTimeoutMs'>,
  availability: EngineAvailability,
): AvailabilityLogLine {
  if (availability.ok) {
    return { level: 'info', text: 'MuScriptor engine: ready (deps installed, HF access verified).' };
  }
  if (availability.code === SELF_CHECK_TIMEOUT_CODE) {
    return {
      level: 'warn',
      text: `MuScriptor engine warming up (first check exceeded ${Math.round(
        config.selfCheckTimeoutMs / 1000,
      )}s — will retry in background)`,
    };
  }
  return {
    level: 'warn',
    text: `MuScriptor engine NOT available: ${availability.code ?? 'unknown'} — ${
      availability.reason ?? 'no reason given'
    }`,
  };
}
