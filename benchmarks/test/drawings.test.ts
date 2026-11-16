import { describe, expect, it } from 'vitest';
import { generateCandles } from '../src/data.ts';
import { DRAWING_TOOLS, generateDrawings } from '../src/drawings.ts';

describe('drawing set', () => {
	const data = generateCandles({ seed: 1, count: 100_000 });

	it('cycles through every tool, half in view and half in older history', () => {
		const drawings = generateDrawings(data, 1000, 99_700, 99_999, 4);
		expect(drawings.length).toBe(1000);
		expect(new Set(drawings.map(d => d.type))).toEqual(new Set(DRAWING_TOOLS));
		const start = data.time[99_700]!;
		const end = data.time[99_999]!;
		const inside = (time: number): boolean => time >= start && time <= end;
		const placed = drawings.map(d =>
			d.inView ? d.points.every(p => inside(p.time)) : d.points.every(p => p.time < start),
		);
		expect(placed.every(Boolean)).toBe(true);
		expect(drawings.filter(d => d.inView).length).toBe(500);
		expect(drawings.filter(d => d.type === 'text').every(d => d.text !== undefined)).toBe(true);
	});

	it('is the same for the same seed', () => {
		expect(generateDrawings(data, 50, 99_700, 99_999, 4)).toEqual(generateDrawings(data, 50, 99_700, 99_999, 4));
	});
});
