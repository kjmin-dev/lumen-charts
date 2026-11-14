import { createChart } from '@lumen-charts/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('createChart', () => {
	let container: HTMLDivElement;
	let frames: (() => void)[];

	beforeEach(() => {
		container = document.createElement('div');
		document.body.appendChild(container);
		frames = [];
		vi.stubGlobal('requestAnimationFrame', (cb: () => void) => frames.push(cb));
		vi.stubGlobal('cancelAnimationFrame', (id: number) => {
			frames[id - 1] = () => {};
		});
	});

	afterEach(() => {
		container.remove();
		vi.unstubAllGlobals();
	});

	it('mounts a canvas inside the container', () => {
		const chart = createChart(container, { autoSize: false, width: 400, height: 200 });
		expect(container.contains(chart.element())).toBe(true);
		expect(chart.element().querySelector('canvas')).not.toBeNull();
		expect(chart.element().style.width).toBe('400px');
		chart.destroy();
	});

	it('coalesces several changes into one frame', () => {
		const chart = createChart(container, { autoSize: false, width: 400, height: 200 });
		const scheduled = frames.length;
		chart.applyOptions({ background: '#000000' });
		chart.applyOptions({ background: '#111111' });
		chart.resize(500, 250);
		expect(frames.length).toBe(scheduled);
		chart.destroy();
	});

	it('does not schedule a frame when options are unchanged', () => {
		const chart = createChart(container, { autoSize: false, width: 400, height: 200 });
		for (const frame of frames.splice(0)) {
			frame();
		}
		chart.applyOptions({ width: 400, height: 200, background: '#ffffff' });
		expect(frames.length).toBe(0);
		chart.applyOptions({ background: '#222222' });
		expect(frames.length).toBe(1);
		chart.destroy();
	});

	it('ignores undefined option values', () => {
		const chart = createChart(container, { autoSize: false, width: 400, height: 200 });
		chart.applyOptions({ width: undefined });
		expect(chart.options().width).toBe(400);
		chart.destroy();
	});

	it('removes its element on destroy and tolerates repeated calls', () => {
		const chart = createChart(container);
		chart.destroy();
		chart.destroy();
		expect(container.childElementCount).toBe(0);
		chart.applyOptions({ background: '#333333' });
		expect(chart.options().background).toBe('#ffffff');
	});
});
