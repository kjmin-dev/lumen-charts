import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET_MS, type PlanOptions } from '../../src/jobs.ts';
import { planJobs } from '../../src/plan.ts';
import type { PrependJob } from '../../src/scenarios/prepend.ts';

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

describe('prepend scenario', () => {
	it('plans prepends with the batch in the left half of the view', () => {
		const planned = planJobs({ ...base, scenarios: ['prepend'] }).jobs;
		const jobs = planned.map(p => p.job as PrependJob);
		expect(planned.map((p, i) => [p.caseId, jobs[i]?.batch, jobs[i]?.visibleBars])).toEqual([
			['prepend/candles-1m/10k', 10_000, 20_000],
			// Twice the batch would be wider than the 1M bars there are to show.
			['prepend/candles-1m/1m', 1_000_000, 1_000_000],
			['prepend/line-10m/10k', 10_000, 20_000],
			['prepend/line-10m/1m', 1_000_000, 2_000_000],
		]);
		for (const job of jobs) {
			expect(job.budgetMs).toBe(DEFAULT_BUDGET_MS);
			expect(job.minPrepends <= job.prepends).toBe(true);
		}
	});
});
