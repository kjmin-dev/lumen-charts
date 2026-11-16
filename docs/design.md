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
- As built in stage 5: of a bucket that holds zeros of both signs, the highest value is +0 and the lowest is −0, whatever their order (section 5.1, "Extremes and the sign of zero").
- A tail update rebuilds the last bucket from its members (at most 16 raw rows at level 16, or 4 child buckets above it). A correction can lower the high, so merging in the new value alone gives wrong results.
- Visible-range min/max comes from pyramid lookups plus raw scans at both ends.
- As built in the stage 2 follow-ups: a correction rebuilds its buckets from all members also when its bar was dropped (it waits until the bar is back), and so do bars that come back from the Datafeed with other values than the ones dropped. A deletion rebuilds the buckets at its edges, and those of the bars it moved.
- As built in stage 2: the main thread holds no raw bars for a wide view, so it has nothing to scan at the ends. Instead, a coarse level draws whole buckets only, each in the pixel column of its first bar, and the price range is exact for the bars drawn; they differ from the bars inside the pane by less than one bucket (under one device pixel) at either end. The origin snaps to a whole device pixel below one pixel per bar, so raw bars and buckets give the same pixels at every level switch.

### 4.3 Time scale

- Ordinal indexes, positioned by `barSpacing` and `rightOffset`.
- The main series' timeline is the reference. Secondary series (comparison symbols) are mapped onto it; a bar at a time the main series lacks merges into the preceding main bar.
- Sessions, time zones and daylight saving are handled in the display layer. Tick weights depend on the time zone, so they are recomputed when it changes.
- Non-time charts such as Renko are derived series in the engine, with their own ordinal index on the time scale.
- As built in stage 4 (time zones and sessions; [measured](benchmarks/stage-4-time-zones.md)):
  - Bar times stay UTC milliseconds in the engine and its protocol; the time zone, the locale and the session schedule are chart options (`localization`, `sessions`) used by the time axis, the crosshair and the session marks only.
  - Offsets come from a table per zone of the instants where the offset changes, shared by the charts of a page. It covers a range of instants and grows on demand: `Intl.DateTimeFormat#format` (1.4 µs a call in V8; `formatToParts` takes 11 µs) is asked every two days and the change between two answers that differ is bisected to the second. Two changes closer than two days that cancel out would be missed; the closest in the tz database from 1850 to 2060 are 7 days apart. The table is grown for the times of every window snapshot when it arrives, so frames make no `Intl` call; converting a time is a binary search with the last segment cached.
  - Weights are not stored per bar. The label walk (labels on the first bar at or after each boundary of a step, unchanged otherwise) weighs a bar by comparing the wall-clock dates of the bar and its predecessor, a few table lookups per label, so a change of zone only invalidates the ticks of the next frame. Calendar boundaries are the first instant at or after the zone's midnight (a skipped midnight gives the instant of the change); uniform steps change at every new interval of the wall clock, so the repeated hour of a change back is labeled again on grids finer than it. Daily and longer bars (at least 20 hours apart per bar, not per bucket) are dates and keep their UTC date, after TradingView's convention for daily bars.
  - Measured at 1M candles: frames in UTC cost what they did; in New York time with an equity schedule, breaks and shading they cost 0–40 µs more (frame JS p50 150–520 µs). A change between zones whose tables exist costs 0–0.08 ms more than any other change of options; the first change to a zone 0.8–1.5 ms, and the first zone of a page 9–11 ms once, mostly `Intl` loading its time zone data [measured].
  - A session schedule is plain JSON: the exchange's zone, weekdays, sessions as `HH:MM` wall-clock intervals with a kind (`regular`, `pre`, `post`) and holidays. A trading day is named by the date its sessions end, so a session spanning midnight starts on the day before. With a schedule, day boundaries are trading-day starts and, on grids finer than a day, every session start is a boundary with a weight between time and day. Breaks (first bar of each trading day) and the runs of extended-hours bars are found per trading day in view, a few lookups each, while a day is at least 6 CSS pixels wide.

## 5. Compute layer

