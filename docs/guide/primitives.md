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

A tick normally redraws only the device columns it changed on the series layer (the last bar's, in
most frames). The chart cannot tell what a `bottom` primitive or a custom renderer draws there, so
with either of them every tick redraws the whole layer, as does a chart whose drawings share the
series layer near the canvas budget.
