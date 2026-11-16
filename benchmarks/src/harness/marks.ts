import { MEASURE_END_MARK, MEASURE_START_MARK } from '../profile.ts';

/**
 * Marks where the measured part of a run starts and ends on the performance timeline. A trace of
 * the run (`pnpm bench --profile`) is cut there; without a trace the two marks cost nothing that a
 * measurement would see, since they are set outside the timed calls.
 */
export function markMeasured(edge: 'start' | 'end'): void {
	performance.mark(edge === 'start' ? MEASURE_START_MARK : MEASURE_END_MARK);
}
