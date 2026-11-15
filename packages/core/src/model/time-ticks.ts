import {
	DAY,
	HOUR,
	MINUTE,
	SECOND,
	civil,
	civilDay,
	civilMonth,
	civilYear,
	daysFromCivil,
	daysInMonth,
} from './calendar';

/** How much of the calendar changed at a tick. A higher weight wins when labels would collide. */
export const WEIGHT_TIME = 0;
export const WEIGHT_DAY = 1;
export const WEIGHT_MONTH = 2;
export const WEIGHT_YEAR = 3;

const UNIFORM = 0;
const DAYS = 1;
const MONTHS = 2;
const YEARS = 3;

interface Step {
	kind: number;
	/** Milliseconds for uniform steps; otherwise a count of days, months or years. */
	size: number;
	/** Approximate length, used to choose a step. */
	span: number;
}

const uniform = (size: number): Step => ({ kind: UNIFORM, size, span: size });

/**
 * Candidate label steps, each a divisor of the next calendar unit so that day, month and year
 * starts are always on the grid. Multi-day steps restart on the first of each month.
 */
const STEPS: readonly Step[] = [
	...[1, 2, 5, 10, 15, 30].map(n => uniform(n * SECOND)),
	...[1, 2, 5, 10, 15, 30].map(n => uniform(n * MINUTE)),
	...[1, 2, 3, 4, 6, 12].map(n => uniform(n * HOUR)),
	...[1, 2, 7, 14].map(n => ({ kind: DAYS, size: n, span: n * DAY })),
	...[1, 3, 6].map(n => ({ kind: MONTHS, size: n, span: n * 30 * DAY })),
	...[1, 2, 5, 10, 20, 50, 100].map(n => ({ kind: YEARS, size: n, span: n * 365 * DAY })),
];

/** Start of the step interval that contains `time`. */
function floorToStep(time: number, step: Step): number {
	if (step.kind === UNIFORM) {
		return Math.floor(time / step.size) * step.size;
	}
	civil(Math.floor(time / DAY));
	switch (step.kind) {
		case DAYS:
			return daysFromCivil(civilYear, civilMonth, 1 + Math.floor((civilDay - 1) / step.size) * step.size) * DAY;
		case MONTHS:
			return daysFromCivil(civilYear, 1 + Math.floor((civilMonth - 1) / step.size) * step.size, 1) * DAY;
		default:
			return daysFromCivil(Math.floor(civilYear / step.size) * step.size, 1, 1) * DAY;
	}
}

/** Start of the interval after the one that starts at `boundary`. */
function nextBoundary(boundary: number, step: Step): number {
	if (step.kind === UNIFORM) {
		return boundary + step.size;
	}
	civil(Math.floor(boundary / DAY));
	switch (step.kind) {
		case DAYS: {
			const day = civilDay + step.size;
			return day > daysInMonth(civilYear, civilMonth)
				? daysFromCivil(civilYear, civilMonth + 1, 1) * DAY
				: daysFromCivil(civilYear, civilMonth, day) * DAY;
		}
		case MONTHS:
			return civilMonth + step.size > 12
				? daysFromCivil(civilYear + 1, 1, 1) * DAY
				: daysFromCivil(civilYear, civilMonth + step.size, 1) * DAY;
		default:
			return daysFromCivil(civilYear + step.size, 1, 1) * DAY;
	}
}

