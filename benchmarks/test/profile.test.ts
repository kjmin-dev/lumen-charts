import { describe, expect, it } from 'vitest';
import {
	type CallFrame,
	MEASURE_END_MARK,
	MEASURE_START_MARK,
	type TraceEvent,
	categorize,
	summarizeTrace,
} from '../src/profile.ts';

const PID = 7;
const MAIN = 1;
const WORKER = 2;

function frame(functionName: string, url = ''): CallFrame {
	return { functionName, url, lineNumber: 0, columnNumber: 0 };
}

/** Sources by function name, standing in for the source maps of a build. */
const SOURCES: Record<string, string> = {
	drawLine: 'packages/core/src/render/series.ts',
	update: 'packages/core/src/views/series-view.ts',
	_renderOverlay: 'packages/core/src/chart.ts',
	emaKernel: 'packages/engine/src/indicators/kernels.ts',
};
const resolve = (callFrame: CallFrame): string | null => SOURCES[callFrame.functionName] ?? null;

function mark(name: string, ts: number): TraceEvent {
	return { pid: PID, tid: MAIN, ts, ph: 'R', cat: 'blink.user_timing', name };
}

function task(tid: number, name: string, ts: number, dur: number): TraceEvent {
	return { pid: PID, tid, ts, dur, ph: 'X', name };
}

function threadName(tid: number, name: string): TraceEvent {
	return { pid: PID, tid, ts: 0, ph: 'M', name: 'thread_name', args: { name } };
}

/** A profile of `tid` whose samples are 100 µs apart from `startTime` on. */
function profile(tid: number, id: string, startTime: number, nodes: unknown[], samples: number[]): TraceEvent[] {
	return [
		{ pid: PID, tid, ts: startTime, ph: 'P', name: 'Profile', id, args: { data: { startTime } } },
		{
			pid: PID,
			tid: 99,
			ts: startTime + 1,
			ph: 'P',
			name: 'ProfileChunk',
			id,
			args: { data: { cpuProfile: { nodes, samples }, timeDeltas: samples.map(() => 100) } },
		},
	];
}

describe('categorize', () => {
	it('puts a native canvas call where its caller is', () => {
		expect(categorize(frame('lineTo'), null, 'series layer: drawing')).toBe('series layer: Canvas 2D calls');
		expect(categorize(frame('fillText'), null, 'overlay')).toBe('other layers: Canvas 2D calls');
	});

	it('tells the parts of the chart apart by source file and, in chart.ts, by function', () => {
		expect(categorize(frame('drawLine', 'http://x/a.js'), 'packages/core/src/render/series.ts', null)).toBe(
			'series layer: drawing',
		);
		expect(categorize(frame('_renderOverlay', 'http://x/a.js'), 'packages/core/src/chart.ts', null)).toBe('overlay');
		expect(categorize(frame('emaKernel', 'http://x/a.js'), 'packages/engine/src/indicators/kernels.ts', null)).toBe(
			'engine: indicator kernels',
		);
		expect(categorize(frame('(garbage collector)'), null, null)).toBe('garbage collection');
		expect(categorize(frame('(idle)'), null, null)).toBe('idle');
	});
});

