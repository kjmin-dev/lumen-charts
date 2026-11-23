import {
	type ChartApi,
	type ChartState,
	type CrosshairMode,
	type DrawingType,
	type DrawTarget,
	type MarkRenderer,
	PALETTES,
	type PanePrimitive,
	type PaneView,
	type PriceScaleMode,
	type PrimitiveBounds,
	type ThemeName,
	createChart,
} from '@lumen-charts/core';
import { generateCandles, generateOrderBookAndTrades, generateSessionCandles } from './data.ts';
import type { DemoName } from './names.ts';

export { DEMO_NAMES, type DemoName } from './names.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

interface DemoContext {
	root: HTMLElement;
	theme: () => ThemeName;
	onThemeChange: (listener: (theme: ThemeName) => void) => void;
	onCleanup: (fn: () => void) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attrs: Record<string, string> = {},
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(attrs)) {
		node.setAttribute(key, value);
	}
	if (text !== undefined) {
		node.textContent = text;
	}
	return node;
}

function buildShell(ctx: DemoContext, options: { toolbar?: boolean; split?: boolean } = {}) {
	const shell = el('div', { class: 'demo-shell' });
	const toolbar = options.toolbar === false ? null : el('div', { class: 'demo-toolbar' });
	const stage = el('div', { class: options.split ? 'demo-stage demo-stage--split' : 'demo-stage' });
	if (toolbar !== null) {
		shell.append(toolbar);
	}
	shell.append(stage);
	ctx.root.replaceChildren(shell);
	return { shell, toolbar, stage };
}

function formatPrice(value: number): string {
	return value.toFixed(2);
}

function formatUtcTime(ms: number): string {
	const d = new Date(ms);
	const y = d.getUTCFullYear();
	const m = String(d.getUTCMonth() + 1).padStart(2, '0');
	const day = String(d.getUTCDate()).padStart(2, '0');
	const hh = String(d.getUTCHours()).padStart(2, '0');
	const mm = String(d.getUTCMinutes()).padStart(2, '0');
	return `${y}-${m}-${day} ${hh}:${mm}`;
}

function makeChart(
	ctx: DemoContext,
	container: HTMLElement,
	options: Parameters<typeof createChart>[1] = {},
): ChartApi {
	const chart = createChart(container, {
		theme: ctx.theme(),
		...options,
	});
	ctx.onThemeChange(theme => chart.applyOptions({ theme }));
	ctx.onCleanup(() => chart.destroy());
	return chart;
}

// ---------------------------------------------------------------- hero

function mountHero(ctx: DemoContext): void {
	const { toolbar, stage } = buildShell(ctx);
	const data = generateCandles({
		count: 25_000,
		stepMs: MINUTE,
		startTime: Date.UTC(2025, 0, 1),
		startPrice: 184.5,
		volatility: 0.0028,
		seed: 101,
	});

	const chart = makeChart(ctx, stage, {
		accessibility: { label: 'LUMEN/USD 1-minute candlesticks with Bollinger Bands and EMA 50' },
		watermark: { visible: true, text: 'LUMEN · 1m' },
		crosshair: { mode: 'normal' },
	});

	const candles = chart.addSeries('candlestick', { id: 'LUMEN' });
	candles.setData(data);
	let bands = candles.addIndicator('bollinger', { params: { period: 20, multiplier: 2 } });
	let ema = candles.addIndicator('ema', { params: { period: 50 }, outputs: { value: { color: '#f5b83d' } } });

	const count = data.time.length;
	chart.timeScale().setVisibleLogicalRange({ from: count - 130, to: count + 4 });

	// Live ticks updating the tail bar and starting a new bar every 18 ticks.
	let lastTime = data.time[count - 1]!;
	let barOpen = data.open[count - 1]!;
	let barHigh = data.high[count - 1]!;
	let barLow = data.low[count - 1]!;
	let price = data.close[count - 1]!;
	let barVolume = data.volume[count - 1]!;
	let live = true;
	let tickIndex = 0;

	const status = el('span', { class: 'demo-status' });
	const dot = el('span', { class: 'demo-dot' });
	const statusLabel = el('span', {}, '25,000 bars · Live');
	status.append(dot, statusLabel);

	const liveBtn = el('button', { type: 'button', class: 'demo-btn', 'aria-pressed': 'true' }, 'Live ticks');
	liveBtn.addEventListener('click', () => {
		live = !live;
		liveBtn.setAttribute('aria-pressed', String(live));
		dot.className = live ? 'demo-dot' : 'demo-dot demo-dot--paused';
		statusLabel.textContent = live ? '25,000 bars · Live' : '25,000 bars · Paused';
	});

	let showIndicators = true;
	const indBtn = el('button', { type: 'button', class: 'demo-btn', 'aria-pressed': 'true' }, 'Bollinger + EMA');
	indBtn.addEventListener('click', () => {
		showIndicators = !showIndicators;
		indBtn.setAttribute('aria-pressed', String(showIndicators));
		if (showIndicators) {
			bands = candles.addIndicator('bollinger', { params: { period: 20, multiplier: 2 } });
			ema = candles.addIndicator('ema', { params: { period: 50 }, outputs: { value: { color: '#f5b83d' } } });
		} else {
			bands.remove();
			ema.remove();
		}
	});

	const fitBtn = el('button', { type: 'button', class: 'demo-btn' }, 'Fit all 25k');
	fitBtn.addEventListener('click', () => chart.timeScale().fitContent());

	const recentBtn = el('button', { type: 'button', class: 'demo-btn' }, 'Latest');
	recentBtn.addEventListener('click', () =>
		chart.timeScale().setVisibleLogicalRange({ from: count - 130, to: count + 4 }),
	);

	const readout = el('span', { class: 'demo-readout' });
	const renderReadout = (o: number, h: number, l: number, c: number) => {
		const cls = c >= o ? 'up' : 'down';
		readout.innerHTML = `O <strong>${formatPrice(o)}</strong> H <strong>${formatPrice(h)}</strong> L <strong>${formatPrice(l)}</strong> C <strong class="${cls}">${formatPrice(c)}</strong>`;
	};
	renderReadout(barOpen, barHigh, barLow, price);

	chart.subscribe('crosshairMove', event => {
		const value = event.values.get('LUMEN');
		if (value !== undefined && 'close' in value) {
			renderReadout(value.open, value.high, value.low, value.close);
		} else if (event.point === null) {
			renderReadout(barOpen, barHigh, barLow, price);
		}
	});

	toolbar?.append(status, liveBtn, indBtn, fitBtn, recentBtn, readout);

	const timer = window.setInterval(() => {
		if (!live) {
			return;
		}
		tickIndex++;
		if (tickIndex % 18 === 0) {
			lastTime += MINUTE;
			barOpen = price;
			barHigh = price;
			barLow = price;
			barVolume = 140;
		}
		const step = (Math.sin(tickIndex * 0.73) * 0.42 + Math.cos(tickIndex * 1.91) * 0.31) * 0.45;
		price = Math.max(10, price + step);
		barHigh = Math.max(barHigh, price);
		barLow = Math.min(barLow, price);
		barVolume += 12;
		candles.update({ time: lastTime, open: barOpen, high: barHigh, low: barLow, close: price, volume: barVolume });
		if (tickIndex % 3 === 0) {
			renderReadout(barOpen, barHigh, barLow, price);
		}
	}, 180);
	ctx.onCleanup(() => window.clearInterval(timer));
}

