import { createChart, getCanvasBudget, setCanvasBudget, type MarkRenderer } from '@lumen-charts/core';
import { canvasPixelsInUse } from '../../../packages/core/src/shared/canvas-budget';
const start = 1_731_000_000_000;
const barTime = (i: number) => start + i * 60_000 + (i >= 48 ? 2 * 86400000 : 0);
const raf = () => new Promise<void>(done => requestAnimationFrame(() => done()));

function fixture(pref: MarkRenderer | undefined, worker: boolean) {
	const host = document.createElement('div');
	document.body.append(host);
	const chart = createChart(host, {
		width: 380,
		height: 240,
		autoSize: false,
		worker,
		markRenderer: pref,
		theme: 'light',
		redraw: 'full',
		localization: { timeZone: 'America/New_York' },
	});
	const bars = chart.addSeries('candlestick');
	bars.setData(
		Array.from({ length: 96 }, (_, i) => ({
			time: barTime(i),
			open: 80 + (i % 7),
			high: 97,
			low: 70,
			close: 83 + (i % 3),
		})),
	);
	const scatter = chart.addSeries('scatter', {
		id: 'trades',
		pointSize: 1.5,
		palette: ['#ab3232', '#77ac86'],
		valueMin: 0,
		valueMax: 100,
	});
	const heat = chart.addSeries('heatmap', {
		id: 'depth',
		valueMin: 0,
		valueMax: 100,
		palette: ['rgba(12,96,120,0.4)', '#dc7832'],
		opacity: 0.73,
	});
	const rows = 141;
	const time = Float64Array.from({ length: 864 }, (_, i) => barTime(Math.floor(i / 9)) + (i % 9) * 3000);
	const column = Float32Array.from({ length: rows }, (_, i) => (i % 5 === 0 ? NaN : i % 101));
	heat.setData({
		time,
		priceStart: 65,
		priceStep: 0.25,
		rows,
		values: Float32Array.from({ length: time.length * rows }, (_, i) => (i % 29 === 0 ? NaN : ((i * 31) % 1000) / 10)),
	});
	const points = Array.from({ length: 2500 }, (_, i) => ({
		time: time[Math.floor((i * time.length) / 2500)]!,
		price: 69 + ((i * 73) % 3000) / 100,
		value: i % 101,
	}));
	scatter.setData(points);
	chart.drawings().add({
		id: 'reference',
		type: 'trendLine',
		points: [
			{ time: barTime(10), price: 73 },
			{ time: barTime(87), price: 95 },
		],
	});
	chart.timeScale().setVisibleLogicalRange({ from: 1.25, to: 90.77 });
	return {
		chart,
		host,
		scatter,
		heat,
		column,
		points,
		dispose() {
			chart.destroy();
			host.remove();
		},
	};
}

/** Record uploads on the chart's shared GL context for one settled public operation. */
async function uploadBytes(gl: WebGL2RenderingContext | undefined, operation: () => Promise<void>) {
	const bytes = [0, 0, 0];
	if (!gl) {
		await operation();
		return bytes;
	}
	const original = gl.texSubImage2D;
	gl.texSubImage2D = new Proxy(original, {
		apply(method, context, args) {
			const unit = gl.getParameter(gl.ACTIVE_TEXTURE) - gl.TEXTURE0;
			bytes[unit] = (bytes[unit] ?? 0) + args[4] * args[5] * 4;
			return Reflect.apply(method, context, args);
		},
	});
	try {
		await operation();
	} finally {
		gl.texSubImage2D = original;
	}
	return bytes;
}

type Fixture = ReturnType<typeof fixture>;

/**
 * Points over the first 90 bars with sizes of their own, 0.5 to 11.5 CSS pixels and some without
 * one, and two 24 pixels wide at the ends, which reach into the pane from beside it.
 */
function sizedPoints() {
	const n = 3000;
	const time = new Float64Array(n),
		price = new Float64Array(n),
		value = new Float32Array(n),
		size = new Float32Array(n);
	let seed = 5;
	for (let i = 0; i < n; i++) {
		const bar = (i / n) * 90;
		time[i] = barTime(Math.floor(bar)) + Math.floor((bar % 1) * 60000);
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		price[i] = 70 + (25 * seed) / 4294967296;
		value[i] = i % 101;
		size[i] = i % 11 === 0 ? NaN : 0.5 + ((i * 37) % 23) / 2;
	}
	size[0] = 24;
	size[n - 1] = 24;
	return { time, price, value, size };
}
/** Internal to the library: whether WebGL2 drew the heatmap from its values or its palette slots. */
function heatPath(s: Fixture): string | null {
	return (s.heat as unknown as { glHeatPath(): string | null }).glHeatPath();
}
/** Internal to the library: the WebGPU kernel of a series' last dispatch, the scatter's by default. */
function kernel(s: Fixture, series: object = s.scatter): string | null {
	return (series as { gpuKernel(): string | null }).gpuKernel();
}

