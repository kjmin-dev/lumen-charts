# Stage 5: the optional steps, as decided and as built

Stage 5 of the [design](../design.md) is optional: each step is taken only with profiling evidence.
Of the optional steps of stage 5, the partial redraw of tick frames is built: a
tick that leaves the view and the price scales as they are redraws only the columns it changed.

Each heading below is the section of the design the text under it belongs to, and section numbers
in the text are those of the design. The measurements are in
[docs/benchmarks/stage-5-profile.md](../benchmarks/stage-5-profile.md),
[stage-5-min-max.md](../benchmarks/stage-5-min-max.md) and
[stage-5-partial-redraw.md](../benchmarks/stage-5-partial-redraw.md).

## 4.2 LOD pyramid

- As built in stage 5: of a bucket that holds zeros of both signs, the highest value is +0 and the lowest is −0, whatever their order (section 5.1, "Extremes and the sign of zero").

## 5. Compute layer

- As decided in stage 5 ([measured](../benchmarks/stage-5-profile.md)): no WASM kernels for now.
  - Share: kernels take 56% of the engine's time in a load of 1M bars with 20 indicators, 2% of its time in a tick, and none of a frame.
  - Speed: Rust ports of eight kernels gave the same bits over 1M rows. The recursive ones (SMA, EMA, WMA, RSI, MACD, Bollinger) ran at 0.95–1.24 times JavaScript. Only the loops that take a minimum and a maximum gained: rolling extremes 10 times, Stochastic 3.9 times, level-of-detail buckets 7 times (20 with SIMD).
  - Those loops are slow in JavaScript because V8 compiles their comparisons to branches that prices mispredict. With `Math.max` and `Math.min` (after a test for NaN) they run 1.5–4.8 times faster, at the speed of scalar WASM for the buckets. That change is adopted instead (section 6.2, built in stage 5); what WASM would add after it is under a tenth of a load that has no budget to meet.
  - Reconsidered when a kernel V8 compiles badly cannot be fixed in JavaScript, or when loads get a gate the JavaScript kernels miss.

## 6.2 Stage 5: as decided, and as built

Stage 5 profiled `main` after stage 4 and decided each optional step against the criteria above
([stage 5 profile](../benchmarks/stage-5-profile.md)). The two steps adopted are built: partial
redraw and the min/max loops.

- **Partial redraw of tick frames: built** ([stage 5 partial redraw](../benchmarks/stage-5-partial-redraw.md)).
  Light invalidation exceeded its budget in one place: with 20 indicators and all 1M bars in view,
  a tick's frame took 4.1 ms of JavaScript inside the 4 ms the stage 3 gate gives the whole tick,
  80% of it drawing lines that did not change. Such a frame now clears and redraws only the device
  columns in which something changed, through a clip: 0.50 ms of JavaScript instead of 4.13 ms in that case, and 1.0 ms instead of 4.3 ms in the GPU process.
  - **When.** A frame asked for by data alone (an engine event; every other change marks the layer
    stale) keeps the series layer if it was drawn with the same geometry, window (`version`), vertical
    grid lines and session marks (their positions, since a new bar computes the time ticks again
    without moving them), grid scale and ticks, and every series with the same items
    (`SeriesView.generation`) and price mapping (offset, factor, logarithm). The checks are a few
    comparisons per series; nothing is allocated. Anything else is a full redraw, as before: a tick
    that moves a price scale, a new bar that adds an item or scrolls the view, a replaced window, a
    change of options, size or pixel ratio, a canvas the browser restored.
  - **Which columns.** `SeriesView.update` notes the items it rebuilt in place; the columns are
    those from the item before the first to the item after the last (a changed point moves the line
    from both neighbors), widened by what a series draws around an item: half the line width, the
    half pixel a merged column's path is offset by, and a pixel of antialiasing; the body width
    for candles and bars. They are the union over the series, so an output that changes anywhere
    (a correction of an old bar, an output drawn shifted) dirties its own columns. No dirty column
    in the pane: the layer is left as it is.
  - **What is drawn.** Inside the clip, the same calls in the same order as a full redraw:
    background, session shading, grid, session breaks, watermark, then each series over the items
    that can reach the columns, plus one on either side, so a line's first and last point (a cap
    where the whole path has a join) lie outside the clip by more than the stroke reaches.
    Coordinates of items that did not change are not computed again (`SeriesView.project`).
  - **Dashes** are counted along the path. A dashed or dotted line is drawn from its first item,
    and its columns reach to the right edge of the pane, since a change moves every dash after it.
  - **A single segment.** Chromium strokes a path of one segment as another shape than a longer
    path (its ends are antialiased beyond the cap), which showed as the one pixel difference of the
    first comparison. `drawLine` widens a range that holds one segment until it holds two or is the
    whole line.
  - **Full redraw kept** for a custom series renderer, a `bottom` primitive and drawings merged
    into the series layer: the chart cannot bound what they draw.
  - **Tested** by a model of what reaches a range of columns (unit tests, every frame against full
    redraws of the state before and after) and pixel for pixel in headless Chromium
    (`pnpm bench:pixels`): 2,025 comparisons over 1,788 partial frames at pixel
    ratios 1, 1.5 and 2 with no pixel different where the canvas is rasterized on the GPU.
    Chromium's software rasterizer draws a line slightly differently along its length when its
    last point moves, so there two full redraws already differ in columns where nothing changed,
    and a partial frame differs from a full one in a few antialiased pixels.
