import { describe, expect, it } from 'vitest';
import { SessionMarks } from '../src/model/session-marks';
import { type SessionSchedule, formatDay, sessionCalendar } from '../src/model/sessions';
import { TimeDisplay } from '../src/model/time-display';
import { timeZone } from '../src/model/time-zone';
import { type ChartOptions, type DeepPartial, mergeOptions, resolveOptions } from '../src/options';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const EQUITIES: SessionSchedule = {
	timeZone: 'America/New_York',
	days: [1, 2, 3, 4, 5],
	hours: [
		{ start: '04:00', end: '09:30', kind: 'pre' },
		{ start: '09:30', end: '16:00' },
		{ start: '16:00', end: '20:00', kind: 'post' },
	],
	holidays: ['2024-07-04'],
};

/** CME Globex: Sunday to Friday 18:00 to 17:00 the next day, New York time. */
const FUTURES: SessionSchedule = {
	timeZone: 'America/New_York',
	days: [1, 2, 3, 4, 5],
	hours: [{ start: '18:00', end: '17:00' }],
	holidays: [],
};

function display(sessions: SessionSchedule, options: DeepPartial<ChartOptions> = {}): TimeDisplay {
	const time = new TimeDisplay();
	time.apply(resolveOptions(mergeOptions(options, { sessions: { schedule: sessions } }), false));
	return time;
}

describe('session schedule', () => {
	it('tells regular, pre- and post-market hours apart, through daylight saving changes', () => {
		const time = display(EQUITIES);
		const at = (iso: string) => time.sessionAt(Date.parse(iso));
		// Wednesday 3 July 2024 (EDT, UTC-4).
		expect(at('2024-07-03T07:59:00Z')).toBeNull();
		expect(at('2024-07-03T08:00:00Z')).toEqual({ index: 0, kind: 'pre', tradingDay: '2024-07-03' });
		expect(at('2024-07-03T13:29:59Z')?.kind).toBe('pre');
		expect(at('2024-07-03T13:30:00Z')?.kind).toBe('regular');
		expect(at('2024-07-03T19:59:00Z')?.kind).toBe('regular');
		expect(at('2024-07-03T20:00:00Z')?.kind).toBe('post');
		expect(at('2024-07-03T23:59:00Z')?.kind).toBe('post');
		expect(at('2024-07-04T00:00:00Z')).toBeNull();
		// The holiday and the weekend have no sessions.
		expect(at('2024-07-04T14:00:00Z')).toBeNull();
		expect(at('2024-07-06T14:00:00Z')).toBeNull();
		expect(at('2024-07-05T14:00:00Z')?.tradingDay).toBe('2024-07-05');
		// Friday 8 March (EST, UTC-5) and Monday 11 March (EDT): the open moves by an hour in UTC.
		expect(at('2024-03-08T14:29:00Z')?.kind).toBe('pre');
		expect(at('2024-03-08T14:30:00Z')?.kind).toBe('regular');
		expect(at('2024-03-11T13:29:00Z')?.kind).toBe('pre');
		expect(at('2024-03-11T13:30:00Z')?.kind).toBe('regular');
		expect(time.isInSession(Date.parse('2024-03-11T13:00:00Z'))).toBe(true);
		expect(time.isInSession(Date.parse('2024-03-10T13:00:00Z'))).toBe(false);
		expect(time.isInSession(Number.NaN)).toBe(false);
	});

	it('takes sessions across midnight to the trading day they end on', () => {
		const time = display(FUTURES);
		const at = (iso: string) => time.sessionAt(Date.parse(iso));
		// Sunday 10 March 2024, the day of the change to EDT: 18:00 EDT is 22:00 UTC.
		expect(at('2024-03-10T21:59:00Z')).toBeNull();
		expect(at('2024-03-10T22:00:00Z')).toEqual({ index: 0, kind: 'regular', tradingDay: '2024-03-11' });
		expect(at('2024-03-11T04:00:00Z')?.tradingDay).toBe('2024-03-11');
		// The daily break from 17:00 to 18:00.
		expect(at('2024-03-11T20:59:00Z')?.tradingDay).toBe('2024-03-11');
		expect(at('2024-03-11T21:00:00Z')).toBeNull();
		expect(at('2024-03-11T22:00:00Z')?.tradingDay).toBe('2024-03-12');
		// Friday's session ends at 17:00; the next opens on Sunday.
		expect(at('2024-03-15T20:59:00Z')?.tradingDay).toBe('2024-03-15');
		expect(at('2024-03-15T22:00:00Z')).toBeNull();
		expect(at('2024-03-16T22:00:00Z')).toBeNull();
		expect(at('2024-03-17T22:00:00Z')?.tradingDay).toBe('2024-03-18');

		const calendar = time.sessions!;
		// Times between two trading days belong to the earlier one.
		const friday = Date.UTC(2024, 2, 15);
		expect(formatDay(calendar.dayOf(Date.parse('2024-03-16T12:00:00Z')))).toBe('2024-03-15');
		expect(calendar.dayOf(Date.parse('2024-03-15T21:30:00Z'))).toBe(friday / DAY);
		expect(calendar.nextSessionStart(Date.parse('2024-03-15T21:30:00Z'))).toBe(Date.parse('2024-03-17T22:00:00Z'));
	});

	it('handles an overnight session next to regular hours, in the chart time zone', () => {
		const time = display(
			{
				timeZone: '',
				days: [1, 2, 3, 4, 5],
				hours: [
					{ start: '20:00', end: '04:00', kind: 'pre' },
					{ start: '04:00', end: '16:00' },
				],
				holidays: [],
			},
			{ localization: { timeZone: 'Asia/Tokyo' } },
		);
		const calendar = time.sessions!;
		expect(calendar.zone.name).toBe('Asia/Tokyo');
		// Monday 2024-06-03 20:00 JST belongs to Tuesday.
		expect(time.sessionAt(Date.parse('2024-06-03T11:00:00Z'))).toEqual({
			index: 0,
			kind: 'pre',
			tradingDay: '2024-06-04',
		});
		expect(time.sessionAt(Date.parse('2024-06-03T19:00:00Z'))?.kind).toBe('regular');
		expect(time.sessionAt(Date.parse('2024-06-03T07:00:00Z'))).toBeNull();
	});

	it('is always open without hours, and refuses malformed schedules', () => {
		const utc = timeZone('UTC');
		expect(sessionCalendar({ timeZone: '', days: [], hours: [], holidays: [] }, utc)).toBeNull();
		const time = new TimeDisplay();
		expect(time.isInSession(0)).toBe(true);
		expect(time.sessionAt(0)).toBeNull();
		const bad =
			(patch: Partial<SessionSchedule>): (() => unknown) =>
			() =>
				sessionCalendar({ ...EQUITIES, ...patch }, utc);
		expect(bad({ hours: [{ start: '25:00', end: '26:00' }] })).toThrow(RangeError);
		expect(bad({ hours: [{ start: '9:30', end: '16:61' }] })).toThrow(RangeError);
		expect(bad({ hours: [{ start: '24:00', end: '01:00' }] })).toThrow(RangeError);
		expect(
			bad({
				hours: [
					{ start: '09:00', end: '12:00' },
					{ start: '11:00', end: '16:00' },
				],
			}),
		).toThrow(RangeError);
		expect(
			bad({
				hours: [
					{ start: '18:00', end: '17:00' },
					{ start: '17:00', end: '19:00' },
				],
			}),
		).toThrow(RangeError);
		expect(bad({ hours: [{ start: '09:00', end: '10:00', kind: 'lunch' as never }] })).toThrow(RangeError);
		expect(bad({ days: [7] })).toThrow(RangeError);
		expect(bad({ days: [] })).toThrow(RangeError);
		expect(bad({ holidays: ['2024-02-30'] })).toThrow(RangeError);
		expect(bad({ timeZone: 'Nowhere/Land' })).toThrow(RangeError);
		expect(bad({ hours: [{ start: '00:00', end: '24:00' }] })).not.toThrow();
		expect(bad({ hours: [{ start: '09:30:15', end: '16:00:00' }] })).not.toThrow();
	});
});

