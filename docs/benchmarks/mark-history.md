# Mark history: operations, memory and cross-renderer checks

What the [stage 5 follow-ups for marks](../design/stage-5-mark-history.md) cost in the engine, and
the image comparisons that check heatmaps whose grid follows the price across renderers.

## Engine operations

Each operation runs on a fresh store or engine, outside a browser, five times after a warm-up; the
table gives the median and the range of the five, in milliseconds. These are the costs on the thread
that runs the engine: the worker, in a chart. The machine was an Apple M1 shared with other work;
the load average was 55 when the run began (higher a few minutes before), so the ranges are wide and
the medians upper bounds. [Raw run](mark-history-ops.json)

| Operation                                                              | Median |       Range |
| ---------------------------------------------------------------------- | -----: | ----------: |
| Scatter of 1M points: set                                              |  367.5 | 300.9–436.6 |
| Scatter of 1M points: prepend 100,000 older points                     |   61.4 |   42.9–74.2 |
| Scatter of 1M points: remove a tenth in the middle                     |   32.5 |  18.0–115.1 |
| Scatter of 1M points: remove a tenth at the start                      |    3.1 |     1.9–6.0 |
| Scatter of 1M points: let every chunk but the edges go (14 chunks)     |   43.5 |   37.0–72.6 |
| Scatter of 1M points: take one chunk of 65,536 points back             |    4.6 |    4.1–15.3 |
| Heatmap of 2,400 × 600 cells: set, one grid                            |   11.6 |   11.1–13.5 |
| Heatmap of 2,400 × 600 cells: set, a grid following the price          |   12.0 |   10.8–13.8 |
| Indicators over 1M trades: count and VWAP of 16,667 bars, from scratch |   17.4 |   10.9–63.9 |
| Indicators over 1M trades: one trade appended, both updated in place   |    0.2 |     0.1–0.3 |

- A removal at either end cuts the rows off. In the middle the rows of the shorter side move over,
  row by row, and the levels' buckets around the gap are made again.
- Letting a chunk go computes its checksum (65,536 points of 20 bytes): about 3 ms a chunk. Taking
  it back checks the points the datafeed returned against it.
- A heatmap whose columns start at rows of their own costs nothing measurable to store over one grid:
  its columns all have `rows` cells, and only coarse columns span more.
- The aggregates of an indicator over marks cost two binary searches and a pass over the bar's
  marks per bar; an appended trade recomputes the last bar of each reader.

## Heatmaps whose grid follows the price, across renderers

`benchmarks/heat-grid.html` draws the same chart twice, once with Canvas 2D and once with WebGL2 or
WebGPU, and compares every canvas layer byte for byte after each step: a book of 3,600 columns of
41 cells whose lowest row wanders by up to 30 rows, NaN cells, fractional zooms, a view of every
column (a coarse level whose columns span the rows of their members), a narrow view and a pan, a
logarithmic scale, an automatic value range drawn from values and then, after 36 steady draws, from
palette slots, a last column replaced and a new one added on rows of their own, a fixed value range,
older columns prepended, columns removed in the middle and a resize. `valueAt` is compared too.

| Browser (headless)  | Renderers      | Device pixel ratios | Checks per run | Passed |
| ------------------- | -------------- | ------------------- | -------------: | -----: |
| Chromium 156.0.8078 | WebGL2, WebGPU | 1, 1.5, 2           |             59 |  6 / 6 |
| WebKit 27.2         | WebGL2, WebGPU | 1, 2                |             59 |  4 / 4 |
| Firefox 157.0       | WebGL2         | 1, 2                |             59 |  2 / 2 |

Firefox has no WebGPU adapter headless; the run says so and skips it. In every run the WebGL2 or
WebGPU chart drew the heatmap itself (its `renderer()` reported the backend asked for), and the steady
automatic range went over to palette slots (WebGL2's slot program, WebGPU's `heatmap-slots` kernel).
[Chromium](heat-grid-chromium.json) · [WebKit](heat-grid-webkit.json) · [Firefox](heat-grid-firefox.json)

## The existing mark cases against `main`

