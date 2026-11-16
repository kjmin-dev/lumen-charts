import type { ChartApi } from '@lumen-charts/core';
import { LumenChart } from '@lumen-charts/react';
import { StrictMode, act, createElement, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('LumenChart (React)', () => {
	it('creates, updates and destroys the chart with the component', async () => {
		const host = document.createElement('div');
		document.body.appendChild(host);
		const root = createRoot(host);
		const ref = createRef<ChartApi | null>();

		await act(async () => {
			root.render(createElement(LumenChart, { ref, options: { autoSize: false, layout: { background: '#101010' } } }));
		});
		const canvases = host.querySelectorAll('canvas').length;
		expect(canvases).toBeGreaterThan(0);
		// The ref hands out the chart once it is created.
		const chart = ref.current;
		expect(chart).not.toBeNull();
		expect(chart?.options().layout.background).toBe('#101010');

		await act(async () => {
			root.render(createElement(LumenChart, { ref, options: { autoSize: false, layout: { background: '#202020' } } }));
		});
		// An update must reuse the chart, not create a second one.
		expect(host.querySelectorAll('canvas').length).toBe(canvases);
		expect(ref.current).toBe(chart);
		expect(chart?.options().layout.background).toBe('#202020');

		await act(async () => {
			root.unmount();
		});
		expect(host.querySelector('canvas')).toBeNull();
		expect(ref.current).toBeNull();
		host.remove();
	});

	it('hands the chart to the ref under StrictMode, and its state can be saved', async () => {
		const host = document.createElement('div');
		document.body.appendChild(host);
		const root = createRoot(host);
		const ref = createRef<ChartApi | null>();

		await act(async () => {
			root.render(createElement(StrictMode, null, createElement(LumenChart, { ref, options: { autoSize: false } })));
		});
		const chart = ref.current;
		expect(chart).not.toBeNull();
		// StrictMode mounts twice; only one chart must remain.
		const canvases = host.querySelectorAll('canvas').length;
		await act(async () => {
			root.render(createElement(StrictMode, null, createElement(LumenChart, { ref, options: { autoSize: false } })));
		});
		expect(host.querySelectorAll('canvas').length).toBe(canvases);
		expect(chart?.saveState().version).toBeGreaterThan(0);

		await act(async () => {
			root.unmount();
		});
		expect(ref.current).toBeNull();
		host.remove();
	});
});