/** One-minute bars of the extended equity hours, Monday 4 to Friday 8 March 2024, then 11 March. */
function equityBars(): Float64Array {
	const time: number[] = [];
	for (const day of [4, 5, 6, 7, 8, 11]) {
		// 04:00 to 20:00 New York time: EST is UTC-5 until 10 March, EDT UTC-4 after.
		const open = Date.UTC(2024, 2, day, day < 10 ? 9 : 8);
		for (let i = 0; i < 16 * 60; i++) {
			time.push(open + i * MINUTE);
		}
	}
	return Float64Array.from(time);
}

describe('session marks', () => {
	it('breaks at the first bar of each trading day and shades extended hours as runs', () => {
		const time = equityBars();
		const shown = display(EQUITIES);
		const marks = new SessionMarks();
		marks.update(time, 0, time.length, shown.zone, shown.sessions, 100, true, true);
		// No break at the first bar held; one at each later day.
		expect(Array.from(marks.breakRow.subarray(0, marks.breakCount))).toEqual([960, 1920, 2880, 3840, 4800]);
		// Pre-market (330 bars) and post-market (240) of consecutive days touch, Friday and Monday
		// too (the weekend has no bars): one run from each post-market to the next pre-market.
		const runs = Array.from({ length: marks.shadeCount }, (_, i) => [marks.shadeFrom[i], marks.shadeTo[i]]);
		expect(runs[0]).toEqual([0, 330]);
		expect(runs[1]).toEqual([720, 960 + 330]);
		expect(runs[4]).toEqual([3840 - 240, 3840 + 330]);
		expect(runs[5]).toEqual([4800 - 240, 4800 + 330]);
		expect(runs[runs.length - 1]).toEqual([4800 + 720, 4800 + 960]);
		expect(runs.length).toBe(7);
		// Left edges in device pixels, at one pixel per bar from the origin.
		marks.place(0.5, 1, 0, 1);
		expect(marks.breakX[0]).toBe(960);
		expect(marks.shadeLeft[1]).toBe(720);
		expect(marks.shadeRight[1]).toBe(1290);

		// The visible part only, and nothing once days are too dense.
		marks.update(time, 1000, 2000, shown.zone, shown.sessions, 100, true, true);
		expect(Array.from(marks.breakRow.subarray(0, marks.breakCount))).toEqual([1920]);
		expect(marks.shadeFrom[0]).toBe(1000);
		marks.update(time, 0, time.length, shown.zone, shown.sessions, 2, true, true);
		expect(marks.breakCount + marks.shadeCount).toBe(0);
	});

	it('breaks at calendar days of the chart time zone without a schedule', () => {
		const start = Date.UTC(2024, 0, 1);
		const time = Float64Array.from({ length: 72 }, (_, i) => start + i * HOUR);
		const marks = new SessionMarks();
		marks.update(time, 0, time.length, timeZone('Asia/Kolkata'), null, 100, true, true);
		// Midnight in India is 18:30 UTC: the first bar after it is at 19:00.
		expect(Array.from(marks.breakRow.subarray(0, marks.breakCount))).toEqual([19, 43, 67]);
		expect(marks.shadeCount).toBe(0);
		marks.update(time, 0, time.length, timeZone('Asia/Kolkata'), null, 100, false, true);
		expect(marks.breakCount).toBe(0);
	});
});
