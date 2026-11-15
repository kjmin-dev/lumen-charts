import { describe, expect, it } from 'vitest';
import { civil, civilDay, civilMonth, civilYear, daysFromCivil, daysInMonth } from '../src/model/calendar';
import { type SessionCalendar, type SessionSchedule, sessionCalendar } from '../src/model/sessions';
import { TimeFormat } from '../src/model/time-format';
import {
	TimeTicks,
	WEIGHT_DAY,
	WEIGHT_MONTH,
	WEIGHT_SESSION,
	WEIGHT_TIME,
	WEIGHT_YEAR,
	formatDateTime,
} from '../src/model/time-ticks';
import { type TimeZone, timeZone } from '../src/model/time-zone';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function ticksFor(
	time: Float64Array,
	from: number,
	to: number,
	barsPerLabel: number,
	zone?: TimeZone,
	sessions: SessionCalendar | null = null,
	format?: TimeFormat,
) {
	const ticks = new TimeTicks();
	ticks.update(time, from, to, barsPerLabel, zone, sessions, format);
	const result = [];
	for (let i = 0; i < ticks.count; i++) {
		result.push({ position: ticks.position[i]!, weight: ticks.weight[i]!, label: ticks.labels[i]! });
	}
	return result;
}

describe('calendar', () => {
	it('agrees with Date over several centuries', () => {
		for (let days = -150_000; days <= 150_000; days += 37) {
			const date = new Date(days * DAY);
			civil(days);
			expect([civilYear, civilMonth, civilDay]).toEqual([
				date.getUTCFullYear(),
				date.getUTCMonth() + 1,
				date.getUTCDate(),
			]);
			expect(daysFromCivil(civilYear, civilMonth, civilDay)).toBe(days);
		}
	});

	it('knows month lengths and rolls months over', () => {
		expect(daysInMonth(2024, 2)).toBe(29);
		expect(daysInMonth(2023, 2)).toBe(28);
		expect(daysInMonth(2023, 12)).toBe(31);
		expect(daysFromCivil(2023, 13, 1)).toBe(daysFromCivil(2024, 1, 1));
	});

	it('formats a full date and time', () => {
		expect(formatDateTime(Date.UTC(2024, 2, 5, 9, 30))).toBe('2024-03-05 09:30');
		expect(formatDateTime(Date.UTC(2024, 11, 31, 23, 59, 58))).toBe('2024-12-31 23:59:58');
	});
});

describe('TimeTicks', () => {
	it('labels round times on a continuous minute series', () => {
		const start = Date.UTC(2024, 0, 10, 0, 0);
		const time = Float64Array.from({ length: 600 }, (_, i) => start + i * MINUTE);
		const ticks = ticksFor(time, 100, 400, 60);
		expect(ticks.map(tick => tick.label)).toEqual(['02:00', '03:00', '04:00', '05:00', '06:00']);
		expect(ticks.every(tick => tick.weight === WEIGHT_TIME)).toBe(true);
		for (const tick of ticks) {
			expect(time[tick.position]! % (60 * MINUTE)).toBe(0);
		}
	});

	it('keeps labels on the same bars while scrolling', () => {
		const start = Date.UTC(2024, 0, 10, 0, 0);
		const time = Float64Array.from({ length: 2000 }, (_, i) => start + i * MINUTE);
		const a = ticksFor(time, 100, 700, 60).map(tick => tick.position);
		const b = ticksFor(time, 117, 717, 60).map(tick => tick.position);
		const shared = a.filter(position => position >= 117);
		expect(shared.length).toBeGreaterThan(5);
		expect(b.slice(0, shared.length)).toEqual(shared);
	});

	it('marks the first bar of a session with the day, across overnight gaps', () => {
		// Three sessions of 390 one-minute bars starting at 09:30.
		const time: number[] = [];
		for (let day = 0; day < 3; day++) {
			const open = Date.UTC(2024, 4, 14 + day, 9, 30);
			for (let i = 0; i < 390; i++) {
				time.push(open + i * MINUTE);
			}
		}
		const ticks = ticksFor(Float64Array.from(time), 0, time.length, 120);
		const days = ticks.filter(tick => tick.weight === WEIGHT_DAY);
		expect(days.map(tick => tick.label)).toEqual(['14', '15', '16']);
		expect(days.map(tick => tick.position)).toEqual([0, 390, 780]);
		expect(ticks.length).toBeLessThan(12);
	});

	it('uses months and years on daily data', () => {
		const start = Date.UTC(2022, 9, 1);
		const time = Float64Array.from({ length: 800 }, (_, i) => start + i * DAY);
		const ticks = ticksFor(time, 0, 800, 40);
		const years = ticks.filter(tick => tick.weight === WEIGHT_YEAR).map(tick => tick.label);
		expect(years).toEqual(['2023', '2024']);
		const months = ticks.filter(tick => tick.weight === WEIGHT_MONTH).map(tick => tick.label);
		expect(months).toContain('Apr');
		expect(months).not.toContain('Jan');
		for (let i = 1; i < ticks.length; i++) {
			expect(ticks[i]!.position - ticks[i - 1]!.position).toBeGreaterThanOrEqual(40);
		}
	});

	it('does work proportional to the labels, not the bars', () => {
		const count = 1_000_000;
		const start = Date.UTC(2020, 0, 1);
		const time = new Float64Array(count);
		for (let i = 0; i < count; i++) {
			time[i] = start + i * MINUTE;
		}
		const ticks = ticksFor(time, 0, count, count / 12);
		expect(ticks.length).toBeGreaterThan(3);
		expect(ticks.length).toBeLessThanOrEqual(13);
	});

	it('labels the whole range when bars are spaced irregularly', () => {
		// 60% of the gaps are one second and 40% one hour, as in event data.
		let state = 7;
		const next = (): number => {
			state = (state * 1664525 + 1013904223) >>> 0;
			return state / 4294967296;
		};
		const count = 1000;
		const time = new Float64Array(count);
		let t = Date.UTC(2024, 0, 1);
		for (let i = 0; i < count; i++) {
			t += next() < 0.6 ? 1000 : 3_600_000;
			time[i] = t;
		}
		const ticks = ticksFor(time, 0, count, 140);
		expect(ticks.length).toBeGreaterThanOrEqual(4);
		expect(ticks[ticks.length - 1]!.position).toBeGreaterThan(count * 0.7);
		for (let i = 1; i < ticks.length; i++) {
			expect(ticks[i]!.position - ticks[i - 1]!.position).toBeGreaterThanOrEqual(140);
		}
	});

	it('returns nothing for an empty range', () => {
		expect(ticksFor(new Float64Array(0), 0, 0, 10)).toEqual([]);
	});
});

