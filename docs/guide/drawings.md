# Drawings

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
[docs/benchmarks/stage-4-drawings.md](../benchmarks/stage-4-drawings.md)). Mobile browsers cap the
memory of all canvases on a page, so near a budget (`setCanvasBudget(pixels)`, 48M device pixels by
default) a chart draws its drawings into the series layer instead of a layer of its own.
