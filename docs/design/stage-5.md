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
