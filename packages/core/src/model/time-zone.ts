import { DAY, SECOND, daysFromCivil } from './calendar';

/**
 * Offsets are sampled this far apart, and a change between two samples is found by bisection. Two
 * changes closer than this would be missed when they cancel out; the shortest gap between two
 * changes in the tz database from 1850 to 2060 is 7 days (Brazil in 2000, Gaza and Hebron in 2040).
 */
const SAMPLE_STEP = 2 * DAY;
/** The table grows by at least this much at a time, so a view moving through history rarely grows it. */
const GROW = 364 * DAY;
/** Larger than any offset there has been (local mean times reach almost 16 hours). */
const MAX_OFFSET = DAY;
/** The instants `Date` can represent. */
const TIME_LIMIT = 8.64e15;

/** The system's time zone, which the time zone name `local` stands for. */
export function localTimeZone(): string {
	try {
		return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	} catch {
		return 'UTC';
	}
}

/** Order of the numeric fields in `format` output, as indexes into [year, month, day, hour, minute, second]. */
interface FieldOrder {
	fields: Int8Array;
}

/**
 * UTC offsets of one time zone, from a table of the instants where the offset changes.
 *
 * The table covers a range of instants and grows on demand. Growing it samples the offset with
 * `Intl.DateTimeFormat` every two days and bisects to the second between two samples that differ;
 * everything else is a lookup in the table, so converting a bar's time costs no `Intl` call. Tables
 * are shared by every chart of the page that shows the zone (see `timeZone`).
 */
export class TimeZone {
	/** The IANA name, with `local` resolved. */
	public readonly name: string;
	/** Calls of `Intl.DateTimeFormat#format` so far, for tests and benchmarks. */
	public samples = 0;

	/** Start of each segment, ascending; segment `i` has offset `_offsets[i]` until the next start. */
	private _starts: number[] = [];
	private _offsets: number[] = [];
	/** Instants `[_lo, _hi]` the table holds; both are sample points. */
	private _lo = 0;
	private _hi = 0;
	/** Segment of the last lookup: lookups tend to follow each other. */
	private _last = 0;
	private readonly _format: Intl.DateTimeFormat | null;
	private readonly _order: FieldOrder | null;
	/** Numbers parsed from the last `format` output. */
	private readonly _numbers = new Float64Array(6);

	/** Throws a RangeError for a name `Intl` does not know. */
	public constructor(name: string) {
		this.name = name;
		if (isUtc(name)) {
			this._format = null;
			this._order = null;
			this._starts.push(-Infinity);
			this._offsets.push(0);
			this._lo = -Infinity;
			this._hi = Infinity;
			return;
		}
		this._format = new Intl.DateTimeFormat('en-US', {
			timeZone: name,
			hourCycle: 'h23',
			era: 'short',
			year: 'numeric',
			month: 'numeric',
			day: 'numeric',
			hour: 'numeric',
			minute: 'numeric',
			second: 'numeric',
		});
		this._order = fieldOrder(this._format);
	}

	/** Whether the zone is UTC, whose offset is always 0. */
	public get isUtc(): boolean {
		return this._format === null;
	}

	/** Offset of the zone's wall-clock time from UTC at instant `time`, in milliseconds. */
	public offset(time: number): number {
		// Looked up first: growing the table at its start replaces the arrays.
		const segment = this._segment(time);
		return this._offsets[segment]!;
	}

	/** Wall-clock time at instant `time`, as milliseconds on a UTC timeline (read it as UTC). */
	public wall(time: number): number {
		const segment = this._segment(time);
		return time + this._offsets[segment]!;
	}

	/**
	 * Earliest instant, not before `notBefore`, whose wall-clock time is at or after `wall`. A wall
	 * time skipped by a change to summer time gives the instant of the change; one repeated by a
	 * change back gives its first occurrence.
	 */
	public firstAtOrAfter(wall: number, notBefore = -Infinity): number {
		let from = Math.max(wall - MAX_OFFSET, notBefore);
		for (;;) {
			const segment = this._segment(from);
			const candidate = Math.max(from, wall - this._offsets[segment]!);
			// Looking the candidate up grows the table to it, at the end only: `segment` stays valid.
			if (this._segment(candidate) === segment) {
				return candidate;
			}
			from = this._starts[segment + 1]!;
		}
	}

	/**
	 * First instant after `time` whose wall-clock time is in another interval of `step` milliseconds
	 * (an hour, 15 minutes, ...) than the wall-clock time at `time`. Across a change back from summer
	 * time the wall clock repeats an hour, and that is a change of interval too.
	 */
	public nextChange(time: number, step: number): number {
		let segment = this._segment(time);
		let offset = this._offsets[segment]!;
		const interval = Math.floor((time + offset) / step);
		for (;;) {
			const candidate = (interval + 1) * step - offset;
			if (this._segment(candidate) === segment) {
				return candidate;
			}
			segment++;
			const change = this._starts[segment]!;
			offset = this._offsets[segment]!;
			if (Math.floor((change + offset) / step) !== interval) {
				return change;
			}
		}
	}

	/** Makes sure the table covers `[from, to]`, so lookups there call no `Intl`. */
	public cover(from: number, to: number): void {
		if (from === from) {
			this._segment(from);
		}
		if (to === to) {
			this._segment(to);
		}
	}

