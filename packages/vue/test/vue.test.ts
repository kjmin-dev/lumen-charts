import { LumenChart } from '@lumen-charts/vue';
import { describe, expect, it } from 'vitest';
import { createApp, h, nextTick, ref } from 'vue';

describe('LumenChart (Vue)', () => {
	it('creates, updates and destroys the chart with the component', async () => {
		const host = document.createElement('div');
		document.body.appendChild(host);
		const background = ref('#101010');
		const app = createApp({
			render: () => h(LumenChart, { options: { autoSize: false, background: background.value } }),
		});
		app.mount(host);
		const canvases = host.querySelectorAll('canvas').length;
		expect(canvases).toBeGreaterThan(0);

		background.value = '#202020';
		await nextTick();
		// An update must reuse the chart, not create a second one.
		expect(host.querySelectorAll('canvas').length).toBe(canvases);

		app.unmount();
		expect(host.querySelector('canvas')).toBeNull();
		host.remove();
	});
});
