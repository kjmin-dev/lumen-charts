import { DAY, MINUTE, SECOND, civil, civilDay, civilMonth, civilYear } from './calendar';

/** What a time axis label marks: the start of a year, a month, a day, a session, or a time. */
export type TickMarkKind = 'year' | 'month' | 'day' | 'session' | 'time';

/**
 * Formats a time axis label. `time` is the bar's time (UTC milliseconds). `wall` is what the label
 * stands for in the chart's time zone, as milliseconds to read with the `getUTC*` methods of a
 * `Date`: the bar's wall-clock time for `time` and `session` marks, the date's midnight for `day`,
 * `month` and `year` marks (with a session schedule, the date of the trading day). Return null to
 * keep the built-in label.
 */
export type TickMarkFormatter = (time: number, kind: TickMarkKind, wall: number) => string | null | undefined;

/**
 * Formats the crosshair's time label. `time` is the bar's time (UTC milliseconds); `wall` is its
 * wall-clock time in the chart's time zone, to read with the `getUTC*` methods of a `Date`.
 */
export type TimeFormatter = (time: number, wall: number) => string;

/** How much of the calendar changed at a tick. A higher weight wins when labels would collide. */
export const WEIGHT_TIME = 0;
export const WEIGHT_SESSION = 1;
export const WEIGHT_DAY = 2;
export const WEIGHT_MONTH = 3;
export const WEIGHT_YEAR = 4;

const KINDS: readonly TickMarkKind[] = ['time', 'session', 'day', 'month', 'year'];

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TWO_DIGITS: string[] = [];
for (let i = 0; i < 100; i++) {
	TWO_DIGITS.push(i < 10 ? `0${i}` : `${i}`);
}
const DAY_NUMBERS: string[] = [];
for (let i = 0; i <= 31; i++) {
	DAY_NUMBERS.push(`${i}`);
}
/** Labels repeat, so each is built once: these caches only ever hold distinct clock times and years. */
const clockLabels = new Map<number, string>();
const yearLabels = new Map<number, string>();