	/** Index of the segment holding `time`, growing the table to it first. */
	private _segment(time: number): number {
		if (!(time >= this._lo && time <= this._hi)) {
			if (time !== time) {
				if (this._starts.length > 0) {
					return this._last;
				}
				time = 0;
			}
			this._grow(Math.min(TIME_LIMIT, Math.max(-TIME_LIMIT, time)));
			if (!(time >= this._lo && time <= this._hi)) {
				// Beyond what `Date` represents: the offset at the edge.
				return time < this._lo ? 0 : this._starts.length - 1;
			}
		}
		const starts = this._starts;
		const last = this._last;
		if (starts[last]! <= time && (last + 1 === starts.length || time < starts[last + 1]!)) {
			return last;
		}
		let lo = 0;
		let hi = starts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (starts[mid]! <= time) {
				lo = mid;
			} else {
				hi = mid - 1;
			}
		}
		this._last = lo;
		return lo;
	}

	/** Grows the table to cover `time`, by at least `GROW` at the side it grows. */
	private _grow(time: number): void {
		if (this._starts.length === 0) {
			const start = alignDown(time - GROW / 2);
			this._starts.push(start);
			this._offsets.push(this._sample(start));
			this._lo = start;
			this._hi = start;
		}
		if (time > this._hi) {
			const to = Math.min(alignUp(Math.max(time, this._hi + GROW)), alignDown(TIME_LIMIT));
			this._scan(this._starts, this._offsets, this._hi, to, NaN);
			this._hi = to;
		} else if (time < this._lo) {
			const from = Math.max(alignDown(Math.min(time, this._lo - GROW)), alignUp(-TIME_LIMIT));
			const starts = [from];
			const offsets = [this._sample(from)];
			this._scan(starts, offsets, from, this._lo, this._offsets[0]!);
			// The old first segment starts where the table started, not at a change: it continues the
			// last new segment, unless a change falls exactly there.
			if (starts[starts.length - 1] === this._lo) {
				starts.pop();
				offsets.pop();
			} else {
				this._starts.shift();
				this._offsets.shift();
			}
			this._starts = starts.concat(this._starts);
			this._offsets = offsets.concat(this._offsets);
			this._lo = from;
			this._last = 0;
		}
	}

	/**
	 * Appends the changes in `(from, to]` to `starts` and `offsets`, whose last segment holds the
	 * offset at `from`. `atTo` is the offset at `to` if known, else NaN.
	 */
	private _scan(starts: number[], offsets: number[], from: number, to: number, atTo: number): void {
		let current = offsets[offsets.length - 1]!;
		for (let a = from; a < to;) {
			const b = Math.min(a + SAMPLE_STEP, to);
			const atB = b === to && atTo === atTo ? atTo : this._sample(b);
			let lo = a;
			// More than one change between two samples is found too, as long as they do not cancel out.
			while (atB !== current) {
				let x = lo;
				let y = b;
				while (y - x > SECOND) {
					const mid = x + Math.floor((y - x) / (2 * SECOND)) * SECOND;
					if (this._sample(mid) === current) {
						x = mid;
					} else {
						y = mid;
					}
				}
				const offset = y === b ? atB : this._sample(y);
				starts.push(y);
				offsets.push(offset);
				current = offset;
				lo = y;
			}
			a = b;
		}
	}

	/** Offset at `time` (a whole second) from `Intl`. */
	private _sample(time: number): number {
		this.samples++;
		const text = this._format!.format(time);
		const numbers = this._numbers;
		numbers.fill(0);
		let field = 0;
		let digits = false;
		let bc = false;
		for (let i = 0; i < text.length && field < 6; i++) {
			const code = text.charCodeAt(i);
			if (code >= 48 && code <= 57) {
				numbers[field] = numbers[field]! * 10 + code - 48;
				digits = true;
			} else {
				if (digits) {
					field++;
					digits = false;
				}
				if (code === 66) {
					// "BC"
					bc = true;
				}
			}
		}
		const order = this._order!.fields;
		let year = numbers[order[0]!]!;
		if (bc) {
			year = 1 - year;
		}
		const hour = numbers[order[3]!]! % 24;
		const wall =
			daysFromCivil(year, numbers[order[1]!]!, numbers[order[2]!]!) * DAY +
			((hour * 60 + numbers[order[4]!]!) * 60 + numbers[order[5]!]!) * SECOND;
		return wall - time;
	}
}

function isUtc(name: string): boolean {
	const upper = name.toUpperCase();
	return upper === 'UTC' || upper === 'ETC/UTC' || upper === 'GMT' || upper === 'ETC/GMT';
}

function alignDown(time: number): number {
	return Math.floor(time / SAMPLE_STEP) * SAMPLE_STEP;
}

function alignUp(time: number): number {
	return Math.ceil(time / SAMPLE_STEP) * SAMPLE_STEP;
}

/** Where year, month, day, hour, minute and second appear among the numbers of `format` output. */
function fieldOrder(format: Intl.DateTimeFormat): FieldOrder {
	const types = ['year', 'month', 'day', 'hour', 'minute', 'second'];
	const fields = new Int8Array(6);
	let position = 0;
	for (const part of format.formatToParts(Date.UTC(2001, 1, 3, 4, 5, 6))) {
		const index = types.indexOf(part.type);
		if (index >= 0) {
			fields[index] = position++;
		}
	}
	return { fields };
}

const zones = new Map<string, TimeZone>();

/**
 * The shared table of a time zone. `local` is the system's zone. Throws a RangeError for a name
 * `Intl` does not know.
 */
export function timeZone(name: string): TimeZone {
	const resolved = name === 'local' ? localTimeZone() : name;
	let zone = zones.get(resolved);
	if (zone === undefined) {
		try {
			zone = new TimeZone(resolved);
		} catch {
			throw new RangeError(`lumen-charts: unknown time zone "${name}"`);
		}
		zones.set(resolved, zone);
	}
	return zone;
}
