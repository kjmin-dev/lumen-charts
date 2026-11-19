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
book.valueAt(time, price); // the value drawn there, for a readout at the crosshair

chart.markSeries(); // [trades, book]: these two kinds are listed apart from `chart.series()`
chart.removeSeries(book);
```

Both are series of the chart: they have an `id` and options, sit on a price scale
(`priceScaleId`), are saved with `saveState` and restored with `restoreState` (without their data,
like every series), and their data lives in the data engine, in the worker when there is one. They
differ from candles and lines in what they hold, which is not one value per bar:

- **A scatter** holds points in time order; several may share a time. A point is a square or a
  disc (`shape`) of `pointSize` CSS pixels, in the palette's color for its `value`, or in `color`
  without one. It is drawn above the other series and below drawings.
- **A heatmap** holds columns of `rows` cells on one grid of prices. A column covers the time from
  its own to the next column's (the last one, as long as the one before it), so one column per bar
  fills the bars, and several per bar divide them. It is drawn below the other series. The grid is
  set by `setData`; `update` and `append` add columns on it. A grid that follows the price, with
  another range of prices per column, is not built: give the grid the whole range, with NaN where
  there is nothing.

**Time.** Marks are placed on the timeline of the bars by their time, so the chart needs a series
with bars (a hidden line will do). A point at a bar's time is at the middle of the bar and later
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

**Autoscale.** A scatter's points in view take part in the autoscale of its price scale, like the
values of a line. A heatmap's grid does not by default, so the book follows the candles instead of
squeezing them; `autoscale` changes either. A series alone on its scale is fitted whatever the
option says.

**Many marks.** The chart draws these series through a pixel buffer rather than shape by shape, so
the cost of a frame follows the pixels of the pane and the marks in view, not canvas calls:

- A scatter with more points than pixels across is drawn from a level of detail, in which the
  points of one pixel column that share a price bin are one mark with the largest value of them. The
  engine picks the level, and sends the points themselves once the view is narrow enough.
- A heatmap with more columns than pixels is drawn from a level that merges four columns at a
  time, each cell the largest of its members; more rows than pixels are merged while drawing, again
  to the largest. A peak survives zooming out.
- A tick draws what it changed: a point added to a scatter writes that point, a replaced or added
  heatmap column writes from that column to the right edge.

What to expect, on a 2,400 × 1,200 pixel pane (M1): see
[the measurements](../benchmarks/stage-5-heatmap-scatter.md). `series.drawn()` tells the level of
detail and the number of marks the last frame drew from.

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

- `canvas2d` is the default. `webgpu` requests acceleration for marks. The chart draws with Canvas 2D while the optional module, device and pipelines initialize. `whenIdle()` retains its data/frame semantics. Each series reports `requested`, `effective`, `path`, fallback `reason`, current `bytes` and `peakBytes`. These byte estimates cover its GPU buffers and renderer bitmaps. An opaque scatter append can update the retained layer on the CPU while the effective series backend is WebGPU.
- `auto` starts on Canvas 2D and samples full draws on the host. Trials require repeated costly draws, enough visible data after LOD and room in the page rendering budget. The chart compares warm GPU submission/composition costs with its Canvas measurements and uses a cooldown for switching back. Small or inexpensive workloads can stay on Canvas 2D. A browser/device combination needs its own performance measurements. [Integrated chart results](../benchmarks/integrated-mark-renderers.md).
- GPU scatter supports square markers up to nine device pixels. Circles and larger markers use the existing Canvas painter. A sparse held window can use price-band tiles. Larger or time-concentrated windows use a column kernel. Heatmaps share the exact integer edges, missing-value rules and maximum reduction with Canvas, including at fractional zoom and on log scales.
- Each chart keeps grid, price series, marks, drawings and overlay in their original order. Charts in a document share the GPU device and pipelines. Individual series keep their own resources. Budget pressure, unavailable hardware, failed initialization or device loss fall back to the latest engine window. To explicitly retry initialization after a loss, select `canvas2d` and then `webgpu` again. The renderer preference belongs to the host and survives chart-state restoration.

Run the vanilla example with `?bars=1000&marks=1&markRenderer=webgpu` to switch preferences on the same chart.
