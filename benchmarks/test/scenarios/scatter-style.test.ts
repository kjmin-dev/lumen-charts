import { describe, expect, it } from 'vitest';
import { knownFailure } from '../../src/adapters/index.ts';
import type { PlanOptions } from '../../src/jobs.ts';
import { planJobs } from '../../src/plan.ts';
import { type ScatterStyleJob, styleSize } from '../../src/scenarios/scatter-style.ts';

const base: PlanOptions = {
	scenarios: ['scatter-style'],
	adapters: ['a'],
	sizes: [],
	kinds: [],
	repeats: 1,
	quick: false,
	chart: { width: 1200, height: 600 },
	seed: 1,
};

describe('scatter sizes and densities scenario', () => {
	it('plans each style against plain points, by points in view, zoom and appends', () => {
		const { jobs } = planJobs(base);
		const ids = jobs.map(p => p.caseId);
		expect(ids.slice(0, 6)).toEqual([
			'scatter-style/candles-2k/cloud-100k/zoom/plain',
			'scatter-style/candles-2k/cloud-100k/zoom/sized',
			'scatter-style/candles-2k/cloud-100k/zoom/density',
			'scatter-style/candles-2k/cloud-100k/tick/plain',
			'scatter-style/candles-2k/cloud-100k/tick/sized',
			'scatter-style/candles-2k/cloud-100k/tick/density',
		]);
		expect(ids.length).toBe(12);
		expect(ids.slice(6).every(id => id.startsWith('scatter-style/candles-2k/cloud-1m/'))).toBe(true);
		const job = jobs[0]!.job as ScatterStyleJob;
		expect(job).toMatchObject({ points: 100_000, pointSize: 1.5, visibleBars: 1000, shape: 'cloud' });
		expect(planJobs({ ...base, quick: true }).jobs.map(p => p.caseId)).toEqual([
			'scatter-style/candles-2k/cloud-10k/tick/plain',
			'scatter-style/candles-2k/cloud-10k/tick/sized',
			'scatter-style/candles-2k/cloud-10k/tick/density',
		]);
		expect(knownFailure('lumen-worker', { kind: 'candles', size: 2000 }, 'scatter-style')).toBeNull();
		expect(knownFailure('lwc-conflation-on', { kind: 'candles', size: 2000 }, 'scatter-style')).toMatch(/densities/);
	});

	it('sizes points around the plain size of 1.5 CSS pixels', () => {
		const sizes = Array.from({ length: 300 }, (_, value) => styleSize(value + 1));
		expect(new Set(sizes)).toEqual(new Set([1, 1.5, 2]));
		expect(sizes.reduce((sum, size) => sum + size, 0) / sizes.length).toBeCloseTo(1.5, 5);
	});
});
