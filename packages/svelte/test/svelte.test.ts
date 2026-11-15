import type { ChartApi } from '@lumen-charts/core';
import { lumenChart } from '@lumen-charts/svelte';
import { describe, expect, it } from 'vitest';

describe('lumenChart (Svelte action)', () => {
	it('creates, updates and destroys the chart', () => {
		const node = document.createElement('div');
		document.body.appendChild(node);
		let ready: ChartApi | null = null;
		const action = lumenChart(node, {
			options: { autoSize: false, layout: { background: '#101010' } },
			onReady: chart => {
				ready = chart;
			},
		});
		expect(node.querySelector('canvas')).not.toBeNull();
		expect(ready).not.toBeNull();

		action.update?.({ options: { layout: { background: '#202020' } } });
		expect((ready as ChartApi | null)?.options().layout.background).toBe('#202020');

		action.destroy?.();
		expect(node.querySelector('canvas')).toBeNull();
		node.remove();
	});
});
