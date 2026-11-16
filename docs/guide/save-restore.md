# Save and restore

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
(see [docs/benchmarks/stage-4-save-restore.md](../benchmarks/stage-4-save-restore.md)).
