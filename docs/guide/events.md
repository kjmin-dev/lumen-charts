# Events and coordinates

```ts
// A legend: the bar under the crosshair, or the last one.
chart.subscribe('crosshairMove', event => {
	const bar = event.values.get('btc'); // { open, high, low, close } of the series with id `btc`
	legend.textContent = bar && 'close' in bar ? `${formatTime(event.time)} ${bar.close}` : '';
});

chart.subscribe('click', event => {
	if (event.time !== null) console.log('clicked the bar at', event.time);
});

chart.timeScale().subscribe('visibleTimeRangeChange', range => {
	if (range !== null) url.searchParams.set('view', `${range.from}-${range.to}`);
});
```

## Crosshair and clicks

`crosshairMove` and `click` hand over a `ChartPointerEvent`:

- `source`: what moved the crosshair: `pointer`, `keyboard` (the [navigator](accessibility.md)),
  or `api` (`setCrosshairPosition` and `clearCrosshairPosition`). A click is always `pointer`.
- `point`: CSS pixels from the pane's top left corner, or null once the crosshair is hidden.
- `logical`: the bar index at `point.x`, also beyond the bars (null without bars).
- `time`: the time of that bar in UTC milliseconds, or null outside the bars.
- `values`: a `Map` from series id to what the series shows there: `{ open, high, low, close }` for
  a candlestick series, `{ value }` for a line or a histogram. An indicator's outputs are there too,
  as `<indicator id>.<output name>` (`indicator-1.value`, or `bands.upper` for Bollinger bands
  added with `id: 'bands'`). A series without a value at that
  bar is left out. Heatmap and scatter series are not: read them with `valueAt` and `pointAt` (below).

`crosshairMove` comes once per frame at most, after the frame was drawn: a hundred pointer moves
between two frames give one event, for where the pointer ended. It comes only when the crosshair
moved on screen, onto another bar, or appeared or was hidden; a frame for anything else gives none.
`click` comes for a press and release of the primary button, or a tap, that stayed within a few
pixels: a drag pans and is not a click. A press a drawing takes is not a click either: placing a
point of a drawing tool, or selecting or moving a drawing.

The event is built only while someone listens. Without listeners a frame compares a few numbers
and allocates nothing; with one, an event is a few small objects.

`time` and `values` come from the rows the chart drew. Zoomed out so far that bars merge into
buckets (16 bars or more to a device pixel), they are those of the bucket under the crosshair: its first
time, and its open, high, low and close (a line's value is the bucket's last). A bar far from the
view, which the chart does not hold, has a `logical` but no `time` or `values`.

## Placing the crosshair

```ts
chart.setCrosshairPosition(time, price); // price on the default scale; or null for no horizontal line
chart.setCrosshairPosition(time, price, 'volume'); // on another price scale
chart.clearCrosshairPosition();
```

The vertical line goes to the bar at or before `time`: the bar with that time, the bar before it
for a time between two bars, the last bar for a later time; for a time before the first bar the
crosshair is hidden. It stays on its bar and price while the view moves, and the pointer takes it
over once it moves on the chart. The `crosshairMove` it causes has `source: 'api'`.

## Visible range

`visibleLogicalRangeChange` and `visibleTimeRangeChange` on the time scale come once per frame at
most, when the view moved: a pan, a zoom, a resize, a call such as `fitContent`, or a new bar while
the chart follows the last one. They hand over the range, or null without bars.

```ts
const timeScale = chart.timeScale();
timeScale.getVisibleRange(); // { from, to } in UTC milliseconds, the times at the edges of the pane
timeScale.setVisibleRange({ from: Date.UTC(2024, 0, 1), to: Date.UTC(2024, 1, 1) });
```

