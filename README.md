# Lumen Charts

High-performance financial charting engine for the web.

> Status: stage 4 of the [design](docs/design.md) is complete. Candlestick, line and histogram
> series on an ordinal time scale, with the data engine in a worker, panning, zooming, live updates,
> level of detail, a memory limit backed by a datafeed that also takes corrections, deletions and
> resolution changes, indicators (built-in and custom) computed in the engine, several price axes
> with their scale modes, time zones and sessions, drawings and primitives, and save and restore of
> the chart's state.

## Usage

```ts
import { createChart } from 'lumen-charts';

const chart = createChart(document.getElementById('chart')!);
const candles = chart.addSeries('candlestick');

// Times are UTC milliseconds. Columns are the fastest way to hand over a long history;
// an array of { time, open, high, low, close } objects works too.
candles.setData({ time, open, high, low, close });
chart.timeScale().fitContent();

// A tick updates the bar with the same time, or starts a new bar.
candles.update({ time: Date.now(), open: 101, high: 102, low: 100.5, close: 101.4 });
```

History lives in the data engine, which runs in a worker. The main thread keeps only the bars
around the visible range, so data is applied asynchronously: `await chart.whenIdle()` resolves once
everything handed over so far is on screen. If the page blocks workers, the engine runs on the main
thread in slices of a few milliseconds, behind the same interface. Pass `worker: false` to force
that, or `worker: () => new Worker(...)` when a bundler needs the worker created in application
code (the worker entry is `@lumen-charts/engine/worker`).

### Several charts on one page

```ts
import { createChart, setMaxWorkers } from 'lumen-charts';

setMaxWorkers(2); // optional, before the charts are created
const charts = cells.map(cell => createChart(cell));
```

Charts share what the browser gives them instead of each taking its own:

- **Workers.** The first charts get a worker each, up to a limit: 4, or one less than the number of
  processor cores where that is smaller. Every further chart joins the worker with the fewest
  charts. Each chart keeps a data engine of its own inside its worker, the charts of a worker take
  turns in slices of a few milliseconds, and a worker stops when its last chart is destroyed.
  `setMaxWorkers(n)` changes the limit for charts created afterwards (`1` puts every chart on one
  thread, `Infinity` gives every chart its own); `getMaxWorkers()` reads it. Charts given the same
  `worker` function share the workers it makes, and it is called once per worker: define the
  function once and pass it to every chart. A chart given a function of its own keeps a worker of
  its own.
- **Frames.** One animation frame draws every chart that changed. All charts read from the layout
  before any of them writes to the DOM, and an error in one chart does not stop the others.
- **Size.** One `ResizeObserver` sizes the auto-sized charts. A chart fills the content box of its
  container, so padding and borders on the container are fine. Creating a chart or changing its
  options does not read the layout: the size is read once, in the first frame or when it is first
  needed.
- **Viewport.** A chart scrolled out of view keeps applying data but is not drawn until it comes
  back into view. `whenIdle()` does not wait for that.

The numbers are in [docs/benchmarks/shared-resources.md](docs/benchmarks/shared-resources.md).

Wide views draw from levels of detail: the engine keeps buckets of 16, 64, 256, ... bars (first
open, highest high, lowest low, last close; the largest volume), and above 16 bars per device pixel
the chart draws the coarsest level whose buckets fit a pixel column. Frame time stops growing with
the number of bars in view, and the main thread holds buckets instead of bars for wide views.

### History on demand: datafeed and memory limit

```ts
const chart = createChart(element, { memoryLimit: 64 * 1024 * 1024 });
const candles = chart.addSeries('candlestick', {
	datafeed: {
		// Bars with times in [from, to] (UTC ms, inclusive): `countBack` of them, oldest first, in
		// any format setData accepts. `signal` is aborted once the bars are no longer needed.
		getBars: ({ from, to, signal }) => fetchBars(symbol, '1m', from, to, { signal }),
	},
});
candles.setData(history);
```