// ---------------------------------------------------------------- indicators

function mountIndicators(ctx: DemoContext): void {
	const { toolbar, stage } = buildShell(ctx);
	const data = generateCandles({
		count: 420,
		stepMs: HOUR,
		startTime: Date.UTC(2025, 1, 1),
		startPrice: 210,
		volatility: 0.007,
		seed: 202,
	});

	const chart = makeChart(ctx, stage, {
		accessibility: { label: 'Price chart with Bollinger Bands, RSI pane, and volume pane' },
		crosshair: { mode: 'nearest' },
		priceScales: {
			oscillator: { paneWeight: 0.36, visible: true },
			volume: { paneWeight: 0.28, visible: true },
		},
	});

	const candles = chart.addSeries('candlestick', { id: 'Price' });
	candles.setData(data);

	const bands = candles.addIndicator('bollinger', {
		id: 'bb',
		params: { period: 20, multiplier: 2 },
		outputs: { middle: { color: '#ffa726', lineStyle: 'dashed' } },
	});
	const ema = candles.addIndicator('ema', {
		id: 'ema',
		params: { period: 20 },
		outputs: { value: { color: '#7e57c2' } },
	});
	const rsi = candles.addIndicator('rsi', { id: 'rsi', params: { period: 14 }, priceScaleId: 'oscillator' });
	rsi.output().addIndicator('sma', {
		id: 'rsi-sma',
		params: { period: 9 },
		priceScaleId: 'oscillator',
		outputs: { value: { color: '#f5b83d' } },
	});

	const volume = chart.addSeries('histogram', {
		id: 'Volume',
		priceScaleId: 'volume',
		color: 'rgba(38, 166, 154, 0.72)',
		base: 0,
	});
	volume.setData({ time: data.time, value: data.volume });

	chart.timeScale().setVisibleLogicalRange({ from: data.time.length - 140, to: data.time.length + 3 });

	const periodGroup = el('div', { class: 'demo-group' });
	periodGroup.append(el('span', { class: 'demo-label' }, 'EMA period'));
	for (const period of [12, 20, 50]) {
		const btn = el(
			'button',
			{ type: 'button', class: 'demo-btn', 'aria-pressed': String(period === 20) },
			String(period),
		);
		btn.addEventListener('click', () => {
			ema.applyOptions({ params: { period } });
			for (const sibling of periodGroup.querySelectorAll('button')) {
				sibling.setAttribute('aria-pressed', String(sibling === btn));
			}
		});
		periodGroup.append(btn);
	}

	let rsiSeparate = true;
	const paneBtn = el('button', { type: 'button', class: 'demo-btn', 'aria-pressed': 'true' }, 'Separate RSI pane');
	paneBtn.addEventListener('click', () => {
		rsiSeparate = !rsiSeparate;
		paneBtn.setAttribute('aria-pressed', String(rsiSeparate));
		chart.priceScale('oscillator').applyOptions({ paneWeight: rsiSeparate ? 0.36 : 0, visible: rsiSeparate });
	});

	let bandsVisible = true;
	const bbBtn = el('button', { type: 'button', class: 'demo-btn', 'aria-pressed': 'true' }, 'Bollinger');
	bbBtn.addEventListener('click', () => {
		bandsVisible = !bandsVisible;
		bbBtn.setAttribute('aria-pressed', String(bandsVisible));
		for (const out of bands.outputs()) {
			out.applyOptions({ visible: bandsVisible });
		}
	});

	const readout = el('span', { class: 'demo-readout' }, 'Hover to inspect indicator outputs');
	chart.subscribe('crosshairMove', event => {
		const r = event.values.get('rsi.value');
		const e = event.values.get('ema.value');
		if (r !== undefined && 'value' in r && e !== undefined && 'value' in e) {
			readout.innerHTML = `EMA <strong>${formatPrice(e.value)}</strong> · RSI <strong>${r.value.toFixed(1)}</strong>`;
		}
	});

	toolbar?.append(periodGroup, paneBtn, bbBtn, readout);
}

