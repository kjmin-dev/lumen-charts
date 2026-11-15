import { describe, expect, it } from 'vitest';
import type { FramesRun, PlannedJob, RunOutcome } from '../src/jobs.ts';
import { type CompletedJob, aggregate, numericLeaves } from '../src/results.ts';
import { summarize } from '../src/stats.ts';

const job: PlannedJob['job'] = {
	scenario: 'frames',
	adapter: 'a',
	dataset: { kind: 'candles', size: 1000 },
	seed: 1,
	chart: { width: 100, height: 100 },
	zoom: 'all',
	motion: 'pan',
	frames: 10,
	warmupFrames: 1,
};

function run(js: number[]): RunOutcome {
	const result: FramesRun = {
		jsTime: summarize(js),
		interval: summarize([16, 17]),
		framesWithLibraryWork: js.length,
		visibleBars: 1000,
		drawCalls: { fillRect: 3 },
	};
	return { status: 'ok', result, durationMs: 1 };
}

function completed(outcome: RunOutcome, repeat: number): CompletedJob {
	return {
		planned: { id: `x#${repeat}`, caseId: 'frames/candles-1k/pan-all', repeat, job },
		outcome,
		library: { library: { name: 'lib', version: '1' }, options: {} },
	};
}

describe('numericLeaves', () => {
	it('flattens finite numbers by dotted path', () => {
		const leaves = numericLeaves({ a: 1, b: { c: 2, d: 'x', e: Number.NaN }, f: [1, 2], g: null });
		expect([...leaves]).toEqual([
			['a', 1],
			['b.c', 2],
		]);
	});
});

describe('aggregate', () => {
	it('summarizes successful runs and marks partial failures', () => {
		const failed: RunOutcome = { status: 'failed', reason: 'timeout', message: 'slow', durationMs: 5 };
		const [result] = aggregate([completed(run([1, 2, 3]), 0), completed(run([3, 4, 5]), 1), completed(failed, 2)]);
		expect(result?.status).toBe('partial');
		expect(result?.runs).toHaveLength(3);
		expect(result?.summary['jsTime.p50']).toEqual({ median: 3, min: 2, max: 4, relativeRange: 2 / 3, runs: 2 });
		expect(result?.summary['drawCalls.fillRect']?.median).toBe(3);
	});

	it('marks a case without successful runs as failed', () => {
		const failed: RunOutcome = { status: 'failed', reason: 'crash', message: 'oom', durationMs: 5 };
		const [result] = aggregate([completed(failed, 0)]);
		expect(result?.status).toBe('failed');
		expect(result?.summary).toEqual({});
	});
});