With a datafeed, the engine may let go of bars far from the view once it holds more than
`memoryLimit` bytes, and asks the datafeed for them when the view comes back. The levels of detail
stay in memory, so zoomed-out views keep drawing and the finest level is shown while bars are on
their way; bars fetched again are usually drawn in the frame after the view changed. A chunk of
8,192 bars let go keeps only a summary (its first and last time and checksums), against which the
bars that come back are checked: bars that differ in number or time are refused with a console
warning. Values may differ: a bar corrected at the source while it was let go comes back corrected.
A request whose bars the view no longer needs is aborted through `signal`; one that failed is tried
again after a pause that grows from 1 s to 30 s. The same bars are never requested twice at once.

The datafeed contract covers changes of history too:

```ts
// A correction of any existing bar, also one let go: it applies once that bar is back.
candles.update({ time: someOldTime, open, high, low, close });
// Bars removed at the source. At either end the other bars keep their indexes; in the middle the
// bars on the shorter side move over.
candles.removeBars({ from: firstRemovedTime, to: lastRemovedTime });
// Another resolution (or symbol), with a datafeed for it: requests for the old bars are aborted.
candles.setData(fiveMinuteHistory, { datafeed: fiveMinuteFeed });
```

The limit applies to every series with a datafeed; a series without one is never let go. While
other series are drawn on the main series' timeline it keeps the time of every bar, which merging
them takes. The limit is a target: the bars around the view, the first and last chunk of each series
and the levels always stay. The design (section 8) explains the choices.

Indicator outputs are never let go and count toward the limit. An indicator recomputed over bars
that were let go (after a prepend, a parameter change, a correction or a deletion) fetches them
again from the datafeed, a window at a time. A correction recomputes the indicators that read the
series: in place with the tick when the bar is recent, in the background otherwise. A deletion
recomputes them in the background. Their old values stay on screen meanwhile, except after a
deletion in the middle of the main series, whose bars then have other indexes.

### Indicators

```ts
const candles = chart.addSeries('candlestick');
candles.setData({ time, open, high, low, close, volume });

const fast = candles.addIndicator('ema', { params: { period: 12 } });
const bands = candles.addIndicator('bollinger', {
	params: { period: 20, multiplier: 2 },
	outputs: { middle: { color: '#ffa726', lineStyle: 'dashed' } },
});
const strength = candles.addIndicator('rsi');
// Chains: an indicator of another indicator's output.
const smoothed = strength.output().addIndicator('sma', { params: { period: 9 } });

fast.applyOptions({ params: { period: 21 } }); // recomputed in the background
bands.output('upper').applyOptions({ color: '#42a5f5' }); // style only
strength.output().lastValue(); // for a legend, NaN until computed
smoothed.remove();
```

