import { describe, expect, it } from 'vitest';
import { knownFailure } from '../../src/adapters/index.ts';
import type { PlanOptions } from '../../src/jobs.ts';
import { planJobs } from '../../src/plan.ts';
import type { LineTicksJob } from '../../src/scenarios/line-ticks.ts';

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

describe('line-ticks scenario', () => {
	it('plans ticks on solid, dashed and dotted lines in both views, for adapters that can style lines', () => {
		const { jobs } = planJobs({ ...base, scenarios: ['line-ticks'] });
		expect(jobs.map(p => p.caseId)).toEqual([
			'line-ticks/line-1m/latest/solid',
			'line-ticks/line-1m/latest/dashed',
			'line-ticks/line-1m/latest/dotted',
			'line-ticks/line-1m/all/solid',
			'line-ticks/line-1m/all/dashed',
			'line-ticks/line-1m/all/dotted',
		]);
		expect(jobs.every(p => (p.job as LineTicksJob).lines === 5)).toBe(true);
		expect(knownFailure('lumen-worker', { kind: 'line', size: 1_000_000 }, 'line-ticks')).toBeNull();
		expect(knownFailure('lwc-conflation-on', { kind: 'line', size: 1_000_000 }, 'line-ticks')).toMatch(/style/);
	});
});
