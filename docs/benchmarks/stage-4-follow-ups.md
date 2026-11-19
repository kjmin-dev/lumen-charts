# Drawing handles, autoscale and restore

On an Apple M1, headless Chromium drew 1,000 autoscaling drawings over 1M candles in 0.60 ms of JavaScript per pan frame on average. A restore of the existing 1,000 drawings also avoided rebuilding their geometry.

Four interleaved rounds used a 5 s budget per case. The baseline used packages from `16b70c2` with the same harness. The table gives the mean of each round's reported metric. Times are milliseconds. Host load fluctuated substantially, so small differences in frame time are inconclusive. [Measurements for each round](stage-4-follow-ups.json).

| Case                                        | Engine | Metric                 | Baseline | With changes |
| ------------------------------------------- | ------ | ---------------------- | -------: | -----------: |
| Pan, 100 drawings in autoscale              | Worker | Mean frame JS          |        — |        0.299 |
| Pan, 1,000 drawings in autoscale            | Worker | Mean frame JS          |        — |        0.599 |
| Pan, 1,000 drawings, autoscale off          | Worker | Mean frame JS          |    0.672 |        0.535 |
| Hover, 1,000 drawings                       | Worker | Mean hit test          |   0.0021 |       0.0021 |
| Hover, 1,000 drawings                       | Worker | Mean frame JS          |    0.258 |        0.322 |
| Restore current state, 1,000 drawings       | Main   | Median call + frame JS |    2.810 |        1.360 |
| Restore into an empty chart, 1,000 drawings | Main   | Median call + frame JS |    2.180 |        2.249 |

The worker pan case's price span grew from 3.42 with autoscale off to 16.65 with it on. The empty-chart case still creates all 1,000 drawings. The existing-chart case reuses their ids.

Reproduce with `pnpm bench --case draw-autoscale,drawings/candles-1m/1000,state/candles-1m/1000 --lib lumen-worker,lumen-main --repeats 4 --budget 5`.
