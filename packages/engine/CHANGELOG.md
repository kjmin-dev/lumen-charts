# @lumen-ticks/engine

## 0.1.0

### Minor Changes

- fd9b94e: Report errors of the data engine instead of losing them. `chart.subscribe('error', handler)` receives a `ChartError`: `engine` when the engine threw while running a command (with the message, and the value thrown on the calling thread), `worker` when the engine's worker failed after it started, and `refused` with the series id and count of updates the engine did not apply. Without a handler, engine and worker errors are reported as uncaught errors of the page. A worker that fails after it started is stopped, and every chart on it settles `whenIdle` and `whenApplied`, runs the calls that waited for data and keeps drawing what it holds. Engine events carry `error`, `cause` and `rejectedSeries`, and `EngineClient.onlost` reports a lost worker.
- 9ee1ef4: Prepend and remove heatmap and scatter marks, fetch them back from a datafeed under the memory limit, let a heatmap's grid follow the price, let marks make the timeline of a chart without bars, and read marks per bar as indicator inputs. Scatters take a size per point, color by the density of points with `colorBy: 'density'`, and answer `pointAt(x, y)`. Heatmaps with an automatic value range draw from GPU palette slots once the range settles.
- 64a361c: Add in-place mark corrections (`HeatmapSeriesApi.correct` and `ScatterSeriesApi.correct`), evict intermediate coarse mark LOD chunks under `memoryLimit` with on-demand materialization while keeping the topmost level resident, support a unified shared timeline across multiple mark series with `timeline` enabled, and render super-pixel coarse scatter LOD cells over the exact area their points cover across Canvas 2D, WebGL2, and `pointAt` hit testing.
- 591934d: Share browser resources between the charts of a page instead of creating them per chart.

  - Workers: charts share data-engine workers. The first charts get a worker each, up to a limit
    (4, or one less than the number of processor cores if that is smaller); further charts join the
    worker with the fewest charts. `setMaxWorkers(count)` changes the limit and `getMaxWorkers()`
    reads it. Charts given the same `worker` function share the workers it makes; a chart given a
    function of its own keeps a worker of its own. Each chart still has a data engine of its own
    inside its worker, and a worker stops when its last chart is destroyed.
  - Frames: one animation frame draws every chart. All charts read from the layout before any chart
    writes to the DOM, and an error in one chart no longer stops the others from drawing.
  - Size: an auto-sized chart now fills the content box of its container. It used the container's
    bounding rectangle, which made the chart too large in a container with padding or a border and
    wrong under a CSS transform. Creating a chart or changing its options no longer reads the
    layout: the size is read once, in the first frame or when it is first needed.
  - Viewport: a chart scrolled out of view keeps applying data but is not drawn until it comes back.
    `whenIdle()` does not wait for that.
  - Pointer input: hover, wheel and pinch read the chart's position at most once per frame. A wheel
    or pinch zoom is applied in the next frame, or earlier when the time scale is read or set.

  `@lumen-ticks/engine`: a worker host serves several engines, told apart by the `engine` id on
  commands and events (`HostMessage`); `EngineClient` takes its place on a pooled worker.

- dcf50f3: Add candlestick and line series on an ordinal time scale. The data engine keeps history in a chunked
  column store, runs in a worker (or time-sliced on the main thread when workers are blocked) and
  feeds the chart through window snapshots and tick patches.
- 0ed57f4: Complete the datafeed contract and the memory limit.

  - `DatafeedRequest.signal`: an `AbortSignal` aborted when the bars are no longer needed (the view
    moved away before they came, a new history, the series removed, the chart destroyed).
  - `SeriesApi.update` corrects any existing bar, also one the memory limit let go: the correction
    waits for its bars to be fetched again, and the levels of detail are rebuilt from all members.
    Bars that come back with other values than the ones let go are taken over as corrections.
  - `SeriesApi.removeBars({ from, to })` removes bars: at either end the other bars keep their
    indexes; in the middle the bars on the shorter side move over (a new epoch for the main series).
  - `SeriesApi.setData(data, { datafeed })` switches resolution or symbol with a new datafeed; requests
    for the old history are aborted and their answers ignored.
  - The memory limit applies with several series: secondary series with a datafeed are let go too,
    series without one never, and a raw window waits for the rows of every series it shows.
  - Chunks let go keep a summary instead of their time column (first and last time, checksums), which
    lowers the floor on 10M line points from about 109 MiB to the levels of detail.
  - History fetched again is drawn in the frame after the view changed instead of the second one.
  - Indicators follow changes of history: a correction recomputes them (in place when the bar is
    recent), a deletion recomputes them in the background, and a recomputation fetches the rows of
    every series it reads that were let go.

  Engine protocol: fetch requests carry an `id`, `rows` hands rows back by it, events may carry
  `cancel`, `waiting`, `applied` and `refused` (notices carry `fetch` and `cancel` for recomputations),
  a `delete` command removes bars, `set` takes `fetchable`, and window snapshots carry the `request`
  they answer.

