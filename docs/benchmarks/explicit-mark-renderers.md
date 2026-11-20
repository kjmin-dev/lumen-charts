# Per-chart mark renderers

## Whole-chart image comparisons

The qualification page compares each chart layer against an explicit Canvas 2D chart, byte for byte. Both charts receive the same bars, trade points, heatmap values and drawings. The fixture exercises fractional zoom, price scales, opacity, point shapes, overlapping points, reduced cells, live updates, replacement history and state restore.

| Headless browser on Apple M2 Pro | Device pixel ratios | Checks passed | GPU coverage                                                                                                                                           |
| -------------------------------- | ------------------- | ------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Chromium 156                     | 1, 1.5, 2           |           603 | Hardware WebGL2 and WebGPU. Also tested forced absence, rejection and delayed adapter resolution, plus Canvas-only operation.                          |
| Firefox 157                      | 1, 2                |           266 | WebGL2, native WebGPU fallback, delayed adapter and Canvas-only operation.                                                                             |
| WebKit 27.2                      | 1, 2                |           278 | Hardware WebGL2 and WebGPU, delayed adapter and Canvas-only operation. WebKit used the local data engine when its isolation policy blocked the worker. |

The WebGL2 suite also destroys and restores the context during a live update, exhausts and restores the rendering budget, changes the instance preference, and destroys a sibling chart sharing the context. The hardware WebGPU suite destroys the device and verifies the effective fallback. Each suite checks rendering-budget accounting after teardown. A separate SwiftShader run passed 102 comparisons on Chromium using WebGL2, a pending adapter and Canvas-only mode. Physical Android performance remains unmeasured.

```sh
node benchmarks/runner/mark-charts.mjs --mode webgl2,hardware,unavailable,rejected,pending,canvas-only
node benchmarks/runner/mark-charts.mjs --browser firefox --mode webgl2,native,pending,canvas-only --dpr 1,2
node benchmarks/runner/mark-charts.mjs --browser webkit --mode webgl2,native,pending,canvas-only --dpr 1,2
```

## WebGL2 frame time

The public API benchmark uses a worker, candles and a drawing on a 1,200 × 600 CSS-pixel chart at DPR 2 in headless Chromium 156 on an Apple M2 Pro. Each timing is the median of three within-run p95s in milliseconds. Frame JS covers the update or camera operation and chart work in animation callbacks. The interval column measures animation callback cadence on Chromium's virtual display. All 27 runs reported WebGL2 throughout measurement. [Raw measurements](explicit-webgl2-frames.json)

| Series and workload       | Frame JS p95 (ms) | Frame interval p95 (ms) |
| ------------------------- | ----------------: | ----------------------: |
| Scatter 100k zoom         |              1.75 |                   16.67 |
| Scatter 300k zoom         |              1.88 |                   16.67 |
| Scatter 1M zoom           |              3.28 |                   16.67 |
| Scatter 1M append         |              1.95 |                   16.67 |
| Scatter 1M mixed          |              3.46 |                   16.67 |
| Heatmap 1.44M pan         |              1.41 |                   16.67 |
| Heatmap 1.44M zoom        |              0.79 |                   16.67 |
| Heatmap 1.44M last column |              1.32 |                   16.67 |
| Heatmap 1.44M mixed       |              1.40 |                   16.67 |
