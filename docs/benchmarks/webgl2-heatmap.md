# WebGL2 heatmap: word lookups and palette slots

Two changes to the default WebGL2 mark renderer, measured on the 2,400 × 600-cell heatmap (1.44M cells in view):

- **Word lookups.** Word textures are a power of two wide. Shaders find word `i` at `(i & mask, i >> shift)` with the shift and mask of each texture passed as a uniform. Before, every fetch called `textureSize` and divided. The heatmap fragment shader fetches once per cell it covers, four times for its pixel ranges and eight times in the palette search.
- **Palette slots.** With `valueMin` and `valueMax` both set, a cell's palette slot depends on its value alone. The renderer uploads the series' Canvas 2D slots, one byte per cell and four to a word, and the fragment shader takes the highest slot over a pixel's cells and reads its color without a search. Columns are quantized and uploaded as they come into view or change. Without a fixed range the float path stays, since a change of the range would quantize every cell again. A study of the WebGPU renderer on the same layout found that slots halved the GPU time of pan and zoom (p95 1.114 to 0.524 ms) and raised the JS cost of a range change from 0.8 to 4.8 ms, over the 4 ms update budget.

Both paths draw the pixels of Canvas 2D: `node benchmarks/runner/mark-charts.mjs --mode webgl2,canvas-only --dpr 1,2` compares every layer of a chart drawn each way, with hardware GL and with `--software-gl`, including switches between a fixed and an automatic value range.

## Method

Before is `main` at `69de92d`, measured with this branch's harness through `--packages`. After is this branch. Both use `lumen-worker`, `--mark-renderer webgl2`, a 1,200 × 600 CSS-pixel chart at DPR 2 and headless Chromium.

The cases are `heatmap/candles-4800/2400x600/{pan,zoom,tick}`, where the palette spans the values held, and `heatmap/candles-4800/2400x600-fixed/{pan,zoom,tick}`, where `valueMin: 0` and `valueMax: 200` fix it. Before, the fixed cases draw from values like the others: they show what the slot path changes. The automatic cases show what the word lookups change on their own.

Frame JS is the median over runs of the per-run p95 of JavaScript per frame. GPU time comes from separate runs with `--mark-gpu-timers`: a `TIME_ELAPSED_EXT` query of `EXT_disjoint_timer_query_webgl2` from the clear or draw that starts a series' paint to the draw that ends it. Uploads before the draw and the copy into the series' cached image fall outside the query. Results void by a disjoint event are discarded. The column is the median over runs of the per-run p95.

## Results

Apple M1 (8 cores, AC power), headless Chromium 156.0.8078.4 with ANGLE on Metal, load average 4.4–4.7 from other work on the machine. GPU runs went before, after, then after, before; the frame runs once each without timers.

GPU pass p95 in milliseconds, median over three runs (min–max of the runs in parentheses), two rounds:

| Case             | Value range |     Round 1 before |               after |      Round 2 before |               after | Path after   |
| ---------------- | ----------- | -----------------: | ------------------: | ------------------: | ------------------: | ------------ |
| pan, 2400 × 600  | automatic   |   4.22 (2.94–6.13) |    1.34 (1.31–4.65) |    2.94 (2.94–5.89) |    1.34 (1.34–4.38) | webgl2       |
| zoom, 2400 × 600 | automatic   |   4.31 (3.05–4.45) |    1.49 (1.46–4.49) |    3.06 (3.05–3.09) |    1.47 (1.45–4.49) | webgl2       |
| tick, 2400 × 600 | automatic   |  2.52 (0.166–2.58) |  0.165 (0.161–1.40) |  0.169 (0.166–1.84) | 0.165 (0.164–0.166) | webgl2       |
| pan, 2400 × 600  | fixed       |   5.96 (3.22–5.96) | 0.800 (0.763–0.804) |    2.94 (2.94–2.94) |  0.803 (0.777–3.85) | webgl2-slots |
| zoom, 2400 × 600 | fixed       |   3.02 (3.00–3.04) |  0.893 (0.864–1.51) |    3.05 (3.05–3.10) |  0.890 (0.885–1.87) | webgl2-slots |
| tick, 2400 × 600 | fixed       | 0.168 (0.166–2.81) | 0.159 (0.158–0.251) | 0.125 (0.124–0.125) | 0.159 (0.158–0.159) | webgl2-slots |

