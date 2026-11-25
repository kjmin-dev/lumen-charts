import { DAY, HOUR, MINUTE, SECOND, civil, civilDay, civilMonth, civilYear, daysFromCivil } from './calendar';
import { type TimeZone, timeZone } from './time-zone';

/** `regular` hours, or extended hours before (`pre`) or after (`post`) them. */
export type SessionKind = 'regular' | 'pre' | 'post';

/** One session of a trading day, in the wall-clock time of the schedule's time zone. */
export interface TradingSession {
	/** Start, `HH:MM` or `HH:MM:SS`. */
	start: string;
	/**
	 * End (exclusive), `HH:MM` or `HH:MM:SS`; `24:00` is the end of the day. An end at or before the
	 * start ends on the next day: the session starts on the day before its trading day, as a futures
	 * session from 18:00 to 17:00 does.
	 */
	end: string;
	/** Default `regular`. `pre` and `post` are extended hours, which the chart can shade. */
	kind?: SessionKind;
}

/**
 * When a market trades. Plain JSON, so it can be saved and restored with the chart's options.
 *
 * A trading day is named by the date on which its sessions end. Its sessions follow each other in
 * the order given and span at most 24 hours together.
 */
export interface SessionSchedule {
	/** IANA time zone of the exchange; empty (default) uses the chart's time zone. */
	timeZone: string;
	/** Days of the week with a trading day, 0 (Sunday) to 6 (Saturday). Default Monday to Friday. */
	days: number[];
	/** The sessions of a trading day. Empty (default): no schedule, the market never closes. */
	hours: TradingSession[];
	/** Trading days without sessions, `YYYY-MM-DD`. */
	holidays: string[];
}

/** The session a time falls in. */
export interface SessionInfo {
	/** Index of the session in `hours`. */
	index: number;
	kind: SessionKind;
	/** The trading day, `YYYY-MM-DD`. */
	tradingDay: string;
}

/** A compiled schedule: sessions as offsets from the trading day's midnight, in milliseconds. */
export class SessionCalendar {
	public readonly zone: TimeZone;
	/** Session `s` runs from `start[s]` to `end[s]` after the midnight that begins its trading day. */
	public readonly start: Float64Array;
	public readonly end: Float64Array;
	public readonly extended: Uint8Array;
	public readonly kinds: readonly SessionKind[];
	/** Bit `d` is set for weekday `d` (0 is Sunday) with a trading day. */
	private readonly _days: number;
	/** Holidays as day numbers (days since 1970-01-01). */
	private readonly _holidays: Set<number>;

	public constructor(schedule: SessionSchedule, chartZone: TimeZone) {
		this.zone = schedule.timeZone === '' ? chartZone : timeZone(schedule.timeZone);
		const count = schedule.hours.length;
		this.start = new Float64Array(count);
		this.end = new Float64Array(count);
		this.extended = new Uint8Array(count);
		const kinds: SessionKind[] = [];
		for (let s = 0; s < count; s++) {
			const session = schedule.hours[s]!;
			const start = clock(session.start, false);
			let end = clock(session.end, true);
			if (end <= start) {
				end += DAY;
			}
			// Times are relative to the midnight of the day the session ends on.
			const shift = end > DAY ? DAY : 0;
			this.start[s] = start - shift;
			this.end[s] = end - shift;
			const kind = session.kind ?? 'regular';
			if (kind !== 'regular' && kind !== 'pre' && kind !== 'post') {
				throw new RangeError(`lumen-ticks: unknown session kind "${String(kind)}"`);
			}
			kinds.push(kind);
			this.extended[s] = kind === 'regular' ? 0 : 1;
			if (s > 0 && this.start[s]! < this.end[s - 1]!) {
				throw new RangeError(`lumen-ticks: session ${s} starts before session ${s - 1} ends`);
			}
		}
		if (count > 0 && this.end[count - 1]! - this.start[0]! > DAY) {
			throw new RangeError('lumen-ticks: the sessions of a trading day span more than 24 hours');
		}
		this.kinds = kinds;
		let days = 0;
		for (const day of schedule.days) {
			if (!Number.isInteger(day) || day < 0 || day > 6) {
				throw new RangeError(`lumen-ticks: ${String(day)} is not a day of the week (0 to 6)`);
			}
			days |= 1 << day;
		}
		if (days === 0 && count > 0) {
			throw new RangeError('lumen-ticks: a session schedule needs at least one day of the week');
		}
		this._days = days;
		this._holidays = new Set(schedule.holidays.map(date));
	}