// ---------------------------------------------------------------- price-axes

function mountPriceAxes(ctx: DemoContext): void {
	const { toolbar, stage } = buildShell(ctx);
	const primary = generateCandles({
		count: 320,
		stepMs: HOUR,
		startTime: Date.UTC(2025, 0, 15),
		startPrice: 120,
		volatility: 0.0085,
		seed: 303,
	});
	const compare = generateCandles({
		count: 320,
		stepMs: HOUR,
		startTime: Date.UTC(2025, 0, 15),
		startPrice: 4800,
		volatility: 0.0075,
		seed: 309,
	});

	const chart = makeChart(ctx, stage, {
		accessibility: { label: 'Dual price scale comparison chart' },
		priceScale: { mode: 'normal' },
		priceScales: {
			compare: { visible: true, position: 'left', mode: 'percentage' },
			volume: { visible: false, scaleMargins: { top: 0.82, bottom: 0 } },
		},
	});

	const candles = chart.addSeries('candlestick', { id: 'Primary', minMove: 0.25 });
	candles.setData(primary);
	const benchmark = chart.addSeries('line', {
		id: 'Benchmark',
		priceScaleId: 'compare',
		color: '#2962ff',
		lineWidth: 2,
	});
	benchmark.setData({ time: compare.time, value: compare.close });
	const vol = chart.addSeries('histogram', {
		id: 'Volume',
		priceScaleId: 'volume',
		color: 'rgba(38, 166, 154, 0.35)',
	});
	vol.setData({ time: primary.time, value: primary.volume });

	chart.timeScale().setVisibleLogicalRange({ from: 170, to: 324 });

	const modeGroup = el('div', { class: 'demo-group' });
	modeGroup.append(el('span', { class: 'demo-label' }, 'Right scale'));
	const modes: PriceScaleMode[] = ['normal', 'logarithmic', 'percentage', 'indexed'];
	for (const mode of modes) {
		const btn = el('button', { type: 'button', class: 'demo-btn', 'aria-pressed': String(mode === 'normal') }, mode);
		btn.addEventListener('click', () => {
			chart.priceScale().applyOptions({ mode });
			for (const sibling of modeGroup.querySelectorAll('button')) {
				sibling.setAttribute('aria-pressed', String(sibling === btn));
			}
		});
		modeGroup.append(btn);
	}

	let inverted = false;
	const invertBtn = el('button', { type: 'button', class: 'demo-btn', 'aria-pressed': 'false' }, 'Invert');
	invertBtn.addEventListener('click', () => {
		inverted = !inverted;
		invertBtn.setAttribute('aria-pressed', String(inverted));
		chart.priceScale().applyOptions({ invertScale: inverted });
	});

	const hint = el('span', { class: 'demo-readout' }, 'Drag either price axis to scale · Double-click to reset');
	toolbar?.append(modeGroup, invertBtn, hint);
}

// ---------------------------------------------------------------- drawings

