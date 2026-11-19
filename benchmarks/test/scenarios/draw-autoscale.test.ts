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

describe('draw-autoscale scenario', () => {
	it('plans frames with drawings in and out of autoscale, and skips libraries without them', () => {
		const { jobs } = planJobs({ ...base, scenarios: ['draw-autoscale'] });
		expect(jobs.map(p => p.caseId)).toEqual([
			'draw-autoscale/candles-1m/still/1000/off',
			'draw-autoscale/candles-1m/still/100/on',
			'draw-autoscale/candles-1m/still/1000/on',
			'draw-autoscale/candles-1m/pan/1000/off',
			'draw-autoscale/candles-1m/pan/100/on',
			'draw-autoscale/candles-1m/pan/1000/on',
		]);
		expect(knownFailure('lumen-worker', { kind: 'candles', size: 1_000_000 }, 'draw-autoscale')).toBeNull();
		expect(knownFailure('lwc-conflation-off', { kind: 'candles', size: 1_000_000 }, 'draw-autoscale')).toMatch(
			/autoscale/,
		);
	});
});
