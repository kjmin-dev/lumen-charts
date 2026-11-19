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
`lineStyle`, `fillColor`, `text`, `textColor`, `fontSize`, `visible`, `locked` and `autoscale`, and
has a `zIndex`.

With the pointer: hovering a drawing shows its handles, pressing selects it, dragging moves it by
whole bars, and dragging a handle moves that point. A rectangle and a price range have eight
handles: the four corners and the middle of each edge (where the side is at least 20 pixels long).
A corner moves in time and price and the middle of an edge along one of them, and what is opposite
stays where it is. They are still two points, in `points()` and in the saved state: the handles are
derived from them, and a box dragged past its opposite side turns inside out. The other tools have
one handle per point; the third point of a parallel channel is the handle of its second line. A
locked drawing can be selected but not moved;
pressing it pans. Escape cancels a drawing being created or dragged, or clears the selection;
Delete and Backspace remove the selected drawing (the chart takes keys once clicked). With the
crosshair in `magnet` mode, points snap to the open, high, low or close of their bar. Touch reaches
lines from further away than a mouse. Events: `created` (also for `add`), `changed` (API changes,
and once at the end of a drag), `removed`, `selected` and `hovered`.

By default the price scale fits the series and a drawing above or below them is out of view. With
`autoscale: true` the autoscale of its price scale keeps the drawing in view while the time span of
its points overlaps the pane:

```ts
drawings.add({ type: 'horizontalLine', points: [{ time: t1, price: 250 }], options: { autoscale: true } });
zone.applyOptions({ autoscale: true });
```

- It gives the prices of its points, with every Fibonacci level and both lines of a channel. A
  horizontal line counts at any time, a vertical line has no price, and a ray or an extended line
  counts where its two points are, not where it runs to.
- The range is the series' range and the drawings' together, and the scale's `scaleMargins` go
  around both. A scale with `autoScale` off keeps its range, and a scale without a visible series
  takes nothing from drawings.
- A drawing being dragged keeps what it gave before, so the scale does not move under the pointer;
  the scale fits again when it is released.
- It costs the frames that compute price ranges (a pan, a zoom, new data) one pass over the
  drawings that opted in, which looks at the time span first: about 2 µs for 1,000 of them (see
  [docs/benchmarks/stage-4-follow-ups.md](../benchmarks/stage-4-follow-ups.md)). Hovering computes
  no range.

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
