import { describe, expect, it } from 'vitest';
import { knownFailure } from '../../src/adapters/index.ts';
import type { PlanOptions } from '../../src/jobs.ts';
import { planJobs } from '../../src/plan.ts';
import type { AxesFramesJob } from '../../src/scenarios/axes-frames.ts';

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

describe('axes-frames scenario', () => {
	it('plans the price axes cases, one per layout, for adapters that can lay out axes', () => {
		const { jobs } = planJobs({ ...base, scenarios: ['axes-frames'] });
		const ids = jobs.map(p => p.caseId);
		expect(ids).toHaveLength(16);
		expect(ids).toContain('axes-frames/candles-1m/pan-200/one');
		expect(ids).toContain('axes-frames/candles-1m/zoom-all/four');
		expect(jobs.every(p => (p.job as AxesFramesJob).indicators === 3)).toBe(true);
		const selected = planJobs({ ...base, scenarios: ['axes-frames'], cases: ['axes-frames/candles-1m/pan-200'] });
		expect(selected.jobs.map(p => p.caseId)).toEqual([
			'axes-frames/candles-1m/pan-200/one',
			'axes-frames/candles-1m/pan-200/log',
			'axes-frames/candles-1m/pan-200/percent',
			'axes-frames/candles-1m/pan-200/four',
		]);
		expect(knownFailure('lumen-main', { kind: 'candles', size: 1_000_000 }, 'axes-frames')).toBeNull();
		expect(knownFailure('lwc-conflation-on', { kind: 'candles', size: 1_000_000 }, 'axes-frames')).toMatch(/axes/);
	});
});
