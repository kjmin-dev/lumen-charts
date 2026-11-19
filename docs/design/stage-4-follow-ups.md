# Stage 4 follow-ups: handles, autoscale and restore by id, as built

What was built after stage 4 to close limits its parts left open: rectangles had two handles,
primitives and drawings took no part in autoscale, and a restore replaced every drawing and
computed again every indicator after the first that differed. Each heading below is the section of
the [design](../design.md) the text under it belongs to, and section numbers in the text are those
of the design. Where this file and
[stage-4-drawings.md](stage-4-drawings.md) or [stage-4-save-restore.md](stage-4-save-restore.md)
differ, this one says what the library does now. The measurements are in
[docs/benchmarks/stage-4-follow-ups.md](../benchmarks/stage-4-follow-ups.md).

## 7.1 As built after stage 4 (drawings)

- **Handles are derived from the points.** A drawing has one handle per point, and a box (a
  rectangle or a price range, two points that are opposite corners) has eight: its corners, then
  the middles of its edges. A hit test answers `1 + k` for handle `k`: the two points, the corners
  they do not name, the edges at the first and second point's time, the edges at their prices.
  Dragging one writes only what it stands for (`Drawing.moveHandle`): a corner the time of one
  point and the price of the other, the middle of an edge one time or one price. So the opposite
  corner or edge stays where it is without being held, and a box dragged through itself stays a
  box. The middle of a side shorter than 20 CSS pixels has no handle, where the corners' would
  cover it. The handles sit in the geometry array next to the points and are filled by `update`,
  so hovering and hit testing read plain numbers as before.
- **The state did not change.** `DrawingState` is version 1 with two points for a rectangle:
  nothing about handles is saved, and a state written before reads as it did.
- **The other tools were reviewed and left with a handle per point.** A parallel channel has three
  independent things to set (two ends of the base line and the distance of the second line) and
  three handles for them; the third is on the second line. Handles at the ends of the second line
  would move a point they are not on, in price by an amount that depends on the scale mode, so
  none were added. Lines, Fibonacci retracements and text have nothing a point does not reach.

## 8. External contract and scope

Primitives and drawings may take part in autoscale. This replaces "neither primitives nor
renderers take part in autoscale" of stage 4 for primitives; a custom renderer draws a series,
which autoscales as before.

- **Opt-in.** A primitive takes part when it has an `autoscale(range, view)` method
  (`PanePrimitive`, `packages/core/src/primitives.ts`); a drawing when its `autoscale` option is
  on, which is off by default, so nothing changes for charts that do not ask. The method gets the
  logical positions at the edges of the pane and answers with the lowest and highest price to keep
  in view, on the primitive's price scale.
- **Where it runs.** In the model update, between collecting the ranges of the series and fitting
  the scales (`FrameModel.ranges`, `PanePrimitives.includeRanges`), which is the only place a
  range is computed: frames at the Light level or above, never a hover. The drawings layer is
  updated after the model, with the mapping the fit produced, so there is no second pass and no
  feedback: what a primitive gives depends on times and prices, not on rows.
- **Cost.** The chart keeps a list of the primitives that opted in, and beside it one
  `Float64Array` with four numbers each: the logical span the answer holds for, and the prices.
  This is the bounds array of hit testing in data space. A primitive whose answer does not depend
  on the view says so by giving its span (`AutoscaleRange.spanFrom`, `spanTo`); the chart then
  scans the array, skips the entries whose span misses the view, and asks a primitive again only
  after `requestUpdate`, a change of the timeline or of the chart's options. A drawing gives the
  time span of its points, so a frame costs one comparison per opted-in drawing out of view and a
  minimum and a maximum per one in view, without a call and without allocation. A primitive that
  gives no span is asked in every such frame. Nothing is done for primitives that did not opt in,
  and a chart without any pays one length check.
- **What a drawing gives.** The prices of its points while their time span overlaps the view, with
  every Fibonacci level (taken in price) and the second line of a channel (taken in rows, as it
  is drawn, which is exact on every scale mode because rows are linear in the scale's values). A
  horizontal line counts at any time, a vertical line never. A ray and an extended line count
  where their points are: following them to the edge of the pane would let a steep line set the
  range.
- **Precedence.** The range fitted is the union of the visible series' ranges and the primitives'
  answers, in the values of the scale (logarithms, or percent of the base of the scale's first
  series; a price a logarithmic scale cannot show is left out). The scale margins are applied to
  the union, as to series alone. A scale takes answers only when it would be fitted to its series
  anyway: `autoScale` on (or no range yet) and at least one visible series, so a range set by
  hand wins and a scale with nothing but primitives stays without a range, as in stage 4.
- **While it is edited.** A drawing being dragged is drawn on the overlay and keeps the range it
  gave before the drag: fitting to the pointer would move the scale under it. The scale is fitted
  when the drag ends.
- **Invalidation.** A change to a primitive that takes part (attach, detach, `requestUpdate`,
  the option) asks for a Light frame instead of the overlay-only frame other primitives ask for,
  and so does an answer from the time index while any takes part.

## 7.2 As built after stage 4 (save and restore)

This replaces "drawings are replaced" and the prefix rule for indicators in the "One frame"
paragraph of stage 4.

- **Drawings are matched by id** (`Drawings.restore`). A drawing whose state has the same type and
  price scale is kept: equal points, options and z-index leave it untouched, with no event, no
  time looked up and no geometry computed; a difference is taken in place (`Drawing.restore`) with
  one `changed` event. A drawing no state names, or whose state has another type or price scale
  (neither can change on a drawing), is removed with `removed`; a state without a drawing is
  added with `created`. Equal z-indexes are drawn in attach order, so a kept drawing that the
  state lists before an earlier one gets a new place in that order: the drawings end up bottom to
  top as the state lists them, and saving gives the state back. The checks still all run first
  (`planRestore`), and the whole restore is one frame; a restore of the state the chart is in
  draws the series layer once and leaves the drawings layer as it is.
- **Indicators are matched by id** (`ChartIndicators.restore`). An indicator is kept when the
  state has the same id, definition and source for it and every indicator the state has it read
  is kept too and was added before it. The last condition is the engine's: it computes indicators
  in the order they were added, and an input reads only an earlier one. So an indicator after the
  first difference stays, with its values, unless it reads something that is made again. The kept
  ones take the state's options first, then the others are removed (last first) and the missing
  ones added in the state's order. The list stays in the order indicators were added, which is
  topological, so the kept ones come before the new ones in `chart.indicators()` and in the next
  saved state, whatever the order of the state restored; the drawing order (`order`) is the
  state's.