function mountDrawings(ctx: DemoContext): void {
	const { toolbar, stage } = buildShell(ctx);
	const data = generateCandles({
		count: 260,
		stepMs: HOUR,
		startTime: Date.UTC(2025, 2, 1),
		startPrice: 150,
		volatility: 0.0065,
		seed: 404,
	});

	const chart = makeChart(ctx, stage, {
		accessibility: { label: 'Interactive financial chart with drawing tools' },
		crosshair: { mode: 'magnet' },
	});
	const candles = chart.addSeries('candlestick', { id: 'Price' });
	candles.setData(data);
	chart.timeScale().setVisibleLogicalRange({ from: 120, to: 264 });

	const drawings = chart.drawings();
	const seedDrawings = () => {
		drawings.clear();
		const n = data.time.length;
		// Find the true swing high and swing low across the visible slice so the Fibonacci
		// retracement spans a clear vertical range with legible level labels.
		let swingHiIdx = n - 125;
		let swingLoIdx = n - 70;
		for (let i = n - 132; i < n - 85; i++) {
			if (data.high[i]! > data.high[swingHiIdx]!) {
				swingHiIdx = i;
			}
		}
		for (let i = n - 78; i < n - 35; i++) {
			if (data.low[i]! < data.low[swingLoIdx]!) {
				swingLoIdx = i;
			}
		}

		drawings.add({
			type: 'fibRetracement',
			points: [
				{ time: data.time[swingHiIdx]!, price: data.high[swingHiIdx]! },
				{ time: data.time[swingLoIdx]!, price: data.low[swingLoIdx]! },
			],
			options: { color: '#2962ff', fillColor: 'rgba(41, 98, 255, 0.06)' },
		});
		drawings.add({
			type: 'trendLine',
			points: [
				{ time: data.time[swingHiIdx]!, price: data.high[swingHiIdx]! },
				{ time: data.time[n - 18]!, price: data.high[n - 18]! + 0.5 },
			],
			options: { color: '#f5b83d', lineWidth: 2, text: 'Resistance trend' },
		});
		const zoneTop = data.high[n - 32]! + 1.4;
		drawings.add({
			type: 'rectangle',
			points: [
				{ time: data.time[n - 46]!, price: zoneTop },
				{ time: data.time[n - 6]!, price: zoneTop - 2.6 },
			],
			options: { color: '#26a69a', fillColor: 'rgba(38, 166, 154, 0.15)', text: 'Demand zone' },
		});
	};
	seedDrawings();

	const tools: [DrawingType, string][] = [
		['trendLine', 'Trend'],
		['rectangle', 'Rectangle'],
		['fibRetracement', 'Fibonacci'],
		['horizontalLine', 'H-Line'],
		['priceRange', 'Range'],
	];

	const toolButtons = new Map<DrawingType, HTMLButtonElement>();
	const syncToolButtons = () => {
		const active = drawings.activeTool();
		for (const [type, btn] of toolButtons) {
			btn.setAttribute('aria-pressed', String(active === type));
		}
	};

	const group = el('div', { class: 'demo-group' });
	group.append(el('span', { class: 'demo-label' }, 'Tool'));
	for (const [type, label] of tools) {
		const btn = el('button', { type: 'button', class: 'demo-btn', 'aria-pressed': 'false' }, label);
		btn.addEventListener('click', () => {
			if (drawings.activeTool() === type) {
				drawings.cancelTool();
			} else {
				drawings.startTool(type, { color: '#2962ff' });
			}
			syncToolButtons();
		});
		toolButtons.set(type, btn);
		group.append(btn);
	}

	const resetBtn = el('button', { type: 'button', class: 'demo-btn' }, 'Reset');
	resetBtn.addEventListener('click', () => {
		drawings.cancelTool();
		seedDrawings();
		syncToolButtons();
	});

	const clearBtn = el('button', { type: 'button', class: 'demo-btn' }, 'Clear');
	clearBtn.addEventListener('click', () => {
		drawings.cancelTool();
		drawings.clear();
		syncToolButtons();
	});

	const readout = el('span', { class: 'demo-readout' }, 'Click a tool to draw · Drag handles to edit · Del removes');
	drawings.subscribe('created', drawing => {
		syncToolButtons();
		readout.textContent = `Created ${drawing.type} (${drawings.list().length} total)`;
	});
	drawings.subscribe('selected', drawing => {
		readout.textContent =
			drawing === null ? 'Click a tool to draw · Drag handles to edit' : `Selected ${drawing.type} (Del to remove)`;
	});

	toolbar?.append(group, resetBtn, clearBtn, readout);
}

// ---------------------------------------------------------------- heatmap-scatter

function mountHeatmapScatter(ctx: DemoContext): void {
	const { toolbar, stage } = buildShell(ctx);
	const stepMs = MINUTE;
	const data = generateCandles({
		count: 260,
		stepMs,
		startTime: Date.UTC(2025, 3, 1, 13, 30),
		startPrice: 100,
		volatility: 0.0022,
		seed: 505,
	});
	const { book, trades } = generateOrderBookAndTrades(data, stepMs, 509);

	const chart = makeChart(ctx, stage, {
		accessibility: { label: 'Order book heatmap and trade scatter series' },
		markRenderer: 'webgl2',
	});

	const candles = chart.addSeries('candlestick', { id: 'Price' });
	candles.setData(data);

	const heat = chart.addSeries('heatmap', {
		id: 'Book',
		palette: 'heat',
		valueScale: 'log',
		opacity: 0.85,
	});
	heat.setData(book);

	const scatter = chart.addSeries('scatter', {
		id: 'Trades',
		palette: 'turbo',
		shape: 'circle',
		barAlign: 'start',
		opacity: 0.9,
	});
	scatter.setData(trades);

	chart.timeScale().setVisibleLogicalRange({ from: 110, to: 262 });

	const rendererGroup = el('div', { class: 'demo-group' });
	rendererGroup.append(el('span', { class: 'demo-label' }, 'Renderer'));
	const rendererSelect = el('select', { class: 'demo-select', 'aria-label': 'Mark renderer' });
	for (const choice of ['webgl2', 'webgpu', 'canvas2d'] as MarkRenderer[]) {
		rendererSelect.add(new Option(choice, choice));
	}
	rendererSelect.value = chart.options().markRenderer;
	rendererGroup.append(rendererSelect);

	const paletteGroup = el('div', { class: 'demo-group' });
	paletteGroup.append(el('span', { class: 'demo-label' }, 'Heatmap'));
	const paletteSelect = el('select', { class: 'demo-select', 'aria-label': 'Heatmap palette' });
	for (const name of Object.keys(PALETTES)) {
		paletteSelect.add(new Option(name, name));
	}
	paletteSelect.value = 'heat';
	paletteSelect.addEventListener('change', () => heat.applyOptions({ palette: paletteSelect.value }));
	paletteGroup.append(paletteSelect);

	let densityMode = false;
	const densityBtn = el('button', { type: 'button', class: 'demo-btn', 'aria-pressed': 'false' }, 'Density coloring');
	densityBtn.addEventListener('click', () => {
		densityMode = !densityMode;
		densityBtn.setAttribute('aria-pressed', String(densityMode));
		scatter.applyOptions({
			colorBy: densityMode ? 'density' : 'value',
			palette: densityMode ? 'inferno' : 'turbo',
			valueScale: densityMode ? 'log' : 'linear',
		});
	});

	const readout = el('span', { class: 'demo-readout' }, 'Initializing renderer...');
	const updateRendererReadout = () => {
		const status = heat.renderer();
		readout.innerHTML = `Active: <strong>${status.effective}</strong> · Hover for book & trade readout`;
	};
	rendererSelect.addEventListener('change', () => {
		chart.applyOptions({ markRenderer: rendererSelect.value as MarkRenderer });
		void chart.whenIdle().then(updateRendererReadout);
	});
	void chart.whenIdle().then(updateRendererReadout);

	chart.subscribe('crosshairMove', event => {
		if (event.point === null) {
			updateRendererReadout();
			return;
		}
		const time = chart.timeScale().coordinateToTime(event.point.x);
		const price = heat.coordinateToPrice(event.point.y);
		const depth = time !== null && price !== null ? heat.valueAt(time, price) : null;
		const hit = scatter.pointAt(event.point.x, event.point.y);
		const parts: string[] = [];
		if (depth !== null) {
			parts.push(`Book <strong>${depth.toFixed(0)}</strong>`);
		}
		if (hit !== null) {
			const val = hit.value === null ? '' : ` size ${hit.value.toFixed(0)}`;
			parts.push(`Trade <strong>${formatPrice(hit.price)}</strong>${val}`);
		}
		if (parts.length > 0) {
			readout.innerHTML = parts.join(' · ');
		}
	});

	toolbar?.append(rendererGroup, paletteGroup, densityBtn, readout);
}