Indicators run in the data engine: computed in the background after a load, a parameter change or
a prepend (after a prepend only as far as the new history changes them), and incrementally on every
tick, whose message carries the bar and the latest value of every indicator together. Their outputs are series on the main timeline, with levels of
detail like any other, drawn on the price pane as lines (MACD's histogram as a histogram) and
included in autoscale. While an indicator is being recomputed its old values stay on screen;
`chart.whenIdle()` resolves once the new ones are drawn.

Built-in: `sma`, `ema`, `wma`, `rsi`, `macd` (outputs `macd`, `signal`, `histogram`), `bollinger`
(`upper`, `middle`, `lower`), `atr`, `stochastic` (`k`, `d`), `vwap` (restarting every UTC day by
default; `anchor` in milliseconds, 0 for never), `highest` and `lowest`. An input reads a column of
the source by default (`close`, or `high`, `low`, `close` for ATR and Stochastic); pass
`inputs: ['high']`, `inputs: [{ series: other, column: 'close' }]` or `inputs: [someIndicator.output()]`
to read something else. Missing bars and the warm-up read as gaps (NaN). Values are deterministic:
incremental updates give the same bits as a full computation.

A histogram series is also available for your own data, for example volume:
`chart.addSeries('histogram', { color: '#26a69a', negativeColor: '#ef5350', base: 0 })`.

### Price axes

```ts
const chart = createChart(element, {
	// The default scale (id `default`), on which series go unless they name another.
	priceScale: { mode: 'logarithmic' },
	// Further scales by id. Without `visible: true` a scale is an overlay, with no axis of its own.
	priceScales: {
		compare: { visible: true, position: 'left', mode: 'percentage' },
		volume: { scaleMargins: { top: 0.8, bottom: 0 } },
	},
});
const candles = chart.addSeries('candlestick', { minMove: 0.25 }); // tick size of the prices
const other = chart.addSeries('line', { priceScaleId: 'compare' });
chart.addSeries('histogram', { priceScaleId: 'volume', color: '#26a69a80' });
candles.addIndicator('rsi', { priceScaleId: 'oscillator' }); // an overlay of its own

other.applyOptions({ priceScaleId: 'default' }); // a series can change scales at any time
chart.priceScale('compare').applyOptions({ invertScale: true });
const y = candles.priceToCoordinate(101.25); // CSS pixels from the top of the pane, or null
```

Each scale has a mode: `normal`, `logarithmic` (equal ratios take equal room; prices at or below
zero are left out), `percentage` or `indexed` (the change from each series' price at the first
visible bar, in percent or as an index starting at 100, so series of different prices compare).
A scale autoscales to all of its visible series in view, between its `scaleMargins`, and can be
inverted. Dragging an axis scales it and turns its `autoScale` off; a double click on the axis turns
it back on, and while it is off, dragging the pane up or down moves the scale.

Axes go on their side from the pane outward: the default scale first, then the others in the order
`priceScales` lists them. The crosshair shows its price on every visible axis, and each series' last
value is labelled on the axis of its scale (an overlay's on the default axis). `minMove`, the tick
size of a series, rounds its labels and gives them its decimals (`precision` overrides them); the axis
of a scale puts its ticks on multiples of the tick size of its first series. Without a tick size,
labels have as many decimals as the step between ticks needs.

`chart.priceScale(id)` (by default the default scale) and `series.priceScale()` return a handle with
the scale's options, the width of its axis, its visible range (`getVisibleRange`, and
`setVisibleRange`, which turns autoscale off) and price to coordinate conversions. Indicators take
`priceScaleId` for all their outputs, or per output in `outputs`. Every option is documented in
`PriceScaleOptions` and `SeriesOptionsCommon`; the design (section 8.1) explains the choices.

### Custom indicators

A plugin is an ES module of indicator definitions. Its kernel runs inside the data engine, in the
worker or on the main thread when the page blocks workers, so the module is loaded by URL:

```ts
// my-indicators.js: a standalone module (no bare imports), served by the application
export default [
	{
		name: 'momentum',
		inputs: ['close'],
		outputs: [{ name: 'value', style: 'histogram', color: '#26a69a' }],
		params: [{ name: 'period', default: 10, min: 1, integer: true }],
		windowed: true, // values depend only on the last `lookback + 1` rows
		stateSize: () => 0,
		lookback: params => params[0],
		warmup: params => params[0],
		// Rows [offset, offset + length) of a column-major buffer (inputs, then outputs); the `carry`
		// input rows before `offset` hold the rows before the slice.
		kernel(buffer, offset, length, state, carry, params) {
			const stride = buffer.length / 2;
			for (let r = offset; r < offset + length; r++) {
				buffer[stride + r] = buffer[r] - buffer[r - params[0]];
			}
		},
	},
];
```

```ts
await chart.registerIndicators(new URL('./my-indicators.js', import.meta.url));
candles.addIndicator('momentum', { params: { period: 14 } });
```

The contract (`IndicatorKernel`, `IndicatorDefinition`) is documented in the types. A cumulative
kernel (the default) keeps its running values in `state`, which is zeros on a fresh start; a
`windowed` one must rebuild its state from the carry rows after a reset, which lets the engine
recompute only the rows near a prepend. The page's content security policy must allow the module
(`script-src`, and `blob:` for a module made from a Blob). Bundlers must leave it as a separate file
with a stable URL, for example in `public/`; the engine's `import()` is marked to be ignored by
Vite and webpack. To draw an output other than as a line or histogram, give it a custom renderer
(see Primitives below).

### Drawings

```ts
const drawings = chart.drawings();

// Let the user draw: clicks (or press, drag and release) place the points.
drawings.startTool('trendLine', { color: '#f5b83d', lineWidth: 2 });

// Or add them in code. Points are times (UTC ms) and prices.
const zone = drawings.add({
	type: 'rectangle',
	points: [
		{ time: t1, price: 101.5 },
		{ time: t2, price: 99.2 },
	],
	options: { fillColor: 'rgba(38, 166, 154, 0.15)', locked: true },
});
zone.applyOptions({ text: 'Supply' });
zone.bringToFront();

drawings.subscribe('changed', drawing => save(drawing.toJSON()));
drawings.subscribe('selected', drawing => showToolbar(drawing));

// Plain JSON, with a version; `add` takes it back, in this chart or another.
const saved = JSON.stringify(drawings.toJSON());
for (const state of JSON.parse(saved)) {
	otherChart.drawings().add(state);
}
```

A drawing is on a price scale, the default one unless `add` names another (`priceScaleId`), and
stays at its prices in any mode: straight on screen between its points on a logarithmic scale, and
mapped with the scale's base on a percentage or indexed one, as the crosshair reads prices there.

Tools: `trendLine`, `ray`, `extendedLine`, `horizontalLine`, `verticalLine`, `rectangle`,
`parallelChannel` (three points: the third sets the width), `fibRetracement` (`levels` option),
`text` and `priceRange` (change, percentage and bars). Every drawing takes `color`, `lineWidth`,
`lineStyle`, `fillColor`, `text`, `textColor`, `fontSize`, `visible` and `locked`, and has a
`zIndex`.

With the pointer: hovering a drawing shows its handles, pressing selects it, dragging moves it by
whole bars, and dragging a handle moves that point. A locked drawing can be selected but not moved;
pressing it pans. Escape cancels a drawing being created or dragged, or clears the selection;
Delete and Backspace remove the selected drawing (the chart takes keys once clicked). With the
crosshair in `magnet` mode, points snap to the open, high, low or close of their bar. Touch reaches
lines from further away than a mouse. Events: `created` (also for `add`), `changed` (API changes,
and once at the end of a drag), `removed`, `selected` and `hovered`.

Points are stored as times, not bar indexes, so a drawing stays where it was through prepends,
bars removed and a new resolution: a time between two bars sits between them, a time past the last
bar sits in the future at the spacing of the last bars (and stays there while bars arrive at that
spacing). The chart holds only the bars around the view, so a point far from it is looked up in
the data engine; such a drawing appears a frame later.

Drawings have a canvas of their own between the series and the crosshair. Hovering redraws only the
crosshair's layer, and a drawing being dragged moves to that layer, so the others are not redrawn
while it moves. Hit testing first filters by the time span of each drawing and then scans; with
1,000 drawings a hover takes about 0.3 ms of JavaScript (see
[docs/benchmarks/stage-4-drawings.md](docs/benchmarks/stage-4-drawings.md)). Mobile browsers cap the
memory of all canvases on a page, so near a budget (`setCanvasBudget(pixels)`, 48M device pixels by
default) a chart draws its drawings into the series layer instead of a layer of its own.

### Primitives and custom renderers

The built-in drawings are pane primitives; your own code can draw the same way.

```ts
import {
	type DrawTarget,
	HIT_BODY,
	HIT_NONE,
	type PanePrimitive,
	type PaneView,
	type PrimitiveBounds,
	type SeriesItems,
} from 'lumen-charts';

class SessionBox implements PanePrimitive {
	readonly zOrder = 'bottom'; // under the series; 'normal' (default) with the drawings; 'top' over all
	private left = 0;
	private right = 0;

	constructor(
		private from: number,
		private to: number,
	) {}

	// Called when the view or the primitive changed (`host.requestUpdate()`), not every frame.
	update(view: PaneView, bounds: PrimitiveBounds) {
		this.left = view.logicalToX(view.timeToLogical(this.from));
		this.right = view.logicalToX(view.timeToLogical(this.to));
		bounds.left = this.left;
		bounds.right = this.right;
	}

	draw({ context, pixelRatio, height }: DrawTarget) {
		context.fillStyle = 'rgba(41, 98, 255, 0.06)';
		context.fillRect(this.left * pixelRatio, 0, (this.right - this.left) * pixelRatio, height * pixelRatio);
	}

	hitTest(x: number, y: number, tolerance: number) {
		return x >= this.left - tolerance && x <= this.right + tolerance ? HIT_BODY : HIT_NONE;
	}
}

chart.attachPrimitive(new SessionBox(open, close)); // or series.attachPrimitive(...)

// Draw a series or an indicator output with your own code instead of its built-in style.
rsi.output().setRenderer({
	draw({ context }: DrawTarget, items: SeriesItems) {
		for (let i = 0; i < items.count; i++) {
			context.fillRect(items.x[i] - 1, items.yClose[i] - 1, 2, 2);
		}
	},
});
```

A primitive gets the chart's conversions (`logicalToX`, `timeToLogical`, `priceToY`, ...) through
the `PaneView` it is drawn with, declares its layer, and may answer hit tests, which highlight it on
hover (`drawHighlight`). The chart calls `update` only when the view or the primitive changed, and
draws a layer only when something in it changed, so `update` and `draw` should not allocate.

### Save and restore

```ts
// Everything that was configured, as plain JSON with a version: options, series, indicators,
// drawings and the view. No bars.
localStorage.setItem('layout', JSON.stringify(chart.saveState()));

// Later, in a new chart: restore, then hand each series its bars.
const chart = createChart(container);
chart.restoreState(JSON.parse(localStorage.getItem('layout')!));
for (const series of chart.series()) {
	series.setData(await loadBars(series.id));
}
```

```json
{
	"version": 1,
	"options": { "theme": "dark", "priceScales": { "rsi": { "visible": true, "position": "left" } } },
	"series": [
		{
			"id": "AAPL",
			"type": "candlestick",
			"options": { "priceScaleId": "default", "upColor": "#26a69a" },
			"pane": 0,
			"order": 0
		}
	],
	"indicators": [
		{
			"id": "rsi-14",
			"name": "rsi",
			"source": { "series": "AAPL" },
			"params": { "period": 14 },
			"inputs": ["close"],
			"outputs": { "value": { "color": "#7e57c2", "priceScaleId": "rsi" } },
			"priceScaleId": "rsi",
			"order": 1
		}
	],
	"drawings": [
		{ "version": 1, "id": "d-1", "type": "horizontalLine", "points": [{ "time": 1767225600000, "price": 187.5 }] }
	],
	"view": {
		"timeRange": { "from": 1767139200000, "to": 1767312000000 },
		"priceRanges": { "rsi": { "from": 0, "to": 100 } }
	}
}
```

(Shortened: a saved state lists every option of a series, an output and a drawing.)

Series and indicators are found again by `id`: pass one when adding them
(`chart.addSeries('candlestick', { id: 'AAPL' })`, `series.addIndicator('rsi', { id: 'rsi-14' })`)
or take the one the chart gives (`series-1`, `indicator-1`, ... in the order they are added).
`chart.series()` and `chart.indicators()` list them.

`restoreState` makes the chart what the state says:

- **Options** replace those applied before. The state holds the options that were applied, not the
  defaults under them, so a theme stays a theme.
- **Series** the chart already has (same `id` and type) keep their bars and take the state's
  options, so restoring into a chart that is already loaded fetches nothing. A series the chart
  lacks is added without bars, and one the state lacks is removed.
- **Indicators** are computed again from the bars; the ones the chart already has, in the same
  order, are kept and take the state's options.
- **Drawings** are replaced, with a `removed` and a `created` event each. Code that saves on those
  events should not do so during a restore.
- **The view** is saved as the times at the edges of the pane, not bar indexes, so it comes back to
  the same times with more history loaded or at another resolution. With no bars yet it waits for
  them; a view set afterwards (`fitContent`, ...) wins. Price scales that do not autoscale get their
  range back.

What cannot be saved stays as it is on the chart that restores: the size (`width`, `height`,
`autoSize`), `worker`, `memoryLimit` and the formatter functions of `localization`; the datafeed,
custom renderer and primitives of a series it keeps. A series added by the restore has none of
those: set them as for any new series (`series.setData(bars, { datafeed })`, `setRenderer`).
Custom indicators are saved by name, so register their module (`chart.registerIndicators(url)`)
before restoring; a state that names an indicator the chart does not know is refused.

A state comes from storage or the network, so all of it is checked before anything changes: another
`version` (exported as `CHART_STATE_VERSION`), a value of the wrong kind, a duplicate id or an
indicator that reads a series that would not be there throws an error that names the place
(`series[0].options.visible must be a boolean`), and the chart stays as it was. Keys the library
does not know are ignored.

Both calls take the sections to work on (`options`, `series`, `indicators`, `drawings`, `view`), and
a state need not have all of them; what is left out is not touched:

```ts
const drawings = chart.saveState({ parts: ['drawings'] });
otherChart.restoreState(drawings); // only the drawings change
chart.restoreState(layout, { parts: ['options', 'series', 'indicators', 'drawings'] }); // keep the view
```

A restore is applied in one frame however much it holds. With 1,000 drawings and 5 indicators on 1M
candles, `saveState` takes 0.07 ms and `restoreState` about 3 ms of JavaScript, its frame included
(see [docs/benchmarks/stage-4-save-restore.md](docs/benchmarks/stage-4-save-restore.md)).

### Themes and display options

```ts
const chart = createChart(element, {
	theme: 'auto', // 'light' (default), 'dark', or follow the system setting
	grid: { vertLines: { visible: false }, horzLines: { style: 'dashed' } },
	crosshair: { mode: 'magnet' }, // or 'normal', 'hidden'
	priceScale: { position: 'left', scaleMargins: { top: 0.1, bottom: 0.2 } },
	watermark: { visible: true, text: 'BTCUSD · 1m' },
});

// Nested options merge: this changes one color and keeps everything else.
chart.applyOptions({ layout: { textColor: '#8a93a6' } });

const candles = chart.addSeries('candlestick', {
	upColor: 'rgba(0, 0, 0, 0)', // hollow up candles
	borderVisible: true,
	priceLineStyle: 'dotted',
});
const average = chart.addSeries('line', { color: '#f5b83d', lineType: 'step', lineStyle: 'dashed' });
```

A theme sets only colors. Colors you set yourself take precedence and survive a theme change, so
`applyOptions({ theme: 'dark' })` flips the chart while keeping, say, a custom grid color. The
presets are exported as `themes` for building your own. Every option and its default is documented
in `ChartOptions`, `PriceScaleOptions`, `CandlestickOptions`, `LineOptions` and `HistogramOptions`.

### Time zones and sessions

```ts
const chart = createChart(element, {
	// An IANA name, `UTC` (default) or `local`; change it at any time with applyOptions.
	localization: { timeZone: 'America/New_York', locale: 'en-US' },
	sessions: {
		// When the market trades: plain JSON, saved and restored with the options.
		schedule: {
			timeZone: 'America/New_York', // the exchange's; empty takes the chart's
			days: [1, 2, 3, 4, 5],
			hours: [
				{ start: '04:00', end: '09:30', kind: 'pre' },
				{ start: '09:30', end: '16:00' },
				{ start: '16:00', end: '20:00', kind: 'post' },
			],
			holidays: ['2024-12-25'],
		},
		breaks: { visible: true }, // a line at the first bar of each trading day
	},
});

chart.timeScale().isInSession(bar.time); // extended hours included
chart.timeScale().sessionAt(bar.time); // { index: 1, kind: 'regular', tradingDay: '2024-06-03' } or null
```

Bar times stay UTC milliseconds, and the data engine never sees a time zone: only what is shown
changes. The time axis follows the wall clock of the zone. Day, month and year labels fall on its
midnights through daylight saving changes, hourly labels stay on the hour (half-hour and 45-minute
offsets included), and on a fine grid the hour repeated when the clocks go back is labeled again.
The crosshair's time label shows the same wall-clock time. Daily and longer bars (at least 20 hours
apart) are dates and keep their UTC date in every zone, as TradingView's datafeed convention stamps
daily bars at 00:00 UTC.