- **Cheaper wide-view frames: the min/max loops.** `SeriesView.update`, which merges rows into
  pixel columns, is 20–41% of a pan frame with 20 indicators; the level-of-detail builds and the
  rolling extremes are 38% of the engine's time in a load. All take a running minimum and maximum
  by comparison. With `Math.max` and `Math.min` they run 1.5–4.8 times faster, more on noisy series
  than on smooth ones. The one difference is the sign of a zero where a bucket holds both zeros,
  which the change has to settle in one rule for every place a value can be computed two ways.
  - As built ([measured](../benchmarks/stage-5-min-max.md)): changed in `SeriesView.update` (both
    merges and the price range), `aggregate`, `lineBuckets`, `rollingExtreme`, the merge of
    secondary bars into a main bar and the range of a price axis. ATR's largest of three ranges
    stays a comparison (no gain measured), as does `lowestPositive`.
  - The rule: of values that include both zeros, the highest is +0 and the lowest −0, in any order
    (section 5.1, "Extremes and the sign of zero"). It also removes a dependence of the rolling
    extremes on where a slice starts, which the comparisons had for such windows.
  - Measured at 1M candles with 20 indicators, before and after in turns on a busy machine: a pan
    frame with 20,000 bars in view 5.5 → 4.2 ms of JavaScript at p50 (−24%), with all bars in view
    4.1 → 3.8 ms at p50 and 5.6 → 4.9 ms at p95; a load's indicators settled after 351 instead of
    431 ms through the worker (313 instead of 391 ms on the main thread); a 1M prepend shown after
    0.41 instead of 0.53 s. Frames without indicators and ticks show no change beyond the spread
    of the runs.
- **`OffscreenCanvas`: deferred.** Drawing costs the same in a worker (3.4 against 3.5 ms a
  frame), and no frame misses its budget for being on the main thread (p95 0.3–6.7 ms against
  8 ms). It keeps 60 frames a second under a host page that blocks the main thread 91% of the
  time, where the main thread presents 21; pointer input waits for that thread either way. It would
  move the model, views and window cache into the worker and keep a main-thread path beside it
  (principle 4). Reconsidered when displaying under a busy host page becomes a requirement.
- **GPU layer: deferred until the series it serves exist.** Canvas 2D drawn rectangle by rectangle
  breaks at 100,000 scatter points (17.8 ms of JavaScript a frame) and between 14,400 and 240,000
  heatmap cells. Drawn through a pixel buffer (`putImageData`, or a small image scaled by one
  `drawImage`) it takes 5.8 ms for 1M points and 3.0 ms for 1.44M cells. Heatmap and scatter
  series start on that path, as custom renderers; the WebGL2 module follows for more than about a
  million marks changing every frame, or for marks that blend.
- **Candles in one path** (the assumption above) was not pursued: without indicators a frame takes
  0.3–0.5 ms, of which the candle loops are 0.06–0.13 ms.

## 9. Stages and measurement gates

Stage 5, the evidence (measured, [stage 5 profile](../benchmarks/stage-5-profile.md)): partial redraw
of tick frames and branch-free min/max loops are adopted, WASM kernels are rejected for now,
`OffscreenCanvas` and the GPU layer are deferred (sections 5 and 6.2). Each adopted step is
measured again on the gate cases when it is built.