// ---------------------------------------------------------------- time-zones

function mountTimeZones(ctx: DemoContext): void {
	const { toolbar, stage } = buildShell(ctx);
	const data = generateSessionCandles(4, 606);

	const chart = makeChart(ctx, stage, {
		accessibility: { label: 'US equity intraday sessions with timezone selector' },
		localization: { timeZone: 'America/New_York', locale: 'en-US' },
		sessions: {
			schedule: {
				timeZone: 'America/New_York',
				days: [1, 2, 3, 4, 5],
				hours: [
					{ start: '04:00', end: '09:30', kind: 'pre' },
					{ start: '09:30', end: '16:00' },
					{ start: '16:00', end: '20:00', kind: 'post' },
				],
				holidays: [],
			},
			breaks: { visible: true },
			extendedHours: { visible: true },
		},
	});

	const candles = chart.addSeries('candlestick', { id: 'SPY' });
	candles.setData(data);
	chart.timeScale().setVisibleLogicalRange({ from: data.time.length - 230, to: data.time.length + 4 });

	const tzGroup = el('div', { class: 'demo-group' });
	tzGroup.append(el('span', { class: 'demo-label' }, 'Time zone'));
	const zones: [string, string][] = [
		['America/New_York', 'New York'],
		['UTC', 'UTC'],
		['Europe/London', 'London'],
		['Asia/Seoul', 'Seoul'],
	];
	for (const [tz, label] of zones) {
		const btn = el(
			'button',
			{ type: 'button', class: 'demo-btn', 'aria-pressed': String(tz === 'America/New_York') },
			label,
		);
		btn.addEventListener('click', () => {
			chart.applyOptions({ localization: { timeZone: tz } });
			for (const sibling of tzGroup.querySelectorAll('button')) {
				sibling.setAttribute('aria-pressed', String(sibling === btn));
			}
		});
		tzGroup.append(btn);
	}

	const readout = el('span', { class: 'demo-readout' }, 'Shaded pre/post market · Dashed trading-day breaks');
	chart.subscribe('crosshairMove', event => {
		if (event.time === null) {
			return;
		}
		const session = chart.timeScale().sessionAt(event.time);
		readout.innerHTML =
			session === null
				? formatUtcTime(event.time)
				: `Session: <strong>${session.kind}</strong> · Trading day <strong>${session.tradingDay}</strong>`;
	});

	toolbar?.append(tzGroup, readout);
}

// ---------------------------------------------------------------- events

function mountEvents(ctx: DemoContext): void {
	const { toolbar, stage } = buildShell(ctx, { split: true });
	const topPane = el('div', { class: 'demo-pane demo-pane--top' });
	const bottomPane = el('div', { class: 'demo-pane demo-pane--bottom' });
	stage.append(topPane, bottomPane);

	const data = generateCandles({
		count: 340,
		stepMs: HOUR,
		startTime: Date.UTC(2025, 1, 10),
		startPrice: 92,
		volatility: 0.006,
		seed: 707,
	});

	const priceChart = makeChart(ctx, topPane, {
		accessibility: { label: 'Synchronized price chart' },
		timeScale: { visible: false },
	});
	const volumeChart = makeChart(ctx, bottomPane, {
		accessibility: { label: 'Synchronized volume chart' },
	});

	const candles = priceChart.addSeries('candlestick', { id: 'Price' });
	candles.setData(data);
	const vol = volumeChart.addSeries('histogram', { id: 'Volume', color: '#26a69a', base: 0 });
	vol.setData({ time: data.time, value: data.volume });

	const initial = { from: 190, to: 344 };
	priceChart.timeScale().setVisibleLogicalRange(initial);
	volumeChart.timeScale().setVisibleLogicalRange(initial);

	const readout = el('span', { class: 'demo-readout' }, 'Move pointer or pan/zoom either chart to sync both');
	toolbar?.append(el('span', { class: 'demo-label' }, 'Synced charts'), readout);

	const charts = [priceChart, volumeChart];
	for (const chart of charts) {
		const others = charts.filter(other => other !== chart);
		chart.subscribe('crosshairMove', event => {
			if (event.source === 'api') {
				return;
			}
			for (const other of others) {
				if (event.time === null) {
					other.clearCrosshairPosition();
				} else {
					other.setCrosshairPosition(event.time, null);
				}
			}
			if (event.time !== null) {
				const bar = event.values.get('Price');
				const v = event.values.get('Volume');
				const suffix =
					bar !== undefined && 'close' in bar
						? ` · Close <strong>${formatPrice(bar.close)}</strong>`
						: v !== undefined && 'value' in v
							? ` · Vol <strong>${Math.round(v.value)}</strong>`
							: '';
				readout.innerHTML = `${formatUtcTime(event.time)} UTC${suffix}`;
			}
		});
		chart.timeScale().subscribe('visibleLogicalRangeChange', range => {
			if (range !== null) {
				for (const other of others) {
					other.timeScale().setVisibleLogicalRange(range);
				}
			}
		});
	}
}

