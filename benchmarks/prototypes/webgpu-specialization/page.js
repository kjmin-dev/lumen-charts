import { createChart } from '@lumen-charts/core';
import { installMarkPassTimer } from '../../src/marks/pass-timer.ts';

const time = i => 1700000000000 + i * 60000;

function readPixels(src) {
	const c = document.createElement('canvas');
	c.width = src.width;
	c.height = src.height;
	const ctx = c.getContext('2d', { willReadFrequently: true });
	ctx.drawImage(src, 0, 0);
	return ctx.getImageData(0, 0, c.width, c.height).data;
}

function fixture(preference, width, height, n) {
	const host = document.body.appendChild(document.createElement('div'));
	host.style.position = 'absolute';
	host.style.top = '0';
	host.style.left = '0';
	const chart = createChart(host, {
		width,
		height,
		autoSize: false,
		worker: false,
		markRenderer: preference,
		redraw: 'full',
	});
	const bars = chart.addSeries('candlestick');
	bars.setData(Array.from({ length: n }, (_, i) => ({ time: time(i), open: 75, high: 102, low: 1, close: 65 })));
	chart.timeScale().setVisibleLogicalRange({ from: -1, to: n });
	return {
		chart,
		host,
		dispose() {
			chart.destroy();
			host.remove();
		},
	};
}

