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

**TODO: measurements pending.** Fill this table from the four result files of [Reproduce](#reproduce).

| Case             | Value range | Frame JS p95 before | after | GPU p95 before | after | Path after   |
| ---------------- | ----------- | ------------------: | ----: | -------------: | ----: | ------------ |
| pan, 2400 × 600  | automatic   |                TODO |  TODO |           TODO |  TODO | webgl2       |
| zoom, 2400 × 600 | automatic   |                TODO |  TODO |           TODO |  TODO | webgl2       |
| tick, 2400 × 600 | automatic   |                TODO |  TODO |           TODO |  TODO | webgl2       |
| pan, 2400 × 600  | fixed       |                TODO |  TODO |           TODO |  TODO | webgl2-slots |
| zoom, 2400 × 600 | fixed       |                TODO |  TODO |           TODO |  TODO | webgl2-slots |
| tick, 2400 × 600 | fixed       |                TODO |  TODO |           TODO |  TODO | webgl2-slots |

Machine, browser version and load: TODO.

## Reproduce

Run the four sets one after the other on an otherwise idle machine. The baseline is a worktree of `main` at `69de92d`, beside this one.

```sh
git worktree add ../lumen-base 69de92d
CASES=heatmap/candles-4800/2400x600/pan,heatmap/candles-4800/2400x600/zoom,heatmap/candles-4800/2400x600/tick,heatmap/candles-4800/2400x600-fixed

pnpm bench --scenario heatmap --case $CASES --lib lumen-worker --mark-renderer webgl2 --repeats 5 --budget 4 \
  --packages ../lumen-base/packages --out docs/benchmarks/webgl2-heatmap-before-frames.json
pnpm bench --scenario heatmap --case $CASES --lib lumen-worker --mark-renderer webgl2 --repeats 5 --budget 4 \
  --out docs/benchmarks/webgl2-heatmap-after-frames.json

pnpm bench --scenario heatmap --case $CASES --lib lumen-worker --mark-renderer webgl2 --mark-gpu-timers --repeats 3 --budget 4 \
  --packages ../lumen-base/packages --out docs/benchmarks/webgl2-heatmap-before-gpu.json
pnpm bench --scenario heatmap --case $CASES --lib lumen-worker --mark-renderer webgl2 --mark-gpu-timers --repeats 3 --budget 4 \
  --out docs/benchmarks/webgl2-heatmap-after-gpu.json
```

`rendererPath` and `backendFrames` in each run give the path drawn: `webgl2-slots` where the heatmap drew from its slots.