/** Largest calendar unit that differs between two times. */
function weightBetween(previous: number, time: number): number {
	const day = Math.floor(time / DAY);
	const previousDay = Math.floor(previous / DAY);
	if (day === previousDay) {
		return WEIGHT_TIME;
	}
	civil(previousDay);
	const year = civilYear;
	const month = civilMonth;
	civil(day);
	return civilYear !== year ? WEIGHT_YEAR : civilMonth !== month ? WEIGHT_MONTH : WEIGHT_DAY;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TWO_DIGITS: string[] = [];
for (let i = 0; i < 100; i++) {
	TWO_DIGITS.push(i < 10 ? `0${i}` : `${i}`);
}
const clockLabels = new Map<number, string>();
const yearLabels = new Map<number, string>();

function clockLabel(time: number, seconds: boolean): string {
	const ofDay = (((time % DAY) + DAY) % DAY) / SECOND;
	const key = seconds ? Math.floor(ofDay) : -1 - Math.floor(ofDay / 60);
	let label = clockLabels.get(key);
	if (label === undefined) {
		const hours = TWO_DIGITS[Math.floor(ofDay / 3600)]!;
		const minutes = TWO_DIGITS[Math.floor(ofDay / 60) % 60]!;
		label = seconds ? `${hours}:${minutes}:${TWO_DIGITS[Math.floor(ofDay) % 60]!}` : `${hours}:${minutes}`;
		clockLabels.set(key, label);
	}
	return label;
}

function tickLabel(time: number, weight: number, seconds: boolean): string {
	if (weight === WEIGHT_TIME) {
		return clockLabel(time, seconds);
	}
	civil(Math.floor(time / DAY));
	if (weight === WEIGHT_DAY) {
		return `${civilDay}`;
	}
	if (weight === WEIGHT_MONTH) {
		return MONTH_NAMES[civilMonth - 1]!;
	}
	let label = yearLabels.get(civilYear);
	if (label === undefined) {
		label = `${civilYear}`;
		yearLabels.set(civilYear, label);
	}
	return label;
}

/** Full UTC date and time, for the crosshair label. */
export function formatDateTime(time: number): string {
	civil(Math.floor(time / DAY));
	const date = `${civilYear}-${TWO_DIGITS[civilMonth]!}-${TWO_DIGITS[civilDay]!}`;
	const ofDay = ((time % DAY) + DAY) % DAY;
	const clock = clockLabel(time, ofDay % MINUTE !== 0);
	return `${date} ${clock}`;
}

/** First position in `time[lo, hi)` whose value is not below `target`. */
function lowerBound(time: Float64Array, lo: number, hi: number, target: number): number {
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (time[mid]! < target) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
}

const SAMPLES = 15;
const sample = new Float64Array(SAMPLES);

/** Median spacing between neighboring bars, from a few samples. Robust against session gaps. */
function typicalInterval(time: Float64Array, from: number, to: number): number {
	const pairs = to - from - 1;
	if (pairs <= 0) {
		return 0;
	}
	const n = Math.min(SAMPLES, pairs);
	for (let s = 0; s < n; s++) {
		const position = from + Math.floor((s * pairs) / n);
		// Insertion sort: at most fifteen values, and nothing is allocated.
		const value = time[position + 1]! - time[position]!;
		let slot = s;
		while (slot > 0 && sample[slot - 1]! > value) {
			sample[slot] = sample[slot - 1]!;
			slot--;
		}
		sample[slot] = value;
	}
	return sample[n >> 1]!;
}

/**
 * Time-axis ticks for the visible bars.
 *
 * Labels sit on bars that start a calendar interval (the first bar at or after each boundary of
 * the chosen step), so they stay on the same bars while the chart scrolls. The work per call is
 * proportional to the number of labels, not to the number of visible bars.
 */
export class TimeTicks {
	public count = 0;
	/** Position of each tick in the time column that was passed to `update`. */
	public position = new Int32Array(64);
	public weight = new Uint8Array(64);
	public readonly labels: string[] = [];

	/**
	 * @param time times of consecutive bars
	 * @param from first visible position in `time`
	 * @param to one past the last visible position
	 * @param barsPerLabel smallest distance between two labels, in bars
	 */
	public update(time: Float64Array, from: number, to: number, barsPerLabel: number): void {
		this.count = 0;
		if (to <= from) {
			return;
		}
		const target = typicalInterval(time, from, to) * barsPerLabel;
		let step = STEPS[STEPS.length - 1]!;
		for (const candidate of STEPS) {
			if (candidate.span >= target) {
				step = candidate;
				break;
			}
		}
		const seconds = step.kind === UNIFORM && step.size < MINUTE;
		const limit = Math.ceil((to - from) / barsPerLabel) * 4 + 8;
		let boundary = floorToStep(time[from]!, step);
		let lastPosition = -1;
		let lastWeight = -1;
		for (let guard = 0; guard < limit; guard++) {
			// Searching from the start of the column tells a bar that begins an interval apart from
			// one that merely is the first visible bar.
			const position = lowerBound(time, 0, to, boundary);
			if (position >= to) {
				break;
			}
			const barTime = time[position]!;
			if (position >= from) {
				// The first bar held has no predecessor to compare with. It is shown with its date,
				// which is what the start of the data needs.
				const weight = weightBetween(position > 0 ? time[position - 1]! : barTime - DAY, barTime);
				if (lastPosition >= 0 && position - lastPosition < barsPerLabel) {
					// Too close to the previous label: the more significant of the two stays.
					if (weight > lastWeight) {
						this._set(this.count - 1, position, weight, tickLabel(barTime, weight, seconds));
						lastPosition = position;
						lastWeight = weight;
					}
				} else {
					this._set(this.count, position, weight, tickLabel(barTime, weight, seconds));
					this.count++;
					lastPosition = position;
					lastWeight = weight;
				}
			}
			// Continuing from the bar's own interval steps over gaps in one move.
			boundary = nextBoundary(floorToStep(barTime, step), step);
		}
	}

	private _set(slot: number, position: number, weight: number, label: string): void {
		if (slot >= this.position.length) {
			const positions = new Int32Array(slot * 2);
			positions.set(this.position);
			this.position = positions;
			const weights = new Uint8Array(slot * 2);
			weights.set(this.weight);
			this.weight = weights;
		}
		this.position[slot] = position;
		this.weight[slot] = weight;
		this.labels[slot] = label;
	}
}
