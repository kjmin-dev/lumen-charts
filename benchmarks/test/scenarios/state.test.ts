import { describe, expect, it } from 'vitest';
import { knownFailure } from '../../src/adapters/index.ts';
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

describe('state scenario', () => {
	it('plans the stage 4 state cases, and skips them for a library that saves no state', () => {
		const { jobs } = planJobs({ ...base, scenarios: ['state'] });
		expect(jobs.map(p => p.caseId)).toEqual(['state/candles-1m/1000', 'state/candles-1m/0']);
		expect(knownFailure('lumen-main', { kind: 'candles', size: 1_000_000 }, 'state')).toBeNull();
		expect(knownFailure('lwc-conflation-on', { kind: 'candles', size: 1_000_000 }, 'state')).toMatch(/state/);
	});
});
