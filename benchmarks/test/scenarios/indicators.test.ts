import { describe, expect, it } from 'vitest';
import { knownFailure } from '../../src/adapters/index.ts';
import { INDICATOR_SET } from '../../src/indicators.ts';
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

describe('indicator scenarios', () => {
	it('plans the stage 3 cases with 20 indicators on candles', () => {
		const { jobs } = planJobs({ ...base, scenarios: ['ind-load', 'ind-apply', 'ind-frames', 'ind-prepend'] });
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
		expect(
			planJobs({ ...base, scenarios: ['load', 'tick', 'frames', 'prepend'], cases: ['prepend'] }).jobs.length,
		).toBe(4);
	});

	it('skips the stage 3 cases for an adapter that cannot put indicators on a series', () => {
		expect(knownFailure('lumen-worker', { kind: 'candles', size: 1_000_000 }, 'ind-apply')).toBeNull();
		expect(knownFailure('lwc-conflation-on', { kind: 'candles', size: 1_000_000 }, 'ind-apply')).toBeNull();
		expect(knownFailure('nope', { kind: 'candles', size: 1_000_000 }, 'ind-apply')).toMatch(/indicators/);
	});
});