/** Bars every `step` milliseconds over `[from, to)`. */
function bars(from: number, to: number, step: number): Float64Array {
	return Float64Array.from({ length: Math.ceil((to - from) / step) }, (_, i) => from + i * step);
}

describe('TimeTicks in a time zone', () => {
	const newYork = timeZone('America/New_York');

	it('puts hour labels on the wall clock across the change to summer time', () => {
		// 9 to 11 March 2024 in New York; 02:00 EST jumps to 03:00 EDT at 07:00 UTC on the 10th.
		const time = bars(Date.UTC(2024, 2, 9, 5), Date.UTC(2024, 2, 11, 4), MINUTE);
		const ticks = ticksFor(time, 0, time.length, 60, newYork);
		const labels = ticks.map(tick => tick.label);
		expect(labels.slice(0, 4)).toEqual(['9', '01:00', '02:00', '03:00']);
		const sunday = labels.indexOf('10');
		expect(labels.slice(sunday, sunday + 4)).toEqual(['10', '01:00', '03:00', '04:00']);
		// Midnight EST is 05:00 UTC; the hour after 01:00 is 03:00, an hour later.
		expect(time[ticks[sunday]!.position]).toBe(Date.UTC(2024, 2, 10, 5));
		expect(ticks[sunday]!.weight).toBe(WEIGHT_DAY);
		expect(ticks[sunday + 2]!.position - ticks[sunday + 1]!.position).toBe(60);
		const hours = ticks.filter(tick => tick.weight === WEIGHT_TIME);
		expect(hours.length).toBeGreaterThan(30);
		expect(hours.every(tick => newYork.wall(time[tick.position]!) % HOUR === 0)).toBe(true);
	});

	it('labels the repeated hour when the clocks go back', () => {
		// 3 November 2024: 02:00 EDT falls back to 01:00 EST at 06:00 UTC.
		const time = bars(Date.UTC(2024, 10, 3, 4), Date.UTC(2024, 10, 3, 9), MINUTE);
		const quarters = ticksFor(time, 0, time.length, 15, newYork).map(tick => tick.label);
		expect(quarters).toEqual([
			'3',
			'00:15',
			'00:30',
			'00:45',
			'01:00',
			'01:15',
			'01:30',
			'01:45',
			'01:00',
			'01:15',
			'01:30',
			'01:45',
			'02:00',
			'02:15',
			'02:30',
			'02:45',
			'03:00',
			'03:15',
			'03:30',
			'03:45',
		]);
		// On an hourly grid the repeated hour is part of the 01:00 hour, which lasts two hours.
		const hours = ticksFor(time, 0, time.length, 60, newYork);
		expect(hours.map(tick => tick.label)).toEqual(['3', '01:00', '02:00', '03:00']);
		expect(hours[2]!.position - hours[1]!.position).toBe(120);
	});

	it('follows half-hour and 45-minute offsets, with days at the zone midnight', () => {
		const time = bars(Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 4), 5 * MINUTE);
		const kolkata = ticksFor(time, 0, time.length, 72, timeZone('Asia/Kolkata'));
		// Six-hour steps on the wall clock of UTC+5:30. The first bar (05:30) shows its year; 06:00
		// is too close to it.
		expect(kolkata.slice(0, 4).map(tick => tick.label)).toEqual(['2024', '12:00', '18:00', '2']);
		expect(time[kolkata[1]!.position]).toBe(Date.UTC(2024, 0, 1, 6, 30));
		const day = kolkata.find(tick => tick.label === '2')!;
		expect(day.weight).toBe(WEIGHT_DAY);
		expect(time[day.position]).toBe(Date.UTC(2024, 0, 1, 18, 30));
		const kathmandu = ticksFor(time, 0, time.length, 72, timeZone('Asia/Kathmandu'));
		expect(time[kathmandu.find(tick => tick.label === '2')!.position]).toBe(Date.UTC(2024, 0, 1, 18, 15));
	});

	it('weighs months and years by the zone calendar', () => {
		// Hourly bars around New Year: in New York the year starts at 05:00 UTC.
		const time = bars(Date.UTC(2023, 11, 30), Date.UTC(2024, 0, 3), HOUR);
		const ticks = ticksFor(time, 0, time.length, 12, newYork);
		const year = ticks.find(tick => tick.weight === WEIGHT_YEAR)!;
		expect(year.label).toBe('2024');
		expect(time[year.position]).toBe(Date.UTC(2024, 0, 1, 5));
		expect(ticksFor(time, 0, time.length, 12).find(tick => tick.weight === WEIGHT_YEAR)!.position).toBe(48);
	});

	it('treats bars a day or more apart as UTC dates whatever the zone', () => {
		// Daily bars at 00:00 UTC would fall on the previous evening in New York.
		const time = bars(Date.UTC(2023, 9, 2), Date.UTC(2024, 2, 1), DAY);
		const ticks = new TimeTicks();
		ticks.update(time, 0, time.length, 20, newYork);
		expect(ticks.dates).toBe(true);
		const labels = Array.from({ length: ticks.count }, (_, i) => ticks.labels[i]);
		expect(labels).toContain('2024');
		expect(labels).toContain('Nov');
		expect(time[ticks.position[labels.indexOf('2024')]!]).toBe(Date.UTC(2024, 0, 1));
		// A level of detail of minute bars has buckets far apart, but its bars are not dates.
		ticks.update(time, 0, time.length, 20, newYork, null, undefined, 1440);
		expect(ticks.dates).toBe(false);
	});

	it('costs no Intl call once the zone covers the bars', () => {
		const zone = timeZone('Europe/Paris');
		const time = bars(Date.UTC(2021, 0, 1), Date.UTC(2023, 0, 1), 10 * MINUTE);
		zone.cover(time[0]!, time[time.length - 1]!);
		const samples = zone.samples;
		const ticks = new TimeTicks();
		for (let from = 0; from < time.length - 2000; from += 997) {
			ticks.update(time, from, from + 2000, 40, zone);
		}
		expect(zone.samples).toBe(samples);
	});
});

