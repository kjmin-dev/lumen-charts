import { describe, expect, it } from 'vitest';
import type { RunOutcome } from '../src/jobs.ts';
import { type CompletedJob, type ResultsFile, aggregate, mergeResults, numericLeaves } from '../src/results.ts';
import type { FramesJob, FramesRun } from '../src/scenarios/frames.ts';
import { summarize } from '../src/stats.ts';

const job: FramesJob = {
	scenario: 'frames',
	adapter: 'a',
	dataset: { kind: 'candles', size: 1000 },
	seed: 1,
	chart: { width: 100, height: 100 },
	zoom: 'all',
	motion: 'pan',
	frames: 10,
	minFrames: 5,
	budgetMs: 0,
	warmupFrames: 1,
	warmupBudgetMs: 0,
};

function run(js: number[]): RunOutcome {
	const result: FramesRun = {
		jsTime: summarize(js),
		interval: summarize([16, 17]),
		framesWithLibraryWork: js.length,
		visibleBars: 1000,
		warmupFrames: 1,
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

function file(createdAt: string, js: number[], load: number): ResultsFile {
	return {
		schema: 2,
		createdAt,
		environment: { runner: { arguments: ['--repeats', '1'] }, machine: { loadAverageStart: [load, 0, 0] } },
		cases: aggregate([completed(run(js), 0)]),
	};
}

describe('mergeResults', () => {
	it('appends the runs of each case and summarizes them again', () => {
		const merged = mergeResults([file('t1', [1, 2, 3], 2), file('t2', [3, 4, 5], 5), file('t3', [5, 6, 7], 9)]);
		expect(merged.cases).toHaveLength(1);
		expect(merged.cases[0]?.runs).toHaveLength(3);
		expect(merged.cases[0]?.status).toBe('ok');
		expect(merged.cases[0]?.summary['jsTime.p50']).toEqual({ median: 4, min: 2, max: 6, relativeRange: 1, runs: 3 });
		// The first file's environment, and what differed from file to file.
		expect(merged.createdAt).toBe('t1');
		const environment = merged.environment as { merged: { createdAt: string; loadAverageStart: number[] }[] };
		expect(environment.merged.map(entry => [entry.createdAt, entry.loadAverageStart[0]])).toEqual([
			['t1', 2],
			['t2', 5],
			['t3', 9],
		]);
	});

	it('keeps cases that only some files have, and refuses files of another schema', () => {
		const other = file('t2', [1, 2, 3], 1);
		other.cases[0]!.adapter = 'b';
		const merged = mergeResults([file('t1', [1, 2, 3], 1), other]);
		expect(merged.cases.map(c => [c.adapter, c.runs.length])).toEqual([
			['a', 1],
			['b', 1],
		]);
		expect(() => mergeResults([file('t1', [1], 1), { ...other, schema: 1 }])).toThrow(/schema/);
		expect(() => mergeResults([])).toThrow(/Nothing/);
	});
});
