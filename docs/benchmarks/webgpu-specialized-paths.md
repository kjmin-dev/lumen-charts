# WebGPU specialized paths

The three paths that the [workload study](webgpu-workload-specialization.md) prototyped are now part of the WebGPU mark renderer. Each one applies only to the workload it was qualified for:

- **Large scatter squares.** If a column draw covers the whole pane and squares are 5 to 9 device pixels, a second kernel performs one atomic maximum per point, at the marker's bottom row. Each pixel then takes the highest ID among the `size` rows below it. Smaller squares and the strips of a patch keep the kernel that performs one atomic per covered row. The path is still reported as `scatter-columns`; the benchmark harness reports the kernel as `scatter-columns-wide`.
- **Visible-row projection.** The renderer tracks which scatter rows already have records on the GPU. When the column kernel starts over, it projects the rows in view. A pan then adds the rows that come into view, and a patch updates the rows it changed. The tile path builds its index from every row and still projects all of them.
- **Heatmap palette slots.** With both `valueMin` and `valueMax` set, the heatmap uploads the series' one-byte palette slots, four per word, as the WebGL2 renderer does. A kernel takes the highest slot over each pixel's cells. The path is still `heatmap`; the harness reports `heatmap-slots`.

While integrating these paths, the qualification suite also found a bug: after a frame drawn from the values, a heatmap's slots kept the old colors of a patched column. That fix is in the same branch.

All three paths match Canvas 2D pixel for pixel. `node benchmarks/runner/mark-charts.mjs` compares every layer in Chromium in every mode at DPR 1, 1.5 and 2: 56 checks with hardware WebGPU, 61 with WebGL2. The same suite passes in WebKit (WebGPU and WebGL2) and Firefox (WebGL2 and fallback) at DPR 1 and 2. The new checks cover:

- 5-, 7- and 9-pixel squares in a pane taller than one 1,024-row strip, followed by an append
- pans over a 1.32M-point scatter: within the projected rows, beyond them, and to a tail with a point appended out of view, plus a change of the price scale
- the heatmap kernel in use for a fixed and for an automatic value range
- WebGPU upload bytes for a palette-only change and for one changed column

In each of the 10 runs of the study fixture, its nine whole-chart comparisons against Canvas 2D also passed.

## Method

The baseline is `main` at `bf975a1`, and the comparison is this branch at `649f47d`. Both ran from `git archive` copies through `--packages`, with this branch's harness. They alternated one invocation at a time (before, then after), and each JSON file merges the runs of one side. All runs used `lumen-worker`, `--mark-renderer webgpu`, a 1,200 × 600 CSS-pixel chart at DPR 2, and headless Chromium 156.0.8078.4 on an Apple M1 (Metal 3).

The machine was shared with other work throughout. Load averages ranged from 5 to 41, and each run records its load in its JSON. Results where the two sides' ranges overlap are reported as unresolved.

Frame JS is the per-run p95 of JavaScript per frame, and GPU time is the per-run p95 of the compute pass timestamps (`--mark-gpu-timers`). Tables give the median over runs, with the minimum and maximum in parentheses. GPU timestamps on this host fall on steps of about 0.066 ms.

## Heatmaps

GPU pass p95 in milliseconds, three alternating pairs, 1.5-second budget:

| Case                       | Value range |              Before |               After | Path after      |
| -------------------------- | ----------- | ------------------: | ------------------: | --------------- |
| pan, 2400 × 600            | fixed       |    1.11 (1.11–1.11) | 0.524 (0.524–0.524) | `heatmap-slots` |
| zoom, 2400 × 600           | fixed       |    1.31 (1.25–1.38) |  0.721 (0.655–1.57) | `heatmap-slots` |
| tick, 2400 × 600           | fixed       | 0.066 (0.066–0.066) | 0.066 (0.066–0.066) | `heatmap-slots` |
| zoom, 2400 × 600 (control) | automatic   |    1.31 (1.31–2.42) |    1.25 (1.25–1.57) | `heatmap`       |

- With a fixed range, pan and zoom take about half the GPU time, the same result as in the study (1.114 to 0.524 and 1.311 to 0.721 ms). The renderer's estimated allocation falls from 30.84 to 22.60 MiB.
- A tick redraws one column either way, which takes less than one timestamp step.

Frame JS p95 in milliseconds, without timers:

