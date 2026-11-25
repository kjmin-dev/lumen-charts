# @lumen-ticks/core

## 0.1.0

### Minor Changes

- 9ed5a66: Add per-chart accessible names, screen reader data summaries and a keyboard navigator for inspecting prices, moving through history and zooming. Applications can configure navigator key bindings per chart, including modifier combinations and physical keys.
- bf975a1: Add chart events and coordinate conversions. `chart.subscribe('crosshairMove' | 'click', handler)` hands over a `ChartPointerEvent` with its source (pointer, keyboard or api), the point, the bar index and time, and the value of every series and indicator output there; events come at most once per frame, after it was drawn, and are built only while someone listens. `setCrosshairPosition(time, price, scaleId?)` and `clearCrosshairPosition()` place the crosshair for charts that sync it. The time scale gains `visibleLogicalRangeChange` and `visibleTimeRangeChange` events, `getVisibleRange` and `setVisibleRange` by time, and `timeToCoordinate`, `coordinateToTime`, `logicalToCoordinate` and `coordinateToLogical`.
- fd9b94e: Report errors of the data engine instead of losing them. `chart.subscribe('error', handler)` receives a `ChartError`: `engine` when the engine threw while running a command (with the message, and the value thrown on the calling thread), `worker` when the engine's worker failed after it started, and `refused` with the series id and count of updates the engine did not apply. Without a handler, engine and worker errors are reported as uncaught errors of the page. A worker that fails after it started is stopped, and every chart on it settles `whenIdle` and `whenApplied`, runs the calls that waited for data and keeps drawing what it holds. Engine events carry `error`, `cause` and `rejectedSeries`, and `EngineClient.onlost` reports a lost worker.
- 4f3d46f: Select Canvas 2D, WebGL2 or WebGPU per chart for scatter and heatmap series. WebGL2 is the default and the preferred fallback for WebGPU. Canvas 2D handles environments without either GPU API. The former `auto` setting resolves to WebGL2.
- 69de92d: Add independently sized indicator and volume panes, spaced price-axis labels and nearest-series crosshair snapping. Align single-column heatmap queries with their displayed extent. Reuse mark images, coordinate tables and shared WebGL drawing buffers during live chart updates.
- 9ee1ef4: Prepend and remove heatmap and scatter marks, fetch them back from a datafeed under the memory limit, let a heatmap's grid follow the price, let marks make the timeline of a chart without bars, and read marks per bar as indicator inputs. Scatters take a size per point, color by the density of points with `colorBy: 'density'`, and answer `pointAt(x, y)`. Heatmaps with an automatic value range draw from GPU palette slots once the range settles.
- f4495e7: Add optional WebGPU and adaptive scatter and heatmap rendering with per-series diagnostics, shared GPU resources and Canvas 2D recovery.
- 64a361c: Add in-place mark corrections (`HeatmapSeriesApi.correct` and `ScatterSeriesApi.correct`), evict intermediate coarse mark LOD chunks under `memoryLimit` with on-demand materialization while keeping the topmost level resident, support a unified shared timeline across multiple mark series with `timeline` enabled, and render super-pixel coarse scatter LOD cells over the exact area their points cover across Canvas 2D, WebGL2, and `pointAt` hit testing.
- 6c1a6d5: Finish the price axes. Value labels on an axis no longer cover each other: each stays as near its value as the others allow, in value order, labels that would overlap move apart around the mean of their values, and when an axis cannot fit them all the series drawn last lose theirs first (before, labels were pushed down from the top and those nearest the top were kept); the crosshair's label stays at the pointer, over them. Price scales follow what is on them: a scale no option lists goes once no series, indicator output, heatmap, scatter, primitive or drawing is on it, and one `priceScales` lists keeps its options and range but takes no axis width or pane while nothing is on it. `chart.removePriceScale(id)` takes a scale out of the options; `PriceScaleApi` handles stay valid by id. The wheel, a trackpad pinch and a two-finger pinch over a price axis scale that axis around the price under the pointer and turn its `autoScale` off, as dragging it does; over the pane they still zoom time.

  Behaviour change: the `magnet` crosshair mode now snaps to the open, high, low or close (the value, for lines and histograms) nearest to the pointer on screen among the visible series of the pane under the pointer, each placed by its own price scale, instead of the close of the first eligible series. `nearest` does the same with closes only. Drawing points snap the same way among the series on the drawing's scale, so `nearest` mode now snaps them to closes.

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
- 2107937: Add multiple price axes. Besides the default price scale (`priceScale`, id `default`), a chart takes
  any number of scales by id in `priceScales`: axes on the left or the right, several per side, or
  overlays without an axis. Series and indicators choose theirs with `priceScaleId`, which can change at
  any time. Each scale has a mode (`normal`, `logarithmic`, `percentage`, `indexed`, the last two
  relative to each series' first visible bar), autoscale, margins and inversion. Series take a tick
  size (`minMove`) and `precision` for their labels and the ticks of their axis; logarithmic axes tick
  on round prices. Dragging an axis scales it and a double click resets it; the crosshair shows its
  price on every visible axis and value labels go on the axis of each series. New API:
  `chart.priceScale(id)`, `series.priceScale()`, `series.priceToCoordinate(price)` and
  `series.coordinateToPrice(y)`, and the `PriceScaleApi`, `PriceScaleMode` and `PriceRange` types.
- 1bc481a: Add save and restore of a chart's state. `chart.saveState()` returns plain JSON with a `version`
  (`CHART_STATE_VERSION`): the options applied, the series and indicators with their ids and options,
  the drawings, and the view as the times at the edges of the pane and the ranges of price scales
  that do not autoscale. `chart.restoreState(state)` checks all of it first and throws, leaving the
  chart as it was, for another version or a state that is wrong anywhere; then it applies it in one
  frame. Series the chart already has are matched by `id` and keep their bars, datafeed, renderer and
  primitives; indicators are kept where they are the same and computed again otherwise; the view
  comes back to the same times whatever history is loaded. Bars, the size of the chart, `worker`,
  `memoryLimit` and formatter functions are not saved; custom indicators are saved by name and must
  be registered before a restore. Both calls take `{ parts }` to work on some of `options`, `series`,
  `indicators`, `drawings` and `view`.

  Series and indicators have an `id` (the `id` option when they are added, or `series-1`,
  `indicator-1`, ... by default), and `chart.series()` and `chart.indicators()` list them.
  `indicator.options()` includes the `id`.

  `indicator.applyOptions` no longer computes the indicator again when the parameters it is given are
  the ones it has.

- a3358c0: Add time zones, locales and trading sessions to the chart. `localization.timeZone` (an IANA name,
  `UTC` by default, or `local`) puts the time axis, its day, month and year boundaries and the
  crosshair's time label on the zone's wall clock through daylight saving changes; it can change at
  run time with `applyOptions`. Offsets come from a per-zone table built lazily from `Intl`, so
  frames make no `Intl` call. `localization.locale`, `tickMarkFormatter` and `timeFormatter` format
  the labels. `sessions.schedule` describes when the market trades (plain JSON: the exchange's zone,
  weekdays, regular, pre- and post-market sessions, holidays); with it the axis counts trading days
  and prefers session starts for labels, extended hours are shaded and `sessions.breaks` draws a line
  at the first bar of each trading day. `timeScale().isInSession(time)` and `sessionAt(time)` answer
  session queries. Bar times stay UTC milliseconds and the engine is unchanged.
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

- 4903db6: Add light and dark themes (plus `auto`, which follows the system color scheme) and display options:
  grid line visibility and style, crosshair modes and line styles, price axis position, visibility,
  border and margins, time axis visibility and border, and a watermark. Series gain `visible`, a
  separate price line with its own color, width and style, candle outlines and optional wicks, and line
  style, step lines and a crosshair marker. Chart options are now nested (`layout`, `grid`,
  `crosshair`, `priceScale`, `timeScale`, `watermark`) and `applyOptions` merges them deeply; the
  bindings take `DeepPartial<ChartOptions>`.
- 3dd18c0: Refine the worker declaration and pooling interface with zero hot-path overhead:

  - **Polymorphic `WorkerSource` & `WorkerOption`**: `worker` now accepts URL strings, `URL` objects (normalized by absolute `href` so callers share a pool automatically), bundler worker constructors such as Vite `?worker` imports (invoked safely with `new` instead of silently falling back to the main thread), `'dedicated'` for an unshared worker per chart, explicit `WorkerPool` handles, and existing booleans or `() => Worker` factories.
  - **Global configuration (`configureWorker` / `getWorkerConfig`)**: configure the default worker source, `maxWorkers`, and `timeout` once at app startup instead of threading worker factories through every chart.
  - **Explicit `WorkerPool` (`createWorkerPool`)**: manage isolated bounded worker pools with `maxWorkers`, `activeWorkers`, `engines`, optional `warmup(count?)` pre-starting, and `destroy()` teardown.
  - **Standalone `./worker` across every package**: `lumen-ticks`, `@lumen-ticks/core`, and all four framework bindings (`react`, `vue`, `svelte`, `solid`) now export a zero-import bundled `./worker` entry (with explicit `"sideEffects": ["./dist/worker.js"]`) and re-export the worker helpers directly.
  - **Options handling**: `DeepPartial`, `mergeOptions`, and `optionsEqual` now preserve `URL`, constructor, and `WorkerPool` values intact instead of flattening non-plain objects.

### Patch Changes

- b86ac7a: Refactor how the chart connects indicators, data updates, saved state and mark series during construction.
- 93097db: Reduce main-thread allocation when charts receive indicator updates. The chart requests packed buffers
  for changed rows. Existing engine clients continue to receive arrays of patches by default.
- ca86b18: Make ticks cheaper on long histories. A chart names the levels of detail it holds with each window
  request, and the engine sends changed buckets of those levels only, instead of every level. A tick
  that adds no bar no longer sends the bucket times of coarse levels, which it cannot change.
  `EngineClient.requestWindow` takes the levels as an optional bitmask; clients that do not pass it
  receive every level as before.
- 6c1a6d5: Close gaps of the GPU mark renderers found on a physical Android phone. A WebGL2 scatter writes the points of a small append into its retained image in Canvas 2D, as the Canvas 2D and WebGPU paths do, instead of drawing a strip of the pane and copying it back, and a WebGL2 heatmap translates its retained image on a pan by whole device pixels. The column ranges of WebGL2 and WebGPU scatter draws search the rows near the previous column instead of the whole window, and WebGL2 draws scatter points as point sprites, one vertex each and without instancing, where the context's sprites are as large as the widest point: a quarter of the GPU time of the instanced quads for a million points on an Apple M1. WebGL2 draws into a premultiplied drawing buffer with colors premultiplied as the page's Canvas 2D premultiplies them, so the browser no longer converts the buffer when it copies it, a conversion whose rounding differs from Canvas 2D's on some devices; WebGPU premultiplies by the same rule instead of in its kernels. The rule is measured once per page, with the first translucent color. Firefox, which rounds up, matches byte for byte. WebGPU writes a retained, transposed image and copies the strip it drew into a canvas configured without storage usage, which spares Chrome on Android a copy of the whole canvas per frame, and composites it with the same transposed draw as the other two paths.
- 6c1a6d5: Run heatmap and scatter removals and corrections that wait for marks let go under the memory limit when the datafeed already returns the changed history. Such a change stood for a change at the source, yet the marks it waited for were refused unless they were the ones let go, so it was asked for again forever and every later change of the series waited behind it. A chunk the first waiting change needs may now come back as it went or as the change, and maybe some behind it, leave it: marks inside the changes' ranges must be their own, and are put in only right before the change runs. Scatter changes of other times are reordered or merged so that the marks returned fit. A change whose marks fit neither is dropped after three rounds of requests (pauses of 1, 2 and 4 s, once per round) and reported as a `refused` error of its series, and the changes behind it run.

  A removal or correction now fetches only marks that stay: none inside it, a heatmap level is kept rather than fetched only to be dropped, coarse chunks let go are made from the finest level held instead of whole chunks of every level, and a scatter removal decides which side moves only once its edges are back. A heatmap correction of one column fetches one chunk instead of up to 64; 30 points removed from a million let go fetch 4 to 9 chunks of 14 instead of 4 to 13. Reading a row let go, or writing a chunk let go in part, now throws instead of leaving zeros. Also fixes a scatter prepend that lost coarse cells where a bucket ended in a chunk let go, and a search over chunks that failed once points were prepended.

- 1164222: Make pans of wide views cheaper. Below a pixel per bar, a pan moves the pixel columns the bars are
  merged into by whole pixels, so a series view now keeps the columns it holds and merges only those
  the pan uncovers, instead of merging every column of every series again. With 20 indicators on 1M
  candles, a pan frame takes 3.4 instead of 4.3 ms of JavaScript with 20,000 bars in view.
- 596451b: License the packages under MIT. Each package declares the license and ships a copy of it.
- 6c1a6d5: Draw only what changed on the overlay. A frame compares the crosshair's lines, markers and labels, the handles of highlighted drawings and, after new data, the price lines and value labels with what it drew, and clears and redraws only the boxes of those that changed, with the pixels of a full redraw. Dashed lines in opaque colors are copied from a strip of their dashes instead of drawn dash by dash: a hover frame over 1,000 drawings makes about 17 Canvas 2D calls instead of about 470. Primitive layers skip their entries while no view changed, and a tick takes the price range of the items it rebuilt instead of every item of every series.
- baccf89: Add the `redraw` option: `auto` (default) redraws only the pixel columns a tick changed, as before;
  `full` draws the whole series layer for every tick, for pages whose canvases are rasterized in
  software, where a partial frame differs from a full redraw in a few antialiased pixels.

  A tick no longer costs a dashed or dotted line its whole path. Such a line is drawn from the columns
  that changed, after a lead as long as the path before them, so its dashes fall where those of the
  whole path do, pixel for pixel.

- 73d2dbe: Ship a README and the TypeScript sources with every package, so source maps and declaration maps
  resolve in editors and bundlers.
- 9674020: Close three limits of drawings and of save and restore.

  Rectangles and price ranges have eight handles: the four corners and the middle of each edge.
  Dragging one leaves the opposite corner or edge where it is. They are still two points in
  `points()` and in the saved state, so states written before stay valid; a hit test answers
  `1 + k` with `k` up to 7 for them.

  Primitives and drawings can take part in autoscale. A pane primitive with an
  `autoscale(range, view)` method is asked for the prices to keep in view in the frames that compute
  price ranges, and a drawing takes part with the new `autoscale` option (default `false`): while
  the time span of its points overlaps the pane, its price scale keeps it in view. The range is
  joined with the series' range, the scale margins go around both, and a scale that does not
  autoscale keeps its range. `AutoscaleRange` is exported.

  `restoreState` matches drawings by id: a drawing whose state is what it is already is left alone
  (no event), one that differs is updated in place with one `changed` event instead of a `removed`
  and a `created`, and only the rest are added or removed. Indicators are matched by id as well: one
  after the first difference is kept when its definition and source are the same and everything it
  reads is kept; indicators a restore adds are listed after the ones it keeps.

- 99d02d3: Make wide views with indicators and loads cheaper: the loops that take a highest and a lowest value
  (pixel columns and price range of a series view, level-of-detail buckets, rolling highest and
  lowest, Stochastic's range) use `Math.max` and `Math.min` instead of comparisons, which V8 compiles
  without the branches that prices mispredict.

  One rule now holds wherever an extreme is taken: of values that include zeros of both signs, the
  highest is `+0` and the lowest is `-0`, whatever their order. Before, the zero met first was kept,
  so the sign of such a zero could differ from now, and in the rolling highest and lowest (and
  Stochastic) it depended on where a computation started. Nothing else changes: missing values are
  skipped as before.

- 5416630: Redraw only what a tick changed. A frame drawn for new data alone, with the view, the price scales
  and everything else on the series layer as they were, clears and redraws the device columns of the
  changed bars instead of the whole layer, and leaves the layer alone when nothing in view changed.
  The pixels are those of a full redraw. With 20 indicators over 1M bars in view this takes the
  frame out of the time a tick needs to be applied. Charts with a custom series renderer, a `bottom`
  primitive or drawings merged into the series layer keep the full redraw, as do frames in which a
  price scale, the view or an option changes.

  All layers are drawn again after the browser restores a lost canvas context.

- 1ecafaf: Speed up WebGL2 mark drawing: textures are found with shifts and masks, and a heatmap with both `valueMin` and `valueMax` set is drawn from one-byte palette slots, uploaded as columns come into view or change.
- aef336f: Speed up WebGPU mark drawing for three workloads. Square scatter markers of 5 to 9 device pixels drawn over the whole pane take one write per point instead of one per covered row. A change of the price projection projects and uploads the scatter rows in view, and those a pan brings into view, instead of every row held. A heatmap with both `valueMin` and `valueMax` set is drawn from one-byte palette slots, as with WebGL2. Fix heatmap slots that kept the old colors of a patched column after a frame drawn from the values, which a WebGL2 or Canvas 2D frame after a WebGPU one could show.
- Updated dependencies [a0c3771]
- Updated dependencies [fd9b94e]
- Updated dependencies [93097db]
- Updated dependencies [ca86b18]
- Updated dependencies [c261b75]
- Updated dependencies [9ee1ef4]
- Updated dependencies [64a361c]
- Updated dependencies [6c1a6d5]
- Updated dependencies [596451b]
- Updated dependencies [73d2dbe]
- Updated dependencies [591934d]
- Updated dependencies [dcf50f3]
- Updated dependencies [0ed57f4]
- Updated dependencies [f44dd44]
- Updated dependencies [f44dd44]
- Updated dependencies [0be4eb2]
- Updated dependencies [f9502fe]
- Updated dependencies [cea020e]
- Updated dependencies [99d02d3]
- Updated dependencies [3dd18c0]
  - @lumen-ticks/engine@0.1.0