- Indicators run in the engine. Full computation happens on load, on parameter change and on prepend; ticks update incrementally.
- On prepend, cumulative indicators such as EMA start from a new point and are recomputed in full. Until that finishes, the main thread keeps showing the old values.
- The kernel signature is `(buffer, offset, length, state, carry)`. State holds running values such as the previous EMA; carry holds the tail of the previous chunk, sized to the moving window.
- Determinism: with the same starting point and algorithm, JavaScript and WASM results must match bit for bit [review: zero mismatches]. Results are compared with the server within a tolerance, because a different starting point changes the bits [review].
- WASM is adopted for a kernel only when profiling shows the kernel takes a meaningful share of frame or load time, an equivalence test against the JavaScript version passes, and the engine falls back to JavaScript when CSP blocks WASM. SIMD is used only for order-independent min/max and aggregation.
- As decided in stage 5 ([measured](benchmarks/stage-5-profile.md)): no WASM kernels for now.
  - Share: kernels take 56% of the engine's time in a load of 1M bars with 20 indicators, 2% of its time in a tick, and none of a frame.
  - Speed: Rust ports of eight kernels gave the same bits over 1M rows. The recursive ones (SMA, EMA, WMA, RSI, MACD, Bollinger) ran at 0.95–1.24 times JavaScript. Only the loops that take a minimum and a maximum gained: rolling extremes 10 times, Stochastic 3.9 times, level-of-detail buckets 7 times (20 with SIMD).
  - Those loops are slow in JavaScript because V8 compiles their comparisons to branches that prices mispredict. With `Math.max` and `Math.min` (after a test for NaN) they run 1.5–4.8 times faster, at the speed of scalar WASM for the buckets. That change is adopted instead (section 6.2, built in stage 5); what WASM would add after it is under a tenth of a load that has no budget to meet.
  - Reconsidered when a kernel V8 compiles badly cannot be fixed in JavaScript, or when loads get a gate the JavaScript kernels miss.

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
- Only `+ - * /` and `Math.sqrt` are used, and since stage 5 `Math.max` and `Math.min` for the
  rolling extremes (exact, and defined for every operand; see "Extremes and the sign of zero"
  below). Each kernel is tested against a brute-force reference, with gaps, warm-up, chains and
  data on both sides of index 0.

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

**Extremes and the sign of zero (stage 5).** Every highest and lowest value is taken with
`Math.max` and `Math.min` after a test that skips missing values: in level-of-detail buckets
(`aggregate`, `lineBuckets`), in the bars of a secondary series merged into one main bar, in the
rolling extremes and Stochastic's range, in the pixel columns and the price range of
`SeriesView`, and in the range of a price axis. One rule follows for all of them:

- **Of a set that holds both zeros, the highest value is +0 and the lowest is −0**, wherever they
  are in it (−0 orders below +0, as in IEEE 754 `maximum` and `minimum`). A set of only one kind of
  zero keeps that zero. Nothing else differs from a comparison: the two give the same bits for
  every other input, missing values and infinities included.
- The rule does not depend on order or grouping, so a value has the same bits however it is
  reached: a bucket from its rows or from the four buckets below it, a level built at once or grown
  by ticks, prepends and corrections, a pixel column merged from raw rows or from buckets, a
  rolling extreme in whatever slices its rows are computed, and the engine in a worker or on the
  main thread (the same code).
- Comparisons kept the zero met first. That was the same in most of these places, but not in the
  rolling extremes, which cut rows into blocks from where a slice starts: a window of both zeros
  gave +0 or −0 depending on the slicing (38% of such rows in a test of period 3), against the
  first guarantee above. The rule removes that.
- A WASM port has to use `f64.max` and `f64.min`, which follow the same rule, not a comparison
  and a select.
- Tested with rows that are zeros of both signs with gaps between them: `aggregate` in every
  order, levels grown by prepends, ticks and corrections against brute force and against the same
  rows loaded in two steps, rolling extremes and Stochastic from different starting rows, indicator
  values and their buckets through ticks and a prepend, and view items from raw rows against those
  from every level, all bit for bit.

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
and pane or series primitives were deferred to stage 4, which defined them together with drawings
(section 8, as built in stage 4): an output can now be drawn by a custom renderer.

## 6. Render layer

- Canvas 2D with three layers per pane: series (grid, series, indicators), drawings (placed drawings) and overlay (crosshair, last-price line, drawing being edited).
- Four invalidation levels: None, Cursor (overlay only), Light (series layer) and Full (including layout). Changes merge into one draw per `requestAnimationFrame`, which all charts of the page share (section 3).
- Partial redraw (redrawing only the last bar) is left out of the baseline. It breaks when autoscale changes, when an indicator is drawn shifted into the future, and at line joins. It is reconsidered only if Light invalidation exceeds its budget.
- Views write coordinates into reused `Float32Array`s and allocate no objects on the frame path.
- Candles start with `fillRect` and one pass per color. Whether batching into one path is faster is an [assumption].
- The number and size of canvases are capped. Split layouts times three layers times device pixel ratio can exceed mobile canvas memory, so near the cap the drawing and overlay layers merge.
- The GPU layer is an optional module for heatmaps and tick scatter plots. It shares one WebGL2 context per page.

