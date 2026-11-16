# Stage 4: drawings, primitives and custom renderers, as built

What the drawings part of stage 4 built of the [design](../design.md). Each heading below is the section of the
design the text under it belongs to, and section numbers in the text are those of the design.
The measurements are in [docs/benchmarks/stage-4-drawings.md](../benchmarks/stage-4-drawings.md).

## 6.1 As built in stage 4 (drawings)

- **Layers.** The series layer draws the grid, primitives of order `bottom`, the series (or their
  custom renderers). The drawings layer draws primitives of order `normal`, the built-in drawings
  among them. The overlay draws price lines and labels, primitives of order `top`, the highlight of
  the hovered and the selected drawing, the drawing being created or dragged, and the crosshair.
  The drawings layer is created with the first primitive in it, so a chart without drawings keeps
  its four canvases and draws exactly what it drew before.
- **What redraws what.** A change redraws only the layers it touches:

  | Change                                                      | Series layer | Drawings layer       | Overlay    |
  | ----------------------------------------------------------- | ------------ | -------------------- | ---------- |
  | Pointer moves (hover, crosshair)                            | –            | –                    | yes        |
  | Dragging one drawing                                        | –            | when it starts, ends | every move |
  | Selecting a drawing                                         | –            | –                    | yes        |
  | A drawing added, changed or removed through the API         | –            | yes                  | yes        |
  | A tick that leaves both scales as they were                 | its columns  | –                    | yes        |
  | Pan, zoom, resize, a new price range, a bar while following | yes          | yes                  | yes        |
  | The engine answers time lookups (below, section 7.1)        | –            | yes                  | yes        |

- **Geometry is cached.** A primitive's `update` runs when its view changed (bar spacing and
  origin, the price mapping's version, the pane size, the pixel ratio, the time index's version) or
  when it asked for it; a frame that redraws its layer for another reason reuses its geometry. The
  view is the mapping of the last model update, the one on screen, also for presses handled before
  the frame draws.
- **Canvas budget.** The page counts the device pixels of every chart's canvases against a budget
  (48M pixels, about 192 MB, by default; `setCanvasBudget`). A chart whose drawings layer would
  exceed it draws its drawings into the series layer instead. Section 6 had them merge with the
  overlay; the series layer is the better partner because the overlay is redrawn in every frame
  (the last-price line moves with every tick) and on every pointer move, while the series layer is
  redrawn on a subset of those frames (view changes and ticks). Merged, a hover still redraws the
  overlay alone, and a tick redraws the drawings with the series.
- Charts out of view still draw nothing; a drawing changed meanwhile keeps its layer marked and is
  drawn when the chart comes back. All drawing still runs in the write phase of the shared frame.

## 7.1 As built in stage 4 (drawings)

- **Points as times.** A drawing stores times (UTC ms) and prices, and is bound to a pane (0, the
  price pane) and a price scale by id (section 8.1; `default` unless given). It reaches the scale
  only through a narrow interface (`PriceMapping`: price to y, y to price, the price format, a
  version and the base), so any kind and number of scales can stand behind it. The chart's
  `ScaleMapping` maps with `PriceScale.priceToY` and the scale's base: on a percentage or indexed
  scale a drawing sits at its price as the crosshair reads it there, and moves with the base when
  the first visible bar changes. Lines are straight on screen between the points' screen positions,
  and Fibonacci levels are taken in price, then mapped, so both stay right on a logarithmic or
  inverted scale. A drawing on a scale without a range (no series on it yet) is not drawn; the
  magnet snaps to the first visible series on the drawing's own scale.
- **Times to logical positions.** A time is the index of the bar with that time, a fraction of the
  way between two bars for a time between theirs, and beyond either end at the median spacing of
  the 64 bars there, so a point in the future stays put while bars keep arriving at that spacing.
  The main thread holds only the bars around the view, so the time index answers from the raw
  window (exact), beyond the known ends (extrapolated), or asks the engine with a `resolve`
  command, a read that waits for no rows; inside history the memory limit let go, the engine
  interpolates between the times the levels keep (every 16th bar). Until an answer arrives a
  drawing whose points are unknown is not drawn. Positions are cached per time and kept through a
  change of the timeline wherever indexes are kept: bars both timelines share, and positions beyond
  an end that did not move. Only the others are asked again (after a prepend, the points before the
  old first bar; after a new bar, the points in the future); a new epoch (new history, bars removed
  in the middle) asks for all of them, and none is shown until known. A time is never turned into an
  index for good: after a change of resolution a point at 10:07 sits 40% of the way between the
  10:05 and 10:10 bars.
