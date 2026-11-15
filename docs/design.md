# High-performance chart engine design

This design combines two analyses of TradingView's charts and incorporates an independent reviewer's adversarial review of the first draft.

Evidence tags:

- **[source]**: read in the Lightweight Charts v5.3.0 source.
- **[measured]**: benchmark on an Apple M1 under V8 and JavaScriptCore. Runs varied by 20 to 30%.
- **[review]**: experiment run during the adversarial review. The machine was under heavy load, so absolute numbers varied by up to 50%.
- **[assumption]**: not verified. A measurement gate has to confirm it.

## 1. Findings

### 1.1 Adopted from both analyses

- Invalidation levels, merged into one draw per `requestAnimationFrame` [source].
- Separate canvas layers per pane and per axis [source].
- Ordinal index time scale with weighted tick marks [source].
- Integer snapping in physical pixels, with bar and wick widths kept at the same parity [source].
- Separate model, view and renderer, with stateless renderers [source].
- Branded types to keep coordinate spaces apart [source].
- Columnar `TypedArray` storage [measured: 2.8 to 4.7 times faster than arrays of objects].
- Rendering and per-frame code stay in JavaScript [measured: work on 2,000 visible bars takes 0.7 to 2.6 µs].
- Canvas 2D by default. GPU rendering is an optional layer.

### 1.2 Verdicts on the second analysis

| Claim                                                                         | Verdict                  | Evidence                                                                                                                  |
| ----------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Up and down candles are batched into one path with a single fill              | False                    | Each bar uses its own `fillRect`; `fillStyle` changes only when the color changes [source]                                |
| The hot loop allocates nothing                                                | Half right               | The draw loop mostly allocates nothing, but each tick rebuilds every bar as a new object [source]                         |
| `PlotList` is immutable and incremental                                       | Half right               | It is replaced whole, so "immutable" holds and "incremental" does not. The 30-row chunked min/max cache is real [source]  |
| Core bundle is about 45 KB gzip                                               | Inaccurate               | 45 KB is the CI limit, measured with brotli [source]                                                                      |
| Use Relaxed SIMD for fused multiply-add                                       | Rejected                 | Safari support is unconfirmed, and results differ by platform                                                             |
| WASM with SIMD speeds up indicators 4 to 15 times                             | Rejected                 | Recursive indicators cannot use SIMD; WASM runs at 0.97 to 1.5 times JavaScript [measured]                                |
| Its performance table (for example, min/max over 1 million values in 0.12 ms) | Estimates                | Measured: 0.36 ms for f64, 0.17 ms for f32 [measured]                                                                     |
| Compute indicators using f32 deltas from a base price                         | Rejected                 | f32 holds about 7 significant digits. f32 is used only for render coordinates                                             |
| Built-in R-tree for drawing hit tests                                         | Deferred                 | The scale that needs it is unverified                                                                                     |
| Browsers limit the number of WebGL contexts                                   | Adopted                  | The GPU layer shares one context per page                                                                                 |
| Zero-copy views over WASM memory                                              | Adopted with a condition | Holds only within one thread; WASM memory cannot be transferred between threads [review]                                  |
| Zig and Rust perform about the same                                           | Adopted                  | Both compile through LLVM. Rust binaries stay small too: exposing a plain C ABI, 11 kernels compiled to 5.1 KB [measured] |

### 1.3 Results of the adversarial review

| Draft decision                                          | Verdict                    | Change                                                                                                         |
| ------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Main thread owns the store and transfers it to a worker | Does not hold              | The engine (worker) is the only owner; the main thread keeps a window cache (section 3)                        |
| A worker is required                                    | Conflicts with principle 4 | If CSP blocks workers, the engine runs time-sliced on the main thread                                          |
| Time scale built from the union of all timestamps       | Breaks stable indexes      | Map every series onto the main series' timeline                                                                |
| Prepending history is O(1)                              | Overstated                 | Only linking the chunk is O(1); cumulative indicators are recomputed                                           |
| Bit-for-bit match with server results                   | Unrealistic                | Guarantee bit equality between JavaScript and WASM only; compare with the server within a tolerance            |
| Kernel signature `(buffer, offset, length)`             | Insufficient               | Add a state struct and the tail of the previous chunk (carry)                                                  |
| LOD with factor 4 and 33% extra memory                  | Several defects            | Start at level 16, rebuild the last bucket from its members on tail updates, define NaN handling (section 4.2) |
| A "tail" invalidation level                             | Conditions undefined       | Left out of the baseline; decided after measurement                                                            |
| Pass criteria                                           | Not measurable             | Batch averages and p99, with fixed devices and resolution (section 9)                                          |
| LOD described as a new idea                             | Omission                   | Lightweight Charts already ships conflation; the baseline is measured with it on                               |