/** Bytes written to each labelled WebGPU buffer during one settled public operation. */
async function gpuUploads(active: boolean, operation: () => Promise<void>) {
	const bytes: Record<string, number> = {};
	if (!active) {
		await operation();
		return bytes;
	}
	const original = GPUQueue.prototype.writeBuffer;
	GPUQueue.prototype.writeBuffer = function (buffer, offset, data, dataOffset, size) {
		// The renderer passes ArrayBuffers, whose offsets and sizes are in bytes.
		const length = size ?? (data as ArrayBuffer).byteLength - (dataOffset ?? 0);
		bytes[buffer.label] = (bytes[buffer.label] ?? 0) + length;
		return original.call(this, buffer, offset, data as ArrayBuffer, dataOffset, size);
	};
	try {
		await operation();
	} finally {
		GPUQueue.prototype.writeBuffer = original;
	}
	return bytes;
}
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
		largest = 0,
		first = '';
	for (let k = 0; k < left.length; k++) {
		const l = left[k]!,
			r = right[k]!;
		if (l.width !== r.width || l.height !== r.height) throw Error('Canvas layer sizes differ');
		if (!l.width || !l.height) continue;

		const x = read(l),
			y = read(r);
		for (let i = 0; i < x.length; i++)
			if (x[i] !== y[i]) {
				different++;
				largest = Math.max(largest, Math.abs(x[i]! - y[i]!));
				if (!first)
					first = `layer ${k}, pixel ${(i >> 2) % l.width},${Math.floor((i >> 2) / l.width)}, channel ${i % 4}, ${x[i]} vs ${y[i]}`;
			}
	}
	return { different, largest, first };
}

/**
 * Runs the comparisons in `mode`. `tolerance` is the largest difference of a channel value that a
 * comparison accepts: 0, byte for byte, unless a device's rasterizer is known to round otherwise;
 * every difference is recorded either way.
 */
