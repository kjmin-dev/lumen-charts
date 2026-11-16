import { DAY } from './calendar';
import type { SessionCalendar } from './sessions';
import type { TimeZone } from './time-zone';

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

function grown<T extends Int32Array | Float32Array>(array: T, size: number): T {
	if (size <= array.length) {
		return array;
	}
	const next = new (array.constructor as new (length: number) => T)(size * 2);
	next.set(array);
	return next;
}

/**
 * Where the session decorations of the visible bars go: a break at the first bar of each trading
 * day (calendar day without a schedule), and the runs of bars in extended-hours sessions. The work
 * per update is a few lookups per day in view; the caller bounds the days.
 */
export class SessionMarks {
	/** Rows of the time column at which a trading day starts, and the device x of their left edges. */
	public breakCount = 0;
	public breakRow = new Int32Array(16);
	public breakX = new Float32Array(16);
	/** Runs of rows `[from, to)` in extended hours, and the device x of their edges. */
	public shadeCount = 0;
	public shadeFrom = new Int32Array(16);
	public shadeTo = new Int32Array(16);
	public shadeLeft = new Float32Array(16);
	public shadeRight = new Float32Array(16);

	/**
	 * @param time times of consecutive rows (bars, or the first bar of each bucket)
	 * @param from first visible row
	 * @param to one past the last visible row
	 * @param maxDays most days in view for which anything is placed
	 */
	public update(
		time: Float64Array,
		from: number,
		to: number,
		zone: TimeZone,
		sessions: SessionCalendar | null,
		maxDays: number,
		breaks: boolean,
		shade: boolean,
	): void {
		this.breakCount = 0;
		this.shadeCount = 0;
		if (to <= from || (!breaks && !(shade && sessions !== null))) {
			return;
		}
		if (sessions === null) {
			const first = Math.floor(zone.wall(time[from]!) / DAY);
			const last = Math.floor(zone.wall(time[to - 1]!) / DAY);
			if (last - first > maxDays) {
				return;
			}
			for (let day = first; day <= last; day++) {
				this._break(time, from, to, zone.firstAtOrAfter(day * DAY));
			}
			return;
		}
		const first = sessions.dayOf(time[from]!);
		const last = sessions.dayOf(time[to - 1]!);
		if (last - first > maxDays) {
			return;
		}
		const count = sessions.start.length;
		for (let day = first; day <= last; day = sessions.nextTradingDay(day)) {
			if (breaks) {
				this._break(time, from, to, sessions.dayStart(day));
			}
			if (!shade) {
				continue;
			}
			for (let s = 0; s < count; s++) {
				if (sessions.extended[s] === 0) {
					continue;
				}
				const start = lowerBound(time, from, to, sessions.sessionStart(day, s));
				const end = lowerBound(time, start, to, sessions.sessionEnd(day, s));
				if (end > start) {
					this._shade(start, end);
				}
			}
		}
	}

	/** Device x of the marks, for rows that start at item `start` of a level with `size` bars per item. */
	public place(origin: number, spacing: number, start: number, size: number): void {
		for (let i = 0; i < this.breakCount; i++) {
			this.breakX[i] = Math.round(origin + ((start + this.breakRow[i]!) * size - 0.5) * spacing);
		}
		for (let i = 0; i < this.shadeCount; i++) {
			this.shadeLeft[i] = Math.round(origin + ((start + this.shadeFrom[i]!) * size - 0.5) * spacing);
			this.shadeRight[i] = Math.round(origin + ((start + this.shadeTo[i]!) * size - 0.5) * spacing);
		}
	}

	private _break(time: Float64Array, from: number, to: number, dayStart: number): void {
		// Searching from the start of the column tells the first bar of a day from the first visible
		// one. The first row held has no known predecessor, so it gets no break.
		const row = lowerBound(time, 0, to, dayStart);
		if (row <= 0 || row < from || row >= to) {
			return;
		}
		const count = this.breakCount;
		if (count > 0 && this.breakRow[count - 1] === row) {
			return;
		}
		this.breakRow = grown(this.breakRow, count + 1);
		this.breakX = grown(this.breakX, count + 1);
		this.breakRow[count] = row;
		this.breakCount = count + 1;
	}

	private _shade(from: number, to: number): void {
		const count = this.shadeCount;
		// Post-market hours and the next day's pre-market hours usually touch: one run.
		if (count > 0 && this.shadeTo[count - 1]! >= from) {
			this.shadeTo[count - 1] = Math.max(this.shadeTo[count - 1]!, to);
			return;
		}
		this.shadeFrom = grown(this.shadeFrom, count + 1);
		this.shadeTo = grown(this.shadeTo, count + 1);
		this.shadeLeft = grown(this.shadeLeft, count + 1);
		this.shadeRight = grown(this.shadeRight, count + 1);
		this.shadeFrom[count] = from;
		this.shadeTo[count] = to;
		this.shadeCount = count + 1;
	}
}
