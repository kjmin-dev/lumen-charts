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
inverted. Dragging an axis scales it and turns its `autoScale` off; a double click on the axis turns
it back on, and while it is off, dragging the pane up or down moves the scale.

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

Latest-value labels are spaced within each axis while the price lines stay at their values.
If the axis cannot fit every label, the labels nearest its top are shown first.
The `nearest` crosshair mode snaps to the visible close closest to the pointer in the active pane.
At equal distances, series order breaks the tie. The `magnet` mode snaps to the first eligible series.
[Independent indicator panes](indicators.md#independent-indicator-panes)