describe('TimeTicks with sessions', () => {
	const equities: SessionSchedule = {
		timeZone: 'America/New_York',
		days: [1, 2, 3, 4, 5],
		hours: [
			{ start: '04:00', end: '09:30', kind: 'pre' },
			{ start: '09:30', end: '16:00' },
			{ start: '16:00', end: '20:00', kind: 'post' },
		],
		holidays: [],
	};

	it('prefers the open of the regular session over the hours around it', () => {
		// Extended hours, 04:00 to 20:00 EDT, on 3 and 4 June 2024.
		const time: number[] = [];
		for (const day of [3, 4]) {
			const open = Date.UTC(2024, 5, day, 8);
			for (let i = 0; i < 16 * 60; i++) {
				time.push(open + i * MINUTE);
			}
		}
		const column = Float64Array.from(time);
		const calendar = sessionCalendar(equities, timeZone('UTC'))!;
		const ticks = ticksFor(column, 0, column.length, 60, timeZone('America/New_York'), calendar);
		const open = ticks.find(tick => tick.label === '09:30')!;
		expect(open.weight).toBe(WEIGHT_SESSION);
		expect(column[open.position]).toBe(Date.UTC(2024, 5, 3, 13, 30));
		// 09:00 and 10:00 are within an hour of the open and give way to it.
		const labels = ticks.map(tick => tick.label);
		expect(labels.slice(0, 7)).toEqual(['Jun', '05:00', '06:00', '07:00', '08:00', '09:30', '11:00']);
		expect(labels).not.toContain('09:00');
		expect(labels).not.toContain('10:00');
		expect(labels).toContain('16:00');
		const day = ticks.find(tick => tick.label === '4')!;
		expect(day.weight).toBe(WEIGHT_DAY);
		expect(day.position).toBe(960);
	});

	it('names days after the trading day of a session that starts the evening before', () => {
		// Globex: 18:00 to 17:00 New York time. Hourly bars from Sunday 9 June to Wednesday 12 June 2024.
		const futures: SessionSchedule = { ...equities, hours: [{ start: '18:00', end: '17:00' }] };
		const calendar = sessionCalendar(futures, timeZone('UTC'))!;
		const time: number[] = [];
		for (let t = Date.UTC(2024, 5, 9, 22); t < Date.UTC(2024, 5, 12, 21); t += HOUR) {
			// No bars in the daily break from 17:00 to 18:00 EDT.
			if (new Date(t).getUTCHours() !== 21) {
				time.push(t);
			}
		}
		const column = Float64Array.from(time);
		const ticks = ticksFor(column, 0, column.length, 6, timeZone('America/New_York'), calendar);
		const days = ticks.filter(tick => tick.weight >= WEIGHT_DAY);
		expect(days.map(tick => tick.label)).toEqual(['10', '11', '12']);
		// Each at 18:00 EDT of the evening before.
		expect(days.map(tick => column[tick.position])).toEqual([
			Date.UTC(2024, 5, 9, 22),
			Date.UTC(2024, 5, 10, 22),
			Date.UTC(2024, 5, 11, 22),
		]);
		// Midnight inside a session is a time like any other.
		expect(ticks.filter(tick => tick.label === '00:00').every(tick => tick.weight === WEIGHT_TIME)).toBe(true);
	});
});

