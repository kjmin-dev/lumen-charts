import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	CHART_STATE_VERSION,
	type ChartApi,
	type ChartState,
	DRAWING_STATE_VERSION,
	type Datafeed,
	type DrawingInput,
	type SeriesRenderer,
} from '@lumen-charts/core';
import { afterEach, describe, expect, it } from 'vitest';
import { MINUTE, TestChart, candles } from './drawing-helpers';

const charts: TestChart[] = [];
const tickMarkFormatter = () => 'tick';
const timeFormatter = () => 'time';

function testChart(options: ConstructorParameters<typeof TestChart>[0] = {}): TestChart {
	const t = new TestChart(options);
	charts.push(t);
	return t;
}

afterEach(() => {
	for (const t of charts.splice(0)) {
		t.destroy();
	}
});

/** What a state looks like after a trip through storage. */
function stored<T>(state: T): T {
	return JSON.parse(JSON.stringify(state)) as T;
}

function closes(count: number, start = 0, step = MINUTE) {
	const time = new Float64Array(count);
	const value = new Float64Array(count);
	for (let i = 0; i < count; i++) {
		time[i] = start + i * step;
		value[i] = 50 + Math.cos(i / 40) * 5;
	}
	return { time, value };
}

const DRAWINGS: DrawingInput[] = [
	{
		type: 'trendLine',
		id: 'trend',
		points: [
			{ time: 920 * MINUTE, price: 95 },
			{ time: 980 * MINUTE, price: 105 },
		],
		options: { color: '#ff0000', lineWidth: 3 },
	},
	{
		type: 'fibRetracement',
		id: 'fib',
		points: [
			{ time: 930.5 * MINUTE, price: 92 },
			{ time: 1100 * MINUTE, price: 108 },
		],
		options: { levels: [0, 0.5, 1] },
		zIndex: 4,
	},
	{
		type: 'text',
		id: 'note',
		points: [{ time: 950 * MINUTE, price: 55 }],
		options: { text: 'a\nb' },
		priceScaleId: 'cmp',
	},
];

/** A chart with everything a state holds set to something other than its default. */
function configure(t: TestChart): void {
	const chart = t.chart;
	chart.applyOptions({
		theme: 'dark',
		layout: { fontSize: 13 },
		grid: { vertLines: { visible: false } },
		crosshair: { mode: 'magnet' },
		watermark: { visible: true, text: 'LUMEN\n1m' },
		priceScale: { mode: 'logarithmic', scaleMargins: { top: 0.2, bottom: 0.05 } },
		priceScales: { rsi: { visible: true, position: 'left' }, cmp: { scaleMargins: { top: 0.7, bottom: 0 } } },
		timeScale: { barSpacing: 9 },
		localization: { timeZone: 'America/New_York', locale: 'en-US' },
		sessions: {
			schedule: {
				timeZone: 'America/New_York',
				hours: [
					{ start: '04:00', end: '09:30', kind: 'pre' },
					{ start: '09:30', end: '16:00' },
				],
				holidays: ['1970-01-01'],
			},
			breaks: { visible: true },
		},
	});
	const main = chart.addSeries('candlestick', { id: 'main', upColor: '#00ff00', minMove: 0.25 });
	main.setData(candles(1000));
	const average = main.addIndicator('sma', {
		id: 'average',
		params: { period: 10 },
		outputs: { value: { color: '#123456' } },
	});
	const compare = chart.addSeries('line', { id: 'cmp', priceScaleId: 'cmp', lineStyle: 'dashed' });
	compare.setData(closes(1000));
	chart.addSeries('histogram', { id: 'volume', priceScaleId: 'volume', base: 1 }).setData(closes(1000));
	main.addIndicator('rsi', { id: 'strength', priceScaleId: 'rsi', inputs: [{ series: compare, column: 'value' }] });
	average.output().addIndicator('ema', { id: 'smooth', params: { period: 5 } });
	main.addIndicator('macd', { id: 'macd', priceScaleId: 'macd', inputs: [average.output()] });
	for (const drawing of DRAWINGS) {
		chart.drawings().add(drawing);
	}
	chart.timeScale().setVisibleLogicalRange({ from: 900.3, to: 990.75 });
	chart.priceScale('rsi').setVisibleRange({ from: 20, to: 80 });
}