Converting a time is a lookup in a table of the zone's offset changes, not an `Intl` call. The table
is built when a zone is first shown, for the bars around the view, and grows as the view moves: `Intl`
is asked for the offset every two days and the change between two answers that differ is found to
the second. Tables are shared by the charts of a page. The first switch to a zone costs about a
millisecond for two years of bars, and the first zone of a page about 10 ms more, once, while `Intl`
loads its time zone data; later switches cost what any change of options costs (numbers in
[docs/benchmarks/stage-4-time-zones.md](docs/benchmarks/stage-4-time-zones.md)). Frames make no
`Intl` call.

A trading day is named by the date its sessions end, so a session from 18:00 to 17:00 (CME Globex)
belongs to the next day. With a schedule, days on the time axis are trading days, every session
start is a candidate for a label and the open of regular hours wins over the hours around it, and
extended hours are shaded (`sessions.extendedHours`). Breaks and shading are drawn while a day is at
least 6 CSS pixels wide. Without hours there is no schedule: the market never closes,
`isInSession` is always true and breaks, if turned on, mark calendar days. An unknown time zone or
locale, or a malformed schedule, throws a `RangeError` and changes nothing.

`localization.locale` takes month names, dates and the clock from a locale (each distinct label is
formatted once); `tickMarkFormatter(time, kind, wall)` and `timeFormatter(time, wall)` replace the
built-in labels, where `wall` is the wall-clock time to read with `getUTC*`.

