# Canvas 2D, WebGL2 and WebGPU for heatmap and scatter

On an Apple M1, both GPU prototypes freed the main thread during a dense scatter zoom. For one million 3 × 3 device-pixel squares, the WebGL2 point draw took **3.282 ms** of GPU time at p95 and the WebGPU instanced-quad draw **9.765 ms**. In the 1.44M-cell heatmap zoom, the GPU passes took **0.585 ms** and **0.459 ms**, respectively. A Canvas 2D prototype that keeps a precolored bitmap also handled the fixed-grid heatmap within the JS frame budget.

## Measurements

Apple M1, hardware Metal, Chromium 156.0.8078.4 headless, one visible 1,200 × 600 CSS-pixel canvas at DPR 2. Each cell is the median of three within-run p95s, in milliseconds. Each run starts on a fresh page, warms up for 12 frames, then submits 60 frames paced by animation callbacks. The runner rotates backend order between rounds. [Frame runs](mark-backends.json) and [GPU timer runs](mark-backends-gpu.json).

| Workload                | Canvas 2D JS | WebGL2 JS | WebGPU JS | WebGL2 GPU pass | WebGPU GPU pass |
| ----------------------- | -----------: | --------: | --------: | --------------: | --------------: |
| Scatter 300,000, zoom   |        5.510 |     0.085 |     0.170 |           1.343 |           3.539 |
| Scatter 1,000,000, pan  |       15.660 |     0.105 |     0.200 |           3.586 |           9.175 |
| Scatter 1,000,000, zoom |       15.980 |     0.095 |     0.220 |           3.282 |           9.765 |
| Scatter 1,000,000, tick |        0.095 |     0.110 |     0.160 |           0.051 |           0.459 |
| Heatmap 1,440,000, pan  |        0.100 |     0.110 |     0.210 |           0.739 |           0.524 |
| Heatmap 1,440,000, zoom |        0.090 |     0.105 |     0.200 |           0.585 |           0.459 |
| Heatmap 1,440,000, tick |        0.125 |     0.100 |     0.215 |           0.299 |           0.131 |

| Workload                | Canvas 2D display interval | WebGL2 display interval | WebGPU display interval |
| ----------------------- | -------------------------: | ----------------------: | ----------------------: |
| Scatter 300,000, zoom   |                      18.64 |                   17.53 |                   17.69 |
| Scatter 1,000,000, pan  |                      17.79 |                   17.54 |                   17.65 |
| Scatter 1,000,000, zoom |                      18.15 |                   17.81 |                   17.57 |
| Scatter 1,000,000, tick |                      17.99 |                   17.90 |                   18.22 |
| Heatmap 1,440,000, pan  |                      17.18 |                   17.73 |                   17.88 |
| Heatmap 1,440,000, zoom |                      17.35 |                   17.52 |                   19.05 |
| Heatmap 1,440,000, tick |                      17.39 |                   17.53 |                   17.56 |

- **JS** measures the synchronous update, draw submission and `drawImage` into the visible canvas.
- **GPU pass** covers the clear and mark draw in a separate run, with uploads issued before the pass. The runner reads the queries after the measurement window. Compositing into the visible 2D canvas is outside this counter. Chromium quantized the WebGPU durations in this run to about 0.066 ms, including some zero readings for small draws. [WebGL timer queries](https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query_webgl2/) and [WebGPU timestamp queries](https://www.w3.org/TR/webgpu/#timestamp).
- **Display interval** comes from Chromium's `Display::FrameDisplayed` trace events while this page animates. The JSON also includes the event count, window length and animation-callback intervals. The compositor runs against a virtual display in headless mode. Physical display latency, mobile results and 120 Hz interaction need separate measurements.

## Work shared across backends

- Each backend receives the same deterministic data, viewport transform and visible 2D destination. Each scatter starts with evenly spaced times and a dispersed price distribution. Later points win when squares overlap. A pan or zoom redraws from the resident buffer. A tick appends one point, uploads two floats on GPU and composites a 3 × 3 dirty rectangle. WebGL2 uses native 3-pixel points. WebGPU uses four vertices per point in an instanced triangle strip to draw the same square.
- The heatmap has 2,400 columns and 600 rows on a regular grid. Zoom and pan resample the cached image. A tick replaces the last column of 600 values. Canvas 2D stores a precolored bitmap and uses nearest-neighbor scaling. Both GPU implementations keep the scalar grid in an R8 texture and color it in the fragment shader.
- Verification runs on fresh pages before timing. For every workload the runner compares exact RGBA hashes across backends after the initial draw and after two viewport changes or updates. Pixel readback is confined to the verification pages.
- These inputs start in chart-relative coordinates. The existing chart benchmark includes the engine window, time and price projection, palette and level-of-detail choices, candles and other chart layers. In that benchmark the Canvas 2D chart took 29.15 ms JS p95 for the one-million-point zoom and 15.96 ms for the 1.44M-cell zoom. Those values describe a different workload. [Production chart measurements](stage-5-heatmap-scatter.md).

## Implications for the chart

- **Scatter.** The dense-cloud result above measures the four-vertex WebGPU path. A [follow-up with a compute shader](scatter-paths.md) retains the same 3 × 3 pixels and overlap order, and tests both original renderers with visible-range culling. Use that comparison when choosing a scatter path for an integrated trial.
- **Heatmap.** Try the cached Canvas 2D bitmap on uniform time and price intervals before selecting a GPU backend for this case. The production renderer handles irregular time knots, nonlinear scales, transparent missing cells and maximum-value aggregation when multiple cells land on one pixel. The affine fixture exercises only a subset of those semantics. Retain the existing projection and reduction rules when introducing a fast path. The [color-range comparison](heat-range.md) tests cache invalidation and direct WebGPU presentation.
- **Backend selection.** Keep the current Canvas 2D default. A chart trial can accept an explicit backend for mark series and report which backend initialized. Keep the engine's window and data updates shared. Pack large timestamps relative to an origin before conversion to GPU floats. Test layer ordering, opacity, multiple charts, initialization failure and device/context loss with a redraw from the retained window. An automatic selection policy needs end-to-end chart timings on the target desktop and mobile hardware.
- The earlier Stage 5 WebGL2 study timed renderer-thread and GPU-process activity with a scrolling fixture. Here hardware queries time the mark draw itself, and the visible output is composed identically by all three backends. [Previous prototypes](stage-5-profile.md#gpu-layer-defer-until-its-series-exist).

## Reproduce

Run with workspace dependencies and Playwright Chromium installed. The GPU-timer command requires hardware support for both query APIs.

```sh
node benchmarks/runner/mark-backends.mjs --check-only
node benchmarks/runner/mark-backends.mjs --out /tmp/mark-backends.json
node benchmarks/runner/mark-backends.mjs --gpu-timers --out /tmp/mark-backends-gpu.json
```
