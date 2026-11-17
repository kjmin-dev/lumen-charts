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

describe('drawings scenario', () => {
	it('plans the stage 4 drawings cases, and skips them for a library without drawings', () => {
		const { jobs } = planJobs({ ...base, scenarios: ['drawings'] });
		expect(jobs.map(p => p.caseId)).toEqual([
			'drawings/candles-1m/1000/hover',
			'drawings/candles-1m/0/hover',
			'drawings/candles-1m/1000/drag',
			'drawings/candles-1m/1000/pan',
		]);
		expect(knownFailure('lumen-main', { kind: 'candles', size: 1_000_000 }, 'drawings')).toBeNull();
		expect(knownFailure('lwc-conflation-on', { kind: 'candles', size: 1_000_000 }, 'drawings')).toMatch(/drawings/);
	});
});
