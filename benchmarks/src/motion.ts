import type { LogicalRange } from './adapter.ts';
import type { Motion } from './jobs.ts';

/** Pan speed: fraction of the visible width moved per frame. */
export const PAN_STEP = 0.01;

/**
 * Visible ranges for every step of a scripted motion over `size` bars with `visible` bars in view;
 * step 0 is the starting range. Every range holds `to - from + 1` bars.
 *
 * - `pan`: starts at the latest bar and moves into history by `PAN_STEP` of the width per step.
 *   It turns around when the view would leave the data by more than half a width on the left, or
 *   show space after the latest bar on the right. With every bar in view, the data slides between
 *   fully visible and half visible.
 * - `zoom`: keeps the latest bar at the right edge and shows `visible * 2^w` bars, where `w` moves
 *   linearly 0 -> 1 -> 0 -> -1 -> 0, one leg every `legSteps` steps.
 */
export function motionRanges(
	motion: Motion,
	size: number,
	visible: number,
	steps: number,
	legSteps: number,
): LogicalRange[] {
	const ranges: LogicalRange[] = [];
	if (motion === 'pan') {
		const stepBars = visible * PAN_STEP;
		let from = size - visible;
		let direction = -1;
		for (let i = 0; i < steps; i++) {
			if (i > 0) {
				let next = from + direction * stepBars;
				if (next < -visible / 2 || next + visible - 1 > size - 1) {
					direction = -direction;
					next = from + direction * stepBars;
				}
				from = next;
			}
			ranges.push({ from, to: from + visible - 1 });
		}
		return ranges;
	}
	for (let i = 0; i < steps; i++) {
		const leg = Math.floor(i / legSteps) % 4;
		const t = (i % legSteps) / legSteps;
		const w = leg === 0 ? t : leg === 1 ? 1 - t : leg === 2 ? -t : t - 1;
		const count = visible * 2 ** w;
		ranges.push({ from: size - count, to: size - 1 });
	}
	return ranges;
}