Stage 5, the min/max loops (measured, [stage 5 min and max](../benchmarks/stage-5-min-max.md)): with
20 indicators on 1M candles, pan frames take 4.2 instead of 5.5 ms of JavaScript at p50 with 20,000
bars in view and 4.9 instead of 5.6 ms at p95 with all bars in view (gate: p95 8 ms), and the
indicators of a load settle a fifth sooner.

Stage 5, partial redraw (measured, [stage 5 partial redraw](../benchmarks/stage-5-partial-redraw.md)):
with 20 indicators and all 1M bars in view, a tick's frame takes 0.50 instead of 4.13 ms of
JavaScript, and tick to applied through the worker has a p99 of 4.02 ms (2.48–4.79 over 7 rounds)
instead of 6.12 ms (4.69–9.25), measured alternately on a machine under heavy load from other work
(gate: 4 ms; `main` measured 3.9–4.5 ms on a quieter machine). Pan and zoom frames are unchanged.

## 10. Open questions

- Open after stage 3, the first open question of section 10: the p99 of a tick applied through the
  worker with 20 indicators and all 1M bars in view.
  - As decided in stage 5: partial redraw of tick frames takes the frame out of that p99
    (section 6.2). What then remains is what the 200-bar view has, 3.0–3.3 ms, and the trace shows
    that part is not frames (they take 0.4 ms there) but garbage collection on the main thread:
    about 20 tasks of 2–16 ms in 3 s of ticks. Whose garbage it is, the patch objects of the
    library or the benchmark's own pause loop, is open [measured: [stage 5 profile](../benchmarks/stage-5-profile.md)].
  - As built in stage 5: the frame is out of that p99: a tick's frame takes 0.5 instead of 4.1 ms,
    and the p99 fell from 6.12 to 4.02 ms on a heavily loaded machine, lower in each of 7
    alternating rounds and under 4 ms in 3 of them. Whether it holds the gate on a quiet machine,
    where the 200-bar view's 3.0–3.3 ms is the floor, is still to be measured
    [measured: [stage 5 partial redraw](../benchmarks/stage-5-partial-redraw.md)].

## 6.2 Partial redraw: an option to turn it off, and dashed lines from the columns

Two limits of the partial redraw above are closed, and a third is decided
([measured](../benchmarks/stage-5-partial-redraw-options.md)).

- **`redraw: 'auto' | 'full'`, a chart option.** `auto` (the default) is the behavior above. With
  `full`, a frame asked for by data alone draws the whole series layer, like any other frame: the
  test that finds the dirty columns answers "full" first.
  - It is for canvases rasterized in software, where a partial frame differs from a full redraw in
    a few antialiased pixels because the rasterizer antialiases a line by its whole path. With the
    option the pixel check finds no difference on either rasterizer (2,430 comparisons each).
  - There is no `partial` value: every case that falls back to a full redraw does so because the
    columns cannot be bounded or the layer is out of date, which no option can waive.
  - **`auto` does not detect the rasterizer.** Two ways were considered and neither is reliable.
    The renderer string of a WebGL context (`UNMASKED_RENDERER_WEBGL`: SwiftShader, llvmpipe) costs
    a WebGL context per page and tells how WebGL is drawn, not a 2D canvas: a canvas made with
    `willReadFrequently`, or one the browser moved off the GPU after reading it, is rasterized in
    software on a machine whose WebGL is not. A probe (stroke a line twice on a canvas with its last
    point moved, compare far columns) has to read the canvas back, and reading back is what makes
    Chromium rasterize a canvas in software; on a canvas of its own it measures that canvas, not
    the chart's. So the option is documented and the page decides.
