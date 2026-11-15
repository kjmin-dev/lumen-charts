import { describe, expect, it } from 'vitest';
import { civil, civilDay, civilMonth, civilYear, daysFromCivil, daysInMonth } from '../src/model/calendar';
import { TimeTicks, WEIGHT_DAY, WEIGHT_MONTH, WEIGHT_TIME, WEIGHT_YEAR, formatDateTime } from '../src/model/time-ticks';

const MINUTE = 60_000;
const DAY = 86_400_000;

function ticksFor(time: Float64Array, from: number, to: number, barsPerLabel: number) {
	const ticks = new TimeTicks();
	ticks.update(time, from, to, barsPerLabel);
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
