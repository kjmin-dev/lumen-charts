# Primitives and custom renderers

The built-in drawings are pane primitives; your own code can draw the same way.

```ts
import {
	type DrawTarget,
	HIT_BODY,
	HIT_NONE,
	type PanePrimitive,
	type PaneView,
	type PrimitiveBounds,
	type SeriesItems,
} from 'lumen-charts';

class SessionBox implements PanePrimitive {
	readonly zOrder = 'bottom'; // under the series; 'normal' (default) with the drawings; 'top' over all
	private left = 0;
	private right = 0;

	constructor(
		private from: number,
		private to: number,
	) {}

	// Called when the view or the primitive changed (`host.requestUpdate()`), not every frame.
	update(view: PaneView, bounds: PrimitiveBounds) {
		this.left = view.logicalToX(view.timeToLogical(this.from));
		this.right = view.logicalToX(view.timeToLogical(this.to));
		bounds.left = this.left;
		bounds.right = this.right;
	}

	draw({ context, pixelRatio, height }: DrawTarget) {
		context.fillStyle = 'rgba(41, 98, 255, 0.06)';
		context.fillRect(this.left * pixelRatio, 0, (this.right - this.left) * pixelRatio, height * pixelRatio);
	}

	hitTest(x: number, y: number, tolerance: number) {
		return x >= this.left - tolerance && x <= this.right + tolerance ? HIT_BODY : HIT_NONE;
	}
}

chart.attachPrimitive(new SessionBox(open, close)); // or series.attachPrimitive(...)

// Draw a series or an indicator output with your own code instead of its built-in style.
rsi.output().setRenderer({
	draw({ context }: DrawTarget, items: SeriesItems) {
		for (let i = 0; i < items.count; i++) {
			context.fillRect(items.x[i] - 1, items.yClose[i] - 1, 2, 2);
		}
	},
});
```

A primitive gets the chart's conversions (`logicalToX`, `timeToLogical`, `priceToY`, ...) through
the `PaneView` it is drawn with, declares its layer, and may answer hit tests, which highlight it on
hover (`drawHighlight`). The chart calls `update` only when the view or the primitive changed, and
draws a layer only when something in it changed, so `update` and `draw` should not allocate.

A primitive leaves the price scale to the series unless it has an `autoscale` method. One that has
is asked, in every frame that computes price ranges, which prices to keep in view:

```ts
import type { AutoscaleRange, PaneView } from 'lumen-charts';

class Band implements PanePrimitive {
	// ... `draw`, and `update` as above.

	// `range.from` and `range.to` are the logical positions at the edges of the pane.
	autoscale(range: AutoscaleRange, view: PaneView): boolean {
		if (view.timeToLogical(this.to) < range.from || view.timeToLogical(this.from) > range.to) {
			return false; // out of view: nothing to keep
		}
		range.low = this.low;
		range.high = this.high;
		return true;
	}
}
```

- **When.** In frames that compute price ranges (a pan, a zoom, new data, a changed option), not
  for pointer moves, and before `update`: the scale does not have its range of that frame yet, so
  of `view` only the time conversions are current. It must not allocate. When the answer changes
  for another reason than the view, call `host.requestUpdate()`.
- **What it joins.** The price scale of the primitive: the main one for `chart.attachPrimitive`,
  the series' for `series.attachPrimitive`. Prices are prices, on any scale mode: the chart turns
  them into the scale's values (a price a logarithmic scale cannot show is left out).
- **Precedence.** The range fitted is the lowest low and the highest high of the visible series and
  of the primitives that answered, and the scale's `scaleMargins` go around all of it. Only a scale
  that autoscales takes it (`autoScale: false`, or a range set by hand, wins), and only one with a
  visible series: a primitive alone gives a scale no range.
- **Cost.** Only the primitives with the method are asked, one call each per such frame; a chart
  without one pays a length check. The built-in drawings opt in with their `autoscale` option
  ([drawings](drawings.md)).

A tick normally redraws only the device columns it changed on the series layer (the last bar's, in
most frames). The chart cannot tell what a `bottom` primitive or a custom renderer draws there, so
with either of them every tick redraws the whole layer, as does a chart whose drawings share the
series layer near the canvas budget.