// ---------------------------------------------------------------- themes

function mountThemes(ctx: DemoContext): void {
	const { toolbar, stage } = buildShell(ctx);
	const data = generateCandles({
		count: 220,
		stepMs: HOUR,
		startTime: Date.UTC(2025, 2, 10),
		startPrice: 310,
		volatility: 0.0055,
		seed: 808,
	});

	const chart = makeChart(ctx, stage, {
		accessibility: { label: 'Styled candlestick and step line chart' },
		grid: { vertLines: { visible: false }, horzLines: { style: 'dashed' } },
		crosshair: { mode: 'magnet' },
		watermark: { visible: true, text: 'HOLLOW · STEP' },
	});

	const candles = chart.addSeries('candlestick', {
		id: 'Price',
		upColor: 'rgba(0, 0, 0, 0)',
		borderVisible: true,
		priceLineStyle: 'dotted',
	});
	candles.setData(data);

	const avg = new Float64Array(data.close.length);
	let smooth = data.close[0]!;
	for (let i = 0; i < data.close.length; i++) {
		smooth += (data.close[i]! - smooth) * 0.08;
		avg[i] = smooth;
	}
	const stepLine = chart.addSeries('line', {
		id: 'Step average',
		color: '#f5b83d',
		lineType: 'step',
		lineStyle: 'dashed',
		lineWidth: 1.5,
	});
	stepLine.setData({ time: data.time, value: avg });
	chart.timeScale().setVisibleLogicalRange({ from: 110, to: 224 });

	let hollow = true;
	const hollowBtn = el('button', { type: 'button', class: 'demo-btn', 'aria-pressed': 'true' }, 'Hollow candles');
	hollowBtn.addEventListener('click', () => {
		hollow = !hollow;
		hollowBtn.setAttribute('aria-pressed', String(hollow));
		candles.applyOptions({ upColor: hollow ? 'rgba(0, 0, 0, 0)' : '#26a69a', borderVisible: hollow });
	});

	const crossGroup = el('div', { class: 'demo-group' });
	crossGroup.append(el('span', { class: 'demo-label' }, 'Crosshair'));
	for (const mode of ['magnet', 'normal', 'nearest'] as CrosshairMode[]) {
		const btn = el('button', { type: 'button', class: 'demo-btn', 'aria-pressed': String(mode === 'magnet') }, mode);
		btn.addEventListener('click', () => {
			chart.applyOptions({ crosshair: { mode } });
			for (const sibling of crossGroup.querySelectorAll('button')) {
				sibling.setAttribute('aria-pressed', String(sibling === btn));
			}
		});
		crossGroup.append(btn);
	}

	let watermark = true;
	const wmBtn = el('button', { type: 'button', class: 'demo-btn', 'aria-pressed': 'true' }, 'Watermark');
	wmBtn.addEventListener('click', () => {
		watermark = !watermark;
		wmBtn.setAttribute('aria-pressed', String(watermark));
		chart.applyOptions({ watermark: { visible: watermark } });
	});

	toolbar?.append(hollowBtn, crossGroup, wmBtn);
}

// ---------------------------------------------------------------- primitives

class HighlightBand implements PanePrimitive {
	public readonly zOrder = 'bottom' as const;
	private left = 0;
	private right = 0;
	private readonly from: number;
	private readonly to: number;
	private readonly label: string;
	private readonly color: string;

	public constructor(from: number, to: number, label: string, color: string) {
		this.from = from;
		this.to = to;
		this.label = label;
		this.color = color;
	}

	public update(view: PaneView, bounds: PrimitiveBounds): void {
		this.left = view.logicalToX(view.timeToLogical(this.from));
		this.right = view.logicalToX(view.timeToLogical(this.to));
		bounds.left = Math.min(this.left, this.right);
		bounds.right = Math.max(this.left, this.right);
	}

	public draw({ context, pixelRatio, height }: DrawTarget): void {
		const x = this.left * pixelRatio;
		const w = (this.right - this.left) * pixelRatio;
		if (w <= 0) {
			return;
		}
		context.save();
		context.fillStyle = this.color;
		context.fillRect(x, 0, w, height * pixelRatio);
		context.fillStyle = 'rgba(130, 150, 185, 0.9)';
		context.font = `${Math.round(11 * pixelRatio)}px -apple-system, BlinkMacSystemFont, sans-serif`;
		context.fillText(this.label, x + 8 * pixelRatio, 18 * pixelRatio);
		context.restore();
	}
}