async function configured(): Promise<{ t: TestChart; state: ChartState }> {
	const t = testChart();
	configure(t);
	await t.settle();
	return { t, state: t.chart.saveState() };
}

function seriesById(chart: ChartApi, id: string) {
	const series = chart.series().find(entry => entry.id === id);
	if (series === undefined) {
		throw new Error(`No series ${id}`);
	}
	return series;
}

function load(chart: ChartApi): void {
	seriesById(chart, 'main').setData(candles(1000));
	seriesById(chart, 'cmp').setData(closes(1000));
	seriesById(chart, 'volume').setData(closes(1000));
}

describe('chart state', () => {
	it('saves what was configured as plain JSON, without bars or functions', async () => {
		const { state } = await configured();
		expect(state.version).toBe(CHART_STATE_VERSION);
		expect(stored(state)).toEqual(state);
		expect(state.options).toMatchObject({
			theme: 'dark',
			priceScale: { mode: 'logarithmic' },
			priceScales: { rsi: { visible: true, position: 'left', autoScale: false } },
			localization: { timeZone: 'America/New_York', locale: 'en-US' },
			sessions: {
				schedule: {
					hours: [
						{ start: '04:00', end: '09:30', kind: 'pre' },
						{ start: '09:30', end: '16:00' },
					],
				},
			},
		});
		// The colors of the theme are not options that were applied, and the size belongs to the page.
		expect(state.options?.layout).toEqual({ fontSize: 13 });
		expect(Object.keys(state.options!)).not.toContain('width');
		expect(Object.keys(state.options!)).not.toContain('worker');
		expect(state.series!.map(series => [series.id, series.type, series.options.priceScaleId, series.order])).toEqual([
			['main', 'candlestick', 'default', 0],
			['cmp', 'line', 'cmp', 2],
			['volume', 'histogram', 'volume', 3],
		]);
		expect(state.series![0]!.options).toMatchObject({ upColor: '#00ff00', minMove: 0.25, visible: true });
		expect(state.indicators!.map(indicator => [indicator.id, indicator.name, indicator.order])).toEqual([
			['average', 'sma', 1],
			['strength', 'rsi', 4],
			['smooth', 'ema', 5],
			['macd', 'macd', 6],
		]);
		expect(state.indicators![0]).toMatchObject({
			source: { series: 'main' },
			params: { period: 10 },
			inputs: ['close'],
		});
		expect(state.indicators![0]!.outputs['value']).toMatchObject({ color: '#123456', priceScaleId: 'default' });
		expect(state.indicators![1]).toMatchObject({ priceScaleId: 'rsi', inputs: [{ series: 'cmp', column: 'value' }] });
		expect(state.indicators![2]!.source).toEqual({ indicator: 'average', output: 'value' });
		expect(state.indicators![3]!.inputs).toEqual([{ indicator: 'average', output: 'value' }]);
		expect(state.drawings!.map(drawing => [drawing.id, drawing.version, drawing.priceScaleId])).toEqual([
			['trend', DRAWING_STATE_VERSION, 'default'],
			['note', DRAWING_STATE_VERSION, 'cmp'],
			['fib', DRAWING_STATE_VERSION, 'default'],
		]);
		expect(state.view!.priceRanges).toEqual({ rsi: { from: 20, to: 80 } });
		// Bar 900.3 is 30% of the way from bar 900 to bar 901; the right edge is between bars too.
		expect(state.view!.timeRange).toEqual({ from: 900.3 * MINUTE, to: 990.75 * MINUTE });
	});

	it('gives the same state after a restore into a new chart that gets its bars afterwards', async () => {
		const { state } = await configured();
		const t = testChart();
		t.chart.restoreState(stored(state));
		// Before there are bars the state is that of the chart already.
		expect(t.chart.saveState()).toEqual(state);
		load(t.chart);
		await t.settle();
		expect(t.chart.saveState()).toEqual(state);
		expect(t.chart.timeScale().getVisibleLogicalRange()!.from).toBeCloseTo(900.3, 6);
		expect(t.chart.timeScale().getVisibleLogicalRange()!.to).toBeCloseTo(990.75, 6);
		expect(t.chart.options().layout.background).toBe('#0e1116');
		expect(t.chart.indicators().map(indicator => indicator.id)).toEqual(['average', 'strength', 'smooth', 'macd']);
		expect(t.chart.indicators()[0]!.output().lastValue()).toBeGreaterThan(0);
	});

	it('keeps the series, bars and indicators a chart has when it restores a state that names them', async () => {
		const { state } = await configured();
		const t = testChart();
		configure(t);
		t.chart.applyOptions({ theme: 'light', watermark: { text: 'other' }, grid: { horzLines: { visible: false } } });
		t.chart.timeScale().fitContent();
		t.chart.drawings().clear();
		t.chart.indicators()[1]!.applyOptions({ params: { period: 30 } });
		seriesById(t.chart, 'cmp').applyOptions({ color: '#000000' });
		await t.settle();
		const series = t.chart.series();
		const indicators = t.chart.indicators();
		t.chart.restoreState(stored(state));
		expect(t.chart.series()).toEqual(series);
		expect(t.chart.indicators()).toEqual(indicators);
		expect(t.chart.indicators()[1]!.options().params).toEqual({ period: 14 });
		// Options the state does not set are back at their defaults, not left as they were.
		expect(t.chart.options().grid.horzLines.visible).toBe(true);
		await t.settle();
		expect(t.chart.saveState()).toEqual(state);
		expect(indicators[0]!.output().lastValue()).toBeGreaterThan(0);
	});

	it('removes series the state lacks and replaces indicators from the first one that differs', async () => {
		const { t, state } = await configured();
		const kept = t.chart.indicators()[0]!;
		const changed = stored(state);
		changed.series = changed.series!.filter(series => series.id !== 'volume');
		changed.series.push({ ...changed.series[1]!, id: 'extra', order: 9 });
		changed.indicators![2]!.name = 'wma';
		t.chart.restoreState(changed);
		await t.settle();
		expect(t.chart.series().map(series => series.id)).toEqual(['main', 'cmp', 'extra']);
		expect(t.chart.indicators().map(indicator => [indicator.id, indicator.name])).toEqual([
			['average', 'sma'],
			['strength', 'rsi'],
			['smooth', 'wma'],
			['macd', 'macd'],
		]);
		expect(t.chart.indicators()[0]).toBe(kept);
		expect(t.chart.saveState().series!.map(series => series.order)).toEqual([0, 2, 6]);
	});

	it('restores the drawing order of series and indicators', async () => {
		const { state } = await configured();
		const reordered = stored(state);
		// The comparison line below everything, the first average on top.
		reordered.series![1]!.order = -1;
		reordered.indicators![0]!.order = 10;
		const t = testChart();
		t.chart.restoreState(reordered);
		const saved = t.chart.saveState();
		expect(saved.series!.map(series => [series.id, series.order])).toEqual([
			['cmp', 0],
			['main', 1],
			['volume', 2],
		]);
		expect(saved.indicators!.map(indicator => [indicator.id, indicator.order])).toEqual([
			['average', 6],
			['strength', 3],
			['smooth', 4],
			['macd', 5],
		]);
	});

	describe('view', () => {
		it('lands on the same times with another history loaded', async () => {
			const { state } = await configured();
			const t = testChart();
			// 3,000 bars that start 500 minutes later: bar 900 of the saved chart is bar 400 here.
			t.chart.addSeries('candlestick', { id: 'main' }).setData(candles(3000, 500));
			await t.settle();
			t.chart.restoreState(stored(state), { parts: ['view'] });
			await t.settle();
			const range = t.chart.timeScale().getVisibleLogicalRange()!;
			expect(range.from).toBeCloseTo(400.3, 6);
			expect(range.to).toBeCloseTo(490.75, 6);
			expect(t.chart.saveState().view!.timeRange).toEqual(state.view!.timeRange);
		});

		it('lands on the same times at another resolution', async () => {
			const { state } = await configured();
			const t = testChart();
			const five = closes(600, 0, 5 * MINUTE);
			t.chart.addSeries('line', { id: 'main' }).setData(five);
			t.chart.restoreState(stored(state), { parts: ['view'] });
			await t.settle();
			const range = t.chart.timeScale().getVisibleLogicalRange()!;
			expect(range.from).toBeCloseTo(900.3 / 5, 6);
			expect(range.to).toBeCloseTo(990.75 / 5, 6);
		});

		it('saves and restores a view past the last bar and one of every bar', async () => {
			const t = testChart();
			t.chart.addSeries('candlestick', { id: 'main' }).setData(candles(5000));
			t.chart.timeScale().setVisibleLogicalRange({ from: 4950, to: 5020 });
			await t.settle();
			const future = t.chart.saveState({ parts: ['view'] });
			// Past the last bar, times go on at the spacing of the last bars.
			expect(future.view!.timeRange).toEqual({ from: 4950 * MINUTE, to: 5020 * MINUTE });
			t.chart.timeScale().fitContent();
			await t.settle();
			const all = t.chart.saveState({ parts: ['view'] });
			expect(all.view!.timeRange!.from).toBeCloseTo(-0.5 * MINUTE, -3);
			expect(all.view!.timeRange!.to).toBeCloseTo(4999.5 * MINUTE, -3);

			t.chart.restoreState(future);
			await t.settle();
			expect(t.chart.timeScale().getVisibleLogicalRange()!.from).toBeCloseTo(4950, 6);
			expect(t.chart.timeScale().getVisibleLogicalRange()!.to).toBeCloseTo(5020, 6);
			expect(t.chart.saveState({ parts: ['view'] })).toEqual(future);
			t.chart.restoreState(all);
			await t.settle();
			expect(t.chart.timeScale().getVisibleLogicalRange()!.from).toBeCloseTo(-0.5, 1);
			expect(t.chart.timeScale().getVisibleLogicalRange()!.to).toBeCloseTo(4999.5, 1);
		});

		it('gives way to a view set after the restore', async () => {
			const { state } = await configured();
			const t = testChart();
			t.chart.restoreState(stored(state));
			load(t.chart);
			t.chart.timeScale().fitContent();
			await t.settle();
			const range = t.chart.timeScale().getVisibleLogicalRange()!;
			expect(range.from).toBeCloseTo(-0.5, 6);
			expect(range.to).toBeCloseTo(999.5, 6);
		});

		it('has no time range without bars and leaves the view alone when restoring that', async () => {
			const empty = testChart();
			const state = empty.chart.saveState();
			expect(state.view).toEqual({ timeRange: null, priceRanges: {} });
			empty.runFrames();
			const { t } = await configured();
			const before = t.chart.timeScale().getVisibleLogicalRange();
			t.chart.restoreState(state, { parts: ['view'] });
			await t.settle();
			expect(t.chart.timeScale().getVisibleLogicalRange()).toEqual(before);
		});
	});

	describe('a state that is wrong', () => {
		const wrong: [string, (state: ChartState) => unknown, RegExp][] = [
			['is not an object', () => 'state', /must be an object/],
			['is null', () => null, /must be an object/],
			['has no version', state => ({ ...state, version: undefined }), /version undefined is not supported/],
			['is of a later version', state => ({ ...state, version: 2 }), /version 2 is not supported.*reads version 1/],
			['has options of the wrong kind', state => ({ ...state, options: [] }), /options must be an object/],
			[
				'has a number where a string goes',
				state => ({ ...state, options: { layout: { background: 7 } } }),
				/options\.layout\.background must be a string/,
			],
			[
				'has a number that is not finite',
				state => ({ ...state, options: { layout: { fontSize: null } } }),
				/options\.layout\.fontSize must be a finite number/,
			],
			[
				'has an unknown choice',
				state => ({ ...state, options: { priceScales: { rsi: { mode: 'cubic' } } } }),
				/options\.priceScales\.rsi\.mode must be one of normal, logarithmic/,
			],
			[
				'has an unknown crosshair mode',
				state => ({ ...state, options: { crosshair: { mode: 'logarithmic' } } }),
				/options\.crosshair\.mode must be one of normal, magnet, hidden/,
			],
			[
				'has an unknown time zone',
				state => ({ ...state, options: { localization: { timeZone: 'Mars/Olympus' } } }),
				/unknown time zone/,
			],
			[
				'has a malformed schedule',
				state => ({ ...state, options: { sessions: { schedule: { hours: [{ start: '09:30' }] } } } }),
				/options\.sessions\.schedule\.hours must be an array of sessions/,
			],
			[
				'has sessions that overlap',
				state => ({
					...state,
					options: {
						sessions: {
							schedule: {
								hours: [
									{ start: '09:00', end: '12:00' },
									{ start: '11:00', end: '13:00' },
								],
							},
						},
					},
				}),
				/starts before session/,
			],
			['has series that are not a list', state => ({ ...state, series: {} }), /series must be an array/],
			[
				'has a series of an unknown type',
				state => ({ ...state, series: [{ ...state.series![0]!, type: 'area' }] }),
				/series\[0\]\.type must be one of candlestick, line, histogram/,
			],
			[
				'has two series with one id',
				state => ({ ...state, series: [state.series![0]!, state.series![0]!] }),
				/series\[1\]\.id "main" is used twice/,
			],
			[
				'has a series option of the wrong kind',
				state => ({ ...state, series: [{ ...state.series![0]!, options: { visible: 'yes' } }] }),
				/series\[0\]\.options\.visible must be a boolean/,
			],
			[
				'has a series on another pane',
				state => ({ ...state, series: [{ ...state.series![0]!, pane: 1 }] }),
				/series\[0\]\.pane must be 0/,
			],
			[
				'has an indicator the chart does not know',
				state => ({ ...state, indicators: [{ ...state.indicators![0]!, name: 'my-custom' }] }),
				/indicators\[0\]\.name "my-custom" is not an indicator the chart knows: register/,
			],
			[
				'has an indicator on a series that is not there',
				state => ({ ...state, series: state.series!.slice(1) }),
				/indicators\[0\]\.source reads series "main", which the chart would not have/,
			],
			[
				'has an indicator that reads a later one',
				state => ({ ...state, indicators: [state.indicators![2]!, state.indicators![0]!] }),
				/indicators\[0\]\.source reads indicator "average", which is not listed before it/,
			],
			[
				'has an indicator that reads an output that is not there',
				state => ({
					...state,
					indicators: [
						state.indicators![0]!,
						{ ...state.indicators![2]!, source: { indicator: 'average', output: 'x' } },
					],
				}),
				/reads output "x", which indicator "average" does not have/,
			],
			[
				'has an indicator parameter out of bounds',
				state => ({ ...state, indicators: [{ ...state.indicators![0]!, params: { period: -3 } }] }),
				/Invalid value -3 for parameter "period"/,
			],
			[
				'has an indicator input that names no column',
				state => ({ ...state, indicators: [{ ...state.indicators![0]!, inputs: ['median'] }] }),
				/indicators\[0\]\.inputs\[0\] must be one of time, open/,
			],
			[
				'has a drawing of a later version',
				state => ({ ...state, drawings: [{ ...state.drawings![0]!, version: 2 }] }),
				/drawings\[0\]\.version 2 is not supported/,
			],
			[
				'has a drawing with a point missing',
				state => ({ ...state, drawings: [{ ...state.drawings![0]!, points: [{ time: 1, price: 2 }] }] }),
				/drawings\[0\] is not a drawing: a trendLine drawing takes 2 points/,
			],
			[
				'has a drawing with a time that is not a number',
				state => ({
					...state,
					drawings: [
						state.drawings![1]!,
						{
							...state.drawings![0]!,
							points: [
								{ time: '1', price: 2 },
								{ time: 1, price: 2 },
							],
						},
					],
				}),
				/drawings\[1\] is not a drawing: drawing points need a finite time and price/,
			],
			[
				'has a drawing of an unknown type',
				state => ({ ...state, drawings: [{ ...state.drawings![0]!, type: 'constructor' }] }),
				/drawings\[0\]\.type "constructor" is not a drawing type/,
			],
			[
				'has a drawing option of the wrong kind',
				state => ({ ...state, drawings: [{ ...state.drawings![0]!, options: { levels: [0, 'half'] } }] }),
				/drawings\[0\]\.options\.levels must be an array of finite numbers/,
			],
			[
				'has two drawings with one id',
				state => ({ ...state, drawings: [state.drawings![0]!, state.drawings![0]!] }),
				/drawings\[1\]\.id "trend" is used twice/,
			],
			[
				'has a time range that is backwards',
				state => ({ ...state, view: { timeRange: { from: 5, to: 5 }, priceRanges: {} } }),
				/view\.timeRange must have its from below its to/,
			],
			[
				'has a price range without numbers',
				state => ({ ...state, view: { timeRange: null, priceRanges: { rsi: { from: 'a', to: 3 } } } }),
				/view\.priceRanges\.rsi must have a finite from and to/,
			],
		];

		it.each(wrong)('throws when it %s, and leaves the chart as it was', async (_name, change, message) => {
			const { state } = await configured();
			const t = testChart();
			t.chart.addSeries('line', { id: 'own', color: '#111111' }).setData(closes(200));
			t.chart.applyOptions({ theme: 'light', watermark: { text: 'mine' } });
			const drawing = t.chart.drawings().add({ type: 'horizontalLine', id: 'own', points: [{ time: 0, price: 50 }] });
			await t.settle();
			const before = t.chart.saveState();
			const events: string[] = [];
			t.chart.drawings().subscribe('removed', () => events.push('removed'));
			t.chart.drawings().subscribe('created', () => events.push('created'));
			const frames = t.frames.length;
			expect(() => t.chart.restoreState(change(stored(state)) as ChartState)).toThrow(message);
			expect(t.chart.saveState()).toEqual(before);
			expect(t.chart.drawings().list()).toEqual([drawing]);
			expect(events).toEqual([]);
			expect(t.frames.length).toBe(frames);
		});

		it('refuses a part that is no part of a state', async () => {
			const { t, state } = await configured();
			expect(() => t.chart.restoreState(state, { parts: ['drawing' as 'drawings'] })).toThrow(
				/"drawing" is not a part/,
			);
		});

		it('ignores keys it does not know', async () => {
			const { state } = await configured();
			const extended = stored(state) as ChartState & Record<string, unknown>;
			extended['layoutName'] = 'mine';
			(extended.options as Record<string, unknown>)['futureOption'] = { a: 1 };
			(extended.series![0]!.options as unknown as Record<string, unknown>)['glow'] = true;
			(extended.drawings![0]!.options as unknown as Record<string, unknown>)['shadow'] = 3;
			const t = testChart();
			t.chart.restoreState(extended);
			expect(t.chart.saveState()).toEqual(state);
		});

		it('fills in what a state written by hand leaves out', () => {
			const t = testChart();
			t.chart.restoreState({
				version: 1,
				series: [{ id: 'a', type: 'line' }],
				indicators: [{ id: 'i', name: 'sma', source: { series: 'a' } }],
				drawings: [{ id: 'd', type: 'horizontalLine', points: [{ time: 0, price: 1 }] }],
			} as unknown as ChartState);
			const state = t.chart.saveState();
			expect(state.series![0]).toMatchObject({
				id: 'a',
				options: { color: '#2962ff', priceScaleId: 'default' },
				order: 0,
			});
			expect(state.indicators![0]).toMatchObject({ params: { period: 20 }, inputs: ['close'], order: 1 });
			expect(state.drawings![0]).toMatchObject({ zIndex: 0, priceScaleId: 'default', options: { lineWidth: 2 } });
		});
	});

	describe('what cannot be saved', () => {
		it('keeps formatters, the size and the engine options of the chart it restores into', async () => {
			const { state } = await configured();
			const t = testChart({
				memoryLimit: 1e9,
				localization: { tickMarkFormatter, timeFormatter, timeZone: 'Asia/Seoul' },
			});
			t.chart.restoreState(stored(state));
			const options = t.chart.options();
			expect(options.localization).toEqual({
				timeZone: 'America/New_York',
				locale: 'en-US',
				tickMarkFormatter,
				timeFormatter,
			});
			expect(options).toMatchObject({ width: 640, height: 400, autoSize: false, worker: false, memoryLimit: 1e9 });
			const saved = t.chart.saveState();
			expect(saved.options!.localization).toEqual({ timeZone: 'America/New_York', locale: 'en-US' });
			expect(saved).toEqual(state);
		});

		it('keeps the datafeed, renderer and primitives of a series it keeps', async () => {
			const t = testChart();
			const datafeed: Datafeed<'candlestick'> = { getBars: () => Promise.resolve([]) };
			const renderer: SeriesRenderer = { draw: () => {} };
			const primitive = { draw: () => {} };
			const series = t.chart.addSeries('candlestick', { id: 'main', datafeed });
			series.setData(candles(300));
			series.setRenderer(renderer);
			series.attachPrimitive(primitive);
			await t.settle();
			const state = stored(t.chart.saveState());
			expect(JSON.stringify(state)).not.toMatch(/datafeed|renderer|primitive/);
			state.series![0]!.options.visible = false;
			t.chart.restoreState(state);
			const internal = series as unknown as { datafeed: unknown; renderer: unknown; primitives: Set<unknown> };
			expect(t.chart.series()).toEqual([series]);
			expect(series.options().visible).toBe(false);
			expect(internal.datafeed).toBe(datafeed);
			expect(internal.renderer).toBe(renderer);
			expect([...internal.primitives]).toEqual([primitive]);
		});

		it('restores a custom indicator by name once its module is registered', async () => {
			const t = testChart();
			const module = pathToFileURL(resolvePath('packages/engine/test/fixtures/plugin.ts'));
			await t.chart.registerIndicators(module);
			const series = t.chart.addSeries('candlestick', { id: 'main' });
			series.setData(candles(300));
			series.addIndicator('test-momentum', { id: 'momentum', params: { period: 5 } });
			await t.settle();
			const state = stored(t.chart.saveState());
			expect(state.indicators![0]).toMatchObject({ name: 'test-momentum', params: { period: 5 } });

			const other = testChart();
			other.chart.addSeries('candlestick', { id: 'main' }).setData(candles(300));
			expect(() => other.chart.restoreState(state)).toThrow(/"test-momentum" is not an indicator the chart knows/);
			expect(other.chart.indicators()).toEqual([]);
			await other.chart.registerIndicators(module);
			other.chart.restoreState(state);
			await other.settle();
			expect(other.chart.indicators()[0]!.output().type).toBe('histogram');
			expect(other.chart.indicators()[0]!.output().lastValue()).toBeCloseTo(
				t.chart.indicators()[0]!.output().lastValue(),
				10,
			);
		});
	});

	describe('parts', () => {
		it('saves only the parts asked for', async () => {
			const { t, state } = await configured();
			expect(t.chart.saveState({ parts: ['drawings'] })).toEqual({ version: 1, drawings: state.drawings });
			expect(t.chart.saveState({ parts: ['options', 'view'] })).toEqual({
				version: 1,
				options: state.options,
				view: state.view,
			});
		});

		it('restores only the drawings, from a whole state or from one with nothing else', async () => {
			const { state } = await configured();
			for (const given of [state, { version: 1, drawings: state.drawings } as ChartState]) {
				const t = testChart();
				t.chart.addSeries('line', { id: 'own' }).setData(closes(1200));
				t.chart.applyOptions({ watermark: { text: 'mine' } });
				// oxlint-disable-next-line no-await-in-loop
				await t.settle();
				const before = t.chart.saveState();
				t.chart.restoreState(stored(given), given === state ? { parts: ['drawings'] } : undefined);
				// oxlint-disable-next-line no-await-in-loop
				await t.settle();
				expect(t.chart.saveState()).toEqual({ ...before, drawings: state.drawings });
			}
		});

		it('restores everything but the view', async () => {
			const { state } = await configured();
			const t = testChart();
			t.chart.restoreState(stored(state), { parts: ['options', 'series', 'indicators', 'drawings'] });
			load(t.chart);
			await t.settle();
			const saved = t.chart.saveState();
			expect({ ...saved, view: state.view }).toEqual(state);
			// The view a chart starts with: the last bar at the right edge, at the saved bar spacing.
			const range = t.chart.timeScale().getVisibleLogicalRange()!;
			expect(range.to).toBeCloseTo(999.5, 6);
			expect(t.chart.priceScale('rsi').options().autoScale).toBe(false);
		});

		it('restores indicators onto the series the chart has', async () => {
			const { state } = await configured();
			const t = testChart();
			t.chart.addSeries('candlestick', { id: 'main' }).setData(candles(500));
			const partial = stored(state);
			expect(() => t.chart.restoreState(partial, { parts: ['indicators'] })).toThrow(/reads series "cmp"/);
			partial.indicators = partial.indicators!.filter(indicator => indicator.id !== 'strength');
			t.chart.restoreState(partial, { parts: ['indicators'] });
			await t.settle();
			expect(t.chart.indicators().map(indicator => indicator.id)).toEqual(['average', 'smooth', 'macd']);
			expect(t.chart.series().map(series => series.id)).toEqual(['main']);
		});
	});

	describe('cost', () => {
		it('restores 1,000 drawings, series and indicators in one frame', async () => {
			const { state } = await configured();
			const many = stored(state);
			many.drawings = [];
			for (let i = 0; i < 1000; i++) {
				many.drawings.push({ ...state.drawings![0]!, id: `d-${i}`, zIndex: i });
			}
			const t = testChart();
			t.chart.addSeries('candlestick', { id: 'main' }).setData(candles(1000));
			await t.settle();
			const created: string[] = [];
			t.chart.drawings().subscribe('created', drawing => created.push(drawing.id));
			expect(t.frames.length).toBe(0);
			t.chart.restoreState(many);
			// One frame is asked for however much changed, and it draws the drawings once.
			expect(t.frames.length).toBe(1);
			expect(created.length).toBe(1000);
			t.clearCalls();
			t.runFrames();
			expect(t.frames.length).toBeLessThanOrEqual(1);
			expect(t.chart.drawings().list().length).toBe(1000);
			// The drawings layer sits right below the overlay.
			const layer = t.calls(t.canvases().at(-2));
			expect(layer.filter(call => call.name === 'clearRect').length).toBe(1);
			expect(layer.filter(call => call.name === 'stroke').length).toBeGreaterThan(0);
			await t.settle();
			expect(t.chart.saveState().drawings!.length).toBe(1000);
		});

		it('restores the state a chart is in with one frame and without computing an indicator again', async () => {
			const { t, state } = await configured();
			const engine = (t.chart as unknown as { _engine: { updateIndicator: (...args: unknown[]) => void } })._engine;
			let updates = 0;
			const update = engine.updateIndicator.bind(engine);
			engine.updateIndicator = (...args) => {
				updates++;
				update(...args);
			};
			t.chart.restoreState(stored(state));
			expect(t.frames.length).toBe(1);
			t.runFrames();
			// Nothing was asked of the engine, so no answer brings another frame.
			await new Promise(resolve => setTimeout(resolve, 0));
			expect(t.frames.length).toBe(0);
			expect(updates).toBe(0);
			t.chart.indicators()[0]!.applyOptions({ params: { period: 11 } });
			expect(updates).toBe(1);
		});

		it('saves without asking for a frame', async () => {
			const { t } = await configured();
			expect(t.frames.length).toBe(0);
			t.clearCalls();
			t.chart.saveState();
			expect(t.frames.length).toBe(0);
			expect(t.canvases().reduce((count, canvas) => count + t.calls(canvas).length, 0)).toBe(0);
		});
	});

	describe('ids', () => {
		it('names series and indicators that are given no id, and refuses one that is taken', () => {
			const t = testChart();
			const a = t.chart.addSeries('line');
			const b = t.chart.addSeries('line', { id: 'series-3' });
			const c = t.chart.addSeries('line');
			const d = t.chart.addSeries('line');
			expect([a.id, b.id, c.id, d.id]).toEqual(['series-1', 'series-3', 'series-2', 'series-4']);
			expect(() => t.chart.addSeries('line', { id: 'series-1' })).toThrow(/a series with id "series-1" exists already/);
			expect(t.chart.series()).toEqual([a, b, c, d]);
			const first = a.addIndicator('sma');
			const second = a.addIndicator('ema', { id: 'fast' });
			expect([first.id, second.id, first.options().id]).toEqual(['indicator-1', 'fast', 'indicator-1']);
			expect(() => a.addIndicator('sma', { id: 'fast' })).toThrow(/an indicator with id "fast" exists already/);
			second.applyOptions({ id: 'renamed' });
			expect(second.id).toBe('fast');
			expect(t.chart.indicators()).toEqual([first, second]);
			t.chart.removeSeries(a);
			expect(t.chart.series()).toEqual([b, c, d]);
			expect(t.chart.indicators()).toEqual([]);
		});
	});
});
