# Heatmap and scatter series

```ts
const candles = chart.addSeries('candlestick'); // the timeline: heatmaps and scatters are placed on its bars
candles.setData(bars);

// Trades: points at any time and price, many per bar, colored by size.
const trades = chart.addSeries('scatter', { pointSize: 3, palette: 'turbo', barAlign: 'start' });
trades.setData({ time, price, value: size }); // columns, or [{ time, price, value? }, ...]
trades.update({ time: Date.now(), price: 101.4, value: 250 }); // at or after the last point
trades.append({ time: moreTimes, price: morePrices }); // a batch, in one message

// An order book: one column of resting size per snapshot, on a grid of prices.
const book = chart.addSeries('heatmap', { palette: 'heat', valueScale: 'log' });
book.setData({
	priceStart: 95, // lower edge of the lowest cell
	priceStep: 0.05, // height of a cell
	rows: 200, // cells per column
	time: snapshotTimes, // one per column, strictly increasing
	values, // rows values per column, one column after the other; NaN: no value
});
book.update({ time: snapshotTime, values: sizes }); // replaces the last column at its time, or adds one
book.valueAt(time, price); // the value drawn there; at the crosshair, see docs/guide/events.md

// A size per point, the point under the pointer, and points colored by how many cover a pixel.
trades.setData({ time, price, value: side, size: notional }); // CSS pixels; NaN: the series' pointSize
trades.pointAt(x, y); // the point drawn at a position of the pane; at the crosshair, see docs/guide/events.md
const flow = chart.addSeries('scatter', { colorBy: 'density', palette: 'inferno', valueScale: 'log' });

// Older history, and marks removed at the source.
trades.prepend(olderTrades); // at or before the first point's time
book.prepend(olderColumns); // before the first column, on the series' grid
trades.removeMarks({ from: badFrom, to: badTo }); // times in [from, to], inclusive

chart.markSeries(); // [trades, book]: these two kinds are listed apart from `chart.series()`
chart.removeSeries(book);
```

Both are series of the chart: they have an `id` and options, sit on a price scale
(`priceScaleId`), are saved with `saveState` and restored with `restoreState` (without their data,
like every series), and their data lives in the data engine, in the worker when there is one. They
differ from candles and lines in what they hold, which is not one value per bar:

- **A scatter** holds points in time order; several may share a time. A point is a square or a
  disc (`shape`) of its own `size` in CSS pixels, or of the series' `pointSize` without one, drawn
  whole device pixels wide (at least 1 and at most 256; a disc below 3 device pixels is a square). It
  takes the palette's color for its `value`, or `color` without one; with `colorBy: 'density'` a
  pixel takes the palette's color for the number of points that cover it instead. It is drawn above
  the other series and below drawings, a later point over an earlier one.
- **A heatmap** holds columns of `rows` cells on one grid of prices. A column covers the time from
  its own to the next column's (the last one, as long as the one before it), so one column per bar
  fills the bars, and several per bar divide them. A series containing just one column spans one logical bar. Its end time is exclusive for `valueAt`. It is drawn below the other series. The grid is
  set by `setData`; `update`, `append` and `prepend` add columns on it.

**A grid that follows the price.** A book over a long history moves: give each column its own lower
edge, and each keeps only the `rows` cells around its price instead of the whole range at 4 bytes a
cell. Lower edges must lie a whole number of `priceStep` apart (a `RangeError` says when one does
not); the first column's starts the grid. Rows a column has no cell on are transparent in it, the
autoscale takes the rows the columns in view span, and a level of detail merges columns into one that
spans the rows of all of them.

```ts
book.setData({ priceStart: lowerEdges, priceStep: 0.05, rows: 200, time, values }); // one edge per column
book.update({ time, values: sizes, priceStart: lowerEdge }); // a column on rows of its own
```

