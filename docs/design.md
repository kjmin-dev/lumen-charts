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

## 4. Data layer

### 4.1 Chunked column store

- Columns: time, open, high, low, close and volume, all Float64 (48 bytes per bar).
- A chunk holds 8,192 rows, with all six columns in one `ArrayBuffer`.
- Chunks form a deque, so linking a chunk at either end is O(1).
- The global index is a signed integer with a fixed origin. Prepending history leaves existing indexes unchanged.
- Memory has a cap. Past the cap, the engine drops chunks far from the visible range and requests them again from the Datafeed when needed. Ten million bars take 480 MB, more than a mobile browser can hold.

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

## 6. Render layer

- Canvas 2D with three layers per pane: series (grid, series, indicators), drawings (placed drawings) and overlay (crosshair, last-price line, drawing being edited).
- Four invalidation levels: None, Cursor (overlay only), Light (series layer) and Full (including layout). Changes merge into one draw per `requestAnimationFrame`.
- Partial redraw (redrawing only the last bar) is left out of the baseline. It breaks when autoscale changes, when an indicator is drawn shifted into the future, and at line joins. It is reconsidered only if Light invalidation exceeds its budget.
- Views write coordinates into reused `Float32Array`s and allocate no objects on the frame path.
- Candles start with `fillRect` and one pass per color. Whether batching into one path is faster is an [assumption].
- The number and size of canvases are capped. Split layouts times three layers times device pixel ratio can exceed mobile canvas memory, so near the cap the drawing and overlay layers merge.
- The GPU layer is an optional module for heatmaps and tick scatter plots. It shares one WebGL2 context per page.

## 7. Interaction

- Pointer Events for all input, with kinetic scrolling.
- Hit testing: series by index arithmetic; drawings filtered by time range, then scanned linearly. A spatial index is added only after measurement.
- Drawings are stored as (time, price) pairs. Chart state and drawings are saved and restored in a versioned serialization format.

## 8. External contract and scope

- The Datafeed matches the shape of TradingView's pull-based contract, with our own implementation. The contract covers bar corrections, deletions and resolution changes.
- Price axes: multiple axes; logarithmic, percentage and indexed-to-100 modes; formatting by tick size.
- Plugins: custom series, plus pane and series primitives.
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

- The O(N) cost per tick in Lightweight Charts comes from reading the source. Stage 0 measures it in a browser.
- Visual quality during fast scrolling with the window cache is unverified. Stage 2 checks whether the swap from a coarse level to raw bars is visible.
- Benchmarks ran on one Apple M1. x86, Firefox and Android are unmeasured.
- The review's experiments ran on a heavily loaded machine. Their direction holds; their absolute numbers need re-measuring.