### 6.1 As built in stage 4 (drawings)

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
  | A tick that leaves both scales as they were                 | yes          | –                    | yes        |
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

### 6.2 As decided in stage 5

Stage 5 profiled `main` after stage 4 and decided each optional step against the criteria above
([stage 5 profile](benchmarks/stage-5-profile.md)). Of the two steps adopted, the min/max loops
are built; partial redraw is not yet.

- **Partial redraw: adopted for tick frames.** Light invalidation exceeds its budget in one place:
  with 20 indicators and all 1M bars in view, a tick's frame takes 4.1 ms of JavaScript (p99
  4.7 ms) inside the 4 ms the stage 3 gate gives the whole tick, 80% of it drawing lines that did
  not change, and the GPU process rasterizes them again for 5.2 ms. In a prototype, redrawing only
  the last device columns takes 0.06 ms instead of 3.5 ms, and 0.5 ms instead of 3.0 ms in the GPU
  process. The breakers decide when a frame falls back to a full redraw:
  - A tick changed a price scale in 0–3% of the frames measured; 94–99% of tick frames keep
    geometry and scales and can take the tail path.
  - The dirty range is the items each view rebuilt, not "the last bar", so an output drawn shifted
    dirties the columns it is drawn in.
  - The clip is widened by a join and half the widest line, and each path starts two items before
    the first changed one, so the pixels inside the clip are those of a full redraw.
  - A custom series renderer, a `bottom` primitive or drawings merged into the series layer keep
    the full redraw: the chart cannot bound what they draw.
