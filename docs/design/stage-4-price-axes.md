# Stage 4: price axes, as built

What the price axes part of stage 4 built of the [design](../design.md). Each heading below is the section of the
design the text under it belongs to, and section numbers in the text are those of the design.
The measurements are in [docs/benchmarks/stage-4-price-axes.md](../benchmarks/stage-4-price-axes.md).

## 8.1 As built in stage 4: price axes

**Scales and axes.** A chart has a default price scale (id `default`, configured by
`ChartOptions.priceScale`) and any number of others by id (`ChartOptions.priceScales`). Series and
indicator outputs name theirs with `priceScaleId`, which can change at any time; an id that no option
names gets an overlay scale with default options. A scale with a visible axis has a canvas of its
own, made the first time its options show the axis; a scale without one is an overlay. Axes are
laid out on their side from the pane outward: the default scale first, then the others in the order
of `priceScales`. The default scale's canvas keeps its place in the DOM, and further ones go in
below the overlay canvas, so a chart with one axis has the same four canvases as before.

**Which scales there are.** Something is on a scale when a series or an indicator output names it
(shown or hidden), a heatmap or scatter does, or a primitive or drawing is drawn with its view. At
the start of every frame that updates the model (new data, a pan or zoom, a change of options or of
the series) the chart marks the scales something is on, and then:

- The default scale is always there, and shows its axis while its options do.
- A scale `priceScales` lists stays while the option lists it, with its options and, if it does not
  autoscale, its range: they are configuration, saved and restored with the options and the view.
  While nothing is on it, it takes no room: no axis, no pane of its own, its canvas hidden with its
  bitmap let go. Its axis and pane come back with the first thing put on it.
- Any other scale goes once nothing is on it: its state, its canvas, and the view primitives had of
  it. A later use makes it again, with default options.
- `ChartApi.removePriceScale(id)` takes a scale out of `priceScales`, its options and range with it.
  Whatever is still on it stays there, on an overlay of that id; the scale goes once nothing is.
  `applyOptions` merges and cannot take a key out, so this is the only way to remove one; the
  default scale cannot be removed.
- A `PriceScaleApi` handle stands for its id. A handle of a scale that went reads as a scale with
  nothing on it (no width, range or coordinates, the options of an overlay) until the id is used
  again, and then reads that scale; `applyOptions` and `setVisibleRange` through it list the scale
  in `priceScales` and so make it again. A scale `chart.priceScale(id)` made for an id nothing uses
  goes with the next frame that updates the model.

When an axis or a pane appears or goes, the pane takes the room left and the same bars stay in view,
as when an axis widens for its labels.

**Values.** A scale maps a price to a value and the value to a coordinate:

- The value is the price (`normal`), its decimal logarithm (`logarithmic`), its change in percent from
  a base price (`percentage`), or the price as an index on which the base is 100 (`indexed`).
- The base is the series' value at the first visible bar: its close, or at a coarse level the last
  close of the first visible bucket. Each series on a percentage or indexed scale has a base of its
  own, so all of them start at 0% (or 100) and compare. Conversions that take no base use the base of
  the scale's first series with one.
- Values map to coordinates linearly, `y = offset - value * scale`, with `scale` negative on an
  inverted scale. Percentage and indexed values are linear in the price given the base, so the base
  folds into the offset and factor and a view projects with one multiply-add per price, as before.
  Only the logarithmic mode takes a logarithm per price. Prices it cannot show (zero or below) become
  NaN and are not drawn, like gaps.
- On an inverted scale a view's `yHigh` and `yLow` still hold the upper and the lower row of an item,
  so lines, wicks and merged pixel columns draw unchanged; candle bodies and histogram colors take
  the inversion into account.

