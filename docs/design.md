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
- As built: [stage 2](design/stage-2.md#41-chunked-column-store), [stage 2 follow-ups](design/stage-2-follow-ups.md#41-chunked-column-store).

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
- As built: [stage 2](design/stage-2.md#42-lod-pyramid), [stage 2 follow-ups](design/stage-2-follow-ups.md#42-lod-pyramid), [stage 5](design/stage-5.md#42-lod-pyramid).

### 4.3 Time scale

- Ordinal indexes, positioned by `barSpacing` and `rightOffset`.
- The main series' timeline is the reference. Secondary series (comparison symbols) are mapped onto it; a bar at a time the main series lacks merges into the preceding main bar.
- Sessions, time zones and daylight saving are handled in the display layer. Tick weights depend on the time zone, so they are recomputed when it changes.
- Non-time charts such as Renko are derived series in the engine, with their own ordinal index on the time scale.
- As built: [stage 4, time zones and sessions](design/stage-4-time-zones.md).

## 5. Compute layer

- Indicators run in the engine. Full computation happens on load, on parameter change and on prepend; ticks update incrementally.
- On prepend, cumulative indicators such as EMA start from a new point and are recomputed in full. Until that finishes, the main thread keeps showing the old values.
- The kernel signature is `(buffer, offset, length, state, carry)`. State holds running values such as the previous EMA; carry holds the tail of the previous chunk, sized to the moving window.
- Determinism: with the same starting point and algorithm, JavaScript and WASM results must match bit for bit [review: zero mismatches]. Results are compared with the server within a tolerance, because a different starting point changes the bits [review].
- WASM is adopted for a kernel only when profiling shows the kernel takes a meaningful share of frame or load time, an equivalence test against the JavaScript version passes, and the engine falls back to JavaScript when CSP blocks WASM. SIMD is used only for order-independent min/max and aggregation.
- As decided in stage 5: [no WASM kernels for now](design/stage-5.md#5-compute-layer).

### 5.1 As built in stage 3

Moved to [design/stage-3-indicators.md](design/stage-3-indicators.md).

## 6. Render layer

- Canvas 2D with three layers per pane: series (grid, series, indicators), drawings (placed drawings) and overlay (crosshair, last-price line, drawing being edited).
- Four invalidation levels: None, Cursor (overlay only), Light (series layer) and Full (including layout). Changes merge into one draw per `requestAnimationFrame`, which all charts of the page share (section 3).
- Partial redraw (redrawing only the last bar) is left out of the baseline. It breaks when autoscale changes, when an indicator is drawn shifted into the future, and at line joins. It is reconsidered only if Light invalidation exceeds its budget. (It did, for ticks with many indicators in a wide view: section 6.2 has what was built.)
- Views write coordinates into reused `Float32Array`s and allocate no objects on the frame path.
- Candles start with `fillRect` and one pass per color. Whether batching into one path is faster is an [assumption].
- The number and size of canvases are capped. Split layouts times three layers times device pixel ratio can exceed mobile canvas memory, so near the cap the drawing and overlay layers merge.
- Scatter and heatmap series use the per-instance renderer preference. WebGL2 is the default, WebGPU falls back to WebGL2, and Canvas 2D supplies the portable path. [Renderer guide](guide/heatmap-scatter.md#choosing-a-renderer).

### 6.1 As built in stage 4 (drawings)

Moved to [design/stage-4-drawings.md](design/stage-4-drawings.md#61-as-built-in-stage-4-drawings).

### 6.2 Stage 5: as decided, and as built

Moved to [design/stage-5.md](design/stage-5.md#62-stage-5-as-decided-and-as-built).

## 7. Interaction

- Pointer Events for all input, with kinetic scrolling.
- Handlers store positions in the viewport; the chart's rectangle is read at most once per frame, in the read phase, and never kept, since scrolling the page changes it without a resize.
- Hit testing: series by index arithmetic; drawings filtered by time range, then scanned linearly. A spatial index is added only after measurement.
- Drawings are stored as (time, price) pairs. Chart state and drawings are saved and restored in a versioned serialization format. Section 7.2 describes the format as built.

### 7.1 As built in stage 4 (drawings)

Moved to [design/stage-4-drawings.md](design/stage-4-drawings.md#71-as-built-in-stage-4-drawings).

### 7.2 As built in stage 4 (save and restore)

Moved to [design/stage-4-save-restore.md](design/stage-4-save-restore.md).

## 8. External contract and scope

- The Datafeed matches the shape of TradingView's pull-based contract, with our own implementation. The contract covers bar corrections, deletions and resolution changes.
- As built: [stage 2 follow-ups](design/stage-2-follow-ups.md#8-external-contract-and-scope).
- Price axes: multiple axes; logarithmic, percentage and indexed-to-100 modes; formatting by tick size. Section 8.1 describes what stage 4 built. Value labels that keep apart, scales that go once nothing is on them, a magnet that measures every series by its own scale, and the wheel and pinch on an axis followed after stage 5 ([price axes](design/stage-4-price-axes.md)).
- Plugins: custom series, plus pane and series primitives. As built: custom indicators in [stage 3](design/stage-3-indicators.md) (section 5.1), primitives and custom renderers in [stage 4](design/stage-4-drawings.md#8-external-contract-and-scope).
- The core has no framework dependency: strict TypeScript, ESM, tree-shakeable.
- Keyboard data navigation and screen reader summaries are available on each chart. [Accessibility guide](guide/accessibility.md).
- Heatmap and scatter series: history on demand, prepends, removals and corrections in place, coarse levels of detail let go under the memory limit, sizes, densities, cells drawn over the area of their points and readouts of points, one timeline made from the marks of several series, and indicators over them. As built: [stage 5 follow-ups for marks](design/stage-5-mark-history.md).
- Out of scope: a user scripting language like Pine. The isolated engine leaves room for one later.

### 8.1 As built in stage 4: price axes

Moved to [design/stage-4-price-axes.md](design/stage-4-price-axes.md).

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

What each stage measured against its gate is in the document of that stage, under this section's number: the list is in [docs/README.md](README.md#what-each-stage-built).

## 10. Open questions

- Settled by stage 0: the cost per tick in Lightweight Charts is O(N). One `update()` takes 76.7–82.7 µs at 10,000 candles and 9,061–11,103 µs at 1 million [measured: [stage 0 baseline](benchmarks/stage-0-baseline.md)].
- Settled by stage 2: the swap between raw bars and a coarse level is not visible. With the origin on a whole device pixel and exactly 16, 64, 256, ... bars per pixel, both draw the same items and price range (tested at the switches to levels 1 to 4, with gaps in the data and a partial first bucket); headless screenshots on both sides of the switches to levels 1 to 4 look the same. During a fast scroll the chart draws the finest level until the raw bars arrive.
- Open after stage 3: with 20 indicators and all 1M bars in view, a tick applied through the worker
  waits for the frame in progress, so its p99 is the frame time, 3.9–4.5 ms against the gate's 4 ms
  [measured: [stage 3](benchmarks/stage-3.md)]. Cheaper wide-view frames or partial redraw (stage 5)
  would lower it; the main-thread engine's p99 is 0.22–0.33 ms.
  - As decided and as built in stage 5: [design/stage-5.md](design/stage-5.md#10-open-questions).
  - The worker now meets the 4 ms gate on M1 with an idle wait between ticks and packed indicator patches. [GC and tick latency](benchmarks/gc-floor.md).
- Benchmarks ran on one Apple M1. x86, Firefox and Android are unmeasured.
  - Measured after stage 5: in headless Firefox on the M1 ([Firefox](benchmarks/firefox-frames.md)) and on one flagship Android phone ([physical Android](benchmarks/android-physical.md)). x86, desktop discrete GPUs and a mid-range Android device are still unmeasured.
- The review's experiments ran on a heavily loaded machine. Their direction holds; their absolute numbers need re-measuring.
  - The review left no scripts. Its scan-cost claim, measured again: chunk by chunk 0.90–1.11 times a contiguous buffer, row by row through the index 3.1–4.8 times ([review re-measure](benchmarks/review-remeasure.md)); its other numbers cannot be reproduced.
- Open after the stage 5 follow-ups: on a flagship Android phone (Adreno 830) WebGL2 and WebGPU layers differ from Canvas 2D by one step of a channel value in places (cause not isolated), and the WebGL2 1M scatter zoom (p95 8.42 ms) and append (6.05 ms), the hover of 1,000 drawings (1.38 ms) and a worker tick with 20 indicators (4.39 ms) miss their budgets; WebGPU's compute pass there makes viewport redraws miss frames [measured: [physical Android](benchmarks/android-physical.md)]. Headless Firefox on the M1 misses every frame budget by 2 to 30 times with either mark renderer while Chromium meets them; whether headless Firefox draws on the GPU was not recorded, and a headed run on an idle machine is needed [measured: [Firefox](benchmarks/firefox-frames.md)].
  - Explained and changed since, on the M1 only, awaiting the phone ([GPU mark renderer gaps](benchmarks/mark-gpu-device-gaps.md)): the one-step differences of WebGL2 come from the browser premultiplying a straight-alpha drawing buffer with a rounding other than that of `putImageData`. WebGL2 and WebGPU now upload colors premultiplied by the page's own rule, measured with the first translucent color, and WebGPU, whose differences began with the first composite under a price-pane clip, composites transposed like the other paths. WebGL2 draws scatter points as point sprites without instancing (the 1M-point draw takes 4.87 instead of 20.2 ms of GPU time at p50, and that zoom keeps every display frame), a scatter append is written into the retained image (frame JavaScript p95 0.28 instead of 1.07 ms), and WebGPU's canvas no longer has storage usage, with which Chrome on Android copies the whole canvas every frame. The WebGPU compute pass is unchanged.
  - The overlay draws only what changed (about 17 Canvas 2D calls per hover frame over 1,000 drawings instead of about 470, with the pixels of a full redraw), and a tick takes series price ranges from the items it rebuilt. Neither the hover frame nor the worker's tick to applied p99 changed measurably on the M1, also with its CPU slowed four times: most of a hover frame there is native time that does not scale with the calls, and the tick's p99 rests on waits behind frames, including full redraws after the price scale moves. Both gates need the phone again [measured: [slow-device gates](benchmarks/slow-device-gates.md)].
  - Headless Firefox draws Canvas 2D in software by default and WebGL on the GPU. Its 35–342 ms frames came from the machine's load: at a load of about 11 its pan and zoom frames took 2.7–4.1 ms at p50. Copying a WebGL canvas into a software 2D canvas takes 11–14 ms and a transposed copy 8–21 ms, which is why its WebGL2 mark path is slower than its Canvas 2D; with `gfx.canvas.accelerated` forced on, those mark frames take 0.5–5 ms. A Firefox window with GPU canvases is still unmeasured [measured: [slow-device gates](benchmarks/slow-device-gates.md)].
