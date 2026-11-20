# Themes and display options

```ts
const chart = createChart(element, {
	theme: 'auto', // 'light' (default), 'dark', or follow the system setting
	grid: { vertLines: { visible: false }, horzLines: { style: 'dashed' } },
	crosshair: { mode: 'magnet' }, // or 'nearest', 'normal', 'hidden'
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

## Redrawing on ticks

```ts
const chart = createChart(element, { redraw: 'full' }); // default: 'auto'
chart.applyOptions({ redraw: 'auto' });
```

A frame drawn for new data alone, with the view, the price scales and every option as they were,
redraws only the pixel columns the data changed (`redraw: 'auto'`). Where the browser rasterizes the
canvas on the GPU, which is the default, the result is the full redraw's, pixel for pixel, dashed
and dotted lines included.

Set `redraw: 'full'` on pages whose canvases are rasterized in software: a browser without GPU
rasterization (a blocklisted driver, a virtual machine, `--disable-gpu`), or a page that creates 2D
contexts with `willReadFrequently`. A software rasterizer antialiases a line by its whole path, so
there a frame that redraws some columns differs from a full redraw in a few antialiased pixels
along the lines; the differences do not add up from frame to frame. With `full` every such frame
draws the whole series layer,
as a frame that pans or zooms does, at that cost: with 20 indicators over a million bars in view,
about 4 ms of JavaScript a frame instead of 0.5 ms. The chart does not detect the rasterizer itself:
nothing a page can ask tells how its 2D canvases are rasterized without reading one back, and reading
a canvas back is what makes a browser rasterize it in software.