## Packages

| Package                | Purpose                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `@lumen-charts/core`   | Framework-free chart: scales, series views, canvas renderer |
| `@lumen-charts/engine` | Data engine: column store, indicators, worker host, client  |
| `@lumen-charts/react`  | `LumenChart` component                                      |
| `@lumen-charts/vue`    | `LumenChart` component                                      |
| `@lumen-charts/svelte` | `lumenChart` action                                         |
| `@lumen-charts/solid`  | `LumenChart` component (client-side)                        |
| `lumen-charts`         | Re-exports `@lumen-charts/core`                             |

Bindings stay thin: they create the chart on mount, forward option changes to
`applyOptions`, and destroy it on unmount. Data goes through the chart API, never through props.

## Development

Requires Node 20+ and pnpm.

```sh
pnpm install
pnpm dev          # vanilla example with live reload
pnpm test         # unit tests (run against sources, no build needed)
pnpm typecheck    # tsrs (Rust port of the TypeScript 7 checker)
pnpm lint         # Oxlint
pnpm format       # Oxfmt; pnpm format:check only reports
pnpm build        # emit dist/ for every package with tsc
```

Versioning uses Changesets: run `pnpm changeset` in a pull request that changes a package.
All packages are released together under one version. Releases go to npm from CI with trusted
publishing and provenance after a maintainer approves them; [docs/releasing.md](docs/releasing.md)
describes the flow and the one-time setup.