	/** Whether day `day` (days since 1970-01-01) is a trading day. */
	public isTradingDay(day: number): boolean {
		// 1970-01-01 was a Thursday.
		const weekday = (((day + 4) % 7) + 7) % 7;
		return (this._days & (1 << weekday)) !== 0 && !this._holidays.has(day);
	}

	/** The trading day after `day`. */
	public nextTradingDay(day: number): number {
		let next = day + 1;
		// A week without a trading day is a long run of holidays; give up after a year of them.
		for (let i = 0; i < 366 && !this.isTradingDay(next); i++) {
			next++;
		}
		return next;
	}

	public previousTradingDay(day: number): number {
		let previous = day - 1;
		for (let i = 0; i < 366 && !this.isTradingDay(previous); i++) {
			previous--;
		}
		return previous;
	}

	/** Instant session `s` of trading day `day` starts. */
	public sessionStart(day: number, s: number): number {
		return this.zone.firstAtOrAfter(day * DAY + this.start[s]!);
	}

	/** Instant session `s` of trading day `day` ends. */
	public sessionEnd(day: number, s: number): number {
		return this.zone.firstAtOrAfter(day * DAY + this.end[s]!);
	}

	/** Instant trading day `day` starts: the start of its first session. */
	public dayStart(day: number): number {
		return this.sessionStart(day, 0);
	}

	/**
	 * Trading day that `time` belongs to: the last one that started at or before it. Times between
	 * two trading days belong to the earlier one.
	 */
	public dayOf(time: number): number {
		let day = Math.floor((this.zone.wall(time) - this.start[0]!) / DAY);
		if (!this.isTradingDay(day)) {
			day = this.previousTradingDay(day);
		}
		// The wall clock moves by the change at a switch to or from summer time; check in UTC.
		if (time < this.dayStart(day)) {
			return this.previousTradingDay(day);
		}
		const next = this.nextTradingDay(day);
		return time >= this.dayStart(next) ? next : day;
	}

	/** Earliest instant after `time` at which a session starts. */
	public nextSessionStart(time: number): number {
		const day = this.dayOf(time);
		const count = this.start.length;
		for (let s = 1; s < count; s++) {
			const start = this.sessionStart(day, s);
			if (start > time) {
				return start;
			}
		}
		return this.dayStart(this.nextTradingDay(day));
	}

	/** Index of the session `time` falls in, or -1 outside every session. */
	public sessionAt(time: number): number {
		const day = this.dayOf(time);
		for (let s = 0; s < this.start.length; s++) {
			if (time >= this.sessionStart(day, s) && time < this.sessionEnd(day, s)) {
				return s;
			}
		}
		return -1;
	}
}

/** Milliseconds after midnight of `HH:MM[:SS]`; `24:00` only as an end. */
function clock(text: string, end: boolean): number {
	const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(typeof text === 'string' ? text.trim() : '');
	const hours = match === null ? NaN : Number(match[1]);
	const minutes = match === null ? NaN : Number(match[2]);
	const seconds = match?.[3] === undefined ? 0 : Number(match[3]);
	const value = hours * HOUR + minutes * MINUTE + seconds * SECOND;
	if (!(minutes < 60 && seconds < 60 && (value < DAY || (end && value === DAY)))) {
		throw new RangeError(`lumen-ticks: "${String(text)}" is not a time of day (HH:MM)`);
	}
	return value;
}

/** Day number of `YYYY-MM-DD`. */
function date(text: string): number {
	const match = /^(-?\d{4,})-(\d{2})-(\d{2})$/.exec(typeof text === 'string' ? text.trim() : '');
	if (match !== null) {
		const year = Number(match[1]);
		const month = Number(match[2]);
		const day = Number(match[3]);
		const days = daysFromCivil(year, month, day);
		civil(days);
		if (civilYear === year && civilMonth === month && civilDay === day) {
			return days;
		}
	}
	throw new RangeError(`lumen-ticks: "${String(text)}" is not a date (YYYY-MM-DD)`);
}

/** `YYYY-MM-DD` of a day number. */
export function formatDay(day: number): string {
	civil(day);
	const month = civilMonth < 10 ? `0${civilMonth}` : `${civilMonth}`;
	const dayOfMonth = civilDay < 10 ? `0${civilDay}` : `${civilDay}`;
	return `${civilYear}-${month}-${dayOfMonth}`;
}

/** The calendar of a schedule, or null for a schedule without sessions. Throws a RangeError for a malformed one. */
export function sessionCalendar(schedule: SessionSchedule, chartZone: TimeZone): SessionCalendar | null {
	return schedule.hours.length === 0 ? null : new SessionCalendar(schedule, chartZone);
}
