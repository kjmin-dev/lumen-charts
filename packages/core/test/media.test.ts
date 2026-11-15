import { createChart, themes } from '@lumen-charts/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('shared media queries', () => {
	let frames: (() => void)[];
	let queries: { media: string; listeners: Set<() => void> }[];
	let dark = false;
	let ratio = 1;

	const live = (part: string) => queries.filter(query => query.media.includes(part) && query.listeners.size > 0);
	const fire = (part: string): void => {
		for (const query of live(part)) {
			for (const listener of Array.from(query.listeners)) {
				listener();
			}
		}
	};

	beforeEach(() => {
		frames = [];
		queries = [];
		dark = false;
		ratio = 1;
		vi.stubGlobal('requestAnimationFrame', (callback: () => void) => frames.push(callback));
		vi.stubGlobal('cancelAnimationFrame', () => {});
		vi.spyOn(window, 'devicePixelRatio', 'get').mockImplementation(() => ratio);
		vi.spyOn(window, 'matchMedia').mockImplementation((media: string) => {
			const query = { media, listeners: new Set<() => void>() };
			queries.push(query);
			return {
				media,
				get matches() {
					return media.includes('prefers-color-scheme') && dark;
				},
				addEventListener: (_type: string, listener: () => void) => query.listeners.add(listener),
				removeEventListener: (_type: string, listener: () => void) => query.listeners.delete(listener),
			} as unknown as MediaQueryList;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('watches the pixel ratio and the color scheme once for all charts, and stops with the last one', () => {
		const containers = [0, 1, 2].map(() => document.body.appendChild(document.createElement('div')));
		const charts = containers.map(container =>
			createChart(container, { autoSize: false, width: 300, height: 200, theme: 'auto' }),
		);
		expect(queries.map(query => query.media)).toEqual(['(prefers-color-scheme: dark)', '(resolution: 1dppx)']);
		expect(live('resolution').length).toBe(1);
		expect(live('prefers-color-scheme')[0]!.listeners.size).toBe(1);
		for (const frame of frames.splice(0)) {
			frame();
		}

		// A new ratio redraws every chart in one frame and moves the watch to the new ratio.
		ratio = 2;
		fire('resolution');
		expect(frames.length).toBe(1);
		expect(live('resolution').map(query => query.media)).toEqual(['(resolution: 2dppx)']);
		for (const frame of frames.splice(0)) {
			frame();
		}

		dark = true;
		fire('prefers-color-scheme');
		for (const chart of charts) {
			expect(chart.theme()).toBe('dark');
			expect(chart.options().layout.background).toBe(themes.dark.layout.background);
		}
		expect(frames.length).toBe(1);

		// One chart leaves the system scheme; the others keep following it.
		charts[0]!.applyOptions({ theme: 'light' });
		dark = false;
		fire('prefers-color-scheme');
		expect(charts[0]!.theme()).toBe('light');
		expect(charts[1]!.theme()).toBe('light');
		expect(charts[1]!.options().layout.background).toBe(themes.light.layout.background);

		charts[0]!.destroy();
		charts[1]!.destroy();
		expect(live('resolution').length).toBe(1);
		expect(live('prefers-color-scheme').length).toBe(1);
		charts[2]!.destroy();
		expect(live('resolution').length).toBe(0);
		expect(live('prefers-color-scheme').length).toBe(0);
		for (const container of containers) {
			container.remove();
		}
	});
});
