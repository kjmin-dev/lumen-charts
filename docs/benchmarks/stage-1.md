# Stage 1: lumen against the stage 0 baseline

Stage 1 of the [design](../design.md) measured with the stage 0 harness, on the same machine and
settings as the [stage 0 baseline](stage-0-baseline.md): Apple M1, headed Chromium 156.0.8078.4,
viewport 1280 × 720, DPR 2, chart 1200 × 600. Every lumen number below comes from
[stage-1-lumen.json](stage-1-lumen.json); Lightweight Charts numbers come from
[stage-0-baseline.json](stage-0-baseline.json) and were not measured again.

- Code: commit `07db6e2`, recorded in the JSON. After the harness pull request was squash-merged, the
  same code was rebased onto `main` as `4dbe6d4`. The runner marks the tree as dirty because of an
  untracked local tool directory; no tracked file differed.
- Adapters: `lumen-worker` runs the data engine in a worker (the default); `lumen-main` runs it
  time-sliced on the main thread (`worker: false`). lumen takes the harness's columns as they are,
  so there is no conversion step; packing the columns into one transferable block is part of
  `setData`.
- 3 runs per case and adapter (the baseline used 5). Tables give the median, with the range of the
  runs in parentheses. The 10 s time budget never applied: every tick run measured all 10,000 ticks
  and every frames run all 300 frames.
- 132 runs in 8.3 minutes, none failed. Load average 9.0 at the start, 6.5 at the end (the baseline
  started at 4.5).

## Stage 1 gate

The design asks for, with 1 million bars: tick average 0.1 ms and p99 1 ms; pan and zoom frames p95
8 ms.

| Criterion (1M candles)                       | Target | lumen-worker            | lumen-main               | Met |
| -------------------------------------------- | ------ | ----------------------- | ------------------------ | --- |
| Tick average, last 200 / all bars in view    | 0.1 ms | 0.31 µs / 0.33 µs       | 0.33 µs / 0.28 µs        | yes |
| Tick p99, last 200 / all bars in view        | 1 ms   | ≤ 5 µs / ≤ 5 µs         | ≤ 5 µs / ≤ 5 µs          | yes |
| Frame JS p95, worst of 10 pan and zoom cases | 8 ms   | 2.98 ms (pan, all bars) | 3.03 ms (zoom, all bars) | yes |
| Frame interval p95, worst case               | –      | 17.7 ms                 | 17.7 ms                  | –   |

- Tick p99 is 5.00 µs in every run. Samples are multiples of the 5 µs timer step and almost all are
  0, so the true p99 is below one step. The timer-independent sub-batch p99 (mean of each round of
  100 ticks) is 0.55–0.85 µs.
- The gate names two reference devices, a desktop and a mid-range Android phone. Only the desktop
  was measured, so the gate is met on the desktop reference only.

## Against Lightweight Charts, 1M candles

| Metric                                         | LWC conflation on   | LWC conflation off  | lumen-worker        | lumen-main          |
| ---------------------------------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| Load: first painted frame                      | 1133 (1105–1283) ms | 1178 (1140–1256) ms | 33.6 (33.4–33.7) ms | 16.5 (15.9–17.1) ms |
| Load including conversion                      | 1169 (1145–1320) ms | 1221 (1184–1302) ms | 33.6 (33.4–33.7) ms | 16.5 (15.9–17.1) ms |
| Memory retained                                | 517 MiB             | 513 MiB             | see note            | 46.5 MiB            |
| Tick avg, last 200 bars                        | 9476 µs             | 9061 µs             | 0.31 µs             | 0.33 µs             |
| Tick p99, last 200 bars                        | 17410 µs            | 15845 µs            | ≤ 5 µs              | ≤ 5 µs              |
| Tick avg, all bars                             | 11103 µs            | 9611 µs             | 0.33 µs             | 0.28 µs             |
| Tick p99, all bars                             | 37770 µs            | 18520 µs            | ≤ 5 µs              | ≤ 5 µs              |
| Main thread per tick incl. paint, all bars avg | 12907 µs            | 24232 µs            | 4.38 µs             | 4.19 µs             |
| Pan, 200 bars: JS p95                          | 1.74 ms             | 2.36 ms             | 0.19 ms             | 0.20 ms             |
| Zoom, 200 bars: JS p95                         | 9.15 ms             | 9.00 ms             | 0.36 ms             | 0.41 ms             |
| Pan, 200,000 bars: JS p95                      | 2.01 ms             | 189 ms              | 2.15 ms             | 1.86 ms             |
| Zoom, 200,000 bars: JS p95                     | 9.19 ms             | 315 ms              | 2.23 ms             | 2.51 ms             |
| Pan, all bars: JS p95                          | 5.49 ms             | 845 ms              | 2.98 ms             | 2.93 ms             |
| Zoom, all bars: JS p95                         | 9.25 ms             | 864 ms              | 2.88 ms             | 3.03 ms             |
| `fillRect` per redraw, all bars                | 23,446              | 6,000,010           | 2,484               | 2,484               |