**Autoscale.** In every model update each scale collects the value range of its visible series in
view (a histogram's base included where the scale can show it) and fits it, if it autoscales or
has never been fitted. A scale that does not autoscale keeps its range in values; a change of mode,
which changes the units, fits it once. Dragging an axis scales its range around the middle and turns
autoscale off; a double click on the axis turns it back on; dragging the pane up or down moves the
scales that do not autoscale.

Over an axis, the wheel and a pinch scale that axis around the price under the pointer, which keeps
its place, and turn its autoscale off as a drag does: the wheel by `exp(deltaY * 0.002)` (up shows
less), a trackpad pinch (a wheel event with the control key) by `exp(deltaY * 0.01)`, and two
fingers whose first one pressed the axis by the ratio of their distances, around the price between
them; the finger left when the other lifts goes on scaling the axis as a drag. Over the pane they
zoom time, as before. The axis is the event's target and the pointer's place in the chart waits for
the frame's read phase, so neither reads the layout in the handler. There is no option to turn them
off, as there is none for dragging the axis.

**Ticks and labels.**

- Linear ticks are multiples of 1, 2 or 5 times a power of ten, and of the tick size (`minMove`) of
  the scale's first series when it has one.
- On a logarithmic scale that spans less than a factor of 3, ticks are multiples of one round step,
  the one the top of the range needs. Over a wider range the step grows with the price: each tick is
  the first multiple of the round step nearest to the distance to the price `spacing` pixels higher
  (1, 2, 4, 10, 20, 40, ... over decades; every decade or every few when decades get narrow). Ticks
  are always at least `spacing` pixels apart.
- Ticks cover the pane, but not more than `spacing` pixels beyond the scale's range: an oscillator
  that its margins keep in a band below the prices labels that band only.
- Labels take the decimals of the series' tick size or `precision`; without either, as many as the
  tick step needs (2 to 8). Prices are rounded to the tick size. Percentage labels carry a `%`.
- The crosshair shows its price on every visible axis, each in its own values. A series' value label
  goes on the axis of its scale, an overlay's on the default axis (or the first visible one).
- The magnet (`magnet` mode) snaps the horizontal line to the value of the bar under the pointer
  nearest to the pointer on screen. The candidates are the visible series of the pane under the
  pointer, whatever their scale: the open, high, low and close of bars and candles, the value of
  lines and histograms, each placed by its own scale (and base), measured in pixels. Values outside
  the pane are left out. At equal distances the series drawn first wins, and of one bar the open,
  high, low and close in that order. `nearest` mode does the same with closes only. The axis of
  the series snapped to labels its exact value; the other axes their own value at that row. Points
  of drawings snap the same way, among the series on the drawing's own scale.

  This is Lightweight Charts' magnet (`MagnetOHLC`; its `Magnet` takes closes, like `nearest`) with
  two differences: Lightweight Charts leaves out series on overlay scales, and takes values outside
  the pane. Here a series without an axis is a candidate like any other (an independent pane may
  have no axis), and a value the pane cannot show is not, since the line would not be drawn.

- Labels on an axis never cover each other, except the crosshair's. Each axis places the value
  labels of the series on it (an overlay's on the axis it borrows) so that each is as near to its
  value as it can be: in value order, as close to their values in the least-squares sense, and
  inside the axis (pane by pane for independent panes). A label that overlaps nothing stays on its
  value; labels that would overlap move apart as a block centred on the mean of their values. When
  an axis cannot fit them all, the series drawn last lose their labels first. The price lines stay
  at their values. The crosshair's label keeps its place at the pointer and is drawn over the value
  labels while the pointer is there, as in Lightweight Charts; tick labels are on the axis' own
  canvas, under both. Besides the ticks, value labels and the crosshair's are the only labels on
  the axes: price lines have no label of their own, and primitives and drawings draw in the pane.
- The horizontal grid follows the default scale, unless it has no series and a visible axis has.

**Frame path.** Per frame the chart loops over the scales twice (collect, then fit), sets each
series' projection (offset, factor, logarithm or not) and projects into the view's reused typed
arrays; tick rows go into a reused array per axis. Value labels are formatted again only when the
value, the base or the scale's format changed. Nothing reads the layout outside the shared frame's
read phase: the axis under the pointer is the event's target, which needs no layout read.

Marking the scales in use runs first in a frame that updates the model: a pass over the series, the
heatmaps and scatters and the primitives (one lookup per run of primitives on the same view), with
a counter rather than a set, so it allocates nothing. The value labels of an axis are placed in
every overlay frame: an insertion sort of the labels shown (as many as fit, so a few) and one pass
of pool-adjacent-violators over them (`render/label-layout.ts`), in reused arrays.

**Coordinate interface.** Drawings (stage 4) bind to this. There is one pane, so "per pane" is per
chart until panes exist.

| Where                                    | Symbol                                                                     | What                                                                                                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/model/price-scale.ts` | `PriceScale.priceToY(price, base?)`, `yToPrice(y, base?)`                  | Price to CSS pixels from the top of the pane and back; `base` (percentage, indexed) defaults to `PriceScale.base`, that of the scale's first series |
|                                          | `toValue(price, base?)`, `fromValue(value, base?)`, `valueToY`, `yToValue` | The two steps of the above, for code that works on values; `y = offset - value * scale`                                                             |
|                                          | `version`, `hasRange`, `mode`, `inverted`, `id`                            | `version` changes with the mapping of values to coordinates; nothing is mapped before `hasRange`                                                    |
| `packages/core/src/price-axes.ts`        | `PriceAxis` (`scale`, `settings`, `axisLeft`, `axisWidth`)                 | A scale with its options and axis place; implements the public `PriceScaleApi`                                                                      |
|                                          | `PriceAxes.find(id)`                                                       | The scale of an id, or null: looks without making one, as `get` would                                                                               |
| `packages/core/src/series.ts`            | `Series.axis`, `Series.base`, `Series.deviceY(price)`                      | The scale a series was drawn on, its base, and the device-pixel row of a price as last drawn (the frame path's form)                                |
| `packages/core/src/chart.ts`             | `Chart.priceAxisOf(series)`, `Chart.priceScale(id)`                        | Scale of a series (following `priceScaleId`), and of an id (made as an overlay if new)                                                              |
| `packages/core/src/options.ts`           | `DEFAULT_PRICE_SCALE_ID`                                                   | `'default'`                                                                                                                                         |

A drawing stored as (time, price) pairs bound to a series converts with its series' scale and base,
and moves with them in percentage and indexed modes as the first visible bar changes, as the series
does; one bound to a scale id uses the scale's base. The public forms are
`SeriesApi.priceToCoordinate`, `coordinateToPrice` and `priceScale()`, and `ChartApi.priceScale(id)`
(`PriceScaleApi`: options, width, visible range, conversions).

**Measured** in [stage-4-price-axes.md](../benchmarks/stage-4-price-axes.md): with one axis the frame
takes what it took within one step of the 5 µs timer; a logarithmic scale costs a logarithm per price
per frame (+25% of frame JavaScript with 1M candles and three averages in view).

**Built since stage 4** (price axis follow-ups): value labels that keep apart, scales that go once
nothing is on them and `removePriceScale`, a magnet that measures every series on screen through its
own scale, and the wheel and pinch on an axis, as described above. Measured in
[price-axis-follow-ups.md](../benchmarks/price-axis-follow-ups.md): no change in frame time the
runs could resolve, on a machine other work kept busy; a cost of a few percent can be neither
excluded nor confirmed there.

**Not built.** Which scales are in use is found in frames that update the model; a primitive or
drawing attached or detached alone redraws only its layer, so the axis of a listed scale that it
alone is on appears or goes with the next frame that updates the model. There is no option to turn
off the wheel or pinch on an axis (nor dragging it).