| Case                    | Set            |              Before |               After |
| ----------------------- | -------------- | ------------------: | ------------------: |
| pan, 2400 × 600, fixed  | 1, three pairs |  0.870 (0.805–1.07) |    1.47 (1.39–1.63) |
| tick, 2400 × 600, fixed | 1, three pairs | 0.570 (0.415–0.755) | 0.660 (0.450–0.755) |
| pan, 2400 × 600, fixed  | 2, four pairs  |   1.16 (0.940–1.37) |   1.08 (0.905–1.33) |
| zoom, 2400 × 600, fixed | 2, four pairs  |  0.980 (0.935–1.36) |   1.04 (0.965–1.18) |

In the first set, the pan was slower after in all three pairs. The second set showed no difference, and the reasons point to load rather than the slot path:

- In the same first set's timer runs, the automatic-range control, whose path did not change, also rose from 0.965 to 1.22 ms.
- A profiled pair of the fixed pan measured 0.845 ms before and 0.875 ms after. In that profile, `quantize` takes about 17 µs per frame.

The slot path therefore does not resolve to any change in frame JS. Frame JS for the WebGL2 slot path also stayed within the spread of its runs ([WebGL2 heatmap](webgl2-heatmap.md)).

The changes that the slots make cheaper or more expensive come from the study fixture: a local engine, 1.44M held cells all in view, 30 operations after six warm-ups, and five alternating pairs. JS p95 in milliseconds, and the bytes written to the GPU per operation:

| Operation                        |       Before JS p95 |        After JS p95 | Upload bytes, before → after |
| -------------------------------- | ------------------: | ------------------: | ---------------------------: |
| Change the palette               |  0.910 (0.830–1.11) | 0.820 (0.780–0.930) |              29,408 → 28,384 |
| Change `valueMax`                |  0.895 (0.745–1.52) |    4.44 (3.71–4.82) |           29,408 → 1,468,384 |
| Replace the last 600-cell column | 0.595 (0.555–0.740) | 0.600 (0.565–0.690) |                  2,432 → 632 |

Slots trade the cost of a mapping change for cheaper frames. A change of `valueMin`, `valueMax` or `valueScale` turns every cell in view into slots again and uploads them, which goes over the 4 ms update budget here. The WebGL2 renderer and the Canvas 2D path already pay the same cost for a fixed range. An application that animates the range every frame should leave `valueMin` and `valueMax` unset. Without them, the heatmap keeps drawing from its values.

## Large scatter squares

GPU pass p95 in milliseconds, from the study fixture: one million source points, DPR 2, 48 alternating fractional viewport changes per size, five alternating pairs. The uniform fixture draws about one million marks at level 0. The burst fixture puts 87.5% of the points in the middle 3.125% of the time range and draws about 539,000 marks at level 1. The last column counts the pairs where after was lower.

| Square (device pixels) | Distribution | Before | After | Lower after |
| ---------------------: | ------------ | -----: | ----: | ----------: |
|            3 (control) | uniform      |  1.311 | 1.638 |         1/5 |
|            3 (control) | burst        |  1.114 | 1.376 |         2/5 |
|                      5 | uniform      |  3.473 | 1.966 |         3/5 |
|                      5 | burst        |  2.359 | 1.966 |         2/5 |
|                      7 | uniform      |  4.456 | 2.884 |         4/5 |
|                      7 | burst        |  3.539 | 2.228 |         5/5 |
|                      9 | uniform      |  6.029 | 3.670 |         5/5 |
|                      9 | burst        |  4.653 | 2.753 |         4/5 |

- At 7 and 9 pixels the new kernel takes 35–41% less GPU time, as in the study.
- At 3 pixels both sides run the same kernel, so the 0.26–0.33 ms that after shows there is the noise of this load and of the run order.
- At 5 pixels, the medians fall by more than that noise, but the individual pairs are mixed. The study on a quieter machine improved every uniform pair at 5 pixels, and its burst difference there was one timestamp step. The threshold stays at 5.
- Frame JS medians stay the same at every size (about 1.0 ms for burst, 1.3–1.4 ms for uniform). The p95 values of 48 frames differ in both directions.

## Scatter projection

Frame JS p95 in milliseconds, without timers:

| Case                                     | Set            |           Before |            After |
| ---------------------------------------- | -------------- | ---------------: | ---------------: |
| trades, 5M, pan (178,654 marks, level 3) | 1, three pairs | 5.68 (4.99–6.81) | 4.88 (3.11–4.97) |
| trades, 5M, pan                          | 2, four pairs  | 5.34 (5.08–6.17) | 3.43 (3.19–3.50) |
| cloud, 1M, zoom (control)                | 1, three pairs | 2.16 (2.02–2.87) | 2.53 (2.01–2.99) |
| cloud, 1M, zoom (control)                | 2, four pairs  | 2.10 (1.99–2.72) | 2.78 (2.65–3.02) |