The time range is that of the edges of the pane: between bars and beyond the ends, times are placed
as the timeline places them (see [drawings](drawings.md)), so `setVisibleRange(getVisibleRange())`
shows the same view. `setVisibleRange` shows the times as soon as they can be placed: at once when
the bars around them are held, otherwise once the data engine has placed them. `getVisibleRange`
returns null without bars, and where the rows at an edge are not held yet; the event then waits for
them.

## Coordinates

```ts
timeScale.timeToCoordinate(time); // x of a time
timeScale.coordinateToTime(x);
timeScale.logicalToCoordinate(logical); // x of a logical position: bar i is centered on i
timeScale.coordinateToLogical(x);
series.priceToCoordinate(price); // y of a price on the series' scale
series.coordinateToPrice(y);
```

Coordinates are CSS pixels from the pane's top left corner. The conversions map what is on screen,
the view of the last frame, which is current in event handlers; right after a call that moves the
view, they follow once the next frame has drawn it. They return null without bars and where there
is no answer. A time far from the bars the chart holds is asked of the data engine, as for
[primitives](primitives.md): `timeToCoordinate` returns null until the answer is in, a frame or two
later.

For a readout of a heatmap at the crosshair:

```ts
chart.subscribe('crosshairMove', event => {
	if (event.point === null) return;
	const time = chart.timeScale().coordinateToTime(event.point.x);
	const price = book.coordinateToPrice(event.point.y);
	tooltip.textContent = time === null || price === null ? '' : String(book.valueAt(time, price) ?? '');
});
```

A scatter is read at the event's point as it is, in CSS pixels of the pane:

```ts
chart.subscribe('crosshairMove', event => {
	const hit = event.point === null ? null : trades.pointAt(event.point.x, event.point.y);
	tooltip.textContent =
		hit === null ? '' : `${hit.price} ${hit.value ?? ''}${hit.count > 1 ? ` (${hit.count} trades)` : ''}`;
});
```

`pointAt` returns the point drawn at the device pixel under the position, as the last frame placed,
sized and shaped it: of the points whose marks cover the pixel, the one drawn on top, the last in
time order; null where none is drawn, and for a hidden series. It gives the point's `time`, `price`,
`value` (null without one) and `size` (its own, or `pointSize`), `count`, the points a mark of a
coarse level of detail stands for (1 for a point), and `density`, the points whose marks cover the
pixel, the number a `colorBy: 'density'` series colors it by. It reads the rows the chart holds,
whichever renderer drew them, and looks only at those whose center is within the widest mark of the
pixel's column, found by a binary search in time: cheap enough for every pointer move.

## Synced charts

```ts
const charts = [prices, volume];
for (const chart of charts) {
	const others = charts.filter(other => other !== chart);
	chart.subscribe('crosshairMove', event => {
		if (event.source === 'api') return; // the echo of a call below
		for (const other of others) {
			if (event.time === null) other.clearCrosshairPosition();
			else other.setCrosshairPosition(event.time, null);
		}
	});
	chart.timeScale().subscribe('visibleTimeRangeChange', range => {
		if (range !== null) for (const other of others) other.timeScale().setVisibleRange(range);
	});
}
```

Setting a range a chart already shows causes no event (a change of less than a millionth of a bar
or a microsecond does not count), so the ranges settle after one round. Charts with the same bars
can sync `visibleLogicalRangeChange` and `setVisibleLogicalRange` instead.

## Loading older history

```ts
let first = 0; // logical position of the oldest bar: 0 after setData, lower with every prepend
let oldest = bars.time[0];
let loading = false;
chart.timeScale().subscribe('visibleLogicalRangeChange', async range => {
	if (range === null || loading || range.from > first + 50) return;
	loading = true;
	const older = await fetchBars({ before: oldest, count: 1000 }); // columns, oldest first
	if (older.time.length > 0) {
		series.prepend(older);
		first -= older.time.length;
		oldest = older.time[0];
	}
	loading = false;
});
```

A prepend keeps the index of every bar there is, so the view does not jump. For history that the
chart may let go and fetch again, give the series a [datafeed](datafeed.md) instead.