- The word lookups alone take the automatic-range pan and zoom from about 3 ms to 1.3–1.5 ms at p95. Palette slots take the fixed-range ones to 0.8–0.9 ms, about a quarter of before.
- A tick redraws one column either way: 0.12–0.17 ms, near the timer's step on this machine. Single runs whose p95 caught a full redraw (the 2–3 ms maxima) are in both columns.

Frame JS p95 in milliseconds, without timers, one run of each set:

| Case             | Value range |              Before |               After |
| ---------------- | ----------- | ------------------: | ------------------: |
| pan, 2400 × 600  | automatic   |   1.05 (0.745–1.47) |   1.09 (0.815–1.11) |
| zoom, 2400 × 600 | automatic   |  0.945 (0.870–1.30) |   1.01 (0.985–1.13) |
| tick, 2400 × 600 | automatic   | 0.475 (0.375–0.480) | 0.610 (0.455–0.735) |
| pan, 2400 × 600  | fixed       |   1.28 (0.990–1.35) |  0.985 (0.900–1.29) |
| zoom, 2400 × 600 | fixed       |   1.03 (0.775–1.29) |    1.10 (1.07–1.33) |
| tick, 2400 × 600 | fixed       | 0.540 (0.535–0.590) | 0.570 (0.550–0.895) |

JavaScript per frame stays within the spread of the runs and far inside the 8 ms (pan, zoom) and 4 ms (update) budgets. The slot path quantizes a column as it enters the view or changes; that work is in the fixed rows above. The automatic tick's p95 was higher after in this pair (0.48 against 0.61 ms, ranges overlapping); the GPU-timer runs, which also record frame JS, had it at 1.06 and 0.89 ms before against 0.86 and 1.03 ms after.

Raw runs: [GPU, round 1 before](webgl2-heatmap-before-gpu.json), [after](webgl2-heatmap-after-gpu.json); [round 2 before](webgl2-heatmap-before-gpu-2.json), [after](webgl2-heatmap-after-gpu-2.json); [frames before](webgl2-heatmap-before-frames.json), [after](webgl2-heatmap-after-frames.json).

## Reproduce

Run the four sets one after the other on an otherwise idle machine. The baseline is a worktree of `main` at `69de92d`, beside this one.

```sh
git worktree add ../lumen-base 69de92d
CASES=heatmap/candles-4800/2400x600/pan,heatmap/candles-4800/2400x600/zoom,heatmap/candles-4800/2400x600/tick,heatmap/candles-4800/2400x600-fixed

pnpm bench --scenario heatmap --case $CASES --lib lumen-worker --mark-renderer webgl2 --repeats 3 --budget 3 \
  --packages ../lumen-base/packages --out docs/benchmarks/webgl2-heatmap-before-frames.json
pnpm bench --scenario heatmap --case $CASES --lib lumen-worker --mark-renderer webgl2 --repeats 3 --budget 3 \
  --out docs/benchmarks/webgl2-heatmap-after-frames.json

pnpm bench --scenario heatmap --case $CASES --lib lumen-worker --mark-renderer webgl2 --mark-gpu-timers --repeats 3 --budget 3 \
  --packages ../lumen-base/packages --out docs/benchmarks/webgl2-heatmap-before-gpu.json
pnpm bench --scenario heatmap --case $CASES --lib lumen-worker --mark-renderer webgl2 --mark-gpu-timers --repeats 3 --budget 3 \
  --out docs/benchmarks/webgl2-heatmap-after-gpu.json
```

`rendererPath` and `backendFrames` in each run give the path drawn: `webgl2-slots` where the heatmap drew from its slots.
