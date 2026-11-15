import { createChart } from '@lumen-charts/core';

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
const chart = createChart(container, {
	// `?theme=light` or `?theme=dark` pins a theme; by default the chart follows the system setting.
	theme: theme === 'light' || theme === 'dark' ? theme : 'auto',
	watermark: { visible: true, text: 'DEMO · 1m' },
	worker: params.get('worker') !== '0',
});
const candles = lineOnly ? null : chart.addSeries('candlestick');
const line = chart.addSeries('line', { color: '#f5b83d', lineWidth: lineOnly ? 1 : 1.5 });
candles?.setData({ time, open, high, low, close });
line.setData({ time, value: lineOnly ? close : average });

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

Object.assign(globalThis, { chart, candles, line });
