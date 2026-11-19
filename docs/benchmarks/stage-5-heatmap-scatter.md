# Heatmap and scatter frame time

Headless Chromium on an Apple M1 ran a worker-backed chart at 1200 × 600 CSS pixels and DPR 2. Each case changes the viewport or sends one update per frame. The table gives JavaScript p95 per frame in milliseconds from the [24-case run](stage-5-heatmap-scatter.json). The pan and zoom budget is 8 ms and the update-frame budget is 4 ms.

| Visible data                    |   Pan |  Zoom | Tick |
| ------------------------------- | ----: | ----: | ---: |
| Scatter cloud, 100k points      |  2.82 |  4.12 | 0.08 |
| Scatter cloud, 300k points      |  6.00 | 10.11 |    — |
| Scatter cloud, 1M points        | 16.64 | 29.15 | 0.08 |
| Trade-shaped scatter, 5M points |  4.04 |     — |    — |
| Heatmap, 1,200 × 200 cells      |  3.62 |  5.00 | 0.38 |
| Heatmap, 2,400 × 600 cells      |  9.55 | 15.96 | 0.47 |

Time and price locality matter. At 5M trade-shaped points, level 3 supplies about 179k marks. A dispersed 1M-point cloud draws at full resolution. Appending a single point or replacing one column uses the dirty region of the series surface. Tick measurements cover frame work only. They do not measure end-to-end worker latency.

The pixel buffer meets both interaction budgets at 100k cloud points and 240k heatmap cells on this desktop. The first measured misses are 300k points on zoom and 1.44M cells on pan and zoom. A previous run on the same machine under heavier load gave zoom p95s of 9.67 and 15.89 ms for those two cases. Dense full redraws are the workloads to compare against WebGL2. Mobile hardware needs its own timings.

Reproduce with `pnpm bench --scenario scatter,heatmap --lib lumen-worker --repeats 1 --budget 3`.
