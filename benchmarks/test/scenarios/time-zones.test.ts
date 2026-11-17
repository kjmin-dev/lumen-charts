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

describe('time zone scenarios', () => {
	it('plans frames in New York time and changes of the zone at three zoom levels', () => {
		const frames = planJobs({ ...base, scenarios: ['tz-frames'] }).jobs;
		expect(frames).toHaveLength(10);
		expect(frames[0]?.job).toMatchObject({ timeZone: 'America/New_York', sessions: true });
		expect(planJobs({ ...base, scenarios: ['tz-change'] }).jobs.map(p => p.caseId)).toEqual([
			'tz-change/candles-1m/200',
			'tz-change/candles-1m/20k',
			'tz-change/candles-1m/all',
		]);
		expect(knownFailure('lumen-main', { kind: 'candles', size: 1_000_000 }, 'tz-change')).toBeNull();
		expect(knownFailure('lwc-conflation-on', { kind: 'candles', size: 1_000_000 }, 'tz-frames')).toMatch(/time zones/);
	});
});