- f44dd44: Add level of detail. The data engine keeps a pyramid of buckets (16, 64, 256, ... bars) for every
  series, built in the background after a load and updated incrementally on prepends and ticks. Above
  16 bars per device pixel the chart draws from the coarsest level whose buckets fit a pixel column,
  so frame time no longer grows with the number of bars in view, and the main thread holds buckets
  instead of raw rows for wide views. Switching between raw bars and a level draws the same pixels.
- f44dd44: Add a memory limit backed by a datafeed. `addSeries(type, { datafeed: { getBars } })` gives the
  chart a source to fetch history from again, and the `memoryLimit` chart option lets the data
  engine release bars far from the view past that many bytes and ask the datafeed for them when the
  view returns. Levels of detail and bar times stay in memory, so zoomed-out views keep drawing and
  fetched bars are checked against the released ones; mismatching bars are refused with a warning.
  Without a datafeed nothing is released.
- 0be4eb2: Add indicators computed in the data engine. `series.addIndicator(name, options)` (or
  `chart.addIndicator(source, name, options)`) adds a built-in indicator (SMA, EMA, WMA, RSI, MACD,
  Bollinger bands, ATR, Stochastic, VWAP, highest, lowest) or one registered from a plugin module with
  `chart.registerIndicators(url)`; it returns a handle with `applyOptions`, `remove` and its outputs,
  which can feed other indicators. Indicators are computed in full in the background after a load,
  a parameter change or a prepend (the old values stay on screen until the new ones are ready) and
  incrementally on every tick, in the same message as the bar. Their outputs are series on the main
  timeline with levels of detail, drawn on the price pane and included in autoscale. Adds a histogram
  series type, `chart.whenApplied()`, and the kernel contract (`IndicatorDefinition`,
  `defineIndicator`, `computeIndicator`) to the engine package.
- f9502fe: Add drawings, pane primitives and custom series renderers. `chart.drawings()` adds, lists, edits
  and removes drawings (trend line, ray, extended line, horizontal and vertical line, rectangle,
  parallel channel, Fibonacci retracement, text, price range) with style options, z-order and
  visible and locked flags; `startTool(type)` lets the user create one with the pointer, and hovering,
  selecting, dragging a drawing or one of its points, Escape, Delete and the magnet crosshair work as
  in trading terminals, with a wider hit tolerance for touch. Points are stored as times and prices,
  so drawings keep their place through prepends, deletions and changes of resolution; times between
  bars and in the future are placed between bars and at the spacing of the last bars. Events
  (`created`, `changed`, `removed`, `selected`, `hovered`) and a plain-JSON state per drawing
  (`toJSON`, with a version) come with them. Drawings have a canvas layer of their own, so hovering
  redraws only the overlay and dragging one drawing redraws no other; near a page-wide canvas budget
  (`setCanvasBudget`) they move into the series layer. `chart.attachPrimitive` and
  `series.attachPrimitive` take user code that draws below the series, with the drawings or on the
  overlay, with the chart's coordinate conversions and hit testing; `series.setRenderer` and
  `indicator.output().setRenderer` draw a series or an indicator output with user code. The engine
  gains a `resolve` command that maps times to logical positions on the main timeline.
- cea020e: Heatmap and scatter series. `chart.addSeries('scatter')` takes points at any time and price, many
  per bar, each colored by a value; `chart.addSeries('heatmap')` takes columns of cells on a grid of
  prices, as an order book or a volume profile over time. Both keep their data in the data engine,
  with levels of detail of their own, and are drawn through a pixel buffer, so a frame costs by the
  pixels of the pane rather than by canvas calls: a million points or cells in view pan within the
  frame budget. They take a palette, a fixed or automatic value range, opacity and a price scale, are
  updated live (`update`, `append`), and are saved and restored with the chart's state.
  `chart.markSeries()` lists them.

  The engine's protocol gains the `marks` and `marksWindow` commands and `marks` on events
  (`EngineClient.addMarks`, `changeMarks`, `requestMarks`, `onmarks`).