- **Cheaper wide-view frames: the min/max loops.** `SeriesView.update`, which merges rows into
  pixel columns, is 20–41% of a pan frame with 20 indicators; the level-of-detail builds and the
  rolling extremes are 38% of the engine's time in a load. All take a running minimum and maximum
  by comparison. With `Math.max` and `Math.min` they run 1.5–4.8 times faster, more on noisy series
  than on smooth ones. The one difference is the sign of a zero where a bucket holds both zeros,
  which the change has to settle in one rule for every place a value can be computed two ways.
  - As built ([measured](benchmarks/stage-5-min-max.md)): changed in `SeriesView.update` (both
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

## 7. Interaction

- Pointer Events for all input, with kinetic scrolling.
- Handlers store positions in the viewport; the chart's rectangle is read at most once per frame, in the read phase, and never kept, since scrolling the page changes it without a resize.
- Hit testing: series by index arithmetic; drawings filtered by time range, then scanned linearly. A spatial index is added only after measurement.
- Drawings are stored as (time, price) pairs. Chart state and drawings are saved and restored in a versioned serialization format. Section 7.2 describes the format as built.

### 7.1 As built in stage 4 (drawings)

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

### 7.2 As built in stage 4 (save and restore)

- **API.** `chart.saveState()` returns a `ChartState` and `chart.restoreState(state)` takes it back
  (`packages/core/src/state.ts`). Both take `{ parts }` to save or restore some of the sections
  (`options`, `series`, `indicators`, `drawings`, `view`), and a state need not hold every section:
  what is left out stays as it is on the chart. Series and indicators have an `id` for this (given
  when they are added, or `series-1`, `indicator-1`, ... by the chart), and `chart.series()` and
  `chart.indicators()` list them.
- **Format.** Plain JSON with a top-level `version` (`CHART_STATE_VERSION`, 1). A state of any other
  version is refused; keys added later are optional, and unknown keys are ignored. Each drawing is
  the `DrawingState` of section 7.1 with its own version. What a state holds is what was configured,
  never bars:

  | Section      | Holds                                                                                                                                                            |
  | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `options`    | The options applied to the chart, not the defaults or the theme's colors under them: the theme stays a theme. Price scales and their modes are among them.       |
  | `series`     | `id`, `type`, every option (`priceScaleId` among them), `pane` (0) and `order`, the place among series and indicators in the drawing order.                      |
  | `indicators` | `id`, the definition's `name`, the `source` and `inputs` by id (`{ series }` or `{ indicator, output }`), every parameter, every option of each output, `order`. |
  | `drawings`   | `DrawingState[]`, bottom to top.                                                                                                                                 |
  | `view`       | `timeRange`: the times at the left and right edge of the pane. `priceRanges`: the range of each scale that does not autoscale (autoscale itself is an option).   |

- **What is not saved.** Bars, and what is not data: functions and what belongs to the page. The
  size (`width`, `height`, `autoSize`), `worker` and `memoryLimit` describe the page and the device,
  so a restore leaves them as they are, like the formatter functions of `localization`. A series the
  chart already has (same `id` and type) keeps its bars, datafeed, custom renderer and primitives; a
  series the restore adds has none of them until the application hands them over. Indicators are
  saved by the name of their definition: a custom one must be registered (`registerIndicators`)
  before the restore, which otherwise refuses the state. Selection, hover and a tool in progress
  are not state.
- **The view is saved as times.** Like drawing points (section 7.1), the edges of the pane are
  times, whole milliseconds: between two bars by interpolation, past either end at the median
  spacing of the 64 bars there. A restore maps them back with the time index, so the same times are
  in view whatever history is loaded, at any resolution; bar spacing and right offset follow from
  the two times and the pane's width, which is why they are not stored. Saving asks the engine
  nothing: past an end whose spacing the main thread has not been told, it takes the median of the
  raw rows held there (the engine's own answer when 65 rows are held) or, zoomed out to a coarse
  level, the spacing of the buckets at that end: an approximation, at a zoom where a bar is a
  fraction of a pixel. A restore
  places the times at once when the raw rows around them are held, and otherwise after one `resolve`
  round trip; into a chart without bars it waits for them. `fitContent` and the other view calls
  after a restore win over a view still waiting.
- **All or nothing.** The whole state is checked before the first change (`planRestore`): the
  version, the kind of every value against the defaults (a finite number, a string or one of its
  choices, a boolean), unique ids, that every series, indicator and output an indicator reads will
  be there, parameter bounds, the time zone, locale and schedule (compiled on the side). An error
  names the place (`series[1].options.visible must be a boolean`). Applying cannot refuse anymore.
- **One frame.** While a state is applied, invalidations only note the highest level asked for, and
  one invalidation follows at the end, so a restore costs one frame however many series, indicators
  and drawings it holds. Series are matched by `id` and type and keep their bars; indicators are
  kept, and only take the state's options, as far as the chart's list and the state's start with the
  same ones (id, definition, source), and the rest are removed and added in the state's order, which
  keeps the engine's order topological. A kept indicator whose parameters and inputs did not change
  is not computed again. Drawings are replaced, with `removed` and `created` events. Saving reads
  the model and draws nothing.
- Measured with 1,000 drawings and 5 indicators on 1M candles
  ([stage 4 save and restore](benchmarks/stage-4-save-restore.md)): saving takes 0.07 ms, and a
  restore 1.7–1.8 ms in the call and 1.2 ms in its one frame.

## 8. External contract and scope

- The Datafeed matches the shape of TradingView's pull-based contract, with our own implementation. The contract covers bar corrections, deletions and resolution changes.
- As built in the stage 2 follow-ups:
  - Pull: `getBars({ from, to, countBack, signal })` resolves to the bars of a time range. The `signal` is aborted when the request becomes obsolete: the view moved away before the bars came (the engine cancels requests nothing needs), a new history (`setData`, also at another resolution), the series removed or the chart destroyed. Answers after an abort are ignored. Requests for the same bars are never out twice; a failed or refused request is retried after a pause that doubles from 1 s to 30 s, for those bars only.
  - Corrections: `update` corrects any existing bar, also a dropped one; the correction waits until its bars are back and the levels are rebuilt from all members. Bars that come back with other values than the ones dropped are taken over as corrections at the source. TradingView handles history changes with `onResetCacheNeededCallback` (reload everything); here only the bars concerned are fetched.
  - Deletions: `removeBars({ from, to })`. Bars at either end are cut off and the others keep their indexes. In the middle, the bars on one side move over to close the gap: the side with fewer dropped bars, then the shorter one. For the main series that re-bases those indexes and starts a new epoch, as a new history does. A tombstone (the bar kept with no values) would keep indexes without moving anything, but the bar would still take a slot on the ordinal time scale, keep its time for secondary bars to merge into, and no longer match a Datafeed that has removed it; re-basing costs a copy of the shorter side and new windows, once per deletion, and leaves no trace.
  - Resolution changes: `setData(bars, { datafeed })` replaces the history and the Datafeed. It drops the series' requests (aborting them), its waiting operations, its windows (new epoch for the main series) and its levels.
- Price axes: multiple axes; logarithmic, percentage and indexed-to-100 modes; formatting by tick size. Section 8.1 describes what stage 4 built.
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
- The core has no framework dependency: strict TypeScript, ESM, tree-shakeable.
- Accessibility: keyboard control and a data summary for screen readers are in scope.
- Out of scope: a user scripting language like Pine. The isolated engine leaves room for one later.

### 8.1 As built in stage 4: price axes

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

**Measured** in [stage-4-price-axes.md](benchmarks/stage-4-price-axes.md): with one axis the frame
takes what it took within one step of the 5 µs timer; a logarithmic scale costs a logarithm per price
per frame (+25% of frame JavaScript with 1M candles and three averages in view).

**Not built.** Value labels that collide are drawn over each other (Lightweight Charts moves them
apart). Scales are never removed; an axis no longer needed is hidden. The magnet takes the first
visible series whatever its scale. Pinch and wheel act on the time scale only.

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

Stage 4, drawings (measured, [stage 4 drawings](benchmarks/stage-4-drawings.md)): with 1,000
drawings, half in view, the JavaScript of a hover frame (pointer event, hit test, overlay) has a
p99 of 0.30 ms with the engine in a worker and 0.33 ms on the main thread, of which the hit test is
about 2 µs.

Stage 4, save and restore (measured, [stage 4 save and restore](benchmarks/stage-4-save-restore.md)):
with 1,000 drawings and 5 indicators on 1M candles, `saveState` takes 0.07 ms and `restoreState`
3.0–3.1 ms of JavaScript in all, in one frame. Stage 4 has no gate for it.

Stage 5, the evidence (measured, [stage 5 profile](benchmarks/stage-5-profile.md)): partial redraw
of tick frames and branch-free min/max loops are adopted, WASM kernels are rejected for now,
`OffscreenCanvas` and the GPU layer are deferred (sections 5 and 6.2). Each adopted step is
measured again on the gate cases when it is built.

Stage 5, the min/max loops (measured, [stage 5 min and max](benchmarks/stage-5-min-max.md)): with
20 indicators on 1M candles, pan frames take 4.2 instead of 5.5 ms of JavaScript at p50 with 20,000
bars in view and 4.9 instead of 5.6 ms at p95 with all bars in view (gate: p95 8 ms), and the
indicators of a load settle a fifth sooner.

## 10. Open questions

- Settled by stage 0: the cost per tick in Lightweight Charts is O(N). One `update()` takes 76.7–82.7 µs at 10,000 candles and 9,061–11,103 µs at 1 million [measured: [stage 0 baseline](benchmarks/stage-0-baseline.md)].
- Settled by stage 2: the swap between raw bars and a coarse level is not visible. With the origin on a whole device pixel and exactly 16, 64, 256, ... bars per pixel, both draw the same items and price range (tested at the switches to levels 1 to 4, with gaps in the data and a partial first bucket); headless screenshots on both sides of the switches to levels 1 to 4 look the same. During a fast scroll the chart draws the finest level until the raw bars arrive.
- Open after stage 3: with 20 indicators and all 1M bars in view, a tick applied through the worker
  waits for the frame in progress, so its p99 is the frame time, 3.9–4.5 ms against the gate's 4 ms
  [measured: [stage 3](benchmarks/stage-3.md)]. Cheaper wide-view frames or partial redraw (stage 5)
  would lower it; the main-thread engine's p99 is 0.22–0.33 ms.
  - As decided in stage 5: partial redraw of tick frames takes the frame out of that p99
    (section 6.2). What then remains is what the 200-bar view has, 3.0–3.3 ms, and the trace shows
    that part is not frames (they take 0.4 ms there) but garbage collection on the main thread:
    about 20 tasks of 2–16 ms in 3 s of ticks. Whose garbage it is, the patch objects of the
    library or the benchmark's own pause loop, is open [measured: [stage 5 profile](benchmarks/stage-5-profile.md)].
- Benchmarks ran on one Apple M1. x86, Firefox and Android are unmeasured.
- The review's experiments ran on a heavily loaded machine. Their direction holds; their absolute numbers need re-measuring.