The review tried and failed to break three points: the scan cost of chunked storage (1.4 to 1.8 times slower than a contiguous buffer, negligible in absolute terms) [review], the visual validity of aggregated candles, and the rejection of Relaxed SIMD and f32 storage.

## 2. Principles

1. Per-frame work is bounded by the number of visible pixels. Per-tick work is constant.
2. Algorithms (LOD, incremental computation) come before low-level optimization (SIMD, GPU).
3. An optimization is adopted only after it passes a measurement gate.
4. Impose no requirements on the host page. Workers, WASM and `SharedArrayBuffer` are all optional and have fallbacks.

## 3. Architecture

```
Main thread                              Data engine (worker; time-sliced on main if blocked)
┌───────────────────────────────┐       ┌───────────────────────────────────┐
│ API and Datafeed adapter      │ bars, │ Chunked store (single owner)      │
│ Model: TimeScale, PriceScale  │ ticks │ LOD pyramid                       │
│ Window cache: raw bars for    │──────▶│ Indicator engine (full and        │
│   the visible range ±2 screens│       │   incremental, holds state)       │
│   and every coarse LOD level  │◀──────│ Derived series (Heikin-Ashi, ...) │
│ View: f32 coordinate buffers  │ snap- │ Kernels: JavaScript, optional WASM│
│ Renderer: Canvas 2D, 3 layers │ shots,│ (WASM memory stays in this thread)│
│ Input, hit testing, drawings  │patches└───────────────────────────────────┘
└───────────────────────────────┘
```

