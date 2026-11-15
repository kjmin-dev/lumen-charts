import { describe, expect, it } from 'vitest';
import { knownFailure } from '../src/adapters/index.ts';
import { INDICATOR_SET } from '../src/indicators.ts';
import {
	DEFAULT_BUDGET_MS,
	INDICATOR_SCENARIOS,
	type PlanOptions,
	caseId,
	matchesCase,
	parseSize,
	planJobs,
	sizeLabel,
} from '../src/jobs.ts';

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

	it('plans prepends with the batch in the left half of the view', () => {
		const { jobs } = planJobs({ ...base, scenarios: ['prepend'], adapters: ['a'], repeats: 1 });
		const views = jobs.map(p => (p.job.scenario === 'prepend' ? [p.caseId, p.job.batch, p.job.visibleBars] : []));
		expect(views).toEqual([
			['prepend/candles-1m/10k', 10_000, 20_000],
			// Twice the batch would be wider than the 1M bars there are to show.
			['prepend/candles-1m/1m', 1_000_000, 1_000_000],
			['prepend/line-10m/10k', 10_000, 20_000],
			['prepend/line-10m/1m', 1_000_000, 2_000_000],
		]);
		for (const { job } of jobs) {
			expect(job.scenario === 'prepend' && job.budgetMs).toBe(DEFAULT_BUDGET_MS);
			expect(job.scenario === 'prepend' && job.minPrepends <= job.prepends).toBe(true);
		}
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
		const tick = jobs[0]?.job;
		expect(tick?.scenario === 'tick' && tick.ticks).toBe(10_000);
		expect(planJobs({ ...base, kinds: ['line'], scenarios: ['tick'] }).jobs).toHaveLength(0);
	});

	it('gives tick and frames runs a time budget unless it is 0', () => {
		const { jobs } = planJobs({ ...base, scenarios: ['tick', 'frames'], adapters: ['a'], repeats: 1 });
		for (const { job } of jobs) {
			expect(job.scenario !== 'load' && job.scenario !== 'ind-load' && job.budgetMs).toBe(DEFAULT_BUDGET_MS);
			expect((job.scenario === 'tick' || job.scenario === 'frames') && job.warmupBudgetMs).toBe(2_000);
		}
		const tick = jobs.find(p => p.job.scenario === 'tick')?.job;
		expect(tick?.scenario === 'tick' && tick.minTicks).toBe(500);
		const unlimited = planJobs({ ...base, scenarios: ['tick', 'frames'], adapters: ['a'], repeats: 1, budgetMs: 0 });
		for (const { job } of unlimited.jobs) {
			expect((job.scenario === 'tick' || job.scenario === 'frames') && job.budgetMs + job.warmupBudgetMs).toBe(0);
		}
	});

	it('has a small quick mode', () => {
		const { jobs } = planJobs({ ...base, quick: true, repeats: 1 });
		expect(jobs.every(p => p.job.dataset.size <= 10_000)).toBe(true);
		const frames = jobs.find(p => p.job.scenario === 'frames')?.job;
		expect(frames?.scenario === 'frames' && frames.frames).toBe(60);
		expect(jobs.some(p => p.job.scenario === 'prepend')).toBe(true);
	});

	it('plans the stage 3 cases with 20 indicators on candles', () => {
		const { jobs } = planJobs({ ...base, scenarios: [...INDICATOR_SCENARIOS], adapters: ['a'], repeats: 1 });
		const ids = jobs.map(p => p.caseId);
		expect(ids).toContain('ind-load/candles-1m/20');
		expect(ids).toContain('ind-apply/candles-1m/latest/20');
		expect(ids).toContain('ind-apply/candles-100k/all/20');
		expect(ids).toContain('ind-frames/candles-1m/zoom-all/20');
		expect(ids).toContain('ind-prepend/candles-1m/1m/20');
		// A batch larger than the data set is left out.
		expect(ids).not.toContain('ind-prepend/candles-100k/1m/20');
		expect(jobs.every(p => 'indicators' in p.job && p.job.indicators === INDICATOR_SET.length)).toBe(true);
		// The regression cases of earlier stages keep their ids and selections.
		expect(planJobs({ ...base, cases: ['prepend'], adapters: ['a'], repeats: 1 }).jobs.length).toBe(4);
	});

	it('skips the stage 3 cases for an adapter that cannot put indicators on a series', () => {
		expect(knownFailure('lumen-worker', { kind: 'candles', size: 1_000_000 }, 'ind-apply')).toBeNull();
		expect(knownFailure('nope', { kind: 'candles', size: 1_000_000 }, 'ind-apply')).toMatch(/indicators/);
	});

	it('plans the multi-chart scenario once per worker limit', () => {
		const all: PlanOptions = { ...base, scenarios: ['multi'], adapters: ['a'], repeats: 1 };
		expect(planJobs(all).jobs.map(p => p.caseId)).toEqual([
			'multi/candles-100k/16-charts',
			'multi/candles-1m/4-charts',
		]);
		const options: PlanOptions = { ...all, sizes: [100_000] };
		const [job] = planJobs(options).jobs;
		expect(job?.caseId).toBe('multi/candles-100k/16-charts');
		expect(job?.job.scenario === 'multi' && [job.job.charts, job.job.visibleCharts, job.job.maxWorkers]).toEqual([
			16,
			8,
			null,
		]);
		const limited = planJobs({ ...options, maxWorkers: [1, null, 4] }).jobs;
		expect(limited.map(p => p.caseId)).toEqual([
			'multi/candles-100k/16-charts/max-workers-1',
			'multi/candles-100k/16-charts',
			'multi/candles-100k/16-charts/max-workers-4',
		]);
		// One pattern selects the scenario with every limit.
		const selected = planJobs({ ...options, maxWorkers: [1, 4], cases: ['multi/candles-100k/16-charts'] }).jobs;
		expect(selected).toHaveLength(2);
		const quick = planJobs({ ...all, quick: true }).jobs[0]?.job;
		expect(quick?.scenario === 'multi' && quick.charts).toBe(4);
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