**Time.** Marks are placed on the timeline of the bars by their time, so the chart needs a series
with bars, or a mark series that makes them (see [a chart without bars](#a-chart-without-bars)). A point at a bar's time is at the middle of the bar and later
times lie toward the middle of the next bar (`barAlign: 'center'`, like the point of a line), or it
is at the bar's left edge, so the points of a bar's period spread over the width of that bar
(`barAlign: 'start'`, for trades inside their candle). Heatmap columns always start at the left
edge of the bar their time falls on.

**Colors.** `palette` is the name of a built-in palette (`viridis`, `inferno`, `turbo`, `greys`,
`heat`, `blue-red`) or an array of colors from the lowest value to the highest. The lowest and
highest are those the series has held since its last `setData`, so colors do not shift while the
view moves; `valueMin` and `valueMax` fix them instead, and `valueScale: 'log'` spreads the palette
over the logarithm of the values. Colors are written `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`,
`rgba()` or `transparent` (the chart writes the pixels itself, so CSS color names are not read),
and may be translucent, as the first colors of `heat` are; `opacity` applies to the whole series.
Options the chart cannot draw throw a `RangeError` before anything changes.

**Density.** With `colorBy: 'density'` the color of a device pixel shows how many points cover it:
every point whose mark covers the pixel counts, at its own size and shape, and a mark of a coarse
level of detail counts the points it holds, so the picture keeps its weight as the view zooms through
the levels. The palette spans from 1 to the largest number in the frame, unless `valueMin` and
`valueMax` fix it, and `valueScale: 'log'` spreads it over the logarithm; pixels without a point stay
transparent, and `value` and `color` play no part. An appended point adds to the densities and hands
over its own pixels; one that raises the largest number of the frame colors the whole picture again,
unless `valueMax` is set. Counts are summed in 32-bit floats, exact up to 16,777,216 points on one
pixel.

**Autoscale.** A scatter's points in view take part in the autoscale of its price scale, like the
values of a line. A heatmap's grid does not by default, so the book follows the candles instead of
squeezing them; `autoscale` changes either. A series alone on its scale is fitted whatever the
option says.

**Many marks.** The engine sends a window around the view to the selected renderer. Each renderer uses the same levels of detail.

- A scatter with more points than pixels across is drawn from a level of detail, in which the
  points of one pixel column that share a price bin are one mark with the largest value of them. The
  engine picks the level, and sends the points themselves once the view is narrow enough. A mark of a
  cell is as wide as the widest of its points, and counts them all.
- A heatmap with more columns than pixels is drawn from a level that merges four columns at a
  time, each cell the largest of its members; more rows than pixels are merged while drawing, again
  to the largest. A peak survives zooming out.
- A tick draws what it changed: a point added to a scatter writes that point (one wider than any
  point held draws the picture again, since it reaches further beyond the view), a replaced or added
  heatmap column writes from that column to the right edge.

What to expect, on a 2,400 × 1,200 pixel pane (M1): see
[the measurements](../benchmarks/stage-5-heatmap-scatter.md). `series.drawn()` tells the level of
detail and the number of marks the last frame drew from.

## Marks let go under the memory limit

```ts
const chart = createChart(element, { memoryLimit: 64 * 1024 * 1024 });
const trades = chart.addSeries('scatter', {
	// The marks with times in [from, to] (UTC ms, inclusive), in any form setData takes.
	datafeed: { getMarks: ({ from, to, signal }) => fetchTrades(symbol, from, to, { signal }) },
});
trades.setData(history);
trades.setData(otherSymbol, { datafeed: otherFeed }); // another datafeed for other marks; null: none
```

With a datafeed, the engine may let go of chunks of a series' marks far from the view once it holds
more than `memoryLimit` bytes, after the bars a datafeed serves: 65,536 points of a scatter, or the
cells of the columns of 256 KB of a heatmap. The levels of detail stay, so a wide view keeps drawing,
and a view that needs marks let go is drawn from the finest level meanwhile while they are fetched,
usually by the next frames. A scatter keeps the first and last time of each chunk, how many of its
points share those times, and a checksum; a heatmap keeps the time and rows of every column and a
checksum of the cells. `getMarks` returns the marks of the times asked for, which may include points
of the chunks beside at the first and last time: the engine takes those of the chunk and refuses,
with a console warning, marks that differ in number or in any value. Marks are not corrected after
the fact, so the levels made from them stay right; to change history, `setData` it. A request the
view no longer needs is aborted through `signal`; a failed or refused one is tried again after a
pause that grows from 1 s to 30 s. A removal that reads or moves marks let go waits for them, and
changes after it wait behind it. `removeMarks` stands for marks removed at the source: once it is
applied, the datafeed must not return those marks again, or the chunks around them are refused when
they come back. `chart.whenIdle()` waits for these requests.

## A chart without bars

```ts
const book = chart.addSeries('heatmap', { timeline: true }); // a bar per column
const trades = chart.addSeries('scatter', { timeline: { interval: 60_000 } }); // a bar per minute with trades
```

With `timeline`, the series' marks make the bars of the time axis: one bar per heatmap column (or per
`interval` milliseconds that hold columns), one per `interval` that holds points of a scatter (a
minute by default). The engine keeps a hidden line series in step with the marks: appends add bars,
prepends add bars before, and a removal removes the bars of the buckets that lost every mark. It is
listed nowhere, saved with no state, and goes with the series. Like a datafeed, `timeline` is not an
option and is not saved; where the chart also has a series of bars, the series that got data first
gives the timeline.

## Indicators over marks

```ts
const count = candles.addIndicator('sma', {
	params: { period: 20 },
	inputs: [{ series: trades, column: 'count' }], // trades per bar, averaged over 20 bars
});
candles.addIndicator('sma', { params: { period: 1 }, inputs: [{ series: trades, column: 'vwap' }] });
candles.addIndicator('ema', { inputs: [{ series: book, column: 'sum' }] }); // resting size
```

An indicator input can read a column of a heatmap or scatter per bar of the main timeline: the marks
with times from the bar's to the next bar's, the last bar's on to any time. A scatter has `count`,
`sum`, `max`, `min` and `mean` of the values, `open`, `high`, `low` and `close` of the prices, and the
value-weighted price `vwap`; a bar without points has a count and sum of 0 and no other value. A
heatmap is read as the book stood in the bar (its last column, or the last column before it): the
`sum` of that column's cells and their value-weighted price `center`, and the largest (`max`) and
smallest (`min`) cell of the bar's columns. The engine computes them like the inputs of bars: appended
marks and new bars update the indicator in place, in the message of the change; other changes
recompute it in the background, fetching marks let go first. Inputs are saved by the series' id and
column; removing the series removes the indicators that read it.

Every option is documented in `ScatterOptions`, `HeatmapOptions` and `MarkSeriesOptionsCommon`; the
design ([stage 5, heatmap and scatter](../design/stage-5-heatmap-scatter.md)) explains the choices
and the limits.

## Choosing a renderer

```ts
const chart = createChart(container, { markRenderer: 'webgpu' });
const trades = chart.addSeries('scatter', { pointSize: 1.5 });
const depth = chart.addSeries('heatmap');
trades.setData(points);
depth.setData(grid);
await chart.whenIdle();
console.log(trades.renderer(), depth.renderer());
chart.applyOptions({ markRenderer: 'canvas2d' });
```

The chart instance selects one mark renderer for its scatter and heatmap series. Candles, axes, labels and drawings use the pane compositor. The preference survives chart-state restoration. Change it at runtime with `applyOptions`.

| `markRenderer`     | Drawing behavior                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `webgl2` (default) | Uses WebGL2 when available, with Canvas 2D as the fallback. Charts in the same document share a GL context and programs. Each series owns its textures and cached image. A restored context redraws from the current engine window.                                                                                                                          |
| `webgpu`           | Uses WebGL2 while the WebGPU device and pipelines initialize, with Canvas 2D available if WebGL2 cannot draw. If WebGPU is unavailable, fails, loses its device, exceeds its resource limits, or cannot draw a marker style, the series tries WebGL2, then Canvas 2D. To retry device acquisition after loss, switch away from `webgpu` and select it again. |
| `canvas2d`         | Uses the Canvas 2D pixel buffer directly, including on devices that support both GPU APIs.                                                                                                                                                                                                                                                                   |

With WebGL2 and WebGPU, a heatmap with both `valueMin` and `valueMax` set is drawn from one-byte palette slots instead of its values: a quarter of the GPU memory and uploads, and no palette search per pixel. A palette change then uploads the colors only, but a change of `valueMin`, `valueMax` or `valueScale` turns every cell in view into slots again. With an automatic range, a new extreme changes the slot of every cell: such a heatmap is drawn from its values while the range changes, and from slots once it has stayed the same for 30 draws; the slots of the cells in view are then made at most 262,144 cells a frame, and a new extreme goes back to the values at once. The pixels are the same either way. [WebGL2](../benchmarks/webgl2-heatmap.md) and [WebGPU](../benchmarks/webgpu-specialized-paths.md) measurements.

Older applications passing `auto` get the WebGL2 default. Rendering cost and mark count do not change the selected backend. WebGPU's scatter kernels cover square stamps up to nine device pixels, one size for all points, colored by value. WebGL2 also supports circular and larger stamps, a size per point, and densities where the browser blends 32-bit floats (`EXT_color_buffer_float` and `EXT_float_blend`); a WebGPU series hands the others to WebGL2, with `renderer().reason` `unsupported-style`, and a density series that WebGL2 cannot blend is drawn with Canvas 2D, for the same reason. A WebGL2 density series on a logarithmic scale, or with `valueMin` set and `valueMax` not, waits for the GPU once per redrawn frame to read back the largest density (four bytes). [Measurements](../benchmarks/scatter-size-density.md). All three backends use the same time and price projections, palette and overlap order. Heatmaps preserve missing cells and maximum-value reduction at coarse levels of detail.

`renderer()` reports the resolved preference, the effective backend and draw path for the last frame, and the reason the preferred backend could not draw it. `bytes` and `peakBytes` estimate per-series acceleration resources and exclude the shared GL drawing buffer. An opaque WebGPU scatter append may update its cached image with a 2D patch. `whenIdle()` waits for data and chart frames and can resolve while WebGPU is initializing.

Run the vanilla example with `?bars=1000&marks=1&markRenderer=webgpu` to switch preferences on the same chart. [Cross-browser checks and WebGL2 timings](../benchmarks/explicit-mark-renderers.md).