- **Ownership**: only the engine holds history and indicator state. It copies window snapshots to the main thread [measured: 0.26 ms per 8 MB].
- **Window cache**: the main thread keeps raw bars for the visible range plus two screens on each side, and every coarse LOD level. If a fast scroll leaves the window, it draws from a coarse level and swaps in raw bars when they arrive.
- **Tick path**: ticks go to the engine, which replies with a single message (patch) holding the tail bar and the tail value of every indicator. The main thread applies the patch at once, so bars and indicators never disagree.
- **One interface**: the engine sits behind one asynchronous interface. Calling code is the same whether it runs in a worker or time-sliced on the main thread.
- **Portable renderer**: a renderer receives only a context and coordinate buffers. Moving it to `OffscreenCanvas` is an optional step in stage 5.
- **Shared between charts**: resources of the page are shared by its charts, not taken per chart [measured: [shared resources](benchmarks/shared-resources.md)].
  - Workers: engines share a small pool of workers (at most 4 by default). One worker hosts several engines, each with its own state, told apart by an engine id on commands and events. Commands of one engine keep their order; engines take turns in slices of 4 ms, so a bulk load does not hold up the others; background LOD work of any engine runs only while no engine has a command waiting. A worker stops with its last engine.
  - Frame: one `requestAnimationFrame` for all charts, in two phases. Every chart reads from the layout (its size if not yet known, the rectangle pointer input needs), then every chart writes and draws.
  - Observers: one `ResizeObserver` (content box of each chart's root element), one `IntersectionObserver` (a chart outside the viewport keeps its data and invalidation level current and draws when it comes back), and one media query list per window for the device pixel ratio and for the color scheme.

## 4. Data layer

### 4.1 Chunked column store

- Columns: time, open, high, low, close and volume, all Float64 (48 bytes per bar).
- A chunk holds 8,192 rows, with all six columns in one `ArrayBuffer`.
- Chunks form a deque, so linking a chunk at either end is O(1).
- The global index is a signed integer with a fixed origin. Prepending history leaves existing indexes unchanged.
- Memory has a cap. Past the cap, the engine drops chunks far from the visible range and requests them again from the Datafeed when needed. Ten million bars take 480 MB, more than a mobile browser can hold.
- As built in stage 2: a dropped chunk keeps its time column (8 bytes per bar), so a refetch can be checked bar by bar against the global indexes it replaces and every time-to-index lookup keeps working; the levels of detail always stay. The cap applies to a series with a Datafeed while it is the only series with data.
- As built in the stage 2 follow-ups: the cap applies to every series with a Datafeed; a series without one is never dropped. A dropped chunk keeps a summary instead of its time column: first and last time, a 64-bit checksum of the times, a checksum of the values and, for a secondary series, the time of every 16th bar (the time pyramid has them for the main series). The main series keeps its time column while other series have data, because merging their bars into main bars needs every main time; a secondary series that gets data meanwhile waits until the main times are back.
  - Lookups across dropped chunks: chunk boundary times place a time before, inside or after a chunk; only a time strictly inside a chunk without its times has no exact row. A correction there waits for the chunk (a time between two chunks matches no bar and is refused at once); the bound of a secondary bar's slot at a chunk start is that chunk's first time; the rows a raw window needs from secondary series are found by the times of its first and last main bar.
  - A refetch is checked by the row count, the first and last time, the checksum, and the time of every 16th bar. Answers for chunks a waiting deletion removes bars from may lack those bars (the source has usually removed them already); the other bars are then checked by the times kept rather than the checksum, which also tells how many bars each gap held.
  - Anything that needs dropped rows waits for them and fetches them: a raw window until the rows of every series it shows are back, a correction until its bucket can be rebuilt from all members (holding up nothing else), and a deletion, or a new main timeline, until every row it reads or moves is back; later operations on that series wait behind it. Nothing is dropped while a command runs; the cap is enforced after each command and in background steps between commands, at most 32 chunks at a time, since a summary takes a pass over the chunk (dropping 10M points at once took over 100 ms).

### 4.2 LOD pyramid

- Levels are 16, 64, 256 and so on, each 4 times the last. Between 1 and 16 bars per pixel, raw bars are merged per pixel column at draw time (at most about 60,000 bars at 4K width).
- Bucket boundaries are fixed at `floor(global index / level size)`. A prepend that is not a multiple of 4 only touches the leftmost partial bucket.
- Columns per level:
  - OHLC series: first open, highest high, lowest low, last close.
  - Volume: the maximum. A sum would make bars jump fourfold at each level change.
  - Line and indicator series: minimum, maximum, first and last. Using the close alone loses extremes [review: at level 64, 77% of buckets missed the true maximum by more than 0.2%].
- Extra memory: about 7% for OHLCV and 27% for a line series.
- NaN values are skipped during aggregation. A bucket that holds only NaN is NaN.
- A tail update rebuilds the last bucket from its members (at most 16 raw rows at level 16, or 4 child buckets above it). A correction can lower the high, so merging in the new value alone gives wrong results.
- Visible-range min/max comes from pyramid lookups plus raw scans at both ends.
- As built in the stage 2 follow-ups: a correction rebuilds its buckets from all members also when its bar was dropped (it waits until the bar is back), and so do bars that come back from the Datafeed with other values than the ones dropped. A deletion rebuilds the buckets at its edges, and those of the bars it moved.
- As built in stage 2: the main thread holds no raw bars for a wide view, so it has nothing to scan at the ends. Instead, a coarse level draws whole buckets only, each in the pixel column of its first bar, and the price range is exact for the bars drawn; they differ from the bars inside the pane by less than one bucket (under one device pixel) at either end. The origin snaps to a whole device pixel below one pixel per bar, so raw bars and buckets give the same pixels at every level switch.

### 4.3 Time scale

- Ordinal indexes, positioned by `barSpacing` and `rightOffset`.
- The main series' timeline is the reference. Secondary series (comparison symbols) are mapped onto it; a bar at a time the main series lacks merges into the preceding main bar.
- Sessions, time zones and daylight saving are handled in the display layer. Tick weights depend on the time zone, so they are recomputed when it changes.
- Non-time charts such as Renko are derived series in the engine, with their own ordinal index on the time scale.

## 5. Compute layer

- Indicators run in the engine. Full computation happens on load, on parameter change and on prepend; ticks update incrementally.
- On prepend, cumulative indicators such as EMA start from a new point and are recomputed in full. Until that finishes, the main thread keeps showing the old values.
- The kernel signature is `(buffer, offset, length, state, carry)`. State holds running values such as the previous EMA; carry holds the tail of the previous chunk, sized to the moving window.
- Determinism: with the same starting point and algorithm, JavaScript and WASM results must match bit for bit [review: zero mismatches]. Results are compared with the server within a tolerance, because a different starting point changes the bits [review].
- WASM is adopted for a kernel only when profiling shows the kernel takes a meaningful share of frame or load time, an equivalence test against the JavaScript version passes, and the engine falls back to JavaScript when CSP blocks WASM. SIMD is used only for order-independent min/max and aggregation.

### 5.1 As built in stage 3

**Kernels.** The signature is `(buffer, offset, length, state, carry, params)`, plain numbers and
typed arrays only, so a WASM build can replace a kernel without other changes.

- `buffer` is column-major: the definition's inputs, then its outputs.
- The carry lives in the buffer, in the `carry` input rows in front of `offset`, instead of in a
  separate array. A kernel reads up to `carry` rows back without checking where the slice starts,
  and the whole call is one contiguous region (one block of WASM memory).
- `params` is a sixth argument, in the definition's order.
- `state` is all zeros on a fresh start, and the kernel keeps a flag or a count in it to tell.
- Missing inputs and undefined outputs (warm-up, gaps) are NaN. Windowed kernels output NaN while
  any row of their window is missing. Cumulative ones skip a missing row and output NaN for it.
- Built-ins: SMA, EMA, WMA, RSI, MACD (macd, signal, histogram), Bollinger bands (upper, middle,
  lower), ATR, Stochastic (k, d), VWAP (anchored to UTC days by default) and rolling highest and
  lowest. EMA-like averages are seeded with the simple average of their first `period` values.
- Only `+ - * /` and `Math.sqrt` are used. Each kernel is tested against a brute-force reference,
  with gaps, warm-up, chains and data on both sides of index 0.

**Runner.** One driver runs every kernel, in the engine and in the standalone `computeIndicator`.

- Slices never cross a chunk boundary (global index a multiple of 8,192).
- A windowed definition declares that its outputs depend only on the last `lookback + 1` input rows
  and that its kernel rebuilds its state from the carry. The runner then restarts it with zero
  state at every boundary. Its values become a function of their window alone, whatever row the
  computation started from.
- The runner keeps a checkpoint of state and carry at every boundary it passes, so a computation
  can restart at any chunk: `stateSize + lookback × inputs` numbers per 8,192 rows.

**Determinism, as tested.** These hold bit for bit:

- Incremental updates give the same bits as a full computation over the same rows.
- After a prepend, a windowed indicator recomputed only near the old first bar gives the same bits
  as a full computation over the new history. This is what the boundary restarts buy.
- A cumulative indicator recomputed after a prepend stops only where its state and carry equal, bit
  for bit, the checkpoint the previous computation kept at that chunk boundary. From there on the
  rows cannot differ, so the result is again that of a full computation from the new first bar.

**Incremental ticks.** All rows but the last are committed: the live runner holds the state and
carry after the second-to-last row.

- A tick that changes the bar still forming computes that row from a copy of the committed state:
  O(state), which is O(1) for the built-ins. The rolling extremes and Stochastic keep no state:
  they take the extreme of the window with the van Herk/Gil-Werman algorithm (three passes, O(1)
  per row in bulk, O(window) for one row), and Stochastic sums its short averages in window order,
  so their bits do not depend on how rows are sliced either.
- A new bar first commits the previous one.
- A correction of an older bar rewinds to the checkpoint of its chunk and recomputes from there,
  in place, if at most four chunks follow and their rows are held. Otherwise it starts a full
  recomputation.
- The changed rows, and the bucket of every level holding them, go into the tick's patch: one
  message for bars and indicators, as section 3 asks.

**Derived series.** Every output is a series on the main timeline.

- Each has its own id, values in chunks aligned with the raw chunks, and a level-of-detail pyramid
  (first, highest, lowest, last), like a line.
- Windows and patches carry them through the existing protocol, so the window cache, levels,
  autoscale and the line renderer work on them unchanged.
- Outputs are drawn as lines, or as histograms (a new series type, also open to application data)
  for MACD's histogram. They overlay the price pane, and autoscale includes them; a histogram's
  base is always in range.

**Recomputations in the background.** Load, a parameter change and a new input recompute an
indicator in full; a prepend recomputes it as far as the new history changes it.

- The job runs in slices of one chunk into storage of its own (values and pyramid), in the order
  indicators were added. That order is topological: an input can only read an earlier indicator,
  so a job waits until the jobs of its inputs are done.
- The live values stay on screen and keep receiving ticks. When the job reaches the end of the
  data it computes the last bar from the current data and swaps everything in at once. Nothing is
  shown half-recomputed, and nothing blanks.
- Corrections behind a running job restart it.
- After a prepend, a windowed indicator recomputes only the rows from the new first bar up to the
  first chunk boundary whose window lies entirely in rows it had before. Those rows are spliced
  in, and their buckets rebuilt, in one step. Near the end of the data it recomputes everything.
- A cumulative indicator recomputes from the new first bar and, at every chunk boundary from the
  old first bar on, compares its state and carry with the live computation's checkpoint there. Once
  they are equal it stops and splices the rows before the boundary the same way. Exponential and
  Wilder averages forget their start within a few thousand rows and a daily VWAP at the next day,
  so a prepend costs about the new rows plus a chunk, not the whole history; a running sum from the
  first bar never converges and is recomputed in full. Kernels therefore keep in their state only
  what later rows depend on (the built-ins clear their seeding sums once seeded).
- An indicator that reads another decides what to recompute when its job starts, after the jobs of
  its inputs: its inputs are unchanged from where the indicators it reads stopped changing.
- The main-thread engine runs these jobs in message tasks, like commands, not in idle time: their
  results are on the way to the screen. Level-of-detail builds still wait for idle time.
- In a worker shared by several charts (section 3), these jobs are part of each engine's background
  work: engines take turns, and none runs while an engine has a command waiting. What a turn
  finished goes out as a notice tagged with that engine's id.

**Notices.** The protocol gains an event that answers no command: values swapped in (the windows
held are stale, and the latest values come as patches), plugin modules loaded, or rows a
recomputation needs fetched. Its `ack` repeats the last command answered.

- Every event says how many indicators are still computing.
- `whenIdle` waits for those to finish and be drawn. `whenApplied` waits only for the data to be
  applied on the main thread.

**Memory limit.** Indicator outputs, their levels and checkpoints are never let go; they count
toward the limit.

- A recomputation that needs rows the limit let go fetches them again through the datafeed, one
  window ahead (16 chunks), and waits while they come back.
- Eviction spares the rows a pending recomputation has yet to read, and lets go again of those it
  has passed. Memory stays near the limit plus that window.
- If the datafeed cannot return the rows, the recomputation is given up: the values on screen stay,
  and the next change tries again.
- Windowed indicators after a prepend read only the new rows and the first chunk, which is always
  held; converging cumulative ones read the new rows and the few chunks before convergence.
- As built in the stage 2 follow-ups: a recomputation may read any series with data, so the rows of
  other series under the main rows it reads next are fetched and kept as well. A failed fetch of
  rows it does not wait for yet is asked for again (after the chart's pause); a failed fetch of the
  rows it waits for gives it up.

**Changes of history** (stage 2 follow-ups, section 8).

- A correction is a tick on an older bar, also when it waited for its bar to come back or the bar
  came back changed at the source, and follows the rule above: in place when recent, a full
  recomputation otherwise.
- Removing bars of another series changes the values merged into the main rows those bars belonged
  to, and is handled like a correction of those rows.
- Removing bars at either end of the main series leaves the other indexes as they are: every
  indicator is recomputed in the background, and the values on screen stay until then. Removing
  bars in its middle re-bases indexes, which drops the values and recomputes them, as a new history
  does.
- A computation starts at the main timeline's first row, which is no longer 0 once bars were removed
  at the head. Slices follow the chunks, so a computation from scratch that should give the same
  bits starts at that row too.

**Plugins.** A custom indicator is a definition: kernel, sizes (`stateSize`, `lookback`, `warmup`)
and plain metadata (inputs, outputs with their style, parameters with bounds, `windowed`).

- `chart.registerIndicators(url)` has the engine `import()` an ES module and register the
  definitions it exports: the default export or `indicators`, one or an array. The import runs in
  the worker, or on the main thread with the fallback. The engine returns the plain metadata, so
  the main thread never needs the kernel.
- Registration is per chart. Charts that share a worker each register the module in their own
  engine, and the worker imports it once. Engines in one worker call the same kernel functions, so
  a kernel keeps what it needs between calls in its state and carry, not in module variables.
- The module is loaded by URL, so it must be a standalone ES module: no bare imports a browser
  cannot resolve.
- CSP: the page's `script-src` must allow its origin. A worker created from a URL follows the CSP
  delivered with the worker script. A `blob:` or `data:` module needs those schemes allowed.
- Bundlers: the engine's `import()` is marked to be left alone (`@vite-ignore`, `webpackIgnore`).
  The application emits the module as a separate file, for example from `public/`, or as a
  separately built entry with a stable URL, and passes `new URL(..., import.meta.url)` or an
  absolute path.

**Custom series and primitives (section 8).** Custom series whose values a kernel computes are
covered by plugins: their outputs are derived series drawn as lines or histograms. Custom renderers
and pane or series primitives are deferred to stage 4. They need hit testing, z-order and a drawing
interface that drawings will define, and adding them now would fix an interface stage 4 would want
to change.

## 6. Render layer

- Canvas 2D with three layers per pane: series (grid, series, indicators), drawings (placed drawings) and overlay (crosshair, last-price line, drawing being edited).
- Four invalidation levels: None, Cursor (overlay only), Light (series layer) and Full (including layout). Changes merge into one draw per `requestAnimationFrame`, which all charts of the page share (section 3).
- Partial redraw (redrawing only the last bar) is left out of the baseline. It breaks when autoscale changes, when an indicator is drawn shifted into the future, and at line joins. It is reconsidered only if Light invalidation exceeds its budget.
- Views write coordinates into reused `Float32Array`s and allocate no objects on the frame path.
- Candles start with `fillRect` and one pass per color. Whether batching into one path is faster is an [assumption].
- The number and size of canvases are capped. Split layouts times three layers times device pixel ratio can exceed mobile canvas memory, so near the cap the drawing and overlay layers merge.
- The GPU layer is an optional module for heatmaps and tick scatter plots. It shares one WebGL2 context per page.

## 7. Interaction

- Pointer Events for all input, with kinetic scrolling.
- Handlers store positions in the viewport; the chart's rectangle is read at most once per frame, in the read phase, and never kept, since scrolling the page changes it without a resize.
- Hit testing: series by index arithmetic; drawings filtered by time range, then scanned linearly. A spatial index is added only after measurement.
- Drawings are stored as (time, price) pairs. Chart state and drawings are saved and restored in a versioned serialization format.

## 8. External contract and scope

- The Datafeed matches the shape of TradingView's pull-based contract, with our own implementation. The contract covers bar corrections, deletions and resolution changes.
- As built in the stage 2 follow-ups:
  - Pull: `getBars({ from, to, countBack, signal })` resolves to the bars of a time range. The `signal` is aborted when the request becomes obsolete: the view moved away before the bars came (the engine cancels requests nothing needs), a new history (`setData`, also at another resolution), the series removed or the chart destroyed. Answers after an abort are ignored. Requests for the same bars are never out twice; a failed or refused request is retried after a pause that doubles from 1 s to 30 s, for those bars only.
  - Corrections: `update` corrects any existing bar, also a dropped one; the correction waits until its bars are back and the levels are rebuilt from all members. Bars that come back with other values than the ones dropped are taken over as corrections at the source. TradingView handles history changes with `onResetCacheNeededCallback` (reload everything); here only the bars concerned are fetched.
  - Deletions: `removeBars({ from, to })`. Bars at either end are cut off and the others keep their indexes. In the middle, the bars on one side move over to close the gap: the side with fewer dropped bars, then the shorter one. For the main series that re-bases those indexes and starts a new epoch, as a new history does. A tombstone (the bar kept with no values) would keep indexes without moving anything, but the bar would still take a slot on the ordinal time scale, keep its time for secondary bars to merge into, and no longer match a Datafeed that has removed it; re-basing costs a copy of the shorter side and new windows, once per deletion, and leaves no trace.
  - Resolution changes: `setData(bars, { datafeed })` replaces the history and the Datafeed. It drops the series' requests (aborting them), its waiting operations, its windows (new epoch for the main series) and its levels.
- Price axes: multiple axes; logarithmic, percentage and indexed-to-100 modes; formatting by tick size.
- Plugins: custom series, plus pane and series primitives. As built in stage 3: custom indicators
  loaded as modules into the engine (section 5.1), whose outputs are derived series; custom
  renderers and primitives come with stage 4.
- The core has no framework dependency: strict TypeScript, ESM, tree-shakeable.
- Accessibility: keyboard control and a data summary for screen readers are in scope.
- Out of scope: a user scripting language like Pine. The isolated engine leaves room for one later.

## 9. Stages and measurement gates

Conditions: two reference devices (one desktop, one mid-range Android) with a fixed viewport and device pixel ratio. Tick cost is the average and p99 over a batch of 10,000 ticks, because browser timers are too coarse for single ticks. Two frame metrics are recorded separately: JavaScript time, and frame interval including rasterization. The numbers below are proposals to be calibrated against the stage 0 baseline.

| Stage | Scope                                                                                                          | Pass criteria                                                                                |
| ----- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 0     | Benchmark harness: Lightweight Charts with conflation on and off                                               | Baselines for tick cost, frame time, memory and load time                                    |
| 1     | Engine interface (worker and main-thread fallback), chunked store, time scale, candles and lines, invalidation | With 1 million bars: tick average 0.1 ms and p99 1 ms; pan and zoom frames p95 8 ms          |
| 2     | LOD, window cache, prepend, memory cap                                                                         | 10 million line points: pan and zoom p95 16 ms; screen updated within 100 ms of a prepend    |
| 3     | Indicator engine, derived series, plugins                                                                      | 20 indicators: tick to applied patch p99 4 ms; indicators recomputed within 1 s of a prepend |
| 4     | Drawings, save and restore, multiple price axes, sessions and time zones                                       | 1,000 drawings: hover p99 1 ms                                                               |
| 5     | Optional: WASM kernels, GPU layer, `OffscreenCanvas`, partial redraw                                           | Each only with profiling evidence                                                            |

## 10. Open questions

- Settled by stage 0: the cost per tick in Lightweight Charts is O(N). One `update()` takes 76.7–82.7 µs at 10,000 candles and 9,061–11,103 µs at 1 million [measured: [stage 0 baseline](benchmarks/stage-0-baseline.md)].
- Settled by stage 2: the swap between raw bars and a coarse level is not visible. With the origin on a whole device pixel and exactly 16, 64, 256, ... bars per pixel, both draw the same items and price range (tested at the switches to levels 1 to 4, with gaps in the data and a partial first bucket); headless screenshots on both sides of the switches to levels 1 to 4 look the same. During a fast scroll the chart draws the finest level until the raw bars arrive.
- Open after stage 3: with 20 indicators and all 1M bars in view, a tick applied through the worker
  waits for the frame in progress, so its p99 is the frame time, 3.9–4.5 ms against the gate's 4 ms
  [measured: [stage 3](benchmarks/stage-3.md)]. Cheaper wide-view frames or partial redraw (stage 5)
  would lower it; the main-thread engine's p99 is 0.22–0.33 ms.
- Benchmarks ran on one Apple M1. x86, Firefox and Android are unmeasured.
- The review's experiments ran on a heavily loaded machine. Their direction holds; their absolute numbers need re-measuring.