function clockLabel(wall: number, seconds: boolean): string {
	const ofDay = (((wall % DAY) + DAY) % DAY) / SECOND;
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

/** Full date and time of a wall-clock time (as UTC milliseconds), for the crosshair label. */
export function formatDateTime(wall: number): string {
	civil(Math.floor(wall / DAY));
	const date = `${civilYear}-${TWO_DIGITS[civilMonth]!}-${TWO_DIGITS[civilDay]!}`;
	const ofDay = ((wall % DAY) + DAY) % DAY;
	return `${date} ${clockLabel(wall, ofDay % MINUTE !== 0)}`;
}

/** Labels of a locale, from `Intl.DateTimeFormat`; each distinct label is formatted once. */
class LocaleLabels {
	private readonly _months: string[] = [];
	private readonly _days: string[] = [];
	private readonly _years = new Map<number, string>();
	private readonly _clock = new Map<number, string>();
	private readonly _year: Intl.DateTimeFormat;
	private readonly _minutes: Intl.DateTimeFormat;
	private readonly _seconds: Intl.DateTimeFormat;
	private readonly _dateTime: Intl.DateTimeFormat;
	private readonly _dateTimeSeconds: Intl.DateTimeFormat;

	public constructor(locale: string) {
		// Wall-clock times are UTC timestamps here: formatting them in UTC shows them as they are.
		const utc = { timeZone: 'UTC' } as const;
		const month = new Intl.DateTimeFormat(locale, { ...utc, month: 'short' });
		const day = new Intl.DateTimeFormat(locale, { ...utc, day: 'numeric' });
		for (let m = 0; m < 12; m++) {
			this._months.push(month.format(Date.UTC(2001, m, 1)));
		}
		this._days.push('');
		for (let d = 1; d <= 31; d++) {
			this._days.push(day.format(Date.UTC(2001, 0, d)));
		}
		this._year = new Intl.DateTimeFormat(locale, { ...utc, year: 'numeric' });
		this._minutes = new Intl.DateTimeFormat(locale, { ...utc, hour: 'numeric', minute: '2-digit' });
		this._seconds = new Intl.DateTimeFormat(locale, { ...utc, hour: 'numeric', minute: '2-digit', second: '2-digit' });
		const date = { ...utc, year: 'numeric', month: 'short', day: 'numeric' } as const;
		this._dateTime = new Intl.DateTimeFormat(locale, { ...date, hour: 'numeric', minute: '2-digit' });
		this._dateTimeSeconds = new Intl.DateTimeFormat(locale, {
			...date,
			hour: 'numeric',
			minute: '2-digit',
			second: '2-digit',
		});
	}

	public label(wall: number, weight: number, seconds: boolean): string {
		if (weight <= WEIGHT_SESSION) {
			const ofDay = Math.floor((((wall % DAY) + DAY) % DAY) / SECOND);
			const key = seconds ? ofDay : -1 - Math.floor(ofDay / 60);
			let label = this._clock.get(key);
			if (label === undefined) {
				const time = (seconds ? ofDay : Math.floor(ofDay / 60) * 60) * SECOND;
				label = (seconds ? this._seconds : this._minutes).format(time);
				this._clock.set(key, label);
			}
			return label;
		}
		civil(Math.floor(wall / DAY));
		if (weight === WEIGHT_DAY) {
			return this._days[civilDay]!;
		}
		if (weight === WEIGHT_MONTH) {
			return this._months[civilMonth - 1]!;
		}
		let label = this._years.get(civilYear);
		if (label === undefined) {
			label = this._year.format(wall);
			this._years.set(civilYear, label);
		}
		return label;
	}

	public dateTime(wall: number): string {
		return (wall % MINUTE === 0 ? this._dateTime : this._dateTimeSeconds).format(wall);
	}
}

const locales = new Map<string, LocaleLabels>();

/**
 * Turns times into labels: the built-in formats, those of a locale, or the application's formatters.
 * The caller converts times to wall-clock time first.
 */
export class TimeFormat {
	public readonly locale: string;
	public readonly tickMarkFormatter: TickMarkFormatter | null;
	public readonly timeFormatter: TimeFormatter | null;
	private readonly _locale: LocaleLabels | null;
	/** The crosshair label is asked for on every pointer move; most moves stay on the same bar. */
	private _crosshairTime = NaN;
	private _crosshairWall = NaN;
	private _crosshairLabel = '';

	/** Throws a RangeError for a locale `Intl` does not accept. */
	public constructor(locale: string, tickMarkFormatter: TickMarkFormatter | null, timeFormatter: TimeFormatter | null) {
		this.locale = locale;
		this.tickMarkFormatter = tickMarkFormatter;
		this.timeFormatter = timeFormatter;
		if (locale === '') {
			this._locale = null;
		} else {
			let labels = locales.get(locale);
			if (labels === undefined) {
				labels = new LocaleLabels(locale);
				locales.set(locale, labels);
			}
			this._locale = labels;
		}
	}

	/**
	 * Label of a tick. `wall` is the wall-clock time for time and session weights, else the midnight
	 * of the date the label stands for.
	 */
	public label(time: number, wall: number, weight: number, seconds: boolean): string {
		const formatter = this.tickMarkFormatter;
		if (formatter !== null) {
			const label = formatter(time, KINDS[weight]!, wall);
			if (typeof label === 'string') {
				return label;
			}
		}
		if (this._locale !== null) {
			return this._locale.label(wall, weight, seconds);
		}
		if (weight <= WEIGHT_SESSION) {
			return clockLabel(wall, seconds);
		}
		civil(Math.floor(wall / DAY));
		if (weight === WEIGHT_DAY) {
			return DAY_NUMBERS[civilDay]!;
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

	/** Label of the crosshair at a bar with time `time` and wall-clock time `wall`. */
	public crosshair(time: number, wall: number): string {
		if (time === this._crosshairTime && wall === this._crosshairWall) {
			return this._crosshairLabel;
		}
		const label =
			this.timeFormatter !== null
				? this.timeFormatter(time, wall)
				: this._locale !== null
					? this._locale.dateTime(wall)
					: formatDateTime(wall);
		this._crosshairTime = time;
		this._crosshairWall = wall;
		this._crosshairLabel = label;
		return label;
	}
}
