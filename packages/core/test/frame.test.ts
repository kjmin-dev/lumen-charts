import { createChart } from '@lumen-charts/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FrameClient, cancelFrame, requestFrame } from '../src/shared/frame';

describe('shared frame', () => {
	let frames: ((now: number) => void)[];
	let cancelled: number[];
	let reported: unknown[];
	let log: string[];

	const runFrame = (): void => {
		for (const frame of frames.splice(0)) {
			frame(16);
		}
	};
	const client = (name: string, write?: () => void): FrameClient => ({
		frameQueued: false,
		frameRead: () => {
			log.push(`read ${name}`);
		},
		frameWrite: () => {
			log.push(`write ${name}`);
			write?.();
		},
	});

	beforeEach(() => {
		frames = [];
		cancelled = [];
		reported = [];
		log = [];
		vi.stubGlobal('requestAnimationFrame', (callback: (now: number) => void) => frames.push(callback));
		vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
			cancelled.push(handle);
			frames[handle - 1] = () => {};
		});
		vi.stubGlobal('reportError', (error: unknown) => reported.push(error));
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('runs every read before any write, in one animation frame', () => {
		const a = client('a');
		const b = client('b');
		requestFrame(a);
		requestFrame(b);
		requestFrame(a);
		expect(frames.length).toBe(1);
		runFrame();
		expect(log).toEqual(['read a', 'read b', 'write a', 'write b']);
		expect(a.frameQueued).toBe(false);
		expect(frames.length).toBe(0);
	});

	it('reports an error of one client and still runs the others', () => {
		const failure = new Error('draw failed');
		const a = client('a', () => {
			throw failure;
		});
		const b = client('b');
		const c: FrameClient = {
			frameQueued: false,
			frameRead: () => {
				throw failure;
			},
			frameWrite: () => {
				log.push('write c');
			},
		};
		requestFrame(a);
		requestFrame(c);
		requestFrame(b);
		runFrame();
		expect(log).toEqual(['read a', 'read b', 'write a', 'write c', 'write b']);
		expect(reported).toEqual([failure, failure]);
		// The client that threw can ask for the next frame like any other.
		requestFrame(a);
		expect(frames.length).toBe(1);
		cancelFrame(a);
	});

	it('serves a request made during a frame in this frame or the next, never twice', () => {
		const c = client('c');
		const a = client('a', () => {
			// `c` has not drawn yet: this frame serves it. `a` has: it waits for the next frame.
			requestFrame(c);
			requestFrame(a);
		});
		requestFrame(a);
		requestFrame(c);
		runFrame();
		expect(log).toEqual(['read a', 'read c', 'write a', 'write c']);
		expect(frames.length).toBe(1);
		log.length = 0;
		a.frameWrite = () => {
			log.push('write a');
		};
		runFrame();
		expect(log).toEqual(['read a', 'write a']);
	});

	it('leaves out a client withdrawn during the frame', () => {
		const b = client('b');
		const a = client('a', () => cancelFrame(b));
		requestFrame(a);
		requestFrame(b);
		runFrame();
		expect(log).toEqual(['read a', 'read b', 'write a']);
		expect(b.frameQueued).toBe(false);
	});

	it('cancels the animation frame once nobody waits for it', () => {
		const a = client('a');
		const b = client('b');
		requestFrame(a);
		requestFrame(b);
		cancelFrame(a);
		expect(cancelled).toEqual([]);
		cancelFrame(b);
		expect(cancelled).toEqual([1]);
		runFrame();
		expect(log).toEqual([]);
		requestFrame(a);
		expect(frames.length).toBe(1);
		cancelFrame(a);
		expect(cancelled).toEqual([1, 1]);
	});

	it('draws every chart of the page in one animation frame and lets go of it with the last chart', () => {
		const containers = [0, 1, 2].map(() => document.body.appendChild(document.createElement('div')));
		const charts = containers.map(container => createChart(container, { autoSize: false, width: 300, height: 200 }));
		expect(frames.length).toBe(1);
		runFrame();
		for (const chart of charts) {
			chart.applyOptions({ layout: { background: '#101010' } });
		}
		expect(frames.length).toBe(1);
		for (const chart of charts) {
			chart.destroy();
		}
		expect(cancelled.length).toBe(1);
		for (const container of containers) {
			container.remove();
		}
	});

	it('keeps drawing the other charts when one chart fails to draw', () => {
		const containers = [0, 1].map(() => document.body.appendChild(document.createElement('div')));
		const charts = containers.map(container => createChart(container, { autoSize: false, width: 300, height: 200 }));
		runFrame();
		const failure = new Error('canvas lost');
		const draws: number[] = [];
		charts.forEach((chart, index) => {
			const internals = chart as unknown as { _placeLayers(): void };
			const place = internals._placeLayers.bind(chart);
			internals._placeLayers = () => {
				draws.push(index);
				if (index === 0) {
					throw failure;
				}
				place();
			};
			chart.applyOptions({ width: 320 });
		});
		runFrame();
		expect(draws).toEqual([0, 1]);
		expect(reported).toEqual([failure]);
		expect(charts[1]!.element().style.width).toBe('320px');
		for (const chart of charts) {
			chart.destroy();
		}
		for (const container of containers) {
			container.remove();
		}
	});
});