The scatter and heatmap cases of the harness, `main` (`aef336f`) and this branch alternately
through `--packages` (before, after, after, before), WebGL2, headless Chromium 156, a 1,200 × 600
CSS-pixel chart at DPR 2, two runs each; load average 18–30. Frame JavaScript p95 of each run, in
milliseconds, and in a separate set with GPU timers the GPU pass p95 and the renderer's bytes.
[Frames](marks-history-ab-frames-before-1.json): [after 1](marks-history-ab-frames-after-1.json),
[after 2](marks-history-ab-frames-after-2.json), [before 2](marks-history-ab-frames-before-2.json);
GPU: [before](marks-history-ab-gpu-before.json), [after](marks-history-ab-gpu-after.json)

| Case                                 | Before 1    | After 1     | After 2     | Before 2     |
| ------------------------------------ | ----------- | ----------- | ----------- | ------------ |
| scatter 1M cloud, zoom               | 3.95 / 4.39 | 3.78 / 4.08 | 3.76 / 8.02 | 3.82 / 18.13 |
| scatter 1M cloud, tick               | 1.73 / 2.49 | 1.52 / 1.37 | 1.37 / 1.34 | 1.31 / 2.24  |
| heatmap 2400 × 600, pan              | 0.82 / 0.89 | 0.95 / 0.90 | 0.79 / 1.03 | 1.13 / 0.79  |
| heatmap 2400 × 600, zoom             | 1.52 / 1.15 | 1.20 / 1.25 | 1.26 / 0.98 | 0.87 / 0.87  |
| heatmap 2400 × 600, tick             | 0.64 / 0.38 | 0.41 / 0.58 | 0.44 / 0.41 | 0.45 / 0.39  |
| heatmap 2400 × 600, fixed range, pan | 1.03 / 0.86 | 1.43 / 0.88 | 0.84 / 0.85 | 1.11 / 0.98  |

| Automatic value range | GPU pass p95, before | after         | Renderer bytes, before | after    | Path after     |
| --------------------- | -------------------- | ------------- | ---------------------- | -------- | -------------- |
| heatmap, pan          | 1.458 / 1.660        | 1.010 / 1.391 | 20.9 MiB               | 12.7 MiB | `webgl2-slots` |
| heatmap, zoom         | 1.662 / 1.931        | 1.232 / 1.429 | 20.9 MiB               | 12.7 MiB | `webgl2-slots` |

- Frame JavaScript stays within the spread of the runs on every case; the single slow frames (8 and
  18 ms in a 1M zoom) fell once on each side.
- The heatmap with an automatic range drew 3 frames from its values and the remaining 178 from palette
  slots once the range had stayed the same: GPU pass p95 down a quarter to a third, and two fifths less
  memory for the renderer, as the fixed range gets.

## Reproduce

```sh
LUMEN_MEASURE_OUT=docs/benchmarks/mark-history-ops.json npx vitest run --config benchmarks/engine/vitest.config.ts
node benchmarks/runner/heat-grid.mjs --out docs/benchmarks/heat-grid-chromium.json
node benchmarks/runner/heat-grid.mjs --browser webkit --dpr 1,2 --out docs/benchmarks/heat-grid-webkit.json
node benchmarks/runner/heat-grid.mjs --browser firefox --dpr 1,2 --mode webgl2 --out docs/benchmarks/heat-grid-firefox.json
git archive aef336f packages | tar -x -C ../lumen-base
CASES=scatter/candles-2k/cloud-1m/zoom,scatter/candles-2k/cloud-1m/tick,heatmap/candles-4800/2400x600/pan,heatmap/candles-4800/2400x600/zoom,heatmap/candles-4800/2400x600/tick,heatmap/candles-4800/2400x600-fixed/pan
pnpm bench --case $CASES --lib lumen-worker --mark-renderer webgl2 --repeats 2 --budget 3 --port 4393 \
  --packages ../lumen-base/packages --out docs/benchmarks/marks-history-ab-frames-before-1.json
pnpm bench --case heatmap/candles-4800/2400x600/pan,heatmap/candles-4800/2400x600/zoom --lib lumen-worker \
  --mark-renderer webgl2 --mark-gpu-timers --repeats 2 --budget 3 --port 4393 --out docs/benchmarks/marks-history-ab-gpu-after.json
```
