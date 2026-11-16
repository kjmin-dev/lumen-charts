import { describe, expect, it } from 'vitest';
import { TimeZone, localTimeZone, timeZone } from '../src/model/time-zone';

const SECOND = 1000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const references = new Map<string, Intl.DateTimeFormat>();

/** Offset at `time` straight from `Intl`, through `formatToParts`, independently of the table. */
function intlOffset(zone: string, time: number): number {
	let format = references.get(zone);
	if (format === undefined) {
		format = new Intl.DateTimeFormat('en-GB', {
			timeZone: zone,
			hourCycle: 'h23',
			era: 'short',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		});
		references.set(zone, format);
	}
	const parts: Record<string, string> = {};
	for (const part of format.formatToParts(time)) {
		parts[part.type] = part.value;
	}
	let year = Number(parts['year']);
	if (parts['era']!.startsWith('B')) {
		year = 1 - year;
	}
	const date = new Date(0);
	date.setUTCFullYear(year, Number(parts['month']) - 1, Number(parts['day']));
	date.setUTCHours(Number(parts['hour']) % 24, Number(parts['minute']), Number(parts['second']), 0);
	return date.getTime() - Math.floor(time / SECOND) * SECOND;
}

/** Offset in minutes of a zone at an ISO instant, from a fresh table. */
function offsetAt(name: string, iso: string): number {
	return new TimeZone(name).offset(Date.parse(iso)) / 60_000;
}

/** Deterministic pseudo-random numbers in [0, 1). */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

/**
 * Zones with DST gaps and overlaps, half-hour and 45-minute offsets, half-hour DST, negative DST,
 * DST at midnight, Ramadan suspensions, and historical changes of the standard offset.
 */
const ZONES = [
	'America/New_York',
	'America/Los_Angeles',
	'America/St_Johns',
	'America/Sao_Paulo',
	'America/Caracas',
	'America/Havana',
	'America/Santiago',
	'Europe/London',
	'Europe/Dublin',
	'Europe/Berlin',
	'Europe/Moscow',
	'Europe/Istanbul',
	'Africa/Casablanca',
	'Africa/Cairo',
	'Asia/Kolkata',
	'Asia/Kathmandu',
	'Asia/Tehran',
	'Asia/Gaza',
	'Asia/Tokyo',
	'Asia/Shanghai',
	'Australia/Adelaide',
	'Australia/Lord_Howe',
	'Australia/Eucla',
	'Pacific/Chatham',
	'Pacific/Apia',
	'Pacific/Kiritimati',
	'Antarctica/Troll',
];

