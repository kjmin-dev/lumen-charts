import { describe, expect, it } from 'vitest';
import { type PlanOptions, caseId, parseSize, planJobs, sizeLabel } from '../src/jobs.ts';

const base: PlanOptions = {
	scenarios: ['load', 'tick', 'frames'],
	adapters: ['a', 'b'],
	sizes: [],
	kinds: [],
	repeats: 2,
	quick: false,
	chart: { width: 1200, height: 600 },
	seed: 1,
};

describe('sizes', () => {
	it('parses and labels sizes', () => {
		expect(parseSize('100k')).toBe(100_000);
		expect(parseSize('1m')).toBe(1_000_000);
		expect(parseSize('10M')).toBe(10_000_000);
		expect(parseSize('2500')).toBe(2500);
		expect(sizeLabel(10_000_000)).toBe('10m');
		expect(sizeLabel(300_000)).toBe('300k');
		expect(sizeLabel(1234)).toBe('1234');
		expect(() => parseSize('lots')).toThrow(/Invalid size/);
	});
});

describe('planJobs', () => {
	it('builds the default matrix', () => {
		const plan = planJobs(base);
		const cases = new Set(plan.map(p => p.caseId));
		// load: 4 data sets; tick: 4 sizes x 2 views; frames: 5 zoom levels x 2 motions.
		expect(cases.size).toBe(4 + 8 + 10);
		expect(plan).toHaveLength(cases.size * 2 * 2);
		expect(cases.has('load/line-10m')).toBe(true);
		expect(cases.has('tick/candles-1m/all')).toBe(true);
		expect(cases.has('frames/candles-1m/zoom-all')).toBe(true);
		expect(cases.has('frames/candles-1m/pan-200')).toBe(true);
	});

	it('runs every adapter back to back within a repeat', () => {
		const plan = planJobs({ ...base, scenarios: ['load'], sizes: [1_000_000], kinds: ['candles'] });
		expect(plan.map(p => p.id)).toEqual([
			'load/candles-1m/a#1',
			'load/candles-1m/b#1',
			'load/candles-1m/a#2',
			'load/candles-1m/b#2',
		]);
	});

	it('filters by scenario, size and kind', () => {
		const plan = planJobs({ ...base, scenarios: ['tick'], sizes: [100_000], adapters: ['a'], repeats: 1 });
		expect(plan.map(p => p.caseId)).toEqual(['tick/candles-100k/latest', 'tick/candles-100k/all']);
		const tick = plan[0]?.job;
		expect(tick?.scenario === 'tick' && tick.ticks).toBe(10_000);
		expect(planJobs({ ...base, kinds: ['line'], scenarios: ['tick'] })).toHaveLength(0);
	});

	it('has a small quick mode', () => {
		const plan = planJobs({ ...base, quick: true, repeats: 1 });
		expect(plan.every(p => p.job.dataset.size <= 10_000)).toBe(true);
		const frames = plan.find(p => p.job.scenario === 'frames')?.job;
		expect(frames?.scenario === 'frames' && frames.frames).toBe(60);
	});

	it('names cases by scenario, data set and parameters', () => {
		const [first] = planJobs({ ...base, scenarios: ['frames'], adapters: ['a'], repeats: 1 });
		expect(first && caseId(first.job)).toBe('frames/candles-1m/pan-200');
	});
});