## Benchmarks

`benchmarks/` is a browser harness that measures chart libraries through one adapter interface
(`benchmarks/src/adapter.ts`). It measures Lightweight Charts 5.3.0 with conflation on and off
(`lwc-conflation-on`, `lwc-conflation-off`) and lumen from the workspace sources with the data
engine in a worker or on the main thread (`lumen-worker`, `lumen-main`). The stage 0 baseline and
the definition of every metric are in [docs/benchmarks/stage-0-baseline.md](docs/benchmarks/stage-0-baseline.md);
stage 1 results against it are in [docs/benchmarks/stage-1.md](docs/benchmarks/stage-1.md), the
stage 2 scenarios with the stage 1 numbers on them in [docs/benchmarks/stage-2-before.md](docs/benchmarks/stage-2-before.md),
and stage 2 (level of detail, memory limit) against them in [docs/benchmarks/stage-2.md](docs/benchmarks/stage-2.md).
The `refetch` scenario runs series with a datafeed under a memory limit, times how long the chart
takes to show history it let go and what corrections, deletions and a change of resolution cost, and
measures the memory floor; [docs/benchmarks/stage-2-follow-ups.md](docs/benchmarks/stage-2-follow-ups.md)
has the results. The `multi` scenario puts several auto-sized charts on one
page, some of them below the fold, and measures workers, memory, the time until all are shown and
the cost of a round of ticks; its results are in
[docs/benchmarks/shared-resources.md](docs/benchmarks/shared-resources.md). The stage 3 scenarios
(`ind-load`, `ind-apply`, `ind-frames`, `ind-prepend`) put 20 indicators on the candles; results are
in [docs/benchmarks/stage-3.md](docs/benchmarks/stage-3.md). The `axes-frames` scenario pans and
zooms candles with three moving averages on one axis, on a logarithmic or a percentage scale, and on
four axes; it and the frame cases of earlier stages against `main` are in
[docs/benchmarks/stage-4-price-axes.md](docs/benchmarks/stage-4-price-axes.md). The `drawings`
scenario hovers, drags and pans over 1,000 drawings on 1M candles (the stage 4 hover gate); results
are in [docs/benchmarks/stage-4-drawings.md](docs/benchmarks/stage-4-drawings.md). The scenarios
`tz-frames` (pan and zoom in New York time with the sessions of an equity exchange) and `tz-change`
(switching time zones at run time) are in
[docs/benchmarks/stage-4-time-zones.md](docs/benchmarks/stage-4-time-zones.md). The `state`
scenario saves and restores a chart with 5 indicators and 1,000 drawings; results are in
[docs/benchmarks/stage-4-save-restore.md](docs/benchmarks/stage-4-save-restore.md).