On the trade-history pan, the price projection changes as the view moves. Frame JS p95 there falls by about a third, lower in each of the four pairs of the second set; the mean falls from 1.74 to 1.39 ms. In a profiled pair, the sampled self time of `scatterRecords` falls from 44.8 to 28.6 ms and that of `write` from 21.3 to 14.1 ms.

On the raw 1M cloud, the view shows nearly every row held. The mean stayed level or fell (2.13 to 2.00 ms in the second set), but p95 rose. To isolate the cause, this branch ran against a copy with only the projection change reverted, in four alternating pairs:

| 1M cloud | This branch, p95 (mean) | Projection reverted, p95 (mean) |
| -------- | ----------------------: | ------------------------------: |
| pan      |             1.66 (1.51) |                     1.56 (1.86) |
| zoom     |             2.02 (1.76) |                     1.82 (1.97) |

On this workload, the change moves the projection work rather than reducing it. Before, a frame that started over projected every held row at once; that rare large frame raised the mean but stayed beyond p95. After, that frame projects only the rows in view, and the pans that follow project the rest a little at a time. As a result, p95 rises by 0.1–0.2 ms and the mean falls by 0.2–0.35 ms, both well inside the 8 ms budget. The study proposed a threshold: below a minimum share of held rows saved, project them all. It is now calibrated at 0.4 ([projection threshold](projection-threshold.md)). The 1M cloud stays in the acceptance cases for it.

Raw runs:

- GPU: [before](webgpu-specialized-paths-gpu-before.json), [after](webgpu-specialized-paths-gpu-after.json)
- Frames, set 1: [before](webgpu-specialized-paths-frames-before.json), [after](webgpu-specialized-paths-frames-after.json)
- Heatmap frames, set 2: [before](webgpu-specialized-paths-heat-frames-before.json), [after](webgpu-specialized-paths-heat-frames-after.json)
- Scatter frames, set 2: [before](webgpu-specialized-paths-scatter-frames-before.json), [after](webgpu-specialized-paths-scatter-frames-after.json)
- Study pairs: [study](webgpu-specialized-paths-study.json)
- Projection A/B on the 1M cloud: [this branch](webgpu-specialized-paths-projection-branch.json), [projection reverted](webgpu-specialized-paths-projection-reverted.json)

## Reproduce

Run from the repository root, with a copy of the baseline's packages next to it:

```sh
base=$(mktemp -d)
git archive bf975a1 packages | tar -x -C "$base"
GPU=heatmap/candles-4800/2400x600-fixed/pan,heatmap/candles-4800/2400x600-fixed/zoom,heatmap/candles-4800/2400x600-fixed/tick,heatmap/candles-4800/2400x600/zoom,scatter/candles-2k/cloud-1m/zoom
FRAMES=scatter/candles-2k/trades-5m/pan,scatter/candles-2k/cloud-1m/zoom,heatmap/candles-4800/2400x600-fixed/pan

# Alternate: one invocation for the baseline, then one for this checkout, per round.
pnpm bench --packages "$base/packages" --lib lumen-worker --mark-renderer webgpu --case $GPU --mark-gpu-timers --repeats 1 --budget 1.5 --out gpu-before-1.json
pnpm bench --lib lumen-worker --mark-renderer webgpu --case $GPU --mark-gpu-timers --repeats 1 --budget 1.5 --out gpu-after-1.json
pnpm bench --packages "$base/packages" --lib lumen-worker --mark-renderer webgpu --case $FRAMES --repeats 1 --budget 2 --out frames-before-1.json
pnpm bench --lib lumen-worker --mark-renderer webgpu --case $FRAMES --repeats 1 --budget 2 --out frames-after-1.json
pnpm bench:merge gpu-before.json gpu-before-*.json

node benchmarks/prototypes/webgpu-specialization/transitions.mjs --packages "$base/packages" --sizes 3,5,7,9 --out study-before-1.json
node benchmarks/prototypes/webgpu-specialization/transitions.mjs --sizes 3,5,7,9 --out study-after-1.json
```

`rendererPath` and `backendFrames` in each run name the kernel that drew: `heatmap-slots` and `scatter-columns-wide` where the new kernels ran. Add `--profile <dir>` to a separate run to sample CPU stacks.
