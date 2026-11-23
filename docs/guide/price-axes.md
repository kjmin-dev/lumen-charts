# Price axes

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
const y = candles.priceToCoordinate(101.25); // CSS pixels from the top of the shared plot, or null
```

Each scale has a mode: `normal`, `logarithmic` (equal ratios take equal room; prices at or below
zero are left out), `percentage` or `indexed` (the change from each series' price at the first
visible bar, in percent or as an index starting at 100, so series of different prices compare).
A scale autoscales to all of its visible series in view, between its `scaleMargins`, and can be
inverted. Dragging an axis, or the wheel or a pinch over it, scales it and turns its `autoScale` off
(the wheel and a pinch keep the price under the pointer in place); a double click on the axis turns
it back on, and while it is off, dragging the pane up or down moves the scale. Over the pane, the
wheel and a pinch zoom time.

Axes go on their side from the pane outward: the default scale first, then the others in the order
`priceScales` lists them. The crosshair shows its price on every visible axis of the active pane, and each series' last
value is labelled on the axis of its scale (an overlay's on the default axis). `minMove`, the tick
size of a series, rounds its labels and gives them its decimals (`precision` overrides them); the axis
of a scale puts its ticks on multiples of the tick size of its first series. Without a tick size,
labels have as many decimals as the step between ticks needs.

`chart.priceScale(id)` (by default the default scale) and `series.priceScale()` return a handle with
the scale's options, the width of its axis, its visible range (`getVisibleRange`, and
`setVisibleRange`, which turns autoscale off) and price to coordinate conversions. Indicators take
`priceScaleId` for all their outputs, or per output in `outputs`. Every option is documented in
`PriceScaleOptions` and `SeriesOptionsCommon`; the design ([section 8.1](../design/stage-4-price-axes.md)) explains the choices.

A scale other than the default one takes room only while something is on it: a series or an
indicator output (shown or hidden), a heatmap or scatter, a primitive or a drawing. One that
`priceScales` lists keeps its options, and its range when it does not autoscale, while nothing is on
it, without its axis or pane, which come back with the next thing put on it. Any other scale goes
once nothing is on it.

```ts
chart.removeSeries(other); // `compare` keeps its options and takes no room
chart.removePriceScale('compare'); // and now it is gone from the options too
```

`removePriceScale` is the only way to take a scale out of the options (`applyOptions` merges);
whatever is still on it stays there, on an overlay. Handles from `chart.priceScale(id)` stay valid:
while the chart has no scale of that id they read as an empty overlay, and `applyOptions` or
`setVisibleRange` through them list the scale again.

Labels on an axis do not cover each other. Each series' latest value is labelled as near its value
as the others allow, in value order: labels that would overlap move apart around the mean of their
values, while the price lines stay at their values. When an axis cannot fit every label, the series
drawn last lose theirs first. The crosshair's label stays at the pointer, drawn over them.

The `magnet` crosshair mode puts the horizontal line on the value of the bar under the pointer that
is nearest to it on screen, among the visible series of the pane under the pointer, each placed by
its own scale: the open, high, low or close of candles, the value of lines and histograms. The
`nearest` mode does the same with closes only. At equal distances the series drawn first wins.
Drawing tools snap their points the same way, among the series on the drawing's scale.
[Independent indicator panes](indicators.md#independent-indicator-panes)