- **Pointer.** Handlers still only store what an event says. While drawings or a tool are active,
  the presses, moves and releases of the first pointer queue in order (consecutive moves merge)
  until the read phase of the next frame, which learns whether each press lands on a drawing (or a
  tool takes it): a taken press gets the moves and release after it, any other pans by them, so
  two clicks within one frame both count. A second finger before the press is answered makes it a
  pinch. The interaction is a state machine: idle (hover highlights, a press selects),
  armed (a tool waits for its first point), placing (the next point follows the pointer; a click or
  the release of a drag places it), pressed and dragging (a drawing moves by whole bars and the
  pointer's distance on the price axis, or one point follows its handle). Hit tolerance is 4 CSS
  pixels for a mouse and 12 for touch and pens; a press becomes a drag past 3 or 8 pixels.
- **Hit testing.** Each layer keeps the bounds of its primitives in one `Float64Array` (four
  numbers each), refreshed only by `update`. A hit test scans it from the top, skipping primitives
  whose bounds (grown by the tolerance) miss the point, and asks only the rest. For drawings the
  bounds are the time filter in screen space, and a drawing whose time span misses the view skips
  its geometry altogether. Measured with 1,000 drawings, half in view: a hit test takes about 2 µs and
  a whole hover frame 0.30–0.33 ms at p99 (`docs/benchmarks/stage-4-drawings.md`), so no spatial
  index was added.
- **State.** `toJSON()` gives `{ version: 1, id, type, points: [{ time, price }], options, zIndex,
  pane, priceScaleId }` per drawing (`DrawingState` in `packages/core/src/drawings/types.ts`);
  `drawings.add` takes it back and refuses other versions.

## 8. External contract and scope

- Plugins: custom series, plus pane and series primitives. As built in stage 3: custom indicators
  loaded as modules into the engine (section 5.1), whose outputs are derived series. As built in
  stage 4:
  - A pane primitive (`PanePrimitive`, `packages/core/src/primitives.ts`) is an object with
    `draw(target, view)` and optionally `zOrder` (`bottom`: under the series; `normal`: the drawings
    layer; `top`: the overlay, redrawn on every pointer move), `zIndex` within its layer,
    `attached(host)`, `detached()`, `update(view, bounds)`, `hitTest(x, y, tolerance)` and
    `drawHighlight(target, view, hovered, selected)`. `view` (`PaneView`) has the conversions the
    chart uses itself: logical position and x, time and logical position (section 7.1), price and y
    on the primitive's scale, price formatting. `bounds` is the box it covers, which culls drawing
    and filters hit tests. `host.requestUpdate()` asks for `update` and a redraw of its layer.
  - `chart.attachPrimitive` attaches one to the pane with the main price scale,
    `series.attachPrimitive` to a series (and its scale); it is detached with the series.
  - The built-in drawings are primitives of order `normal` on this interface. What they have beyond
    it (dragging, selection) lives in the drawings manager, which uses the same hit tests.
  - A custom renderer (`SeriesRenderer`) draws a series or an indicator output instead of its
    built-in style, from the items the series view keeps (`SeriesItems`: x, the four prices and
    their rows, per item, and the bar width), so it gets level of detail and autoscale unchanged.
  - Neither primitives nor renderers take part in autoscale or draw on the axes yet.

## 9. Stages and measurement gates

Stage 4, drawings (measured, [stage 4 drawings](../benchmarks/stage-4-drawings.md)): with 1,000
drawings, half in view, the JavaScript of a hover frame (pointer event, hit test, overlay) has a
p99 of 0.30 ms with the engine in a worker and 0.33 ms on the main thread, of which the hit test is
about 2 µs.