describe('TimeZone', () => {
	it('agrees with Intl at random instants from 1850 to 2050, whatever order they come in', () => {
		const next = random(11);
		const from = Date.UTC(1850, 0, 1);
		const to = Date.UTC(2050, 0, 1);
		// Every other zone: the table of each grows over two centuries, both ways.
		for (const name of ZONES.filter((_, i) => i % 2 === 0)) {
			const zone = new TimeZone(name);
			for (let i = 0; i < 300; i++) {
				const time = Math.floor(from + next() * (to - from));
				expect(zone.offset(time), `${name} at ${new Date(time).toISOString()}`).toBe(intlOffset(name, time));
			}
		}
	}, 30_000);

	it('finds every change to the second, and nothing between changes', () => {
		// Daily from 2000 to 2026 in each zone: wherever Intl sees the offset change within a day, the
		// table changes at the same second.
		const from = Date.UTC(2000, 0, 1);
		const to = Date.UTC(2026, 0, 1);
		const changes: { name: string; zone: TimeZone; at: number; before: number }[] = [];
		for (const name of ZONES) {
			const zone = new TimeZone(name);
			let previous = intlOffset(name, from);
			for (let time = from + DAY; time < to; time += DAY) {
				const offset = intlOffset(name, time);
				expect(zone.offset(time)).toBe(offset);
				if (offset !== previous) {
					// Bisect the day with Intl alone.
					let lo = time - DAY;
					let hi = time;
					while (hi - lo > SECOND) {
						const mid = lo + Math.floor((hi - lo) / 2 / SECOND) * SECOND;
						if (intlOffset(name, mid) === previous) {
							lo = mid;
						} else {
							hi = mid;
						}
					}
					changes.push({ name, zone, at: hi, before: previous });
				}
				previous = offset;
			}
		}
		expect(changes.length).toBeGreaterThan(400);
		// Both sides of every change.
		for (const { name, zone, at, before } of changes) {
			expect(zone.offset(at), `${name} change at ${new Date(at).toISOString()}`).toBe(intlOffset(name, at));
			expect(zone.offset(at - 1)).toBe(before);
			expect(zone.offset(at - SECOND)).toBe(before);
		}
	}, 30_000);

	it('knows half-hour, 45-minute and historical offsets', () => {
		expect(offsetAt('Asia/Kolkata', '2024-06-01T00:00:00Z')).toBe(330);
		expect(offsetAt('Asia/Kathmandu', '2024-06-01T00:00:00Z')).toBe(345);
		expect(offsetAt('Pacific/Chatham', '2024-01-01T00:00:00Z')).toBe(825);
		expect(offsetAt('Pacific/Chatham', '2024-07-01T00:00:00Z')).toBe(765);
		expect(offsetAt('Australia/Lord_Howe', '2024-01-01T00:00:00Z')).toBe(660);
		expect(offsetAt('Australia/Lord_Howe', '2024-07-01T00:00:00Z')).toBe(630);
		// Caracas moved to -4:30 in December 2007 and back to -4 in May 2016.
		expect(offsetAt('America/Caracas', '2007-12-01T00:00:00Z')).toBe(-240);
		expect(offsetAt('America/Caracas', '2010-01-01T00:00:00Z')).toBe(-270);
		expect(offsetAt('America/Caracas', '2017-01-01T00:00:00Z')).toBe(-240);
		// Moscow kept summer time all year from 2011 to 2014.
		expect(offsetAt('Europe/Moscow', '2012-01-15T00:00:00Z')).toBe(240);
		expect(offsetAt('Europe/Moscow', '2015-01-15T00:00:00Z')).toBe(180);
		// Samoa skipped 30 December 2011 when it crossed the date line.
		expect(offsetAt('Pacific/Apia', '2011-12-29T00:00:00Z')).toBe(-600);
		expect(offsetAt('Pacific/Apia', '2011-12-31T00:00:00Z')).toBe(840);
		// Local mean time of New York, before standard time in 1883: -4:56:02.
		expect(new TimeZone('America/New_York').offset(Date.UTC(1880, 0, 1))).toBe(-(4 * HOUR + 56 * 60_000 + 2 * SECOND));
	});

	it('maps wall-clock times in gaps and overlaps', () => {
		const zone = new TimeZone('America/New_York');
		// 2024-03-10: 02:00 EST jumps to 03:00 EDT at 07:00 UTC.
		expect(zone.firstAtOrAfter(Date.UTC(2024, 2, 10, 1, 59))).toBe(Date.UTC(2024, 2, 10, 6, 59));
		expect(zone.firstAtOrAfter(Date.UTC(2024, 2, 10, 2, 30))).toBe(Date.UTC(2024, 2, 10, 7, 0));
		expect(zone.firstAtOrAfter(Date.UTC(2024, 2, 10, 3, 0))).toBe(Date.UTC(2024, 2, 10, 7, 0));
		// 2024-11-03: 02:00 EDT falls back to 01:00 EST at 06:00 UTC; 01:30 happens twice.
		expect(zone.firstAtOrAfter(Date.UTC(2024, 10, 3, 1, 30))).toBe(Date.UTC(2024, 10, 3, 5, 30));
		// Not before the change: the second occurrence.
		expect(zone.firstAtOrAfter(Date.UTC(2024, 10, 3, 1, 30), Date.UTC(2024, 10, 3, 6, 0))).toBe(
			Date.UTC(2024, 10, 3, 6, 30),
		);
		expect(zone.firstAtOrAfter(Date.UTC(2024, 10, 3, 1, 30), Date.UTC(2024, 10, 3, 5, 31))).toBe(
			Date.UTC(2024, 10, 3, 5, 31),
		);
		expect(zone.firstAtOrAfter(Date.UTC(2024, 10, 3, 2, 0))).toBe(Date.UTC(2024, 10, 3, 7, 0));
		// Wall-clock times are offsets applied, both ways.
		expect(zone.wall(Date.UTC(2024, 6, 1, 12))).toBe(Date.UTC(2024, 6, 1, 8));
		expect(zone.wall(Date.UTC(2024, 0, 1, 12))).toBe(Date.UTC(2024, 0, 1, 7));
	});

	it('steps through wall-clock intervals across both changes', () => {
		const zone = new TimeZone('America/New_York');
		const MIN15 = 15 * 60_000;
		// Spring: from 01:45 EST the next quarter hour is 03:00 EDT.
		expect(zone.nextChange(Date.UTC(2024, 2, 10, 6, 45), MIN15)).toBe(Date.UTC(2024, 2, 10, 7, 0));
		expect(zone.nextChange(Date.UTC(2024, 2, 10, 6, 45), HOUR)).toBe(Date.UTC(2024, 2, 10, 7, 0));
		// Fall: the repeated hour is a new quarter hour at 01:00 EST ...
		expect(zone.nextChange(Date.UTC(2024, 10, 3, 5, 45), MIN15)).toBe(Date.UTC(2024, 10, 3, 6, 0));
		expect(zone.nextChange(Date.UTC(2024, 10, 3, 6, 0), MIN15)).toBe(Date.UTC(2024, 10, 3, 6, 15));
		// ... but the same hour on an hourly grid: the next one is 02:00 EST.
		expect(zone.nextChange(Date.UTC(2024, 10, 3, 5, 30), HOUR)).toBe(Date.UTC(2024, 10, 3, 7, 0));
		// Half-hour zones step on their own wall clock.
		expect(new TimeZone('Asia/Kolkata').nextChange(Date.UTC(2024, 0, 1, 0, 0), HOUR)).toBe(Date.UTC(2024, 0, 1, 0, 30));
	});

	it('builds the table for a range once, with a bounded number of Intl calls', () => {
		const zone = new TimeZone('Europe/Berlin');
		const from = Date.UTC(2020, 0, 1);
		const to = Date.UTC(2022, 0, 1);
		zone.cover(from, to);
		// About a sample every two days, plus a bisection of about 17 samples per change.
		expect(zone.samples).toBeLessThan(800);
		const built = zone.samples;
		for (let time = from; time <= to; time += 7 * 60_000) {
			zone.wall(time);
			zone.firstAtOrAfter(time);
		}
		expect(zone.samples).toBe(built);
		// Growing at both ends keeps the answers.
		zone.offset(Date.UTC(1990, 0, 1));
		zone.offset(Date.UTC(2040, 0, 1));
		for (const iso of ['1990-07-01', '2021-03-28T00:59:59Z', '2021-03-28T01:00:00Z', '2039-12-01']) {
			const time = Date.parse(iso);
			expect(zone.offset(time)).toBe(intlOffset('Europe/Berlin', time));
		}
	});

	it('treats UTC without Intl and resolves local and unknown names', () => {
		const utc = timeZone('UTC');
		expect(utc.isUtc).toBe(true);
		expect(utc.wall(123_456)).toBe(123_456);
		expect(utc.firstAtOrAfter(5 * DAY)).toBe(5 * DAY);
		expect(utc.nextChange(5 * DAY + 1, HOUR)).toBe(5 * DAY + HOUR);
		expect(utc.samples).toBe(0);
		expect(timeZone('local').name).toBe(localTimeZone());
		expect(timeZone('Asia/Tokyo')).toBe(timeZone('Asia/Tokyo'));
		expect(() => timeZone('Mars/Olympus_Mons')).toThrow(RangeError);
		expect(timeZone('Asia/Tokyo').offset(Number.NaN)).toBe(9 * HOUR);
	});
});
