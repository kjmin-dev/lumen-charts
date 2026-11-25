import { DRAWING_TYPES, createChart } from '@lumen-ticks/core';

const container = document.getElementById('chart');
if (container === null) {
	throw new Error('Missing #chart element');
}

const params = new URLSearchParams(location.search);
const count = Number(params.get('bars') ?? 1_000_000);
// `?series=line` shows one line instead of candles with an average, for very large data sets.
const lineOnly = params.get('series') === 'line';
const MINUTE = 60_000;

// Random-walk candles, built as columns so a million bars cost no objects.
const time = new Float64Array(count);
const open = new Float64Array(count);
const high = new Float64Array(count);
const low = new Float64Array(count);
const close = new Float64Array(count);
const average = new Float64Array(count);
const start = Date.UTC(2024, 0, 1) - count * MINUTE;
let price = 100;
let smooth = price;
for (let i = 0; i < count; i++) {
	const next = Math.max(1, price + (Math.random() - 0.5) * 0.8);
	time[i] = start + i * MINUTE;
	open[i] = price;
	close[i] = next;
	high[i] = Math.max(price, next) + Math.random() * 0.3;
	low[i] = Math.min(price, next) - Math.random() * 0.3;
	smooth += (next - smooth) * 0.02;
	average[i] = smooth;
	price = next;
}

const theme = params.get('theme');
const renderer = params.get('markRenderer');
const chart = createChart(container, {
	accessibility: { label: 'Demo market, one-minute prices' },
	// `?theme=light` or `?theme=dark` pins a theme; by default the chart follows the system setting.
	theme: theme === 'light' || theme === 'dark' ? theme : 'auto',
	watermark: { visible: true, text: 'DEMO · 1m' },
	worker: params.get('worker') !== '0',
	markRenderer: renderer === 'webgpu' || renderer === 'canvas2d' ? renderer : 'webgl2',
});
const candles = lineOnly ? null : chart.addSeries('candlestick', { id: 'Price' });
const line = chart.addSeries('line', {
	id: lineOnly ? 'Price' : 'Moving average',
	color: '#f5b83d',
	lineWidth: lineOnly ? 1 : 1.5,
});
candles?.setData({ time, open, high, low, close });
line.setData({ time, value: lineOnly ? close : average });
// Indicators computed in the data engine and updated with every tick; `?indicators=0` leaves them out.
const indicators =
	candles === null || params.get('indicators') === '0'
		? []
		: [
				candles.addIndicator('bollinger', { params: { period: 20, multiplier: 2 } }),
				candles.addIndicator('ema', { params: { period: 50 } }),
			];

// ?marks=1&markRenderer=webgpu adds both mark layers and a live backend selector.
if (params.has('marks') && count > 0) {
	const times = time.slice(Math.max(0, count - 1000));
	const scatter = chart.addSeries('scatter', { pointSize: 2 });
	const heat = chart.addSeries('heatmap', { opacity: 0.65 });
	const values = Float32Array.from({ length: times.length * 32 }, (_, i) => 50 + 49 * Math.sin(i * 0.061));
	heat.setData({ time: times, priceStart: price - 3, priceStep: 0.2, rows: 32, values });
	scatter.setData({ time: times, price: close.subarray(count - times.length) });
	const picker = document.createElement('select');
	picker.setAttribute('aria-label', 'Mark renderer');
	for (const choice of ['canvas2d', 'webgl2', 'webgpu']) picker.add(new Option(choice, choice));
	picker.value = chart.options().markRenderer;
	picker.addEventListener('change', () =>
		chart.applyOptions({ markRenderer: picker.value as 'canvas2d' | 'webgl2' | 'webgpu' }),
	);
	document.getElementById('tools')?.append(picker);
}
// Live ticks: several updates to the last bar, then a new one.
let lastTime = time[count - 1]!;
let barOpen = price;
let barHigh = price;
let barLow = price;
let ticks = 0;
if (params.get('live') !== '0')
	setInterval(() => {
		if (++ticks % 20 === 0) {
			lastTime += MINUTE;
			barOpen = price;
			barHigh = price;
			barLow = price;
		}
		price = Math.max(1, price + (Math.random() - 0.5) * 0.2);
		barHigh = Math.max(barHigh, price);
		barLow = Math.min(barLow, price);
		smooth += (price - smooth) * 0.001;
		candles?.update({ time: lastTime, open: barOpen, high: barHigh, low: barLow, close: price });
		line.update({ time: lastTime, value: lineOnly ? price : smooth });
	}, 50);

// A button per drawing tool: click it, then click (or drag) on the chart to place the points.
// Escape cancels, Delete removes the selected drawing; `chart.drawings().toJSON()` saves them.
const tools = document.getElementById('tools');
for (const type of DRAWING_TYPES) {
	const button = document.createElement('button');
	button.textContent = type;
	button.addEventListener('click', () => chart.drawings().startTool(type));
	tools?.append(button);
}

Object.assign(globalThis, { chart, candles, line, indicators });