describe('summarizeTrace', () => {
	const nodes = [
		{ id: 1, callFrame: frame('(root)') },
		{ id: 2, parent: 1, callFrame: frame('drawLine', 'http://x/a.js') },
		{ id: 3, parent: 2, callFrame: frame('lineTo') },
		{ id: 4, parent: 1, callFrame: frame('update', 'http://x/a.js') },
		{ id: 5, parent: 1, callFrame: frame('(idle)') },
		{ id: 6, parent: 1, callFrame: frame('_renderOverlay', 'http://x/a.js') },
	];
	// Samples at 1000, 1100, ...: the measured part is [2000, 13000).
	const samples = [
		...Array.from({ length: 10 }, () => 5),
		// In a frame from 2000 to 2600.
		2,
		2,
		3,
		3,
		3,
		4,
		// Outside a frame.
		6,
		5,
		5,
		5,
		5,
		5,
	];
	const events: TraceEvent[] = [
		threadName(MAIN, 'CrRendererMain'),
		threadName(WORKER, 'DedicatedWorker thread'),
		{ pid: PID, tid: 0, ts: 0, ph: 'M', name: 'process_name', args: { name: 'Renderer' } },
		// An earlier pair of marks (a cold run) is ignored.
		mark(MEASURE_START_MARK, 100),
		mark(MEASURE_END_MARK, 200),
		mark(MEASURE_START_MARK, 2000),
		task(MAIN, 'RunTask', 1900, 800),
		task(MAIN, 'FireAnimationFrame', 2000, 450),
		// A second callback of the same frame, and a frame of its own later.
		task(MAIN, 'FireAnimationFrame', 2450, 150),
		task(MAIN, 'FireAnimationFrame', 12800, 100),
		task(MAIN, 'MinorGC', 2610, 40),
		task(WORKER, 'RunTask', 2100, 300),
		task(WORKER, 'RunTask', 2200, 100),
		mark(MEASURE_END_MARK, 13000),
		...profile(MAIN, '0x1', 900, nodes, samples),
		...profile(
			WORKER,
			'0x2',
			1900,
			[
				{ id: 1, callFrame: frame('(root)') },
				{ id: 2, parent: 1, callFrame: frame('emaKernel', 'http://x/w.js') },
			],
			[2, 2, 2, 2, 2, 2],
		),
	];
	const summary = summarizeTrace(events, resolve);

	it('cuts the trace at the last pair of marks', () => {
		expect(summary.windowMs).toBeCloseTo(11);
	});

	it('adds up the callbacks of one frame', () => {
		expect(summary.frames).toMatchObject({ count: 2, max: 0.6 });
		expect(summary.frames?.p50).toBeCloseTo(0.1);
	});

	it('reports the time each thread was busy, with nested tasks counted once', () => {
		const main = summary.threads.find(thread => thread.thread === 'CrRendererMain');
		const worker = summary.threads.find(thread => thread.thread === 'DedicatedWorker thread');
		// The task from 1900 to 2700 is cut at the start mark; the later frame adds 100 µs.
		expect(main?.busyMs).toBeCloseTo(0.8);
		expect(main?.gcMs).toBeCloseTo(0.04);
		expect(worker?.busyMs).toBeCloseTo(0.3);
	});

	it('gives self time per category, idle left out, native canvas calls with their caller', () => {
		const main = summary.profiles.find(thread => thread.thread === 'CrRendererMain');
		expect(main?.sampleIntervalUs).toBe(100);
		expect(main?.categories['series layer: drawing']).toBeCloseTo(0.2);
		expect(main?.categories['series layer: Canvas 2D calls']).toBeCloseTo(0.3);
		expect(main?.categories['series layer: items and coordinates']).toBeCloseTo(0.1);
		expect(main?.categories['overlay']).toBeCloseTo(0.1);
		expect(main?.categories['idle']).toBeUndefined();
		// The overlay sample at 2600 is outside both frames.
		expect(main?.frameCategories?.['overlay']).toBeUndefined();
		expect(main?.frameCategories?.['series layer: Canvas 2D calls']).toBeCloseTo(0.3);
		expect(main?.top[0]).toMatchObject({ name: 'lineTo', category: 'series layer: Canvas 2D calls' });
		const worker = summary.profiles.find(thread => thread.thread === 'DedicatedWorker thread');
		// Six samples from 2000 on; the last one has no next sample to bound it.
		expect(worker?.categories['engine: indicator kernels']).toBeCloseTo(0.5);
	});

	it('throws without marks', () => {
		expect(() =>
			summarizeTrace(
				events.filter(event => event.ph !== 'R'),
				resolve,
			),
		).toThrow(/marks/);
	});
});