export async function study(sizes) {
	installMarkPassTimer();
	const adapter = await navigator.gpu?.requestAdapter();
	if (!adapter || adapter.info.isFallbackAdapter) throw new Error('Hardware WebGPU required');

	const raf = window.requestAnimationFrame.bind(window);
	let js = 0,
		uploads = 0;
	window.requestAnimationFrame = callback =>
		raf(t => {
			const start = performance.now();
			try {
				callback(t);
			} finally {
				js += performance.now() - start;
			}
		});
	const write = GPUQueue.prototype.writeBuffer;
	GPUQueue.prototype.writeBuffer = function (buffer, offset, data, at, size) {
		if (data instanceof ArrayBuffer) uploads += size ?? data.byteLength - (at ?? 0);
		else
			uploads +=
				size === undefined
					? data.byteLength - (at ?? 0) * (data.BYTES_PER_ELEMENT ?? 1)
					: size * (data.BYTES_PER_ELEMENT ?? 1);
		return write.apply(this, arguments);
	};

	async function ready(f, series) {
		await f.chart.whenIdle();
		for (let k = 0; k < 200 && series.renderer().effective !== 'webgpu'; k++) await new Promise(raf);
		if (series.renderer().effective !== 'webgpu') throw new Error('GPU fallback ' + JSON.stringify(series.renderer()));
	}
	const probes = {};
	const heatStart = performance.now();
	const heat = fixture('webgpu', 1200, 600, 2400);
	const series = heat.chart.addSeries('heatmap', { valueMin: 0, valueMax: 100 });
	const rows = 600;
	const column = Float32Array.from({ length: rows }, (_, i) => i % 101);
	series.setData({
		rows,
		priceStart: 1,
		priceStep: 0.2,
		time: Float64Array.from({ length: 2400 }, (_, i) => time(i)),
		values: Float32Array.from({ length: 2400 * rows }, (_, i) => (i % 17 ? i % 101 : NaN)),
	});
	await ready(heat, series);
	const firstGpuMs = performance.now() - heatStart;
	const apply = async fn => {
		js = 0;
		uploads = 0;
		const start = performance.now();
		fn();
		const api = performance.now() - start;
		await heat.chart.whenIdle();
		return { jsMs: api + js, bytes: uploads, settledMs: performance.now() - start };
	};
	for (const [key, fn] of [
		['palette', i => series.applyOptions({ palette: i % 2 ? 'heat' : 'viridis' })],
		['gain', i => series.applyOptions({ valueMax: i % 2 ? 99 : 100 })],
		[
			'replace',
			i => {
				column[i % rows] = (i + 47) % 101;
				series.update({ time: time(2399), values: column });
			},
		],
	]) {
		const samples = [];
		for (let i = 0; i < 36; i++) {
			const sample = await apply(() => fn(i));
			if (i >= 6) samples.push(sample);
		}
		probes[key] = samples;
	}
	const heatBytes = series.renderer().bytes;
	heat.dispose();

	const a = fixture('canvas2d', 640, 620, 160),
		b = fixture('webgpu', 640, 620, 160);
	const n = 390001;
	const t = new Float64Array(n),
		price = new Float64Array(n),
		value = new Float32Array(n);
	let seed = 81273;
	for (let i = 0; i < n; i++) {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		t[i] = time(((Math.floor(i / 5) * 160) / n) * 5);
		price[i] = i % 97 === 0 ? 1 : (90 * seed) / 4294967296 + 5;
		value[i] = i % 31 === 0 ? NaN : i % 101;
	}
	function scatter(f) {
		const s = f.chart.addSeries('scatter', {
			pointSize: 1.5,
			valueMin: 0,
			valueMax: 100,
			palette: ['transparent', '#47aade80', '#ffaa13'],
			color: '#5b7920',
			maxMarks: 2000000,
		});
		s.setData({ time: t, price, value });
		f.chart.priceScale().setVisibleRange({ from: 12, to: 80 });
		return s;
	}
	const s1 = scatter(a),
		s2 = scatter(b);
	await ready(b, s2);
	await a.chart.whenIdle();
	const checks = [];
	const changes = [
		['initial', () => {}],
		// 1, 4 and 9 device pixels at any ratio.
		['one pixel', s => s.applyOptions({ pointSize: 1 / window.devicePixelRatio })],
		['even size', s => s.applyOptions({ pointSize: 4 / window.devicePixelRatio })],
		['nine pixels', s => s.applyOptions({ pointSize: 9 / window.devicePixelRatio })],
		['fractional zoom', (_, f) => f.chart.timeScale().setVisibleLogicalRange({ from: 14.135, to: 107.7 })],
		['inverted', (_, f) => f.chart.priceScale().applyOptions({ invertScale: true })],
		['log', (_, f) => f.chart.priceScale().applyOptions({ mode: 'logarithmic' })],
		['append', s => s.update({ time: time(160), price: 78, value: 22 })],
		['pan to tail', (_, f) => f.chart.timeScale().setVisibleLogicalRange({ from: 55.6, to: 163.2 })],
	];

	for (const [name, change] of changes) {
		change(s1, a);
		change(s2, b);
		await Promise.all([a.chart.whenIdle(), b.chart.whenIdle()]);
		await new Promise(raf);
		const left = a.host.querySelectorAll('canvas'),
			right = b.host.querySelectorAll('canvas');
		if (left.length !== right.length) throw Error('Different layer counts');
		for (let k = 0; k < left.length; k++) {
			const l = readPixels(left[k]),
				r = readPixels(right[k]);
			if (l.length !== r.length || !l.every((v, i) => v === r[i]))
				throw Error('Pixel difference: ' + name + ' layer ' + k);
		}
		if (s2.renderer().effective !== 'webgpu') throw Error('Unexpected scatter fallback');
		checks.push({
			name,
			path: s2.renderer().path,
			marks: s2.drawn().marks,
			level: s2.drawn().level,
			bytes: s2.renderer().bytes,
		});
	}
	a.dispose();
	b.dispose();
	const scatterFrames = [];
	const f = fixture('webgpu', 1200, 600, 160);
	const samples = 1000000;
	const times = new Float64Array(samples),
		prices = new Float64Array(samples),
		values = new Float32Array(samples);
	for (let i = 0; i < samples; i++) {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		prices[i] = 1 + (100 * seed) / 4294967296;
		values[i] = i % 101;
	}
	const points = f.chart.addSeries('scatter', {
		pointSize: 0.5,
		valueMin: 0,
		valueMax: 100,
		autoscale: false,
		maxMarks: 2000000,
	});
	f.chart.priceScale().setVisibleRange({ from: 1, to: 102 });
	for (const distribution of ['uniform', 'burst']) {
		for (let i = 0; i < samples; i++) {
			const u = (Math.floor(i / 4) * 4) / samples;
			const pos =
				distribution === 'uniform'
					? u
					: u < 0.0625
						? u * 7.75
						: u < 0.9375
							? 0.484375 + (u - 0.0625) / 28
							: 0.515625 + (u - 0.9375) * 7.75;
			times[i] = time(159 * pos);
		}
		// setData can transfer the caller's buffers; keep the originals for the second distribution.
		points.setData({ time: times.slice(), price: prices.slice(), value: values.slice() });
		await ready(f, points);
		for (const pixels of sizes) {
			const before = points.renderer().bytes;
			js = 0;
			const started = performance.now();
			// Squares of `pixels` device pixels at any ratio.
			points.applyOptions({ pointSize: pixels / window.devicePixelRatio });
			await f.chart.whenIdle();
			const switchMs = performance.now() - started,
				switchJsMs = js;
			for (let i = 0; i < 8; i++) {
				f.chart.timeScale().setVisibleLogicalRange({ from: i % 2 ? 0.1 : -1.1, to: 161 });
				await f.chart.whenIdle();
			}
			const pass = window.markPassTimer;
			if (!pass) throw Error('Hardware timestamp queries required for this study');
			pass.start();
			const frameJs = [];
			for (let i = 0; i < 48; i++) {
				js = 0;
				const start = performance.now();
				f.chart.timeScale().setVisibleLogicalRange({ from: i % 2 ? 0.1 : -1.1, to: 161 });
				const api = performance.now() - start;
				await f.chart.whenIdle();
				frameJs.push(api + js);
			}
			pass.stop();
			const gpu = await pass.read();
			if (gpu.length !== 48 || points.renderer().path !== 'scatter-columns')
				throw Error('Expected 48 GPU column draws, got ' + gpu.length + ' ' + points.renderer().path);
			scatterFrames.push({
				pixels,
				distribution,
				switchMs,
				switchJsMs,
				bytesBefore: before,
				bytesAfter: points.renderer().bytes,
				visible: points.drawn(),
				frameJs,
				gpu,
			});
		}
	}
	f.dispose();

	return {
		adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture },
		firstGpuMs,
		heatBytes,
		scatterFrames,
		probes,
		checks,
	};
}
