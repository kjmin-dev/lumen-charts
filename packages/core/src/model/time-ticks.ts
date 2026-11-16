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
import type { SessionCalendar } from './sessions';
import { TimeFormat, WEIGHT_DAY, WEIGHT_MONTH, WEIGHT_SESSION, WEIGHT_TIME, WEIGHT_YEAR } from './time-format';
import { type TimeZone, timeZone } from './time-zone';

export { WEIGHT_DAY, WEIGHT_MONTH, WEIGHT_SESSION, WEIGHT_TIME, WEIGHT_YEAR, formatDateTime } from './time-format';

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

/** Start of the step interval that contains wall-clock time `wall`. */
function floorToStep(wall: number, step: Step): number {
	if (step.kind === UNIFORM) {
		return Math.floor(wall / step.size) * step.size;
	}
	civil(Math.floor(wall / DAY));
	switch (step.kind) {
		case DAYS:
			return daysFromCivil(civilYear, civilMonth, 1 + Math.floor((civilDay - 1) / step.size) * step.size) * DAY;
		case MONTHS:
			return daysFromCivil(civilYear, 1 + Math.floor((civilMonth - 1) / step.size) * step.size, 1) * DAY;
		default:
			return daysFromCivil(Math.floor(civilYear / step.size) * step.size, 1, 1) * DAY;
	}
}

/** Start of the interval after the one that starts at wall-clock time `boundary`. */
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