async function check(
	mode: 'hardware' | 'unavailable' | 'rejected' | 'native-fallback' | 'webgl2' | 'canvas-only' | 'pending',
	worker: boolean,
	tolerance = 0,
) {
	const memory = canvasPixelsInUse(),
		budget = getCanvasBudget(),
		begin = performance.now();
	const a = fixture('canvas2d', worker),
		b = fixture(mode === 'webgl2' ? undefined : 'webgpu', worker);
	const results: {
		name: string;
		different: number;
		largest: number;
		first: string;
		heat: string;
		scatter: string;
		scatterReason: string | null;
	}[] = [];
	let styled: unknown = null;
	async function compare(name: string, change: (s: Fixture) => void = () => {}) {
		for (const s of [a, b]) change(s);
		await Promise.all([a.chart.whenIdle(), b.chart.whenIdle()]);
		await raf();
		const diff = differences(a, b);
		results.push({
			name,
			...diff,
			scatter: b.scatter.renderer().path,
			scatterReason: b.scatter.renderer().reason,
			heat: b.heat.renderer().path,
		});
		if (diff.largest > tolerance) throw Error(name + ' ' + JSON.stringify(diff));
	}
	let report;
	try {
		await Promise.all([a.chart.whenIdle(), b.chart.whenIdle()]);
		const firstFrameMs = performance.now() - begin;
		if (mode === 'hardware') {
			for (
				let i = 0;
				i < 150 && (b.scatter.renderer().effective !== 'webgpu' || b.heat.renderer().effective !== 'webgpu');
				i++
			)
				await raf();
			if (b.heat.renderer().effective !== 'webgpu' || b.scatter.renderer().effective !== 'webgpu')
				throw Error('GPU did not activate: ' + JSON.stringify([b.heat.renderer(), b.scatter.renderer()]));
		}
		await compare('initial fractional range');
		if (mode === 'webgl2' && [b.heat, b.scatter].some(series => series.renderer().effective !== 'webgl2'))
			throw Error('Default WebGL2 did not activate: ' + JSON.stringify([b.heat.renderer(), b.scatter.renderer()]));
		const readyMs = performance.now() - begin;
		for (let i = 0; i < 16; i++)
			await compare('fractional zoom ' + i, s =>
				s.chart.timeScale().setVisibleLogicalRange({ from: i / 9 + 0.125, to: 91.7 - i / 2.7 }),
			);
		await compare('zero opacity', s => s.heat.applyOptions({ opacity: 0 }));
		await compare('restore opacity', s => s.heat.applyOptions({ opacity: 0.73 }));
		await compare('log price scale', s => s.chart.priceScale().applyOptions({ mode: 'logarithmic' }));
		await compare('resize', s => s.chart.resize(365, 231));
		await compare('palette and gain', s =>
			s.heat.applyOptions({ palette: 'viridis', valueMin: 1, valueMax: 73, valueScale: 'log', opacity: 0.55 }),
		);
		// A fixed value range draws from palette slots; one that follows the values from the values.
		const heatGl = mode === 'webgl2' ? window.testMarkContexts.find(context => !context.isContextLost()) : undefined;
		if (heatGl && heatPath(b) !== 'slots') throw Error('Fixed value range did not draw from slots: ' + heatPath(b));
		const gpu = mode === 'hardware';
		if (gpu && kernel(b, b.heat) !== 'heatmap-slots')
			throw Error('Fixed value range did not draw from WebGPU slots: ' + kernel(b, b.heat));
		await compare('automatic value range', s => s.heat.applyOptions({ valueMin: null, valueMax: null }));
		if (heatGl && heatPath(b) !== 'values') throw Error('Automatic value range did not draw from values');
		if (gpu && kernel(b, b.heat) !== 'heatmap') throw Error('Automatic value range did not draw WebGPU values');
		await compare('changed last column, automatic value range', s =>
			s.heat.update({ time: barTime(95) + 24000, values: s.column.map(value => value * 1.5) }),
		);
		await compare('fixed value range again', s => s.heat.applyOptions({ valueMin: 1, valueMax: 73 }));
		if (heatGl && heatPath(b) !== 'slots') throw Error('Fixed value range did not draw from slots again');
		if (gpu && kernel(b, b.heat) !== 'heatmap-slots') throw Error('Fixed value range did not draw WebGPU slots again');
		let gpuPalette: Record<string, number> = {};
		const paletteBytes = await uploadBytes(heatGl, async () => {
			gpuPalette = await gpuUploads(gpu, () =>
				compare('palette only', s => s.heat.applyOptions({ palette: 'inferno' })),
			);
		});
		// The pixel ranges are projected again with every change of the options; the slots stay.
		if (heatGl && (paletteBytes[0] || paletteBytes[2] !== 1024))
			throw Error('Palette-only change uploaded slots, or more than the colors: ' + paletteBytes);
		if (gpu && (gpuPalette['lumen-marks-data'] || gpuPalette['lumen-marks-style'] !== 1024))
			throw Error('Palette-only WebGPU change uploaded slots, or more than the colors: ' + JSON.stringify(gpuPalette));
		await compare('center and duplicate times', s => {
			s.scatter.applyOptions({ barAlign: 'start', opacity: 0.66 });
			s.scatter.append([
				{ time: barTime(95) + 40000, price: 83, value: 1 },
				{ time: barTime(95) + 40000, price: 83, value: 91 },
			]);
		});
		await compare('changed last column', s => s.heat.update({ time: barTime(95) + 24000, values: s.column }));
		await compare('new heat column', s => s.heat.update({ time: barTime(95) + 45000, values: s.column }));
		await compare('show dirty tail', s => s.chart.timeScale().setVisibleLogicalRange({ from: 75.2, to: 98.1 }));
		// Force a complete reference composition while the test chart clips an in-place update.
		b.chart.applyOptions({ redraw: 'auto' });
		await b.chart.whenIdle();
		const liveGL = mode === 'webgl2' ? window.testMarkContexts.find(gl => !gl.isContextLost()) : undefined;
		let gpuColumn: Record<string, number> = {};
		const columnBytes = await uploadBytes(liveGL, async () => {
			gpuColumn = await gpuUploads(gpu, () =>
				compare('partial heatmap composition with foreground bars and drawing', s => {
					s.heat.update({ time: barTime(95) + 45000, values: s.column.map(value => 100 - value) });
				}),
			);
		});
		if (liveGL && (!columnBytes[0] || columnBytes[1])) throw Error('Value-only heatmap upload ' + columnBytes);
		// Slots of one column of 141 rows: 37 words, 38 where the column starts within a word.
		if (liveGL && columnBytes[0]! > 4 * 38) throw Error('Slot column upload ' + columnBytes);
		if (gpu && (!gpuColumn['lumen-marks-data'] || gpuColumn['lumen-marks-data'] > 4 * 38))
			throw Error('WebGPU slot column upload ' + JSON.stringify(gpuColumn));

		await compare('partial heatmap transparency', s => {
			s.heat.update({ time: barTime(95) + 45000, values: s.column.map(() => NaN) });
		});
		const opacityBytes = await uploadBytes(liveGL, () =>
			compare('opacity-only scatter composition', s => s.scatter.applyOptions({ opacity: 0.42 })),
		);
		if (liveGL && opacityBytes.some(bytes => bytes > 0)) throw Error('Opacity uploaded scatter data ' + opacityBytes);
		await compare('independent oscillator pane', s => {
			s.chart.applyOptions({ priceScales: { oscillator: { paneWeight: 0.5, visible: true } } });
			s.chart.series()[0]!.addIndicator('rsi', { priceScaleId: 'oscillator' });
		});
		await compare('circle marker', s => s.scatter.applyOptions({ shape: 'circle', pointSize: 5 }));
		if (mode === 'hardware' && b.scatter.renderer().reason !== 'unsupported-style')
			throw Error('Missing shape fallback');
		if ((mode === 'webgl2' || window.testMarkGlAvailable) && b.scatter.renderer().effective !== 'webgl2')
			throw Error('WebGL2 circle marker was not exercised');
		const state = a.chart.saveState();
		await compare('restore', s => {
			s.chart.restoreState(state);
			s.scatter.applyOptions({ shape: 'square', pointSize: 2 });
		});
		if (
			b.chart.options().markRenderer !== (mode === 'webgl2' ? 'webgl2' : 'webgpu') ||
			JSON.stringify(state).includes('markRenderer')
		)
			throw Error('Renderer preference leaked into state');
		const readPrice = 80;
		const readTime = barTime(91);
		if (
			a.heat.valueAt(readTime, readPrice) !== b.heat.valueAt(readTime, readPrice) ||
			a.scatter.priceToCoordinate(readPrice) !== b.scatter.priceToCoordinate(readPrice)
		)
			throw Error('Mark data queries differ');
		// Points with sizes of their own, then densities. WebGPU draws neither and hands them to
		// WebGL2, which sums densities with float blending, or leaves them to Canvas 2D without it.
		let floatBlend = false;
		const expectStyled = (name: string, density: boolean) => {
			// The WebGL2 context is made when a series first draws with it: in WebGPU mode, here.
			const gl2 = window.testMarkContexts.find(context => !context.isContextLost());
			floatBlend = !!gl2?.getExtension('EXT_color_buffer_float') && !!gl2?.getExtension('EXT_float_blend');
			const status = b.scatter.renderer();
			if (mode === 'hardware' && status.reason !== 'unsupported-style')
				throw Error(name + ': WebGPU did not hand the style over: ' + JSON.stringify(status));
			const gl = mode === 'webgl2' || window.testMarkGlAvailable;
			const wanted = gl && (!density || floatBlend) ? 'webgl2' : 'canvas2d';
			if (status.effective !== wanted) throw Error(name + ': drawn with ' + JSON.stringify(status));
		};
		const readouts = () => {
			// The point at a pixel reads the window, whatever draws it: both charts give the same.
			for (let x = 3; x < 360; x += 7)
				for (let y = 5; y < 220; y += 9) {
					const left = JSON.stringify(a.scatter.pointAt(x + 0.3, y + 0.6));
					if (left !== JSON.stringify(b.scatter.pointAt(x + 0.3, y + 0.6)))
						throw Error(`pointAt(${x}, ${y}) differs: ${left}`);
				}
		};
		await compare('sizes per point', s => {
			s.scatter.applyOptions({ shape: 'square', pointSize: 2, barAlign: 'center' });
			s.scatter.setData(sizedPoints());
		});
		expectStyled('sizes per point', false);
		readouts();
		await compare('sizes per point, discs', s => s.scatter.applyOptions({ shape: 'circle' }));
		await compare('sizes per point, zoom', s => s.chart.timeScale().setVisibleLogicalRange({ from: 55.4, to: 96.9 }));
		await compare('sizes per point, start of bar', s => s.scatter.applyOptions({ barAlign: 'start' }));
		await compare('sized point appended', s =>
			s.scatter.update({ time: barTime(95) + 50000, price: 84, value: 50, size: 9 }),
		);
		await compare('wider point appended', s =>
			s.scatter.update({ time: barTime(95) + 52000, price: 78, value: 20, size: 30 }),
		);
		readouts();
		await compare('density', s =>
			s.scatter.applyOptions({ colorBy: 'density', shape: 'square', barAlign: 'center', palette: 'inferno' }),
		);
		expectStyled('density', true);
		const densityRenderer = b.scatter.renderer();
		readouts();
		await compare('density, discs and log', s => s.scatter.applyOptions({ shape: 'circle', valueScale: 'log' }));
		await compare('density, fixed range', s =>
			s.scatter.applyOptions({ valueMin: 2, valueMax: 5, valueScale: 'linear' }),
		);
		await compare('density point appended, fixed range', s =>
			s.scatter.update({ time: barTime(95) + 55000, price: 84, value: 1, size: 3 }),
		);
		await compare('density, automatic range', s => s.scatter.applyOptions({ valueMin: null, valueMax: null }));
		await compare('density point appended under the top', s =>
			s.scatter.update({ time: barTime(95) + 56000, price: 84, value: 1, size: 3 }),
		);
		await compare('density points appended above the top', s =>
			s.scatter.append(Array.from({ length: 40 }, () => ({ time: barTime(95) + 57000, price: 84, value: 1, size: 4 }))),
		);
		readouts();
		await compare('dense density at a coarse level', s => {
			const n = 600000;
			const time = new Float64Array(n),
				price = new Float64Array(n);
			let seed = 17;
			for (let i = 0; i < n; i++) {
				time[i] = barTime(Math.floor((i / n) * 90)) + Math.floor((((i / n) * 90) % 1) * 60000);
				seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
				// Prices on twenty levels: points share cells, which count them.
				price[i] = 70 + 1.25 * Math.floor((20 * seed) / 4294967296);
			}
			s.scatter.applyOptions({ shape: 'square', pointSize: 1, valueScale: 'log' });
			s.scatter.setData({ time, price });
			s.chart.timeScale().setVisibleLogicalRange({ from: 0.6, to: 92.2 });
		});
		const coarse = b.scatter.drawn();
		if (coarse.level < 1 || coarse.level !== a.scatter.drawn().level)
			throw Error('Coarse density level not exercised: ' + JSON.stringify([coarse, a.scatter.drawn()]));
		readouts();
		// Linear from 1 to the largest: the WebGL2 entries are computed on the GPU, from counts of cells.
		await compare('dense density at a coarse level, linear', s => s.scatter.applyOptions({ valueScale: 'linear' }));
		await compare('dense density, zoom to the points', s =>
			s.chart.timeScale().setVisibleLogicalRange({ from: 40.3, to: 43.1 }),
		);
		await compare('value colors again', s => {
			s.chart.restoreState(state);
			s.scatter.applyOptions({ shape: 'square', pointSize: 2 });
			s.scatter.setData(s.points);
		});
		if (b.scatter.options().colorBy !== 'value') throw Error('colorBy was not restored');
		styled = { floatBlend, density: densityRenderer, coarse };
		if (mode === 'hardware' || mode === 'webgl2') {
			await compare('dense scatter', s => {
				const n = 390000;
				const time = new Float64Array(n),
					price = new Float64Array(n),
					value = new Float32Array(n);
				let seed = 11;
				for (let i = 0; i < n; i++) {
					time[i] = barTime(82) + (i / n) * 60000;
					seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
					price[i] = 70 + (25 * seed) / 4294967296;
					value[i] = i % 100;
				}
				// A distant price outlier keeps the coarse price bins wider than the visible scale.
				price[0] = 1e5;
				s.scatter.applyOptions({ autoscale: false });
				s.scatter.setData({ time, price, value });
				s.chart.priceScale().applyOptions({ mode: 'normal' });
				s.chart.timeScale().setVisibleLogicalRange({ from: 77.3, to: 85.1 });
			});
			if (b.scatter.renderer().path !== (mode === 'hardware' ? 'scatter-columns' : 'webgl2'))
				throw Error('Dense column kernel not exercised: ' + JSON.stringify(b.scatter.drawn()));
			// Squares of 5, 7 and 9 device pixels at the three desktop ratios, in a pane taller than
			// one 1024-row strip at 2, take the kernel that reads a marker's rows back. Above a ratio
			// of 2 (2.625 on many phones) the squares stay at 9, the largest WebGPU draws.
			await compare('large squares in a tall pane', s => {
				s.chart.resize(380, 620);
				s.scatter.applyOptions({ pointSize: Math.min(4.5, 9 / devicePixelRatio) });
			});
			if (mode === 'hardware' && kernel(b) !== 'scatter-columns-wide')
				throw Error('Wide column kernel not exercised: ' + kernel(b) + ' ' + JSON.stringify(b.scatter.renderer()));
			await compare('point appended to large squares', s =>
				s.scatter.update({ time: barTime(82) + 60000, price: 81, value: 64 }),
			);
			// The column kernel reads the rows in view: a pan that overlaps the rows projected adds
			// those that come into view, one past them starts over, and a point appended out of view
			// shows when the view reaches it.
			await compare('dense scatter over many bars, part in view', s => {
				const n = 1_320_000;
				const time = new Float64Array(n),
					price = new Float64Array(n),
					value = new Float32Array(n);
				let seed = 23;
				for (let i = 0; i < n; i++) {
					const bar = (i / n) * 55;
					time[i] = barTime(40 + Math.floor(bar)) + Math.floor((bar % 1) * 60000);
					seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
					price[i] = 70 + (25 * seed) / 4294967296;
					value[i] = i % 100;
				}
				s.scatter.setData({ time, price, value });
				s.chart.timeScale().setVisibleLogicalRange({ from: 60.3, to: 66.8 });
			});
			const pans: [string, number, number][] = [
				['dense scatter, small pan right', 60.9, 67.4],
				['dense scatter, small pan left', 59.8, 66.3],
				['dense scatter, tail out of view', 86.1, 92.6],
			];
			for (const [name, from, to] of pans) {
				await compare(name, s => s.chart.timeScale().setVisibleLogicalRange({ from, to }));
				if (mode === 'hardware' && b.scatter.renderer().path !== 'scatter-columns')
					throw Error(name + ' left the column kernel: ' + b.scatter.renderer().path);
			}
			await compare('point appended out of view', s =>
				s.scatter.update({ time: barTime(95) + 30000, price: 79, value: 12 }),
			);
			await compare('appended point in view', s =>
				s.chart.timeScale().setVisibleLogicalRange({ from: 89.7, to: 96.2 }),
			);
			await compare('price scale change on part of the rows', s =>
				s.chart.priceScale().applyOptions({ invertScale: true }),
			);
			await compare('price scale restored', s => s.chart.priceScale().applyOptions({ invertScale: false }));
			// With most rows held in view, a draw that starts over projects all of them, and a pan
			// then has none left to project.
			const wide: [string, number, number][] = [
				['dense scatter, most rows in view', 50.2, 90.4],
				['dense scatter, pan over rows all projected', 49.6, 89.8],
			];
			for (const [name, from, to] of wide) {
				await compare(name, s => s.chart.timeScale().setVisibleLogicalRange({ from, to }));
				if (mode === 'hardware' && b.scatter.renderer().path !== 'scatter-columns')
					throw Error(name + ' left the column kernel: ' + b.scatter.renderer().path);
			}
			await compare('large squares restored', s => {
				s.chart.resize(365, 231);
				s.scatter.applyOptions({ pointSize: 2 });
			});
			await compare('runtime canvas preference', s => s.chart.applyOptions({ markRenderer: 'canvas2d' }));
			const requested = mode === 'hardware' ? 'webgpu' : 'webgl2';
			b.chart.applyOptions({ markRenderer: requested });
			await b.chart.whenIdle();
			for (let i = 0; i < 150 && b.scatter.renderer().effective !== requested; i++) await raf();
			await compare('runtime GPU selection');
			if (b.scatter.renderer().effective !== requested) throw Error('Runtime selection failed');
		}
		// Force coarse heatmap LOD, including subpixel bins, missing values and a
		// high isolated cell. Compare the public readout as well as the final RGBA layers.
		const extras = new Map<Fixture, ReturnType<Fixture['chart']['markSeries']>[number]>();
		await compare('coarse heatmap with overlapping series', s => {
			const extra = s.chart.addSeries('heatmap', { id: 'coarse', maxMarks: 500, opacity: 0.4 });
			const times = Float64Array.from({ length: 4000 }, (_, i) => barTime(76) + i * 420);
			const values = Float32Array.from({ length: times.length * 20 }, (_, i) => (i % 7 === 0 ? NaN : i % 997));
			extra.setData({ time: times, rows: 20, priceStart: 71, priceStep: 1, values });
			extras.set(s, extra);
			s.chart.timeScale().setVisibleLogicalRange({ from: 72.25, to: 110 });
		});
		const coarseA = extras.get(a)!,
			coarseB = extras.get(b)!;
		if (coarseA.drawn().level < 1 || coarseA.drawn().level !== coarseB.drawn().level)
			throw Error('Coarse heatmap LOD not exercised');
		await compare('remove coarse heatmap', s => s.chart.removeSeries(extras.get(s)!));
		await compare('full history replacement', s =>
			s.scatter.setData([
				{ time: barTime(90), price: 83, value: 1 },
				{ time: barTime(90), price: 83, value: 78 },
			]),
		);
		const peakBytes = b.heat.renderer().peakBytes + b.scatter.renderer().peakBytes;
		if (mode === 'hardware') {
			// Keep the reference chart and device alive while a second accelerated chart is created and removed.
			const deviceCount = window.testMarkDevices.length;
			const c = fixture('webgpu', worker);
			try {
				await c.chart.whenIdle();
				for (let i = 0; i < 100 && c.heat.renderer().effective !== 'webgpu'; i++) await raf();
				if (c.heat.renderer().effective !== 'webgpu') throw Error('Second chart did not activate');
			} finally {
				c.dispose();
			}
			if (window.testMarkDevices.length !== deviceCount) throw Error('Charts did not share a device');
			setCanvasBudget(0);
			await compare('resource budget', s => {
				s.chart.resize(371, 233);
				s.heat.applyOptions({ opacity: 0.58 });
			});
			if (b.heat.renderer().reason !== 'budget') throw Error('Missing budget fallback');
			setCanvasBudget(budget);
			await compare('budget restored', s => s.heat.applyOptions({ opacity: 0.59 }));
			for (const s of [a, b]) s.heat.update({ time: barTime(95) + 45000, values: s.column });
			const live = window.testMarkDevices.at(-1)!;
			live.destroy();
			await live.lost;
			for (let i = 0; i < 90 && b.heat.renderer().reason !== 'device-lost'; i++) await raf();
			await compare('WebGPU device loss');
			if (
				b.heat.renderer().reason !== 'device-lost' ||
				b.heat.renderer().effective !== (window.testMarkGlAvailable ? 'webgl2' : 'canvas2d')
			)
				throw Error('Missing device-loss fallback: ' + JSON.stringify(b.heat.renderer()));
		} else if (mode === 'webgl2') {
			const live = window.testMarkContexts.filter(gl => !gl.isContextLost());
			if (live.length !== 1) throw Error('Mark series did not share a WebGL2 context');
			const other = fixture('webgl2', worker);
			try {
				other.chart.resize(424, 260);
				await other.chart.whenIdle();
				if (
					other.heat.renderer().effective !== 'webgl2' ||
					window.testMarkContexts.filter(gl => !gl.isContextLost()).length !== 1
				)
					throw Error('Charts did not share the GL context');
				const width = live[0]!.canvas.width,
					height = live[0]!.canvas.height;
				for (let i = 0; i < 3; i++) {
					await compare('shared buffer smaller viewport ' + i, s =>
						s.chart.timeScale().setVisibleLogicalRange({ from: 70 + i, to: 97 + i }),
					);
					if (live[0]!.canvas.width !== width || live[0]!.canvas.height !== height)
						throw Error('Smaller chart resized the shared WebGL buffer');
					other.chart.timeScale().setVisibleLogicalRange({ from: i, to: 88 + i });
					await other.chart.whenIdle();
				}
			} finally {
				other.dispose();
			}
			if (live[0]!.canvas.height !== b.host.querySelector('canvas')!.height)
				throw Error('Shared buffer retained the larger sibling');
			await compare('shared WebGL2 context after sibling teardown', s => s.heat.applyOptions({ opacity: 0.5 }));
			const extension = live[0]!.getExtension('WEBGL_lose_context')!;
			extension.loseContext();
			for (let i = 0; i < 90 && b.heat.renderer().reason !== 'context-lost'; i++) await raf();
			await compare('WebGL2 context loss and update', s =>
				s.heat.update({ time: barTime(95) + 45000, values: s.column }),
			);
			if ([b.scatter, b.heat].some(series => series.renderer().effective !== 'canvas2d'))
				throw Error('GL loss fallback failed');
			extension.restoreContext();
			for (let i = 0; i < 120 && b.heat.renderer().effective !== 'webgl2'; i++) await raf();
			await compare('WebGL2 context restored');
			if ([b.scatter, b.heat].some(series => series.renderer().effective !== 'webgl2'))
				throw Error('GL restoration failed');
			setCanvasBudget(0);
			await compare('WebGL2 budget pressure', s => s.chart.resize(390, 251));
			if (b.heat.renderer().reason !== 'budget' || b.heat.renderer().effective !== 'canvas2d')
				throw Error('Missing GL budget fallback');
			setCanvasBudget(budget);
			await compare('WebGL2 budget restored', s => s.heat.applyOptions({ opacity: 0.54 }));
			if (b.heat.renderer().effective !== 'webgl2') throw Error('GL budget recovery failed');
		} else {
			if (mode === 'pending') {
				for (const series of [b.heat, b.scatter]) {
					const status = series.renderer();
					if (status.effective !== 'webgl2' || status.reason !== 'initializing')
						throw Error('Waiting for WebGPU did not use WebGL2');
				}
				window.finishMarkAdapter();
				for (let i = 0; i < 90 && b.heat.renderer().reason === 'initializing'; i++) await raf();
				await compare('pending WebGPU adapter unavailable');
			}
			const status = b.heat.renderer();
			const reason = mode === 'rejected' ? 'initialization-failed' : 'unavailable';
			if (status.effective !== (window.testMarkGlAvailable ? 'webgl2' : 'canvas2d') || status.reason !== reason)
				throw Error('Unexpected fallback: ' + JSON.stringify(status));
		}
		report = {
			mode,
			worker,
			tolerance,
			/** Comparisons with any difference, all within the tolerance. */
			inexact: results.filter(result => result.different > 0).length,
			largest: Math.max(0, ...results.map(result => result.largest)),
			firstFrameMs,
			readyMs,
			peakBytes,
			fallback: b.heat.renderer().reason,
			styled,
			checks: results.length,
			results,
		};
	} finally {
		setCanvasBudget(budget);
		a.dispose();
		b.dispose();
	}
	if (canvasPixelsInUse() !== memory) throw Error('Mark resources leaked after teardown');
	return report;
}
declare global {
	interface Window {
		checkMarkRenderers: typeof check;
		testMarkDevices: GPUDevice[];
		finishMarkAdapter: () => void;
		testMarkContexts: WebGL2RenderingContext[];
		testMarkGlAvailable: boolean;
	}
}
window.checkMarkRenderers = check;

// A USB-connected phone can exercise its own browser through a localhost port reverse.
// The device capture is confined to this qualification page.
if (new URLSearchParams(location.search).has('run')) {
	const result = document.createElement('pre');
	document.body.append(result);
	void (async () => {
		window.testMarkDevices = [];
		const gl = document.createElement('canvas').getContext('webgl2');
		window.testMarkGlAvailable = !!gl;
		gl?.getExtension('WEBGL_lose_context')?.loseContext();
		const adapter = await navigator.gpu?.requestAdapter();
		const available = Boolean(adapter && !adapter.info?.isFallbackAdapter);
		if (available) {
			const request = GPUAdapter.prototype.requestDevice;
			GPUAdapter.prototype.requestDevice = async function (descriptor) {
				const device = await request.call(this, descriptor);
				window.testMarkDevices.push(device);
				return device;
			};
		}
		result.textContent = 'Checking mark renderers…';
		return {
			browser: navigator.userAgent,
			dpr: devicePixelRatio,
			...(await check(available ? 'hardware' : 'native-fallback', true)),
		};
	})()
		.then(run => {
			result.textContent = JSON.stringify(run, null, 2);
		})
		.catch((error: unknown) => {
			result.textContent = String(error);
		});
}
