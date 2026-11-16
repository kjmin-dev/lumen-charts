import { describe, expect, it } from 'vitest';
import type { PlanOptions } from '../../src/jobs.ts';
import { planJobs } from '../../src/plan.ts';

const base: PlanOptions = {
	scenarios: [],
	adapters: ['a'],
	sizes: [],
	kinds: [],
	repeats: 1,
	quick: false,
	chart: { width: 1200, height: 600 },
	seed: 1,
};

describe('multi scenario', () => {
	it('plans the multi-chart scenario once per worker limit', () => {
		const all: PlanOptions = { ...base, scenarios: ['multi'] };
		expect(planJobs(all).jobs.map(p => p.caseId)).toEqual([
			'multi/candles-100k/16-charts',
			'multi/candles-1m/4-charts',
		]);
		const options: PlanOptions = { ...all, sizes: [100_000] };
		const [planned] = planJobs(options).jobs;
		expect(planned?.caseId).toBe('multi/candles-100k/16-charts');
		expect(planned?.job).toMatchObject({ charts: 16, visibleCharts: 8, maxWorkers: null });
		const limited = planJobs({ ...options, maxWorkers: [1, null, 4] }).jobs;
		expect(limited.map(p => p.caseId)).toEqual([
			'multi/candles-100k/16-charts/max-workers-1',
			'multi/candles-100k/16-charts',
			'multi/candles-100k/16-charts/max-workers-4',
		]);
		// One pattern selects the scenario with every limit.
		const selected = planJobs({ ...options, maxWorkers: [1, 4], cases: ['multi/candles-100k/16-charts'] }).jobs;
		expect(selected).toHaveLength(2);
		expect(planJobs({ ...all, quick: true }).jobs[0]?.job).toMatchObject({ charts: 4 });
	});
});