function mountPrimitives(ctx: DemoContext): void {
	const { toolbar, stage } = buildShell(ctx);
	const data = generateCandles({
		count: 200,
		stepMs: HOUR,
		startTime: Date.UTC(2025, 3, 1),
		startPrice: 140,
		volatility: 0.0055,
		seed: 909,
	});

	const chart = makeChart(ctx, stage, {
		accessibility: { label: 'Chart with custom pane primitive and custom indicator renderer' },
	});
	const candles = chart.addSeries('candlestick', { id: 'Price' });
	candles.setData(data);

	const band1 = new HighlightBand(data.time[95]!, data.time[128]!, 'Accumulation', 'rgba(41, 98, 255, 0.1)');
	const band2 = new HighlightBand(data.time[148]!, data.time[176]!, 'Breakout window', 'rgba(38, 166, 154, 0.11)');
	chart.attachPrimitive(band1);
	chart.attachPrimitive(band2);

	const sma = candles.addIndicator('sma', { params: { period: 14 } });
	let dottedDots = true;
	const applyCustomRenderer = () => {
		if (dottedDots) {
			sma.output().setRenderer({
				draw({ context, pixelRatio }, items) {
					context.fillStyle = '#f5b83d';
					const r = 2.4 * pixelRatio;
					for (let i = 0; i < items.count; i++) {
						context.beginPath();
						context.arc(items.x[i]!, items.yClose[i]!, r, 0, Math.PI * 2);
						context.fill();
					}
				},
			});
		} else {
			sma.output().setRenderer(null);
		}
	};
	applyCustomRenderer();
	chart.timeScale().setVisibleLogicalRange({ from: 85, to: 202 });

	const renderBtn = el(
		'button',
		{ type: 'button', class: 'demo-btn', 'aria-pressed': 'true' },
		'Custom dot renderer (SMA 14)',
	);
	renderBtn.addEventListener('click', () => {
		dottedDots = !dottedDots;
		renderBtn.setAttribute('aria-pressed', String(dottedDots));
		applyCustomRenderer();
	});

	let bandsAttached = true;
	const bandsBtn = el('button', { type: 'button', class: 'demo-btn', 'aria-pressed': 'true' }, 'Bottom primitives');
	bandsBtn.addEventListener('click', () => {
		bandsAttached = !bandsAttached;
		bandsBtn.setAttribute('aria-pressed', String(bandsAttached));
		if (bandsAttached) {
			chart.attachPrimitive(band1);
			chart.attachPrimitive(band2);
		} else {
			chart.detachPrimitive(band1);
			chart.detachPrimitive(band2);
		}
	});

	toolbar?.append(renderBtn, bandsBtn);
}

// ---------------------------------------------------------------- playground

