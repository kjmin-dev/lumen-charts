# Stage 4: price axes, as built

What the price axes part of stage 4 built of the [design](../design.md). Each heading below is the section of the
design the text under it belongs to, and section numbers in the text are those of the design.
The measurements are in [docs/benchmarks/stage-4-price-axes.md](../benchmarks/stage-4-price-axes.md).

## 8.1 As built in stage 4: price axes

**Scales and axes.** A chart has a default price scale (id `default`, configured by
`ChartOptions.priceScale`) and any number of others by id (`ChartOptions.priceScales`). Series and
indicator outputs name theirs with `priceScaleId`, which can change at any time; an id that no option
names gets an overlay scale with default options. A scale with a visible axis has a canvas of its
own, made the first time the axis is shown; a scale without one is an overlay. Axes are laid out on
their side from the pane outward: the default scale first, then the others in the order of
`priceScales`. The default scale's canvas keeps its place in the DOM, and further ones go in below
the overlay canvas, so a chart with one axis has the same four canvases as before.

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
- The crosshair shows its price on every visible axis, each in its own values; the magnet snaps to
  the first visible series and labels that series' scale with its exact value. A series' value label
  goes on the axis of its scale, an overlay's on the default axis (or the first visible one).
- The horizontal grid follows the default scale, unless it has no series and a visible axis has.

**Frame path.** Per frame the chart loops over the scales twice (collect, then fit), sets each
series' projection (offset, factor, logarithm or not) and projects into the view's reused typed
arrays; tick rows go into a reused array per axis. Value labels are formatted again only when the
value, the base or the scale's format changed. Nothing reads the layout outside the shared frame's
read phase: the axis under the pointer is the event's target, which needs no layout read.

**Coordinate interface.** Drawings (stage 4) bind to this. There is one pane, so "per pane" is per
chart until panes exist.

| Where                                    | Symbol                                                                     | What                                                                                                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/model/price-scale.ts` | `PriceScale.priceToY(price, base?)`, `yToPrice(y, base?)`                  | Price to CSS pixels from the top of the pane and back; `base` (percentage, indexed) defaults to `PriceScale.base`, that of the scale's first series |
|                                          | `toValue(price, base?)`, `fromValue(value, base?)`, `valueToY`, `yToValue` | The two steps of the above, for code that works on values; `y = offset - value * scale`                                                             |
|                                          | `version`, `hasRange`, `mode`, `inverted`, `id`                            | `version` changes with the mapping of values to coordinates; nothing is mapped before `hasRange`                                                    |
| `packages/core/src/price-axes.ts`        | `PriceAxis` (`scale`, `settings`, `axisLeft`, `axisWidth`)                 | A scale with its options and axis place; implements the public `PriceScaleApi`                                                                      |
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

**Not built.** Scales are never removed; an axis no longer needed is hidden. Pinch and wheel act on the time scale only. (Colliding value-label separation on price axes and `nearest` crosshair magnet mode were built subsequently; see [price axes](../guide/price-axes.md) and [chart events](../guide/events.md).)
