# Themes and display options

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