- 3dd18c0: Refine the worker declaration and pooling interface with zero hot-path overhead:

  - **Polymorphic `WorkerSource` & `WorkerOption`**: `worker` now accepts URL strings, `URL` objects (normalized by absolute `href` so callers share a pool automatically), bundler worker constructors such as Vite `?worker` imports (invoked safely with `new` instead of silently falling back to the main thread), `'dedicated'` for an unshared worker per chart, explicit `WorkerPool` handles, and existing booleans or `() => Worker` factories.
  - **Global configuration (`configureWorker` / `getWorkerConfig`)**: configure the default worker source, `maxWorkers`, and `timeout` once at app startup instead of threading worker factories through every chart.
  - **Explicit `WorkerPool` (`createWorkerPool`)**: manage isolated bounded worker pools with `maxWorkers`, `activeWorkers`, `engines`, optional `warmup(count?)` pre-starting, and `destroy()` teardown.
  - **Standalone `./worker` across every package**: `lumen-ticks`, `@lumen-ticks/core`, and all four framework bindings (`react`, `vue`, `svelte`, `solid`) now export a zero-import bundled `./worker` entry (with explicit `"sideEffects": ["./dist/worker.js"]`) and re-export the worker helpers directly.
  - **Options handling**: `DeepPartial`, `mergeOptions`, and `optionsEqual` now preserve `URL`, constructor, and `WorkerPool` values intact instead of flattening non-plain objects.

### Patch Changes

- a0c3771: Start background work right after a command. A worker waited 20 ms after each command before it
  recomputed indicators or built levels of detail, so the window request after a load could go first.
  It now starts at once in 1 ms slices for those 20 ms: with 20 indicators, a 10k prepend through the
  worker shows its indicators after about 19 instead of 52 ms, and a load of 1M bars settles about
  30 ms sooner.
- 93097db: Reduce main-thread allocation when charts receive indicator updates. The chart requests packed buffers
  for changed rows. Existing engine clients continue to receive arrays of patches by default.
- ca86b18: Make ticks cheaper on long histories. A chart names the levels of detail it holds with each window
  request, and the engine sends changed buckets of those levels only, instead of every level. A tick
  that adds no bar no longer sends the bucket times of coarse levels, which it cannot change.
  `EngineClient.requestWindow` takes the levels as an optional bitmask; clients that do not pass it
  receive every level as before.
- c261b75: Fix a window request failing after the history was replaced (for example at another resolution)
  while an indicator was still being computed in the background.
- 6c1a6d5: Run heatmap and scatter removals and corrections that wait for marks let go under the memory limit when the datafeed already returns the changed history. Such a change stood for a change at the source, yet the marks it waited for were refused unless they were the ones let go, so it was asked for again forever and every later change of the series waited behind it. A chunk the first waiting change needs may now come back as it went or as the change, and maybe some behind it, leave it: marks inside the changes' ranges must be their own, and are put in only right before the change runs. Scatter changes of other times are reordered or merged so that the marks returned fit. A change whose marks fit neither is dropped after three rounds of requests (pauses of 1, 2 and 4 s, once per round) and reported as a `refused` error of its series, and the changes behind it run.

  A removal or correction now fetches only marks that stay: none inside it, a heatmap level is kept rather than fetched only to be dropped, coarse chunks let go are made from the finest level held instead of whole chunks of every level, and a scatter removal decides which side moves only once its edges are back. A heatmap correction of one column fetches one chunk instead of up to 64; 30 points removed from a million let go fetch 4 to 9 chunks of 14 instead of 4 to 13. Reading a row let go, or writing a chunk let go in part, now throws instead of leaving zeros. Also fixes a scatter prepend that lost coarse cells where a bucket ended in a chunk let go, and a search over chunks that failed once points were prepended.

- 596451b: License the packages under MIT. Each package declares the license and ships a copy of it.
- 73d2dbe: Ship a README and the TypeScript sources with every package, so source maps and declaration maps
  resolve in editors and bundlers.
- 99d02d3: Make wide views with indicators and loads cheaper: the loops that take a highest and a lowest value
  (pixel columns and price range of a series view, level-of-detail buckets, rolling highest and
  lowest, Stochastic's range) use `Math.max` and `Math.min` instead of comparisons, which V8 compiles
  without the branches that prices mispredict.

  One rule now holds wherever an extreme is taken: of values that include zeros of both signs, the
  highest is `+0` and the lowest is `-0`, whatever their order. Before, the zero met first was kept,
  so the sign of such a zero could differ from now, and in the rolling highest and lowest (and
  Stochastic) it depended on where a computation started. Nothing else changes: missing values are
  skipped as before.
