# Indicators

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
incremental updates give the same bits as a full computation. An input can also read trades or a
book per bar, `inputs: [{ series: trades, column: 'count' }]`: see
[indicators over marks](heatmap-scatter.md#indicators-over-marks).

A histogram series is also available for your own data, for example volume:
`chart.addSeries('histogram', { color: '#26a69a', negativeColor: '#ef5350', base: 0 })`.

## Independent indicator panes

Set a positive `paneWeight` on a named price scale to give its series a pane below the price chart.
The main pane has weight 1 by default. Named panes follow the order of the `priceScales` options.
This layout assigns half the height to price and a quarter each to RSI and volume.

```ts
chart.applyOptions({
	priceScales: {
		oscillator: { paneWeight: 0.5, visible: true },
		volume: { paneWeight: 0.5, visible: true },
	},
	crosshair: { mode: 'nearest' },
});
candles.addIndicator('rsi', { priceScaleId: 'oscillator' });
const volume = chart.addSeries('histogram', { priceScaleId: 'volume' });
```

Each pane fits its own price range. Pan, zoom and the vertical crosshair share the time axis.
Dragging a visible price axis scales that pane. Adjust its height at runtime with
`chart.priceScale('oscillator').applyOptions({ paneWeight: 0.75 })`. A weight of zero
returns the series to the main pane as an overlay. Saving and restoring the chart options
and series preserves the pane sizes and assignments.
