import { describe, expect, it } from 'vitest';
import {
	type SamplingNode,
	allocationSites,
	allocationsHeadline,
	ownerOf,
	summarizeAllocations,
} from '../src/allocations.ts';
import { type CallFrame, MEASURE_END_MARK, MEASURE_START_MARK, type TraceEvent } from '../src/profile.ts';

const PID = 7;
const MAIN = 1;
const WORKER = 2;

/** Sources by function name, standing in for the source maps of a build. */
const SOURCES: Record<string, string> = {
	receive: 'packages/engine/src/pool.ts',
	applyPatches: 'packages/core/src/data/window-cache.ts',
	waitTasks: 'benchmarks/src/harness/frames.ts',
	update: 'node_modules/lightweight-charts/dist/lightweight-charts.production.mjs',
};
const resolve = (frame: CallFrame): string | null => SOURCES[frame.functionName] ?? null;

function node(functionName: string, selfSize: number, children: SamplingNode[] = []): SamplingNode {
	const url = functionName in SOURCES ? 'http://localhost/assets/index.js' : '';
	return { callFrame: { functionName, url, lineNumber: 0, columnNumber: 0 }, selfSize, children };
}

function mark(name: string, ts: number): TraceEvent {
	return { pid: PID, tid: MAIN, ts, ph: 'R', cat: 'blink.user_timing', name };
}

function collection(name: string, tid: number, ts: number, dur: number, before: number, after: number): TraceEvent {
	return { pid: PID, tid, ts, dur, ph: 'X', name, args: { usedHeapSizeBefore: before, usedHeapSizeAfter: after } };
}

describe('ownerOf', () => {
	it('tells the library from the harness by source file', () => {
		expect(ownerOf('packages/engine/src/client.ts')).toBe('library');
		expect(ownerOf('../packages/core/src/chart.ts')).toBe('library');
		expect(ownerOf('benchmarks/src/scenarios/indicators.ts')).toBe('harness');
		expect(ownerOf('node_modules/lightweight-charts/dist/index.mjs')).toBe('other scripts');
		expect(ownerOf(null)).toBe('outside JavaScript');
	});
});

describe('allocationSites', () => {
	it('gives the bytes of a built-in to the function that called it, and adds up a function called from two places', () => {
		const head = node('(root)', 100, [
			node('receive', 1000, [node('applyPatches', 200, [node('subarray', 50)])]),
			node('waitTasks', 300, [node('postMessage', 30), node('applyPatches', 5)]),
		]);
		expect(allocationSites(head, resolve)).toEqual([
			{ function: 'receive', source: SOURCES['receive'], owner: 'library', bytes: 1000 },
			{ function: 'waitTasks', source: SOURCES['waitTasks'], owner: 'harness', bytes: 330 },
			{ function: 'applyPatches', source: SOURCES['applyPatches'], owner: 'library', bytes: 255 },
			{ function: '(outside JavaScript)', source: null, owner: 'outside JavaScript', bytes: 100 },
		]);
	});
});

describe('summarizeAllocations', () => {
	const head = node('(root)', 100, [node('receive', 1000), node('waitTasks', 300), node('update', 40)]);

	it('adds up the owners and counts the collections of the main thread between the marks', () => {
		const summary = summarizeAllocations(
			head,
			10,
			[
				collection('MajorGC', MAIN, 500, 9000, 50, 10),
				mark(MEASURE_START_MARK, 1000),
				collection('MinorGC', MAIN, 2000, 300, 5000, 1000),
				collection('MinorGC', MAIN, 3000, 700, 6000, 1500),
				collection('MajorGC', MAIN, 4000, 2500, 9000, 2000),
				collection('MajorGC', WORKER, 4500, 100, 9000, 2000),
				mark(MEASURE_END_MARK, 11_000),
				collection('MinorGC', MAIN, 12_000, 300, 5000, 1000),
			],
			resolve,
		);
		expect(summary.windowMs).toBe(10);
		expect(summary.bytes).toBe(1440);
		expect(summary.ticks).toBe(10);
		expect(summary.bytesPerTick).toBe(144);
		expect(summary.ownersPerTick).toEqual({ library: 100, harness: 30, 'other scripts': 4, 'outside JavaScript': 10 });
		expect(allocationsHeadline(summary)).toBe(
			'allocated per tick: 144 B (library 100, harness 30, outside JavaScript 10, other 4); ' +
				'collections: minor 2 (1.0 ms, longest 0.7), major 1 (2.5 ms, longest 2.5)',
		);
		expect(summary.owners).toEqual({ library: 1000, harness: 300, 'other scripts': 40, 'outside JavaScript': 100 });
		expect(summary.sites[0]).toMatchObject({ function: 'receive', bytes: 1000 });
		expect(summary.minor).toEqual({ count: 2, totalMs: 1, maxMs: 0.7, freedBytes: 8500 });
		expect(summary.major).toEqual({ count: 1, totalMs: 2.5, maxMs: 2.5, freedBytes: 7000 });
	});

	it('keeps the largest sites only', () => {
		const events = [mark(MEASURE_START_MARK, 0), mark(MEASURE_END_MARK, 1000)];
		const summary = summarizeAllocations(head, 0, events, resolve, 2);
		expect(summary.sites.map(site => site.function)).toEqual(['receive', 'waitTasks']);
		expect(summary.bytes).toBe(1440);
		expect(summary.bytesPerTick).toBe(0);
	});

	it('throws without a pair of marks', () => {
		expect(() => summarizeAllocations(head, 1, [mark(MEASURE_START_MARK, 0)], resolve)).toThrow(/measure marks/);
	});
});
