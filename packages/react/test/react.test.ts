import type { ChartApi } from '@lumen-charts/core';
import { LumenChart } from '@lumen-charts/react';
import { act, createElement, createRef } from 'react';
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
			root.render(createElement(LumenChart, { ref, options: { autoSize: false, background: '#101010' } }));
		});
		expect(host.querySelector('canvas')).not.toBeNull();

		await act(async () => {
			root.render(createElement(LumenChart, { ref, options: { autoSize: false, background: '#202020' } }));
		});
		expect(host.querySelectorAll('canvas').length).toBe(1);

		await act(async () => {
			root.unmount();
		});
		expect(host.querySelector('canvas')).toBeNull();
		host.remove();
	});
});