Other data sets: 1M line points load in 16.7 ms with either adapter (Lightweight Charts: 960–1003
ms) and 10M line points in 51–68 ms, retaining 153 MiB with the engine on the main thread
(Lightweight Charts crashed the renderer in every run).

## Observations

- **Tick cost does not depend on the number of bars.** `update()` writes the tick into a typed array
  and the engine applies a batch per task, so the average is 0.28–0.39 µs at 10k, 100k, 300k and 1M
  bars alike. Main-thread time per tick including the paint it causes is 1.6 µs with 200 bars in view
  and 4.2–4.4 µs with all bars in view, against 12.9–24.2 ms for Lightweight Charts.
- **Frame cost stops growing at about 20,000 bars in view.** Below one bar per device pixel, candles
  are merged per pixel column, so one redraw issues at most about 2,500 `fillRect` calls however many
  bars are in view. Frame JS p95 is 0.2–0.4 ms at 200 bars, 1.1–1.5 ms at 20,000 and 2.9–3.0 ms with
  all 1M in view; the remaining growth is the per-bar merge, which is linear in the bars in view (not
  profiled).
- **lumen is not faster everywhere.** Panning 200,000 bars, Lightweight Charts with conflation
  (2.01 ms) is on par with lumen (1.86–2.15 ms). lumen is ahead in zoom at every level, and at every
  level without conflation.
- **New data is drawn in the frame after it arrives.** The chart requests the rows around the visible
  range as soon as the engine reports new data, rather than in the next draw. Without this the first
  frame showed an empty chart and the data followed one frame later (load 33.5 ms on the main thread
  and 49.9 ms with the worker in a run before the change). With the worker, transferring the data and
  the worker's reply take one more frame than on the main thread.
- **Memory.** On the main thread, 1M candles retain 46.5 MiB: six columns of 8 bytes per bar (45.8
  MiB) plus the window around the view. With the worker the runner sees 0.3 MiB because it measures
  only the page; the worker holds the same columns.
- **Worker or main thread make little difference here.** The scenarios hand over data once and then
  tick lightly, so the main thread is never busy enough for the worker to pay off; the difference
  shows when the engine has real work (indicators, stage 3).

## Outlier

In one of three `lumen-main` runs panning 20,000 bars, one frame interval was 250 ms and one frame had
no draw, while the longest animation-frame callback took 1.87 ms: the main thread was busy outside
the chart's frames, or the browser skipped frames. Five more runs of every frames case with both
adapters (100 runs) showed no interval above 40 ms and a draw in every frame, so it was not
reproduced. The cause is not known.

## Caveats

- One desktop machine; Android, x86 and Firefox are unmeasured.
- Frame JS time covers animation-frame callbacks on the main thread. Work in the worker and GPU
  rasterization are not included; frame intervals stayed at the 60 Hz refresh (p95 16.7–17.7 ms).
- Memory of the worker is not measured (see Observations).
- The window cache holds raw rows only. With every bar in view it holds the whole history on the main
  thread as well, about 46 MiB for 1M candles. Level of detail is stage 2.
- Volume is not drawn by either library in these scenarios.

## Reproducing

```sh
pnpm bench --lib lumen-worker,lumen-main --repeats 3 --out benchmarks/results/stage-1-lumen.json
pnpm bench:report docs/benchmarks/stage-0-baseline.json benchmarks/results/stage-1-lumen.json
```

Since stage 2 the default matrix also has frames on 10M line points and the prepend scenario; add
`--case load,tick,frames/candles-1m` to run the stage 1 matrix alone. Memory now includes workers
(see [stage 2 before](stage-2-before.md)).
