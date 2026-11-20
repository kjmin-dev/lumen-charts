# Live heatmap updates and mark composition

Apple M1, headless Chromium 156 with hardware WebGL2. The chart measured 1200 × 600 CSS pixels at DPR 2. Three production runs of the worker workload replaced the final 600-cell column of a 2400-column view with candles and a drawing. The median of the three frame JavaScript p95s fell from 1.005 ms on `9ed5a66` to 0.500 ms. Frame interval p95 was 16.67 ms in both sets on the virtual display. [Per-run measurements](mark-update-composition.json)

```sh
pnpm bench --case heatmap/candles-4800/2400x600/tick --lib lumen-worker --mark-renderer webgl2 --repeats 3 --budget 2
```

A separate public-API probe used the local engine, 100 bars and a heatmap with 128 values per column at the same chart size and DPR. It counted the four-byte words written by `texSubImage2D` and the clip on the final pane composition. A 100,000-point scatter shared the plot. Eight paired updates exercised a second chart measuring 460 × 260 CSS pixels.

| Operation                                                           |     Before |      After |
| ------------------------------------------------------------------- | ---------: | ---------: |
| Last column, value bytes uploaded                                   |        512 |        512 |
| Last column, coordinate-table bytes uploaded                        |     27,328 |          0 |
| Last column, pane width repainted in device pixels                  |      2,272 |         23 |
| Scatter opacity change, record bytes uploaded                       |    800,000 |          0 |
| Shared WebGL canvas dimension assignments across eight update pairs |         32 |          0 |
| Highest page rendering bytes sampled after a settled update pair    | 61,984,256 | 70,910,976 |

The shared buffer now retains room for the larger chart between draws. The page budget covers the retained capacity. Destroying the larger chart reduced the buffer to the remaining pane's 792 × 464 device pixels. Destroying both charts returned the tracked allocation to its starting value. The memory samples include chart bitmaps and tracked mark resources. Transient driver allocations fall outside this counter.
