import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET_MS, type PlanOptions, matchesCase, parseSize, sizeLabel } from '../src/jobs.ts';
import { caseId, planJobs } from '../src/plan.ts';
import type { FramesJob } from '../src/scenarios/frames.ts';
import type { TickJob } from '../src/scenarios/tick.ts';

const base: PlanOptions = {
	scenarios: ['load', 'tick', 'frames', 'prepend'],
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
		const { jobs, skipped } = planJobs(base);
		const cases = new Set(jobs.map(p => p.caseId));
		// load: 4 data sets; tick: 4 sizes x 2 views; frames: 5 zoom levels x 2 motions on 1M candles
		// and 6 x 2 on 10M line points; prepend: 2 data sets x 2 batch sizes.
		expect(cases.size).toBe(4 + 8 + 10 + 12 + 4);
		expect(jobs).toHaveLength(cases.size * 2 * 2);
		expect(skipped).toEqual([]);
		expect(cases.has('load/line-10m')).toBe(true);
		expect(cases.has('tick/candles-1m/all')).toBe(true);
		expect(cases.has('frames/candles-1m/zoom-all')).toBe(true);
		expect(cases.has('frames/candles-1m/pan-200')).toBe(true);
		expect(cases.has('frames/candles-1m/pan-2m')).toBe(false);
		expect(cases.has('frames/line-10m/pan-2m')).toBe(true);
		expect(cases.has('frames/line-10m/zoom-all')).toBe(true);
		expect(cases.has('prepend/line-10m/1m')).toBe(true);
		expect(cases.has('prepend/candles-1m/10k')).toBe(true);
	});

	it('skips adapters on data sets they are known to fail on, and lists them', () => {
		const { jobs, skipped } = planJobs({
			...base,
			repeats: 1,
			skip: (adapter, dataset) => (adapter === 'b' && dataset.size === 10_000_000 ? 'crashes' : null),
		});
		expect(jobs.some(p => p.job.adapter === 'b' && p.job.dataset.size === 10_000_000)).toBe(false);
		expect(jobs.some(p => p.job.adapter === 'a' && p.job.dataset.size === 10_000_000)).toBe(true);
		// load, 12 frames cases and 2 prepend cases on 10M line points.
		expect(skipped).toHaveLength(15);
		expect(skipped[0]).toEqual({ caseId: 'load/line-10m', adapter: 'b', reason: 'crashes' });
	});

	it('selects cases by id prefix', () => {
		const { jobs } = planJobs({ ...base, adapters: ['a'], repeats: 1, cases: ['frames/line-10m', 'prepend'] });
		const cases = new Set(jobs.map(p => p.caseId));
		expect(cases.size).toBe(12 + 4);
		expect([...cases].every(id => id.startsWith('frames/line-10m/') || id.startsWith('prepend/'))).toBe(true);
	});

	it('runs every adapter back to back within a repeat', () => {
		const { jobs } = planJobs({ ...base, scenarios: ['load'], sizes: [1_000_000], kinds: ['candles'] });
		expect(jobs.map(p => p.id)).toEqual([
			'load/candles-1m/a#1',
			'load/candles-1m/b#1',
			'load/candles-1m/a#2',
			'load/candles-1m/b#2',
		]);
	});

	it('filters by scenario, size and kind', () => {
		const { jobs } = planJobs({ ...base, scenarios: ['tick'], sizes: [100_000], adapters: ['a'], repeats: 1 });
		expect(jobs.map(p => p.caseId)).toEqual(['tick/candles-100k/latest', 'tick/candles-100k/all']);
		expect(jobs[0]?.job).toMatchObject({ ticks: 10_000 });
		expect(planJobs({ ...base, kinds: ['line'], scenarios: ['tick'] }).jobs).toHaveLength(0);
	});

	it('gives tick and frames runs a time budget unless it is 0', () => {
		const { jobs } = planJobs({ ...base, scenarios: ['tick', 'frames'], adapters: ['a'], repeats: 1 });
		for (const p of jobs) {
			const job = p.job as TickJob | FramesJob;
			expect(job.budgetMs).toBe(DEFAULT_BUDGET_MS);
			expect(job.warmupBudgetMs).toBe(2_000);
		}
		expect(jobs.find(p => p.job.scenario === 'tick')?.job).toMatchObject({ minTicks: 500 });
		const unlimited = planJobs({ ...base, scenarios: ['tick', 'frames'], adapters: ['a'], repeats: 1, budgetMs: 0 });
		for (const p of unlimited.jobs) {
			const job = p.job as TickJob | FramesJob;
			expect(job.budgetMs + job.warmupBudgetMs).toBe(0);
		}
	});

	it('has a small quick mode', () => {
		const { jobs } = planJobs({ ...base, quick: true, repeats: 1 });
		expect(jobs.every(p => p.job.dataset.size <= 10_000)).toBe(true);
		expect(jobs.find(p => p.job.scenario === 'frames')?.job).toMatchObject({ frames: 60 });
		expect(jobs.some(p => p.job.scenario === 'prepend')).toBe(true);
	});

	it('plans the scenarios in their own order, whatever order they are asked for in', () => {
		const forward = planJobs({ ...base, scenarios: ['load', 'tick'], adapters: ['a'], repeats: 1 });
		const backward = planJobs({ ...base, scenarios: ['tick', 'load'], adapters: ['a'], repeats: 1 });
		expect(backward).toEqual(forward);
		expect(forward.jobs[0]?.job.scenario).toBe('load');
	});

	it('ignores the name of a scenario there is none of', () => {
		expect(planJobs({ ...base, scenarios: ['nope'] }).jobs).toEqual([]);
	});

	it('names cases by scenario, data set and parameters', () => {
		const [first] = planJobs({ ...base, scenarios: ['frames'], adapters: ['a'], repeats: 1 }).jobs;
		expect(first && caseId(first.job)).toBe('frames/candles-1m/pan-200');
	});
});

describe('matchesCase', () => {
	it('matches whole /-separated parts from the start', () => {
		expect(matchesCase('frames/line-10m/pan-200', 'frames')).toBe(true);
		expect(matchesCase('frames/line-10m/pan-200', 'frames/line-10m')).toBe(true);
		expect(matchesCase('frames/line-10m/pan-200', 'frames/line-10m/pan-200')).toBe(true);
		expect(matchesCase('frames/candles-1m/pan-2000', 'frames/candles-1m/pan-200')).toBe(false);
		expect(matchesCase('load/line-10m', 'load/line-1m')).toBe(false);
		expect(matchesCase('load/line-10m', 'line-10m')).toBe(false);
		expect(matchesCase('load/line-10m', '')).toBe(false);
	});
});