- **A dashed or dotted line is drawn from the dirty columns**, not from its first item.
  - Dashes are counted along each subpath from its start, so a path that starts at a later item has
    to tell the rasterizer how long the whole path is before that item. `SeriesView` keeps those
    lengths per item for the path `drawLine` traces (`lineLengths`), computed when a dashed line is
    first drawn in part and afterwards only from the first rebuilt or projected item on: a tick on
    the last bar computes none.
  - **A dash offset of that length is not exact.** Skia sums the lengths of a path's segments in
    single precision and places each dash by that sum. A path that starts later sums from zero,
    rounds otherwise, and its dashes land thousandths of a pixel off (hundredths at a length of
    100,000 pixels, tenths at 500,000), which flips antialiasing samples at many dash ends: 51 of
    64 probe paths differed from the whole path inside the clip, by a quarter of the line's color
    and more in 99,000 pixels together, and the first version of this change failed 180 of 405
    pixel comparisons.
  - **A lead of that length is exact.** The path starts left of its first point, level with it, as
    far away as the whole path is long before that point, so the rasterizer arrives at the first
    point with the sum it has there in the whole path and goes on to the same dashes. The length is
    summed the way Skia sums it: per segment in single precision, each product and the sum rounded
    on their own (with the squares added before rounding, 2 of 384 probe paths differed in a
    pixel; with exact lengths 294 did; with this, none). The dashes along the lead and the join at
    its end are left of the clip, like the cap of a solid line that starts there.
  - The lead is one horizontal segment, so its length is the difference of two x coordinates in
    single precision, which the chart can check: where no x gives exactly the length (a short piece
    after a gap, far from the left edge), the line is drawn from its first item as before. A gap
    inside the range needs nothing: the piece after it starts its dashes at zero in both paths.
  - The columns of a dashed line still reach to the right edge of the pane, since a change of the
    path's length moves every dash after it.
  - A tick no longer traces the path in JavaScript: with five dashed lines over 1M points in view,
    215 `lineTo` calls per tick instead of 44,050 and a frame of 0.26 ms of JavaScript instead of
    1.39 ms. What remains: the rasterizer still makes the dashes of the lead, as many as the whole
    path had up to there, and clips them away (3.6 ms a frame in the GPU process for those five
    lines instead of 7.7 ms, against 1.0 ms for solid ones).
  - Exact where it was measured: Chromium on arm64, GPU rasterization, pixel ratios 1, 1.5 and 2
    (2,430 comparisons over 2,284 partial frames, 405 of them on a chart of dashed and dotted lines
    alone, no pixel different). A rasterizer that sums lengths otherwise would place dashes
    thousandths of a pixel off in a partial frame, as the dash offset does; `redraw: 'full'` is the
    way out there too.
- **A new bar on a chart that follows the last bar stays a full redraw.** Shifting the layer by a
  bar (`drawImage` of the canvas onto itself) and drawing the new columns is exact only when a bar
  is a whole number of device pixels wide, since items are rounded to pixels one by one. Even then
  the layer holds what does not move with the bars: the watermark, dashed horizontal grid lines
  (their dashes start at the left edge), time ticks that are chosen again, the cap where each line
  enters at the left edge, and the price scale, which a new bar often moves. It would save one
  frame per bar, not per tick, behind several more conditions on the fast path. Left as it is.
- **Tested** as above: the model of the unit tests now takes a dashed segment with the length of
  its line before it summed in single precision, so a partial frame passes only with a lead of
  exactly the right length (a lead a pixel off, or none, fails 14 tests). The pixel check has a
  chart of dashed and dotted lines (wide and translucent, stepped, with gaps, and one whose path
  through merged columns is many times as long as the pane is wide), and `--redraw full` runs every
  case with the option, where each frame must be a full one and no comparison may differ on either
  rasterizer.

## Allocations between ticks

The indicator benchmark created a message channel for each turn of its wait loop. An idle worker wait removes most of those allocations. Packing the changed rows of all indicators into two transferred buffers further reduces library allocations on the main thread. Charts request packed patches on their first engine command. Direct clients get object patches by default, including clients using an older worker. See the [allocation profiles and gate measurement](../benchmarks/gc-floor.md).

## Background work right after a command

A worker host waited 20 ms after a command before it started background work, so that the window
request that follows the answer to a load or a prepend would not wait behind a slice of it. The
worker sat idle meanwhile, and a prepend that needs no window request (the bars land outside the
view) waited the whole 20 ms for nothing: a worker's 10k prepend settled at 52 ms against the main
thread's 28 ms (stage 3).

- **As built.** Background work starts in a task of its own right after a command, behind the
  messages that have arrived by then. For 20 ms after each command it runs in slices of 1 ms
  instead of 4 ms, so a window request that arrives meanwhile waits at most a short slice. Every
  command opens those 20 ms again.
- **Measured** ([background-start.md](../benchmarks/background-start.md)): a 10k prepend's
  indicators are shown after 18.6–18.8 instead of 51.8 ms with 1M bars, a load of 1M bars with 20
  indicators settles after 283 instead of 316 ms. The bars of a prepend reach the screen about
  0.8 ms later, the wait for the slice under way. Ticks are unchanged.
