import { createChart, type HeatmapSeriesApi, type MarkRenderer } from '@lumen-ticks/core';

/**
 * Whole-chart image comparisons of heatmaps whose grid follows the price: each column has a lower
 * edge of its own on one grid of prices. A chart drawn by WebGL2 or WebGPU is compared byte for
 * byte with the same chart drawn by Canvas 2D, through pans and zooms that merge columns, value
 * ranges that draw from palette slots or from the values, live columns on rows of their own,
 * prepends and removals.
 */
const start = 1_731_000_000_000;
const barTime = (i: number) => start + i * 60_000;
const raf = () => new Promise<void>(done => requestAnimationFrame(() => done()));
const ROWS = 41;
const STEP = 0.25;

/** A book of `count` columns from column `first` on, 20 per bar, whose lowest row wanders. */
function book(first: number, count: number) {
	const time = new Float64Array(count);
	const priceStart = new Float64Array(count);
	const values = new Float32Array(count * ROWS);
	for (let i = 0; i < count; i++) {
		const c = first + i;
		time[i] = barTime(Math.floor(c / 20)) + (c % 20) * 3000;
		// A whole number of rows from 70, which wanders by up to 30 rows.
		priceStart[i] = 70 + Math.round(Math.sin(c / 37) * 20 + Math.sin(c / 5) * 6) * STEP;
		for (let r = 0; r < ROWS; r++) {
			values[i * ROWS + r] = (c * 7 + r) % 23 === 0 ? Number.NaN : ((c * 31 + r * 17) % 1000) / 10;
		}
	}
	return { time, priceStart, priceStep: STEP, rows: ROWS, values };
}

function fixture(pref: MarkRenderer) {
	const host = document.createElement('div');
	document.body.append(host);
	const chart = createChart(host, {
		width: 380,
		height: 240,
		autoSize: false,
		worker: true,
		markRenderer: pref,
		theme: 'light',
		redraw: 'full',
	});
	const bars = chart.addSeries('candlestick');
	bars.setData(
		Array.from({ length: 220 }, (_, i) => ({ time: barTime(i), open: 80, high: 84, low: 76, close: 81 + (i % 3) })),
	);
	const heat: HeatmapSeriesApi = chart.addSeries('heatmap', {
		valueMin: 0,
		valueMax: 100,
		palette: ['rgba(12,96,120,0.4)', '#dc7832'],
		autoscale: true,
	});
	heat.setData(book(400, 3600));
	chart.timeScale().setVisibleLogicalRange({ from: 18.25, to: 121.6 });
	return {
		chart,
		host,
		heat,
		dispose() {
			chart.destroy();
			host.remove();
		},
	};
}
type Fixture = ReturnType<typeof fixture>;

function read(source: HTMLCanvasElement) {
	const copy = document.createElement('canvas');
	copy.width = source.width;
	copy.height = source.height;
	const ctx = copy.getContext('2d', { willReadFrequently: true })!;
	ctx.drawImage(source, 0, 0);
	return ctx.getImageData(0, 0, copy.width, copy.height).data;
}

function differences(a: Fixture, b: Fixture) {
	const left = Array.from(a.host.querySelectorAll('canvas')),
		right = Array.from(b.host.querySelectorAll('canvas'));
	if (!left.length || left.length !== right.length) throw Error('Canvas layer count differs');
	let different = 0,
		first = '';
	for (let k = 0; k < left.length; k++) {
		const l = left[k]!,
			r = right[k]!;
		if (!l.width || !l.height) continue;
		const x = read(l),
			y = read(r);
		for (let i = 0; i < x.length; i++)
			if (x[i] !== y[i]) {
				different++;
				if (!first)
					first = `layer ${k}, pixel ${(i >> 2) % l.width},${Math.floor((i >> 2) / l.width)}, ${x[i]} vs ${y[i]}`;
			}
	}
	return { different, first };
}

/** Pixels of the heatmap's own layer that are not transparent, in the Canvas 2D chart. */
function lit(s: Fixture): number {
	let count = 0;
	for (const canvas of s.host.querySelectorAll('canvas')) {
		const data = read(canvas);
		for (let i = 3; i < data.length; i += 4) if (data[i]) count++;
	}
	return count;
}

