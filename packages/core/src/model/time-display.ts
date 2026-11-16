import { type ChartOptions, type LocalizationOptions, optionsEqual } from '../options';
import { SessionMarks } from './session-marks';
import { type SessionCalendar, type SessionInfo, type SessionSchedule, formatDay, sessionCalendar } from './sessions';
import { TimeFormat } from './time-format';
import { DATE_BARS } from './time-ticks';
import { type TimeZone, timeZone } from './time-zone';

/**
 * How a chart shows time: its time zone, session schedule and label formats, compiled from the
 * options. Bar times stay UTC milliseconds everywhere else; the engine never sees any of this.
 */
export class TimeDisplay {
	public zone: TimeZone = timeZone('UTC');
	public sessions: SessionCalendar | null = null;
	public format = new TimeFormat('', null, null);
	public readonly marks = new SessionMarks();
	private _localization: LocalizationOptions | null = null;
	private _schedule: SessionSchedule | null = null;

	/**
	 * Takes over the time options. Returns whether anything shown changes. Throws a RangeError for an
	 * unknown time zone or locale, or a malformed schedule, and then changes nothing.
	 */
	public apply(options: ChartOptions): boolean {
		const localization = options.localization;
		const schedule = options.sessions.schedule;
		const previous = this._localization;
		if (previous !== null && optionsEqual(localization, previous) && optionsEqual(schedule, this._schedule)) {
			return false;
		}
		const zone = timeZone(localization.timeZone);
		const format =
			previous !== null &&
			localization.locale === previous.locale &&
			localization.tickMarkFormatter === previous.tickMarkFormatter &&
			localization.timeFormatter === previous.timeFormatter
				? this.format
				: new TimeFormat(localization.locale, localization.tickMarkFormatter, localization.timeFormatter);
		const sessions = sessionCalendar(schedule, zone);
		this.zone = zone;
		this.format = format;
		this.sessions = sessions;
		this._localization = localization;
		this._schedule = schedule;
		return true;
	}

	/**
	 * Builds the offset tables for the first `count` times of a window, each a row of `rowBars` bars,
	 * ahead of the frames that need them. Daily and longer bars are dates shown in UTC (see
	 * `DATE_BARS`): a century of them needs no table.
	 */
	public cover(time: Float64Array, count: number, rowBars: number): void {
		if (count <= 0) {
			return;
		}
		const from = time[0]!;
		const to = time[count - 1]!;
		if (count > 1 && (to - from) / ((count - 1) * rowBars) >= DATE_BARS) {
			return;
		}
		this.zone.cover(from, to);
		const sessions = this.sessions;
		if (sessions !== null && sessions.zone !== this.zone) {
			sessions.zone.cover(from, to);
		}
	}

	/** Whether `time` is in a session of the schedule, extended hours included; true without one. */
	public isInSession(time: number): boolean {
		const sessions = this.sessions;
		return sessions === null || (Number.isFinite(time) && sessions.sessionAt(time) >= 0);
	}

	/** The session `time` is in, or null outside every session and without a schedule. */
	public sessionAt(time: number): SessionInfo | null {
		const sessions = this.sessions;
		if (sessions === null || !Number.isFinite(time)) {
			return null;
		}
		const index = sessions.sessionAt(time);
		return index < 0 ? null : { index, kind: sessions.kinds[index]!, tradingDay: formatDay(sessions.dayOf(time)) };
	}
}