/** Weight of a date change from day `previous` to the later day `day` (day numbers). */
function dateWeight(previous: number, day: number): number {
	civil(previous);
	const year = civilYear;
	const month = civilMonth;
	civil(day);
	return civilYear !== year ? WEIGHT_YEAR : civilMonth !== month ? WEIGHT_MONTH : WEIGHT_DAY;
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

const UTC = timeZone('UTC');
const BUILT_IN = new TimeFormat('', null, null);
/**
 * Bars at least this far apart are dates (daily bars and longer), shown as their UTC date whatever
 * the time zone: TradingView's datafeed convention stamps them at 00:00 UTC, which a zone west of
 * UTC would show on the day before.
 */
export const DATE_BARS = 20 * HOUR;

/**
 * Time-axis ticks for the visible bars.
 *
 * Labels sit on bars that start a calendar interval (the first bar at or after each boundary of
 * the chosen step), so they stay on the same bars while the chart scrolls. Boundaries are those of
 * the wall clock in the chart's time zone, through daylight saving changes; with a session
 * schedule, days are trading days and every session start is a boundary too. The work per call is
 * proportional to the number of labels, not to the number of visible bars: each label costs a few
 * lookups in the time zone's table of offsets.
 */
export class TimeTicks {
	public count = 0;
	/** Position of each tick in the time column that was passed to `update`. */
	public position = new Int32Array(64);
	public weight = new Uint8Array(64);
	public readonly labels: string[] = [];
	/** True when the bars of the last update were dates (see `DATE_BARS`), shown in UTC. */
	public dates = false;

	private _zone: TimeZone = UTC;
	private _sessions: SessionCalendar | null = null;
	private _step: Step = STEPS[0]!;
	/** What the label of the last weighed bar stands for (see `TimeFormat.label`). */
	private _labelWall = 0;

	/**
	 * @param time times of consecutive bars
	 * @param from first visible position in `time`
	 * @param to one past the last visible position
	 * @param barsPerLabel smallest distance between two labels, in bars
	 * @param zone time zone whose wall clock the labels follow
	 * @param sessions the session schedule, if any
	 * @param format turns times into labels
	 * @param rowBars bars per row of `time` (a bucket of a level of detail holds several)
	 */
	public update(
		time: Float64Array,
		from: number,
		to: number,
		barsPerLabel: number,
		zone: TimeZone = UTC,
		sessions: SessionCalendar | null = null,
		format: TimeFormat = BUILT_IN,
		rowBars = 1,
	): void {
		this.count = 0;
		if (to <= from) {
			return;
		}
		const interval = typicalInterval(time, from, to);
		this.dates = interval / rowBars >= DATE_BARS;
		this._zone = this.dates ? UTC : zone;
		this._sessions = this.dates ? null : sessions;
		const target = interval * barsPerLabel;
		let step = STEPS[STEPS.length - 1]!;
		for (const candidate of STEPS) {
			if (candidate.span >= target) {
				step = candidate;
				break;
			}
		}
		this._step = step;
		const seconds = step.kind === UNIFORM && step.size < MINUTE;
		// Evenly spaced data needs about one iteration per label. Data with irregular gaps can put a
		// bar into many more step intervals than there is room for labels; past this many iterations
		// the walk jumps straight to the next bar a label could go on.
		const patience = Math.ceil((to - from) / barsPerLabel) * 4 + 8;
		const stride = Math.ceil(barsPerLabel);
		let lastPosition = -1;
		let lastWeight = -1;
		let position = from;
		// The first visible bar is labeled if it starts an interval, not merely because it is visible.
		let starts = from === 0 || this._begins(time[from - 1]!, time[from]!);
		// Every iteration moves on by at least one bar, so this bound is never the one that stops a
		// normal walk.
		for (let guard = 0; guard <= to - from; guard++) {
			const barTime = time[position]!;
			if (starts) {
				// The first bar held has no predecessor to compare with. It is shown with its date,
				// which is what the start of the data needs.
				const weight = this._weigh(position > 0 ? time[position - 1]! : barTime - DAY, barTime);
				if (lastPosition >= 0 && position - lastPosition < barsPerLabel) {
					// Too close to the previous label: the more significant of the two stays.
					if (weight > lastWeight) {
						this._set(this.count - 1, position, weight, format.label(barTime, this._labelWall, weight, seconds));
						lastPosition = position;
						lastWeight = weight;
					}
				} else {
					this._set(this.count, position, weight, format.label(barTime, this._labelWall, weight, seconds));
					this.count++;
					lastPosition = position;
					lastWeight = weight;
				}
			}
			// Continuing from the bar's own interval steps over gaps in one move.
			let boundary = this._next(barTime);
			if (guard > patience && lastPosition >= 0 && lastPosition + stride < to) {
				const ahead = this._next(time[lastPosition + stride - 1]!);
				if (ahead > boundary) {
					boundary = ahead;
				}
			}
			position = lowerBound(time, position + 1, to, boundary);
			if (position >= to) {
				break;
			}
			starts = true;
		}
	}

	/** Step interval of `time`: an index for uniform steps, the interval's start for calendar ones. */
	private _interval(time: number): number {
		const step = this._step;
		if (step.kind === UNIFORM) {
			return Math.floor(this._zone.wall(time) / step.size);
		}
		const sessions = this._sessions;
		return floorToStep(sessions === null ? this._zone.wall(time) : sessions.dayOf(time) * DAY, step);
	}

	/**
	 * Whether a bar at `time` after one at `previous` starts an interval, or, on a grid finer than a
	 * day, a session.
	 */
	private _begins(previous: number, time: number): boolean {
		const sessions = this._sessions;
		return (
			this._interval(previous) !== this._interval(time) ||
			(sessions !== null && this._step.kind === UNIFORM && sessions.nextSessionStart(previous) <= time)
		);
	}

	/**
	 * First instant after `time` at which the next interval starts, or, on a grid finer than a day,
	 * the next session. Labels a day or more apart have no room for the sessions within a day.
	 */
	private _next(time: number): number {
		const step = this._step;
		const zone = this._zone;
		const sessions = this._sessions;
		if (step.kind === UNIFORM) {
			const next = zone.nextChange(time, step.size);
			if (sessions === null) {
				return next;
			}
			const session = sessions.nextSessionStart(time);
			return session < next ? session : next;
		}
		if (sessions === null) {
			return zone.firstAtOrAfter(nextBoundary(floorToStep(zone.wall(time), step), step), time);
		}
		let day = nextBoundary(floorToStep(sessions.dayOf(time) * DAY, step), step) / DAY;
		if (!sessions.isTradingDay(day)) {
			day = sessions.nextTradingDay(day);
		}
		return sessions.dayStart(day);
	}

	/**
	 * Weight of a bar at `time` after one at `previous`: the largest calendar unit that changed
	 * between their wall-clock times (trading days with a schedule), or a session start. Sets what
	 * the label stands for.
	 */
	private _weigh(previous: number, time: number): number {
		const sessions = this._sessions;
		const zone = this._zone;
		if (sessions !== null) {
			const previousDay = sessions.dayOf(previous);
			const day = sessions.dayOf(time);
			if (day > previousDay) {
				this._labelWall = day * DAY;
				return dateWeight(previousDay, day);
			}
			this._labelWall = zone.wall(time);
			return sessions.nextSessionStart(previous) <= time ? WEIGHT_SESSION : WEIGHT_TIME;
		}
		const wall = zone.wall(time);
		const day = Math.floor(wall / DAY);
		const previousDay = Math.floor(zone.wall(previous) / DAY);
		// The wall clock can go back at a change from summer time; only a later date is a new day.
		if (day > previousDay) {
			this._labelWall = day * DAY;
			return dateWeight(previousDay, day);
		}
		this._labelWall = wall;
		return WEIGHT_TIME;
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