async function check(mode: 'webgl2' | 'webgpu') {
	const a = fixture('canvas2d'),
		b = fixture(mode);
	const results: { name: string; different: number; first: string; path: string; level: number }[] = [];
	async function compare(name: string, change: (s: Fixture) => void = () => {}) {
		for (const s of [a, b]) change(s);
		await Promise.all([a.chart.whenIdle(), b.chart.whenIdle()]);
		await raf();
		await raf();
		const diff = differences(a, b);
		results.push({ name, ...diff, path: b.heat.renderer().path, level: b.heat.drawn().level });
		if (diff.different) throw Error(name + ' ' + JSON.stringify(diff) + ' ' + JSON.stringify(b.heat.renderer()));
		if (b.heat.renderer().effective !== mode)
			throw Error(name + ': drawn by ' + JSON.stringify(b.heat.renderer()) + ', not ' + mode);
	}
	try {
		await Promise.all([a.chart.whenIdle(), b.chart.whenIdle()]);
		for (let i = 0; i < 150 && b.heat.renderer().effective !== mode; i++) await raf();
		await compare('initial');
		if (lit(a) < 10_000) throw Error('Too little of the heatmap is drawn to compare');
		for (let i = 0; i < 8; i++)
			await compare('fractional zoom ' + i, s =>
				s.chart.timeScale().setVisibleLogicalRange({ from: 18.25 + i * 1.37, to: 121.6 - i * 2.11 }),
			);
		await compare('every column in view', s => s.chart.timeScale().setVisibleLogicalRange({ from: 0, to: 219 }));
		if (b.heat.drawn().level === 0) throw Error('No coarse level was drawn');
		await compare('narrow view', s => s.chart.timeScale().setVisibleLogicalRange({ from: 60.3, to: 71.9 }));
		await compare('pan', s => s.chart.timeScale().setVisibleLogicalRange({ from: 64.3, to: 75.9 }));
		await compare('log price scale', s => s.chart.priceScale().applyOptions({ mode: 'logarithmic' }));
		await compare('normal price scale', s => s.chart.priceScale().applyOptions({ mode: 'normal' }));
		await compare('automatic value range', s => s.heat.applyOptions({ valueMin: null, valueMax: null }));
		// The range stays: after a number of draws the GPU draws from palette slots.
		for (let i = 0; i < 36; i++)
			await compare('steady automatic range ' + i, s =>
				s.chart.timeScale().setVisibleLogicalRange({ from: 64.3 + (i % 2) * 0.5, to: 75.9 + (i % 2) * 0.5 }),
			);
		const internal = b.heat as unknown as { glHeatPath(): string | null; gpuKernel(): string | null };
		const fromSlots = mode === 'webgl2' ? internal.glHeatPath() === 'slots' : internal.gpuKernel() === 'heatmap-slots';
		if (!fromSlots) throw Error('A steady automatic range did not go over to slots');
		await compare('back to a wide view', s => s.chart.timeScale().setVisibleLogicalRange({ from: 17.1, to: 218.4 }));
		const live = book(3999, 2);
		await compare('last column on rows of its own', s =>
			s.heat.update({
				time: barTime(Math.floor(3999 / 20)) + (3999 % 20) * 3000,
				values: live.values.subarray(0, ROWS),
				priceStart: live.priceStart[0]! + 9 * STEP,
			}),
		);
		await compare('new column on rows of its own', s =>
			s.heat.update({
				time: barTime(200),
				values: live.values.subarray(ROWS, 2 * ROWS),
				priceStart: live.priceStart[1]! - 13 * STEP,
			}),
		);
		await compare('fixed value range', s => s.heat.applyOptions({ valueMin: 5, valueMax: 95 }));
		await compare('older columns', s => s.heat.prepend(book(0, 400)));
		await compare('every column in view again', s => s.chart.timeScale().setVisibleLogicalRange({ from: -2, to: 221 }));
		await compare('columns removed', s => s.heat.removeMarks({ from: barTime(40), to: barTime(55) }));
		await compare('resize', s => s.chart.resize(361, 229));
		for (let t = 0; t < 220; t += 3.7)
			for (let p = 60; p < 100; p += 1.3) {
				const time = barTime(t);
				if (a.heat.valueAt(time, p) !== b.heat.valueAt(time, p)) throw Error(`valueAt(${t}, ${p}) differs`);
			}
		return { mode, checks: results.length, results };
	} finally {
		a.dispose();
		b.dispose();
	}
}

declare global {
	interface Window {
		checkHeatGrid: typeof check;
	}
}
window.checkHeatGrid = check;