function mountPlayground(ctx: DemoContext): void {
	const { shell, toolbar, stage } = buildShell(ctx);
	const statePanel = el('pre', { class: 'demo-state-panel', hidden: '' });
	shell.append(statePanel);

	const stepMs = MINUTE;
	const data = generateCandles({
		count: 5000,
		stepMs,
		startTime: Date.UTC(2025, 4, 1),
		startPrice: 100,
		volatility: 0.0024,
		seed: 2026,
	});
	const tailCount = 260;
	const tailSlice = {
		time: data.time.subarray(data.time.length - tailCount),
		open: data.open.subarray(data.open.length - tailCount),
		high: data.high.subarray(data.high.length - tailCount),
		low: data.low.subarray(data.low.length - tailCount),
		close: data.close.subarray(data.close.length - tailCount),
		volume: data.volume.subarray(data.volume.length - tailCount),
	};
	const { book, trades } = generateOrderBookAndTrades(tailSlice, stepMs, 2027);

	const chart = makeChart(ctx, stage, {
		accessibility: { label: 'Lumen Charts interactive playground' },
		watermark: { visible: true, text: 'LUMEN PLAYGROUND' },
		crosshair: { mode: 'nearest' },
		markRenderer: 'webgl2',
		priceScales: {
			oscillator: { paneWeight: 0.34, visible: true },
			volume: { paneWeight: 0.24, visible: true },
		},
	});

	const candles = chart.addSeries('candlestick', { id: 'Price' });
	candles.setData(data);
	const vol = chart.addSeries('histogram', {
		id: 'Volume',
		priceScaleId: 'volume',
		color: 'rgba(38, 166, 154, 0.7)',
	});
	vol.setData({ time: data.time, value: data.volume });

	let bb = candles.addIndicator('bollinger', { id: 'bb', params: { period: 20, multiplier: 2 } });
	let ema = candles.addIndicator('ema', {
		id: 'ema',
		params: { period: 50 },
		outputs: { value: { color: '#f5b83d' } },
	});
	let rsi = candles.addIndicator('rsi', { id: 'rsi', params: { period: 14 }, priceScaleId: 'oscillator' });

	const heat = chart.addSeries('heatmap', {
		id: 'Book',
		palette: 'heat',
		valueScale: 'log',
		opacity: 0.8,
		visible: false,
	});
	heat.setData(book);
	const scatter = chart.addSeries('scatter', {
		id: 'Trades',
		palette: 'turbo',
		shape: 'circle',
		barAlign: 'start',
		visible: false,
	});
	scatter.setData(trades);

	chart.timeScale().setVisibleLogicalRange({ from: data.time.length - 160, to: data.time.length + 4 });

	// Layer toggles.
	let bbOn = true;
	const bbBtn = el('button', { type: 'button', class: 'demo-btn', 'aria-pressed': 'true' }, 'Bollinger');
	bbBtn.addEventListener('click', () => {
		bbOn = !bbOn;
		bbBtn.setAttribute('aria-pressed', String(bbOn));
		if (bbOn) {
			bb = candles.addIndicator('bollinger', { id: 'bb', params: { period: 20, multiplier: 2 } });
		} else {
			bb.remove();
		}
	});

	let emaOn = true;
	const emaBtn = el('button', { type: 'button', class: 'demo-btn', 'aria-pressed': 'true' }, 'EMA 50');
	emaBtn.addEventListener('click', () => {
		emaOn = !emaOn;
		emaBtn.setAttribute('aria-pressed', String(emaOn));
		if (emaOn) {
			ema = candles.addIndicator('ema', {
				id: 'ema',
				params: { period: 50 },
				outputs: { value: { color: '#f5b83d' } },
			});
		} else {
			ema.remove();
		}
	});

	let rsiOn = true;
	const rsiBtn = el('button', { type: 'button', class: 'demo-btn', 'aria-pressed': 'true' }, 'RSI pane');
	rsiBtn.addEventListener('click', () => {
		rsiOn = !rsiOn;
		rsiBtn.setAttribute('aria-pressed', String(rsiOn));
		chart.priceScale('oscillator').applyOptions({ paneWeight: rsiOn ? 0.34 : 0, visible: rsiOn });
		if (rsiOn) {
			rsi = candles.addIndicator('rsi', { id: 'rsi', params: { period: 14 }, priceScaleId: 'oscillator' });
		} else {
			rsi.remove();
		}
	});

	let marksOn = false;
	const marksBtn = el('button', { type: 'button', class: 'demo-btn', 'aria-pressed': 'false' }, 'Book + Trades');
	marksBtn.addEventListener('click', () => {
		marksOn = !marksOn;
		marksBtn.setAttribute('aria-pressed', String(marksOn));
		heat.applyOptions({ visible: marksOn });
		scatter.applyOptions({ visible: marksOn });
	});

	// Scale mode selector.
	const scaleSelect = el('select', { class: 'demo-select', 'aria-label': 'Price scale mode' });
	for (const mode of ['normal', 'logarithmic', 'percentage', 'indexed'] as PriceScaleMode[]) {
		scaleSelect.add(new Option(`Scale: ${mode}`, mode));
	}
	scaleSelect.addEventListener('change', () => {
		chart.priceScale().applyOptions({ mode: scaleSelect.value as PriceScaleMode });
	});

	// Drawing tool selector.
	const drawSelect = el('select', { class: 'demo-select', 'aria-label': 'Drawing tool' });
	drawSelect.add(new Option('Draw: none', ''));
	for (const [type, label] of [
		['trendLine', 'Trend line'],
		['rectangle', 'Rectangle'],
		['fibRetracement', 'Fibonacci'],
		['horizontalLine', 'Horizontal line'],
		['priceRange', 'Price range'],
	] as [DrawingType, string][]) {
		drawSelect.add(new Option(`Draw: ${label}`, type));
	}
	drawSelect.addEventListener('change', () => {
		if (drawSelect.value === '') {
			chart.drawings().cancelTool();
		} else {
			chart.drawings().startTool(drawSelect.value as DrawingType, { color: '#2962ff' });
		}
	});
	chart.drawings().subscribe('created', () => {
		drawSelect.value = '';
	});

	// Save / restore JSON state.
	let savedState: ChartState | null = null;
	const saveBtn = el('button', { type: 'button', class: 'demo-btn' }, 'Save state');
	const restoreBtn = el('button', { type: 'button', class: 'demo-btn', disabled: '' }, 'Restore');
	saveBtn.addEventListener('click', () => {
		savedState = chart.saveState();
		restoreBtn.removeAttribute('disabled');
		statePanel.hidden = false;
		statePanel.textContent = JSON.stringify(savedState, null, 2);
	});
	restoreBtn.addEventListener('click', () => {
		if (savedState !== null) {
			chart.restoreState(savedState);
		}
	});

	const fitBtn = el('button', { type: 'button', class: 'demo-btn' }, 'Fit');
	fitBtn.addEventListener('click', () => chart.timeScale().fitContent());

	toolbar?.append(bbBtn, emaBtn, rsiBtn, marksBtn, scaleSelect, drawSelect, saveBtn, restoreBtn, fitBtn);
}

// ---------------------------------------------------------------- mount

const MOUNTERS: Record<DemoName, (ctx: DemoContext) => void> = {
	hero: mountHero,
	indicators: mountIndicators,
	'price-axes': mountPriceAxes,
	drawings: mountDrawings,
	'heatmap-scatter': mountHeatmapScatter,
	'time-zones': mountTimeZones,
	events: mountEvents,
	themes: mountThemes,
	primitives: mountPrimitives,
	playground: mountPlayground,
};

function readTheme(): ThemeName {
	return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function mountDemo(root: HTMLElement, name: DemoName): () => void {
	const themeListeners: ((theme: ThemeName) => void)[] = [];
	const cleanups: (() => void)[] = [];

	const observer = new MutationObserver(() => {
		const next = readTheme();
		for (const listener of themeListeners) {
			listener(next);
		}
	});
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

	const ctx: DemoContext = {
		root,
		theme: readTheme,
		onThemeChange: listener => themeListeners.push(listener),
		onCleanup: fn => cleanups.push(fn),
	};

	MOUNTERS[name](ctx);

	return () => {
		observer.disconnect();
		for (const cleanup of cleanups) {
			cleanup();
		}
	};
}
