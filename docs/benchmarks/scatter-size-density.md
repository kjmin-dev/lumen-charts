# Scatter sizes per point and density coloring

What a size per point (`ScatterPoint.size`) and `colorBy: 'density'` cost a scatter's frames on each
mark renderer, against the same points drawn plain, and whether the renderers draw the same pixels.
The design is in [stage 5, heatmap and scatter](../design/stage-5-heatmap-scatter.md) (sections 4.4,
6.3 and 7), the API in [the guide](../guide/heatmap-scatter.md).

## Results

Frame JavaScript time in milliseconds (the step and the chart's draw for it), p50 and p95 of 240
measured frames (fewer where noted), median of two runs; M1, headless Chromium 156, a 1200 × 600 CSS
pixel chart at a device pixel ratio of 2, the engine in a worker. Every case drew from level 0 (the
points themselves). The path is the series' renderer of the last frame; on `webgpu`, sized and
density series are drawn by WebGL2 (`unsupported-style`). WebGL2 and WebGPU were measured at commit
`f68e827`, Canvas 2D at `083ee4c`, whose Canvas 2D code is the same.

| Points | Step | Style   | Canvas 2D p50 |   p95 | WebGL2 p50 |   p95 | WebGPU p50 |   p95 | WebGPU path                  |
| ------ | ---- | ------- | ------------: | ----: | ---------: | ----: | ---------: | ----: | ---------------------------- |
| 100k   | zoom | plain   |          3.69 |  7.08 |       1.02 |  2.15 |       1.20 |  2.23 | scatter-tiles                |
| 100k   | zoom | sized   |          6.54 | 13.18 |       0.94 |  1.60 |       0.98 |  2.11 | webgl2 (`unsupported-style`) |
| 100k   | zoom | density |         12.82 | 19.67 |       0.98 |  1.59 |       1.05 |  2.29 | webgl2 (`unsupported-style`) |
| 100k   | tick | plain   |          0.24 |  0.38 |       0.77 |  1.21 |       0.27 |  0.50 | scatter-tiles                |
| 100k   | tick | sized   |          0.25 |  0.35 |       0.78 |  1.47 |       0.80 |  1.59 | webgl2 (`unsupported-style`) |
| 100k   | tick | density |          0.23 |  0.29 |       0.81 |  1.42 |       0.81 |  1.57 | webgl2 (`unsupported-style`) |
| 1M     | zoom | plain   |         17.79 | 32.38 |       2.45 | 18.99 |       1.55 |  6.09 | scatter-columns              |
| 1M     | zoom | sized   |    43.74 [^a] | 83.77 |       2.44 | 17.67 |       1.87 | 16.53 | webgl2 (`unsupported-style`) |
| 1M     | zoom | density |    41.56 [^a] | 65.24 |       2.51 |  7.69 |       2.19 |  7.00 | webgl2 (`unsupported-style`) |
| 1M     | tick | plain   |          0.25 |  0.33 |       1.51 |  2.61 |       0.29 |  0.54 | scatter-columns              |
| 1M     | tick | sized   |          0.25 |  0.32 |       1.40 |  2.51 |       1.24 |  2.53 | webgl2 (`unsupported-style`) |
| 1M     | tick | density |          0.25 |  0.39 |       1.26 |  2.40 |       1.21 |  2.32 | webgl2 (`unsupported-style`) |

[^a]: The measuring budget ended these runs early: 202 and 201 frames (sized), 225 and 233 (density).

- **WebGL2 and WebGPU.** A size per point and densities cost a zoom frame what plain points cost at
  the median: 0.9 to 2.5 ms at 100k and 1M. Densities need no wait for the GPU with their default
  palette (from 1 to the frame's largest, linear): the color pass computes each pixel's entry from
  the largest density, which a reduction found on the GPU (see "Without reading back" below).
- **The p95 of a 1M zoom on WebGL2** is the frames where a new window arrives (p90 is 4.1 to 4.3 ms
  plain, 3.5 to 4.1 sized, 3.9 density; the worst frames take 80 to 145 ms): every row of the
  window, over a million, is projected into its GPU record and uploaded. Packing 1.4 million records
  took 49 ms with value colors (`scatterRecords`, the path WebGL2 had), 33 ms with sizes and 14 to 21
  ms with counts, in Node on the same machine; the p95 follows (19.0, 17.7 and 7.7 ms). WebGPU
  projects only the rows in view (its 6.1 ms), which sized and density series, drawn by WebGL2, do
  not get. A first version of the sized records, with a call per row for its size and its color,
  took 167 ms to pack, and its p95 was 27.3 ms.
- **Canvas 2D** pays for both in proportion to the points: a size per point takes 1.8 to 2.5 times
  the plain frame (the plain loop writes 3 × 3 squares unrolled; sizes drawn at random from 2, 3 and
  4 device pixels go through a stamp per point, and their branches cannot be predicted), densities
  2.3 to 3.5 times (a sum per covered pixel, then a color per pixel of the box held, 2.9 million at
  most). At 100k plain points fit the 8 ms pan and zoom budget at p95 (7.1 ms), sized ones (13.2) and
  densities (19.7) do not; at 1M none does, plain points included.
- **Appended points** cost what they cost plain: a point at level 0 is written (sized) or added to
  the densities and colored (density) where it lands. On WebGL2 a density patch sums its points
  alone and colors the whole pane again, on the GPU, since the top of the palette may have moved.
  On WebGPU, plain points keep its cheaper append path (0.3 ms); sized and density ones take
  WebGL2's (1.2 to 1.6 ms).

### Without reading back

A first version read the largest density back from the GPU (one texel, four bytes) before coloring
every frame, so the CPU waited for the frame's GPU passes. Measured the same way at commit `bc29e4c`
(raw results not kept: the files were measured again), its WebGL2 density zoom took 4.63 / 6.54 ms
(p50 / p95) at 100k and 18.68 / 29.36 ms at 1M, against 0.98 / 1.59 and 2.51 / 7.69 ms now. The read
is still made where the palette's entries cannot be computed in whole numbers on the GPU, which
keeps Canvas 2D's 64-bit thresholds exact: a logarithmic `valueScale`, or a `valueMin` with an
automatic top. A fixed `valueMax` needs no read.

## The same pixels

`node benchmarks/runner/mark-charts.mjs --mode webgl2,native,canvas-only --dpr 1,2` draws a Canvas
2D chart and a chart with the renderer under test (bars, a heatmap, a scatter, a trend line, an
oscillator pane), applies each change to both, and compares the RGBA bytes of every layer after
each; one byte apart fails the run. 17 of the checks are new: sizes per point (squares, discs,
a zoom, points placed from the start of their bar, a point appended, a wider one appended), densities
(linear from 1 to the largest, discs on a logarithmic scale, a fixed range, points appended below
the fixed top, below the automatic top and above it), and 600,000 points on twenty prices drawn as
densities from a coarse level (level 1, 5,700 cells of about a hundred points each) on a
logarithmic and a linear scale, then zoomed to the points. Between them, `pointAt` is read over a
grid of the pane on both charts, and must agree.

| Mode                       | DPR | Checks | Differing pixels | Sized and density series drawn by     |
| -------------------------- | --: | -----: | ---------------: | ------------------------------------- |
| `webgl2`                   |   1 |     78 |                0 | WebGL2 (float blending available)     |
| `webgl2`                   |   2 |     78 |                0 | WebGL2                                |
| `native` (hardware WebGPU) |   1 |     73 |                0 | WebGL2, reason `unsupported-style`    |
| `native` (hardware WebGPU) |   2 |     73 |                0 | WebGL2, reason `unsupported-style`    |
| `canvas-only` (no WebGL2)  |   1 |     56 |                0 | Canvas 2D, reason `unsupported-style` |
| `canvas-only` (no WebGL2)  |   2 |     56 |                0 | Canvas 2D, reason `unsupported-style` |

Densities are sums of whole numbers in 32-bit floats, exact below 2^24 points on a pixel on both
sides (Canvas 2D rounds after every addition, as float blending does); entries are then found by
comparing floats with thresholds computed once in 64-bit floats, or computed in whole numbers, both
exact on the GPU. The unit tests check the rest without a GPU: every disc up to 256 device pixels
rounds in 32-bit floats as in 64-bit ones even with a square root four units off, and the WebGL2
scatter kernel, run on the CPU from the records and column ranges uploaded, gives the Canvas 2D
pixels for points of mixed sizes, whole and in strips (and does not when the ranges are padded by
the series' size alone).

## How it was measured

- **Frames.** The `scatter-style` scenario (`benchmarks/src/scenarios/scatter-style.ts`) runs the
  `scatter` scenario's cases on a cloud of points (spread over a band of prices many times the
  candles' range, so few share a pixel): 100k and 1M points in view, 1,000 bars in view of 2,000.
  `zoom` goes from half the bars in view to all of them, one step per frame; `tick` appends one point
  per frame inside the last bar. Each case is drawn three ways: `plain` (`pointSize: 1.5`, as the
  `scatter` scenario), `sized` (each point a size of its own by its value, 1, 1.5 or 2 CSS pixels:
  2 to 4 device pixels, the plain size on average, so a size per point is measured and not larger
  points), and `density` (`colorBy: 'density'`, the plain size, the default palette range).
- **Commands**, headless Chromium in its new headless mode (GPU rasterization), one renderer per run:
  `pnpm bench --scenario scatter-style --lib lumen-worker --repeats 2 --mark-renderer <renderer> --port <port>`,
  and the pixel check above with `--port <port>`. The port, on 127.0.0.1 and strict, keeps another
  checkout's preview server from answering for this one.
- **Load.** The Mac was shared and busy throughout: the one-minute load average was 27 to 182
  during the Canvas 2D run, 19 to 35 during WebGL2 and 19 to 31 during WebGPU, with the CPU 0 to 8%
  idle between runs (`uptime` before and after, and the runner's `host` of every run); it had peaked
  near 390 between them, and the runs waited for it to come down. The
  absolute times are inflated by it and the runs were not interleaved: compare styles within a
  renderer's columns, where the three styles ran back to back.

Raw results: [Canvas 2D](scatter-size-density-canvas2d.json), [WebGL2](scatter-size-density-webgl2.json),
[WebGPU](scatter-size-density-webgpu.json), [pixel checks](scatter-size-density-charts.json).
