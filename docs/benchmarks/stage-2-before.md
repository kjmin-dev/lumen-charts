# Stage 2 before: lumen stage 1 on the stage 2 scenarios

The stage 2 gate of the [design](../design.md) (section 9) is: with 10 million line points, pan and
zoom p95 16 ms, and the screen updated within 100 ms of a prepend. The harness could measure neither
part, nor the memory of a data engine that runs in a worker. This document defines the three
additions to the harness and records the stage 1 lumen code on them: the "before" that stage 2
(level of detail, window cache by level, memory cap) is compared with. Every number comes from
[stage-2-before-lumen.json](stage-2-before-lumen.json) and
[stage-2-before-lwc.json](stage-2-before-lwc.json).

- **Headless.** These runs are headless (Chromium 156.0.8078.4 in new headless mode, rasterizing on
  the GPU), the runner's default since this stage. Stage 0 and stage 1 were measured headed. Frame
  JavaScript time and tick cost match between the modes; headless frame intervals do not (they stay
  at the refresh interval, see the [stage 0 notes](stage-0-baseline.md#reproducing)). Compare the
  numbers here with stage 1 only with that caveat, and do not compare intervals at all.
- Machine and settings as in stage 0 and 1: Apple M1 on AC power, viewport 1280 × 720, DPR 2,
  chart 1200 × 600.
- Code: lumen as of `dcf50f3` (stage 1; `packages/` is unchanged on this branch), harness at
  `8e1a512`, recorded in the JSON with a clean tree.
- Adapters: `lumen-worker` and `lumen-main` on every case; Lightweight Charts (both variants) only
  on prepends of 10k bars to 1M candles (see Prepend).
- 3 runs per case and adapter; tables give the median with the range of the runs in parentheses.
  All times in ms.
- 114 runs, none failed: 108 lumen runs in 9.0 minutes, then 6 Lightweight Charts runs in 1.3
  minutes; 10.5 minutes of wall time including the two builds. Load average (1 min) 3.10 at the
  start and 5.92 at the end; the machine was shared with light editing and unit tests.

## Stage 2 gate

| Criterion, 10M line points                 | Target | lumen-worker               | lumen-main                 | Met on this desktop                      |
| ------------------------------------------ | ------ | -------------------------- | -------------------------- | ---------------------------------------- |
| Pan: frame JS p95, worst of 6 zoom levels  | 16 ms  | 12.0 ms (all 10M in view)  | 12.2 ms (all 10M in view)  | yes, 3.8 ms to spare                     |
| Zoom: frame JS p95, worst of 6 zoom levels | 16 ms  | 12.1 ms (all 10M in view)  | 12.0 ms (all 10M in view)  | yes, 3.9 ms to spare                     |
| Prepend 10k: shown p95 (worst prepend)     | 100 ms | 18.0 ms (18.5 ms)          | 17.9 ms (18.4 ms)          | yes                                      |
| Prepend 1M: shown p95 (worst prepend)      | 100 ms | 47.8 ms (88.9 ms)          | 46.3 ms (53.3 ms)          | yes, 11 ms to spare in the worst prepend |
| Frame interval p95, worst                  | –      | 16.7 ms (headless: pinned) | 16.7 ms (headless: pinned) | –                                        |

"Worst prepend" is the largest single latency of all prepends in the three runs. The stage 1 code
already meets the stage 2 numbers in these scenarios, on this desktop, without level of detail. The
gate names two reference devices; the mid-range Android one is not measured, so the gate is not
shown to be met on it. The margin is small for a desktop: at 12.2 ms, a device whose JavaScript runs
1.3 times slower than this M1 would miss 16 ms with all 10M points in view (arithmetic, assuming
frame time scales with CPU speed).

## Scenarios

The harness in `benchmarks/` got three additions. Everything else (page, build, settling, frame
instrumentation, repeats, time budget) is as described in the [stage 0 baseline](stage-0-baseline.md#method).

### Pan and zoom on 10M line points

The frames scenario of stage 0 on a second data set: 10 million line points (`line-10m`), with 200,
2,000, 20,000, 200,000, 2,000,000 and all 10M bars in view. The pane is about 2,300 device pixels
wide, so these are about 0.09, 0.9, 9, 90, 900 and 4,300 bars per device pixel; the zoom motion goes
from half to twice each level. The 2M level exists only for this data set (levels at or above the
data set size are left out). The metrics are the stage 0 ones; the gate is read on frame JavaScript
time, as stage 1's was.

Lightweight Charts is not run on 10M line points: loading them crashed its renderer in all 10 stage
0 runs. The adapter registry now lists such known failures, and the planner skips and reports them
(`--include-known-crashes` runs them anyway).

### Prepend

A chart is loaded with the base data set. Then, repeatedly:

1. Untimed: a batch of older bars is generated that ends one interval before the series' current
   first bar, and the view is set so that the first bar is in the middle of the pane. The left half
   of the view is empty.
2. `prepend(batch)` is called. Existing bars keep their logical indexes and the new ones take the
   indexes below, so the view stays where it is and the batch appears in its left half.
3. The latency is measured until the frame that shows the batch.

Consecutive prepends continue back in time, like pages of history loaded while the user keeps
scrolling left. The first prepend of a run is cold (its code paths are not compiled yet) and is
reported separately; the distributions cover the following ones.

| Base       | Batch | Bars in view | Prepends measured | Rows after the run |
| ---------- | ----- | ------------ | ----------------- | ------------------ |
| 1M candles | 10k   | 20k          | up to 20, min 5   | up to 1.21M        |
| 1M candles | 1M    | 1M           | up to 5, min 3    | up to 7M           |
| 10M line   | 10k   | 20k          | up to 20, min 5   | up to 10.21M       |
| 10M line   | 1M    | 2M           | up to 5, min 3    | up to 16M          |

- **Bases** are the data sets of the gates: 10M line points are the stage 2 gate's, 1M candles the
  stage 1 gate's and the frames scenario's.
- **10k** is a page of history of the size a datafeed delivers while the user scrolls back, small
  enough that the fixed costs of a prepend (messages, the window request, one redraw) dominate.
  **1M** is a bulk load. The other costs grow with the batch (packing, copying into the store, the
  window snapshot, and at stage 2 the level-of-detail buckets of the new range); 1M makes them
  visible against the 100 ms gate.
- **Bars in view** are twice the batch, so the batch fills exactly the left half: the zoom follows
  the batch the way a datafeed sizes its pages to the screen. lumen does not zoom out further than
  all data fits, so the view is at most the base (1M for 1M candles, where the left half shows half
  of each batch).
- **Prepends per run**: every 1M prepend adds 1M rows, hence fewer. The time budget (`--budget`,
  10 s) applies as it does to ticks and frames.

Metrics per prepend, from the `prepend` call:

- **Shown**: until `settle()`, called right after `prepend`, resolves: the bars are applied and the
  main thread has finished rendering the frame that shows them. This is the gate's "screen
  updated". For lumen it is exact: `settle()` waits until the engine has answered every command
  (the prepend and the window request it triggers) and the chart has drawn with them.
- **First frame**: until the end of the first frame in which the library ran an animation-frame
  callback. For lumen that frame can still show the old window: the engine's answer to the prepend
  makes the chart request the rows of the new range and draw, in the same task, and if the rows
  come back after that frame, a second draw shows them. For Lightweight Charts, which applies
  `setData` synchronously, the first frame is the one that shows the bars.
- **Call**: the synchronous `prepend` call (lumen: packing the columns into one transferable block
  and posting it).
- **Longest frame**: the longest gap between the call, every frame that began before the bars were
  shown, and that moment: how long the screen could not update. About one refresh interval when
  nothing blocks the main thread.
- **Prepare**: building the batch in the library's input format before the call; not part of any
  latency (in the JSON).

After the last prepend, two untimed redraws count Canvas 2D calls: one at the last prepend's view
(left half: the last batch) and one at the new first bar (left half empty). In every case the first
issues 1.85 to 2.00 times the series calls of the second (lumen candles `fillRect` 2,486 against
1,343; lumen line `lineTo` 9,089 against 4,545; Lightweight Charts `fillRect` 15,010 against 7,510
with conflation, 120,010 against 60,010 without), so the prepended bars are drawn.

Lightweight Charts has no prepend. The adapter emulates it the way the library adds older history:
`setData` with the older bars followed by the current ones. Building that array (converting the
batch, reading the current bars back with `series.data()`, concatenating) is preparation; the
latency starts at `setData`. This is not equivalent to a prepend: `setData` processes every bar of
the series again, so its cost grows with the history already loaded. It was run only with 10k
batches on 1M candles; 1M batches would take it to 7M candles, about 3.5 GiB of JavaScript heap at
the 538–550 bytes per candle of stage 0.

The adapter interface gained `preparePrepend` and `prepend`. Logical ranges keep a fixed origin
(prepended rows get negative indexes), which the Lightweight Charts adapter maps onto the library's
indexes, which start at its first bar.

### Worker memory

Memory samples now include the page's dedicated workers. Every worker has a V8 heap of its own,
which `Runtime.getHeapUsage` on the page does not include, so stage 1 saw 0.3 MiB for `lumen-worker`.

- The runner attaches to the page's workers with CDP `Target.setAutoAttach` on the page's session
  and sends each worker `HeapProfiler.collectGarbage` and `Runtime.getHeapUsage`. Playwright's CDP
  sessions cannot address the flattened child sessions that `setAutoAttach` creates with
  `flatten: true`, so the runner uses the older non-flat mode and `Target.sendMessageToTarget`
  (deprecated in the protocol, working in Chromium 156). Workers are attached only while a sample
  is taken, so no debugging session is attached while scenarios are timed. If attaching fails, the
  sample says so and has no worker numbers.
- Page and workers stay separate: the existing fields are the page's, `workers` holds the workers'
  sum and count, `allTotalBytes` both. `retainedBytes` is now page plus workers (it was the page
  alone; results schema 2), with `retainedPageBytes` and `retainedWorkerBytes` next to it.
- Checked: in a test page, a worker holding a 100 MiB `Float64Array` reports 100.0 MiB of backing
  stores. With 1M candles, `lumen-worker` reports 46.5 MiB in its worker and 0.3 MiB in the page,
  the same 46.5 MiB that `lumen-main` holds in the page (table below).
- On the manual page, `performance.measureUserAgentSpecificMemory` is split the same way, by the
  realm each entry is attributed to.

## Results

### Pan and zoom, 10M line points

| Motion, bars in view | Adapter      | JS p50              | JS p95              | JS p99              | JS max              | Interval p95     | Interval max     | `lineTo` per redraw |
| -------------------- | ------------ | ------------------- | ------------------- | ------------------- | ------------------- | ---------------- | ---------------- | ------------------- |
| pan 200              | lumen-worker | 0.290 (0.275–0.305) | 0.440 (0.420–0.445) | 0.520 (0.515–0.520) | 0.565 (0.565–0.770) | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 199                 |
| pan 200              | lumen-main   | 0.280 (0.250–0.305) | 0.440 (0.385–0.460) | 0.540 (0.485–0.550) | 0.570 (0.560–0.645) | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 199                 |
| zoom 200             | lumen-worker | 0.245 (0.230–0.250) | 0.365 (0.315–0.380) | 0.385 (0.350–0.440) | 0.420 (0.400–0.510) | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 199                 |
| zoom 200             | lumen-main   | 0.250 (0.240–0.255) | 0.350 (0.300–0.395) | 0.400 (0.385–0.510) | 0.565 (0.440–0.600) | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 199                 |
| pan 2,000            | lumen-worker | 0.345 (0.330–0.350) | 0.475 (0.440–0.495) | 0.530 (0.515–0.540) | 0.580 (0.580–0.580) | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 1999                |
| pan 2,000            | lumen-main   | 0.330 (0.325–0.405) | 0.415 (0.410–0.530) | 0.510 (0.460–0.580) | 0.615 (0.545–0.630) | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 1999                |
| zoom 2,000           | lumen-worker | 0.415 (0.355–0.465) | 0.725 (0.590–0.810) | 0.785 (0.645–0.860) | 0.860 (0.805–0.920) | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 1999                |
| zoom 2,000           | lumen-main   | 0.425 (0.415–0.430) | 0.700 (0.685–0.710) | 0.765 (0.745–0.785) | 0.835 (0.800–0.905) | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 1999                |
| pan 20,000           | lumen-worker | 0.875 (0.800–0.875) | 1.11 (1.05–1.13)    | 1.20 (1.18–1.21)    | 1.34 (1.23–1.64)    | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 9089                |
| pan 20,000           | lumen-main   | 0.795 (0.795–0.875) | 1.06 (1.05–1.10)    | 1.14 (1.13–1.17)    | 1.25 (1.22–1.25)    | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 9089                |
| zoom 20,000          | lumen-worker | 0.835 (0.795–0.850) | 1.13 (0.990–1.20)   | 1.33 (1.12–1.41)    | 1.45 (1.27–1.49)    | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 9089                |
| zoom 20,000          | lumen-main   | 0.800 (0.785–0.835) | 1.17 (1.13–1.28)    | 1.38 (1.37–1.38)    | 1.45 (1.45–1.46)    | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 9089                |
| pan 200,000          | lumen-worker | 1.94 (1.61–1.96)    | 2.74 (2.74–2.74)    | 2.81 (2.80–2.87)    | 2.97 (2.91–2.99)    | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 9089                |
| pan 200,000          | lumen-main   | 2.13 (1.70–2.16)    | 2.73 (2.72–2.76)    | 2.79 (2.77–2.81)    | 2.89 (2.79–2.90)    | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 9089                |
| zoom 200,000         | lumen-worker | 2.21 (1.80–2.34)    | 3.39 (3.31–3.54)    | 3.58 (3.53–3.75)    | 3.86 (3.77–3.93)    | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 9089                |
| zoom 200,000         | lumen-main   | 2.08 (1.93–2.43)    | 3.42 (3.32–3.48)    | 3.70 (3.64–3.72)    | 3.84 (3.82–3.91)    | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 9089                |
| pan 2,000,000        | lumen-worker | 4.49 (4.40–4.50)    | 4.88 (4.88–4.99)    | 5.01 (5.00–6.67)    | 7.34 (7.19–7.72)    | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 9089                |
| pan 2,000,000        | lumen-main   | 4.47 (4.47–4.47)    | 4.80 (4.71–4.85)    | 4.91 (4.87–4.99)    | 6.58 (6.56–7.33)    | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 9089                |
| zoom 2,000,000       | lumen-worker | 4.41 (4.38–4.67)    | 6.25 (6.24–6.27)    | 6.52 (6.44–6.54)    | 6.68 (6.55–6.74)    | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 9089                |
| zoom 2,000,000       | lumen-main   | 4.52 (4.50–4.67)    | 6.26 (6.22–6.29)    | 6.53 (6.47–6.56)    | 6.63 (6.61–6.71)    | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 9089                |
| pan all 10M          | lumen-worker | 9.99 (9.93–10.0)    | 12.0 (12.0–12.1)    | 12.3 (12.3–12.5)    | 12.5 (12.5–14.2)    | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 9089                |
| pan all 10M          | lumen-main   | 9.98 (9.94–10.0)    | 12.2 (12.1–12.2)    | 12.4 (12.3–12.4)    | 12.6 (12.6–13.2)    | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 9089                |
| zoom all 10M         | lumen-worker | 7.52 (6.98–7.82)    | 12.1 (12.0–12.2)    | 13.3 (13.2–14.1)    | 39.7 (26.2–40.0)    | 16.7 (16.7–16.7) | 33.3 (16.7–33.3) | 9089                |
| zoom all 10M         | lumen-main   | 7.75 (7.74–7.78)    | 12.0 (12.0–12.2)    | 16.1 (14.1–16.8)    | 30.5 (18.1–30.5)    | 16.7 (16.7–16.7) | 33.3 (16.7–33.3) | 9089                |

Every run measured all 300 frames, with a library draw in every frame. Intervals are headless.

### Prepend

| Base + batch, bars in view | Adapter            | Shown p50        | Shown p95        | Shown max        | First frame p50  | Call max            | Longest frame max | Cold shown       | Prepends   |
| -------------------------- | ------------------ | ---------------- | ---------------- | ---------------- | ---------------- | ------------------- | ----------------- | ---------------- | ---------- |
| line 10M + 10k, 20k        | lumen-worker       | 17.2 (17.1–17.2) | 18.0 (17.8–18.4) | 18.3 (18.1–18.5) | 17.1 (17.1–17.2) | 0.175 (0.170–0.330) | 15.9 (15.6–15.9)  | 17.2 (17.0–17.3) | 20 (20–20) |
| line 10M + 10k, 20k        | lumen-main         | 17.3 (17.1–17.4) | 17.9 (17.7–18.3) | 18.1 (18.0–18.4) | 17.3 (17.1–17.3) | 0.115 (0.110–0.145) | 15.4 (15.3–15.6)  | 16.9 (16.8–17.0) | 20 (20–20) |
| line 10M + 1M, 2M          | lumen-worker       | 35.0 (28.6–37.7) | 47.8 (46.1–88.9) | 47.8 (46.1–88.9) | 13.2 (12.3–23.3) | 3.16 (3.13–3.37)    | 18.1 (16.7–19.3)  | 36.3 (35.9–36.4) | 5 (5–5)    |
| line 10M + 1M, 2M          | lumen-main         | 32.6 (32.4–37.8) | 46.3 (44.9–53.3) | 46.3 (44.9–53.3) | 15.4 (14.6–23.6) | 2.66 (2.64–5.03)    | 17.8 (16.7–17.9)  | 36.0 (31.1–38.2) | 5 (5–5)    |
| candles 1M + 10k, 20k      | lumen-worker       | 17.3 (17.1–17.5) | 18.0 (17.7–18.1) | 18.5 (17.9–18.7) | 17.3 (17.1–17.5) | 0.270 (0.240–0.285) | 15.5 (15.2–15.6)  | 16.4 (16.4–16.5) | 20 (20–20) |
| candles 1M + 10k, 20k      | lumen-main         | 17.3 (17.3–17.4) | 18.1 (18.0–18.3) | 18.2 (18.2–18.6) | 17.3 (17.3–17.4) | 0.175 (0.135–0.180) | 15.6 (15.1–15.7)  | 16.8 (16.3–17.0) | 20 (20–20) |
| candles 1M + 10k, 20k      | lwc-conflation-on  | 586 (580–602)    | 833 (804–879)    | 833 (804–879)    | 586 (580–602)    | 728 (699–748)       | 820 (802–867)     | 516 (511–642)    | 15 (15–16) |
| candles 1M + 10k, 20k      | lwc-conflation-off | 798 (760–890)    | 1031 (1021–1254) | 1031 (1021–1254) | 798 (760–890)    | 731 (724–804)       | 1001 (983–1254)   | 770 (711–797)    | 11 (11–12) |
| candles 1M + 1M, 1M        | lumen-worker       | 43.8 (43.8–44.2) | 48.4 (47.9–55.1) | 48.4 (47.9–55.1) | 19.7 (18.9–24.7) | 7.13 (6.90–7.22)    | 16.7 (16.7–16.7)  | 37.3 (37.1–41.4) | 5 (5–5)    |
| candles 1M + 1M, 1M        | lumen-main         | 46.6 (36.7–48.0) | 50.3 (48.2–66.4) | 50.3 (48.2–66.4) | 24.4 (23.9–24.6) | 6.54 (5.84–8.08)    | 16.7 (16.7–16.7)  | 35.7 (34.7–36.1) | 5 (5–5)    |

With 5 measured prepends, p95 and max are the same prepend. Lightweight Charts runs stopped at the
10 s budget.

### Memory

| Case                           | Adapter            | Rows   | Retained (MiB)   | Page (MiB)          | Workers (MiB)       | Bytes per row |
| ------------------------------ | ------------------ | ------ | ---------------- | ------------------- | ------------------- | ------------- |
| candles 1M, after load         | lumen-worker       | 1M     | 46.8 (46.8–46.8) | 0.305 (0.305–0.311) | 46.5 (46.5–46.5)    | 49.1          |
| candles 1M, after load         | lumen-main         | 1M     | 46.5 (46.5–46.5) | 46.5 (46.5–46.5)    | 0.000 (0.000–0.000) | 48.8          |
| line 10M, after load           | lumen-worker       | 10M    | 154 (154–154)    | 0.249 (0.249–0.252) | 153 (153–153)       | 16.1          |
| line 10M, after load           | lumen-main         | 10M    | 153 (153–153)    | 153 (153–153)       | 0.000 (0.000–0.000) | 16.1          |
| candles 1M, after 10k prepends | lumen-worker       | 1.21M  | 59.7 (59.7–59.7) | 3.39 (3.39–3.39)    | 56.3 (56.3–56.3)    | 51.7          |
| candles 1M, after 10k prepends | lumen-main         | 1.21M  | 59.4 (59.4–59.4) | 59.4 (59.4–59.4)    | 0.000 (0.000–0.000) | 51.5          |
| candles 1M, after 1M prepends  | lumen-worker       | 7M     | 483 (483–483)    | 161 (161–161)       | 322 (322–322)       | 72.3          |
| candles 1M, after 1M prepends  | lumen-main         | 7M     | 482 (482–482)    | 482 (482–482)       | 0.000 (0.000–0.000) | 72.3          |
| line 10M, after 10k prepends   | lumen-worker       | 10.21M | 158 (158–158)    | 1.56 (1.56–1.56)    | 157 (157–157)       | 16.2          |
| line 10M, after 10k prepends   | lumen-main         | 10.21M | 158 (158–158)    | 158 (158–158)       | 0.000 (0.000–0.000) | 16.2          |
| line 10M, after 1M prepends    | lumen-worker       | 16M    | 337 (337–337)    | 92.1 (92.1–92.1)    | 245 (245–245)       | 22.1          |
| line 10M, after 1M prepends    | lumen-main         | 16M    | 337 (337–337)    | 337 (337–337)       | 0.000 (0.000–0.000) | 22.1          |
| candles 1M, after 10k prepends | lwc-conflation-on  | 1.16M  | 523 (523–527)    | 523 (523–527)       | 0.000 (0.000–0.000) | 473           |
| candles 1M, after 10k prepends | lwc-conflation-off | 1.12M  | 588 (588–593)    | 588 (588–593)       | 0.000 (0.000–0.000) | 551           |

"After load" is the load scenario (warm load, latest bars in view); "after prepends" is sampled at
the end of a prepend run, with the view at the new first bar. Rows of Lightweight Charts are the
median run's.

## Observations

- **Frame time grows with the points in view, not with draw calls.** Frame JS p95 is 0.35–0.44 ms
  with 200 points in view, 1.1–1.2 ms at 20,000, 2.7–3.4 ms at 200,000, 4.8–6.3 ms at 2M and
  12.0–12.2 ms with all 10M, while every redraw from 20,000 points up issues the same 9,089 `lineTo`
  calls. The growth is per-point work in every frame (not profiled here). At stage 1 there is no
  level of detail, so every frame goes over every point in view; that is what stage 2 bounds, and
  the 3.8 ms margin at all 10M is what it has to protect on slower devices.
- **Zooming with all 10M points in view has outliers.** The longest frame of a run took 26.2–40.0 ms
  of JavaScript with `lumen-worker` and 18.1–30.5 ms with `lumen-main`. The four runs whose longest
  frame took 30 ms or more each have one frame interval of 33.3 ms (a missed frame); JS p99 stays at
  13.2–16.8 ms. The cause is not known (not profiled).
- **10k prepends are on screen in the next frame.** Shown p50 17.2–17.3 ms and p95 17.9–18.1 ms on
  both bases and with both adapters, and the first frame after the call already shows the batch.
- **1M prepends take two to three frames.** Shown p50 32.6–46.6 ms, p95 46.3–50.3 ms. The first
  frame comes 13–24 ms after the call (p50), 20–25 ms before the bars are shown. By the code, that
  frame still draws the old window, and the bars follow once the engine has copied the window
  snapshot of the new range: for the 2M-bar view, two screens on each side clipped at the first
  bar, 6M rows, which matches the 92.1 MiB the page holds afterwards (6M × 16 bytes = 91.6 MiB).
  The worst single prepend, 88.9 ms, was in one `lumen-worker` run on 10M line points; the other two
  runs' worst were 46.1 and 47.8 ms.
- **Prepends never freeze the screen.** No gap between frames during a prepend was longer than 19.3
  ms in any lumen run. The call takes up to 8.1 ms for 1M candles and 5.0 ms for 1M points (packing
  the columns into one block of 48 and 16 MB); the rest runs in the worker or in time slices. Worker
  and main thread give the same latencies within the run-to-run spread.
- **Lightweight Charts' emulated prepend blocks for most of a second.** Adding 10k bars to 1M candles
  with `setData` takes 586 ms (conflation on) and 798 ms (off) to the screen at p50, 833 and 1,031
  ms at p95, and the main thread is blocked for nearly all of it (longest frame gap 820 and 1,001
  ms). That is 34 and 46 times lumen's p50 on the same case.
- **The worker holds the store, the page holds the window.** After load, the worker holds 46.5 MiB
  for 1M candles (six 8-byte columns: 45.8 MiB) and 153 MiB for 10M line points (two columns: 152.6
  MiB); the page holds 0.25–0.31 MiB. `lumen-main` holds the same total in the page.
- **Wide views make the main-thread window large, and nothing caps memory.** After the 1M prepends
  the worker holds 245 MiB for 16M points (16M × 16 bytes = 244 MiB) and 322 MiB for 7M candles
  (7M × 48 bytes = 320 MiB), and the page holds another 92.1 and 161 MiB of raw rows for the window
  around a 2M- or 1M-bar view.
  At stage 1 the window cache holds raw rows for the view plus two screens on each side; stage 2's
  window cache by level and its memory cap are meant to replace this.

## Caveats

- One desktop machine, headless. The mid-range Android reference device of the gate, x86 and Firefox
  are unmeasured.
- Headless frame intervals stay at the refresh interval and miss rasterization and presentation
  stalls; the 33.3 ms intervals above appear only in runs with a frame of 30 ms or more of
  JavaScript. Use `--headed` for intervals comparable with stage 0 and 1.
- Frame JavaScript time covers animation-frame callbacks on the main thread. The engine's work in
  the worker is not in it, and neither are the main-thread engine's time slices, which run in tasks
  between frames.
- Prepend latency ends when the main thread has rendered the frame; GPU rasterization and display
  come after. The scenario prepends to a series whose view sits at the first bar; a prepend far
  outside the view would only change the extent.
- Memory excludes canvas and GPU memory and the browser and GPU processes, as in stage 0.

## Reproducing

```sh
pnpm bench --case frames/line-10m,prepend,load/candles-1m,load/line-10m --lib lumen-worker,lumen-main \
  --repeats 3 --out benchmarks/results/stage-2-before-lumen.json
pnpm bench --case prepend/candles-1m/10k --lib lwc-conflation-on,lwc-conflation-off --repeats 3 \
  --out benchmarks/results/stage-2-before-lwc.json
pnpm bench:report docs/benchmarks/stage-2-before-lumen.json docs/benchmarks/stage-2-before-lwc.json
```

Runs are headless by default; `pnpm bench --quick --scenario frames,prepend` is a one-minute smoke
test of the new scenarios.