Runs are headless by default (Chromium's new headless mode, rasterizing on the GPU), so no window
takes the focus; `--headed` opens a window. Stage 0 and stage 1 were measured headed. Frame
JavaScript time and tick cost, the metrics of the gates, match between the two modes, but headless
frame intervals stay at the refresh interval (p95 16.67 ms) and do not show rasterization or
presentation stalls: compare intervals only between headed runs.

```sh
pnpm bench:install                      # once: download Playwright's Chromium (CI never needs it)
pnpm bench --quick                      # smoke test, about a minute
pnpm bench                              # full matrix, headless Chromium, JSON in benchmarks/results/
pnpm bench --scenario tick --size 1m --lib lwc-conflation-off --repeats 3
pnpm bench --case frames/line-10m,prepend --lib lumen-worker,lumen-main --repeats 3
pnpm bench --scenario multi --lib lumen-worker --max-workers 1,4,default
pnpm bench --packages ../other-checkout/packages --lib lumen-worker   # measure another checkout
pnpm bench --help                       # all options (headed, Chrome channel, viewport, DPR, ...)
pnpm bench:report <results.json>        # Markdown tables from a results file
pnpm bench:merge <out.json> <a.json> <b.json>   # join runs of the same cases into one file
pnpm bench:serve                        # production build of the harness page, to run by hand
```

## Layout

```
packages/     libraries published to npm
examples/     runnable examples (not published)
benchmarks/   benchmark harness (not published)
docs/         design documents and benchmark results
```

## License

[MIT](LICENSE). Each published package carries a copy of the license.