describe('TimeFormat', () => {
	it('formats labels in a locale', () => {
		const format = new TimeFormat('de-DE', null, null);
		expect(format.label(0, Date.UTC(2024, 2, 1), WEIGHT_MONTH, false)).toBe(
			new Intl.DateTimeFormat('de-DE', { month: 'short', timeZone: 'UTC' }).format(Date.UTC(2024, 2, 1)),
		);
		expect(format.label(0, Date.UTC(2024, 2, 1, 14, 5), WEIGHT_TIME, false)).toBe('14:05');
		expect(new TimeFormat('en-US', null, null).label(0, Date.UTC(2024, 2, 1, 14, 5), WEIGHT_TIME, false)).toMatch(
			/^2:05\sPM$/,
		);
		expect(format.label(0, Date.UTC(2024, 0, 1), WEIGHT_YEAR, false)).toBe('2024');
		expect(format.crosshair(1, Date.UTC(2024, 2, 1, 14, 5))).toBe(
			new Intl.DateTimeFormat('de-DE', {
				timeZone: 'UTC',
				year: 'numeric',
				month: 'short',
				day: 'numeric',
				hour: 'numeric',
				minute: '2-digit',
			}).format(Date.UTC(2024, 2, 1, 14, 5)),
		);
		expect(() => new TimeFormat('not a locale!', null, null)).toThrow(RangeError);
	});

	it('hands labels to the application formatters, falling back on null', () => {
		const calls: [number, string, number][] = [];
		const format = new TimeFormat(
			'',
			(time, kind, wall) => {
				calls.push([time, kind, wall]);
				return kind === 'day' ? `day ${new Date(wall).getUTCDate()}` : null;
			},
			(time, wall) => `${time}/${wall}`,
		);
		expect(format.label(5, Date.UTC(2024, 2, 7), WEIGHT_DAY, false)).toBe('day 7');
		expect(format.label(6, Date.UTC(2024, 2, 7, 9, 30), WEIGHT_SESSION, false)).toBe('09:30');
		expect(calls).toEqual([
			[5, 'day', Date.UTC(2024, 2, 7)],
			[6, 'session', Date.UTC(2024, 2, 7, 9, 30)],
		]);
		expect(format.crosshair(1, 2)).toBe('1/2');
		expect(formatDateTime(Date.UTC(2024, 2, 5, 9, 30))).toBe('2024-03-05 09:30');
	});
});
