# Shared resources between charts

Every chart used to take its own worker, animation-frame callback, `ResizeObserver` and media query
lists, measured itself with a forced layout, and kept drawing when it was scrolled out of view.
The charts of a page now share those resources (see "Several charts on one page" in the
[guide](../guide/several-charts.md) and section 3 of the [design](../design.md)). This document gives what
that changed, measured before and after, and what it did not change.

The short version, for 16 charts with 100k candles each, 8 of them in view:

- **Clear, by count or with ranges that do not overlap:** 16 workers become 4; the renderer's
  resident memory grows by 117 MiB instead of 156 MiB; all charts are shown after 60 ms instead of
  90 ms; a round of ticks runs 1 animation-frame callback instead of 16 and draws 8 charts instead
  of 16.
- **Smaller than expected or within the spread:** frame JavaScript per round fell by a fifth to a
  quarter, not by half; main-thread time per round is about the same.
- **Worse:** a `series.update()` call got 0.36 µs slower per tick in this case, which an experiment
  traces to the charts that are no longer drawn (see "The update call"). The page heap of a single
  chart is 0.03–0.05 MiB larger.
- **No effect:** with every chart in view (4 charts, 1M candles each) nothing changed in time or
  memory except the layout work while loading. For a single chart, tick and pan cost are the same
  in a paired test, and the harness runs of the gate cases overlap in every time.

## Conditions

Apple M1 (8 cores) on AC power, headless Chromium 156.0.8078.4 (new headless mode, GPU
rasterization), viewport 1280 × 720, DPR 2, Node 26.13.1. Tables give the median with the range of
the runs in parentheses; times in ms unless a unit is given.

- **Before** is `main` at `74052b7`; **after** is the branch at `383318b`. Both were measured with
  the branch's harness: the runner's new `--packages` option builds the adapters from the
  `packages/` directory of another checkout.
- **Hashes.** The hashes in this document are the ones recorded in the JSON files, from before the
  branch was rebased onto `main` at `73d2dbe`. After the rebase the same commits are `090579f`
  (`383318b`), `b7f20de` (`65731c7`) and `8d04e5a` (`5ee2d92`). Between `74052b7` and `73d2dbe`,
  `main` gained license, release and package metadata files; no library or harness source changed,
  so nothing was measured again.
- **Alternating runs.** Before and after ran one after the other, one invocation each, pass after
  pass, so drift of the machine falls on both. `pnpm bench:merge` joined the invocations of each
  side into one file with a run per pass. "Pairs" below compares the two sides of one pass.
- **The machine was not quiet.** Other work ran on it during every run; benchmarks themselves never
  overlapped. The load average of every invocation is in the JSON files (`environment.merged`) and
  quoted with each table.
- **Times fall into two states.** Runs of one and the same configuration give frame JavaScript
  times that differ by a factor of about two: the three rows of the worker table below that are the
  same configuration (4 charts in 4 workers) range from 0.200 to 0.505 ms per round. The cause was
  not investigated. Counts and memory do not depend on it. For times, treat a difference as shown
  only where the ranges do not overlap or where the pairs agree, and see the paired test under
  "Single-chart gates" for a comparison that is free of it.

Files:

- [shared-resources-multi-before.json](shared-resources-multi-before.json) and
  [shared-resources-multi-after.json](shared-resources-multi-after.json): the multi-chart scenario,
  5 passes.
- [shared-resources-workers.json](shared-resources-workers.json): the branch with worker limits of
  1, 2, 4, 8 and 16, 3 passes.
- [shared-resources-gates-before.json](shared-resources-gates-before.json) and
  [shared-resources-gates-after.json](shared-resources-gates-after.json): existing gate cases, 4
  passes. Passes 1 and 2 ran at `65731c7` with uncommitted documentation in the tree, passes 3 and
  4 at `383318b`; the library sources are the same in both.

## The multi-chart scenario

New in the harness (`--scenario multi`). Auto-sized charts fill the cells of a grid whose first
rows fill the viewport; the other rows are below the fold. One loop creates every chart and hands
it its data; then every chart gets the same tick, round after round (every tenth tick starts a new
bar), and the harness waits for all charts after each round. Two cases:

- **16 charts, 100k candles each, 8 in view** (cells of 314 × 360 CSS pixels).
- **4 charts, 1M candles each, all in view** (cells of 636 × 360).

What is measured:

- **Workers** and **worker heaps**: over CDP, after a collection in each worker, as in stage 2.
- **Renderer resident growth**: resident memory of the browser's renderer processes (`ps`) after
  the charts are loaded, minus before they are created. It includes what the heaps do not: thread
  stacks, the engine's own structures per thread, compiled code, canvas bitmaps.
- **Create and load loop**: the synchronous loop of `createChart` and `setData` for every chart.
- **All charts shown**: from the start of that loop until every chart has settled with its data.
- **Layout until shown**: the browser's own layout time in that span (CDP `Performance.getMetrics`).
- **Per round of ticks**: JavaScript in animation-frame callbacks, the number of those callbacks,
  and the main thread's total task time from the browser's counters, which also counts message
  handlers, rendering and the harness's own loop.
- **Reveal**: frame JavaScript when the charts below the fold are scrolled into view at the end.

## 16 charts, 8 in view

5 passes, 241 rounds each. Load average 3.8–5.5 during the runs.

| Engine in a worker (`lumen-worker`) | Before              | After               | Ranges  | Pairs lower after |
| ----------------------------------- | ------------------- | ------------------- | ------- | ----------------- |
| Workers                             | 16                  | 4                   | apart   | 5 of 5            |
| Worker heaps (MiB)                  | 95.9 (95.8–95.9)    | 91.0                | apart   | 5 of 5            |
| of them JavaScript heap (MiB)       | 6.45 (6.39–6.45)    | 2.09 (2.07–2.09)    | apart   | 5 of 5            |
| Page heap (MiB)                     | 3.9                 | 3.5                 | apart   | 5 of 5            |
| Renderer resident growth (MiB)      | 156 (155–159)       | 117 (116–117)       | apart   | 5 of 5            |
| Create and load loop                | 19.1 (17.8–19.7)    | 14.1 (13.6–15.5)    | apart   | 5 of 5            |
| All charts shown                    | 90 (75–138)         | 60 (59–63)          | apart   | 5 of 5            |
| Layout until shown                  | 0.98 (0.93–1.27)    | 0.33 (0.29–0.35)    | apart   | 5 of 5            |
| Main thread until shown             | 62 (54–77)          | 39 (36–46)          | apart   | 5 of 5            |
| Round: animation-frame callbacks    | 16                  | 1                   | apart   | 5 of 5            |
| Round: frame JS p50                 | 0.475 (0.390–0.530) | 0.360 (0.295–0.395) | overlap | 5 of 5            |
| Round: frame JS p95                 | 0.620 (0.555–0.690) | 0.520 (0.500–0.555) | touch   | 5 of 5            |
| Round: main thread                  | 1.71 (1.52–1.80)    | 1.58 (1.51–1.72)    | overlap | 4 of 5            |
| Timed JS per tick (µs)              | 30.5 (26.4–34.0)    | 23.6 (21.8–25.7)    | apart   | 5 of 5            |
| `update()` call per tick (µs)       | 0.91 (0.89–0.96)    | 1.27 (1.15–1.41)    | apart   | 0 of 5            |
| Round settle p50 / p95              | 16.6 / 17.3         | 16.6 / 17.4         | overlap | –                 |
| Reveal: frame JS, in total          | 0                   | 1.22 (1.19–2.63)    | –       | –                 |

| Engine on the main thread (`lumen-main`) | Before              | After               | Ranges  | Pairs lower after |
| ---------------------------------------- | ------------------- | ------------------- | ------- | ----------------- |
| Page heap (MiB)                          | 93.2 (93.0–93.2)    | 92.8                | apart   | 5 of 5            |
| Renderer resident growth (MiB)           | 103.1 (102.9–103.4) | 102.3 (101.9–102.5) | apart   | 5 of 5            |
| Create and load loop                     | 14.8 (13.6–16.1)    | 13.8 (13.3–14.1)    | overlap | 4 of 5            |
| All charts shown                         | 49 (47–51)          | 47 (46–49)          | overlap | 3 of 5            |
| Layout until shown                       | 0.61 (0.58–0.73)    | 0.28 (0.26–0.33)    | apart   | 5 of 5            |
| Round: animation-frame callbacks         | 16                  | 1                   | apart   | 5 of 5            |
| Round: frame JS p50                      | 0.445 (0.375–0.530) | 0.355 (0.280–0.400) | overlap | 5 of 5            |
| Round: frame JS p95                      | 0.620 (0.475–0.675) | 0.540 (0.520–0.615) | overlap | 4 of 5            |
| Round: main thread                       | 1.49 (1.39–1.62)    | 1.38 (1.37–1.58)    | overlap | 5 of 5            |
| Timed JS per tick (µs)                   | 29.9 (25.2–34.2)    | 23.4 (21.7–26.2)    | overlap | 5 of 5            |
| `update()` call per tick (µs)            | 1.09 (1.06–1.12)    | 1.50 (1.41–1.58)    | apart   | 0 of 5            |
| Reveal: frame JS, in total               | 0                   | 2.37 (1.31–2.86)    | –       | –                 |

"Ranges" compares the range of the five before runs with that of the five after runs; "pairs"
counts the passes in which the after run was lower than the before run of the same pass. "Timed JS
per tick" is the `update()` calls of a round plus its animation-frame callbacks, divided by the 16
ticks. It leaves out the handlers that receive the engine's answers.

What the numbers say:

- **Workers and memory.** 16 workers become 4, the default limit on this machine. The heaps the
  harness reads differ by only 4.9 MiB: each worker's JavaScript heap is small, and the 89 MiB of
  bar data is the same either way. What a worker costs is outside the heaps: the renderer's
  resident memory grows by 39 MiB less. The worker table below puts it at 3 to 4 MiB per worker.
  With the engine on the main thread there are no workers, and the memory changes by less than
  1 MiB. The page heap is 0.4 MiB smaller in both; what accounts for that was not broken down.
- **Time until all charts are shown** fell by a third with workers (90 → 60 ms) and did not change
  without them (49 → 47 ms, ranges overlap). Fewer workers account for part of it: in the worker
  table the branch took 63 ms (47–65) with 4 workers and 70 ms (69–71) with 16. Which of the other
  changes accounts for the rest was not isolated, and the 70 ms comes from a different set of runs
  than the 90 ms.
- **Layout.** Creating a chart no longer reads the layout (one `getBoundingClientRect()` per chart
  before, none now; see the browser checks), and the browser's layout time until the charts are
  shown fell from 0.98 to 0.33 ms (0.61 to 0.28 ms on the main thread). The number of layouts was
  not counted. The harness page has almost nothing on it, so layout is cheap here (the difference
  is about 0.04 ms per chart); on a real page it costs what that page's layout costs.
- **A round of ticks** runs one animation-frame callback instead of 16 and draws the 8 charts in
  view instead of all 16. Frame JavaScript per round is lower in all 10 pairs, by a fifth to a
  quarter at the median (0.475 → 0.360 ms and 0.445 → 0.355 ms), but the ranges overlap, and it is
  less than the half that drawing 8 of 16 charts would suggest. Why it is not half was not
  established.
- **Main-thread time per round** is lower in 9 of 10 pairs, by about 0.1 ms of 1.6 ms, with
  overlapping ranges: at most a small gain.
- **The charts below the fold** are drawn when they are scrolled into view, which took 1.2 to
  2.9 ms of frame JavaScript in total for the eight of them.

## The update call

`series.update()` got slower per call in the 16-chart case: 0.91 → 1.27 µs with workers and
1.09 → 1.50 µs without, ranges apart, in all 10 pairs. The code on that path did not change, and
in the 4-chart case, where every chart is in view, there is no difference (2.77 → 2.82 µs and
2.89 → 2.60 µs, ranges overlap).

An experiment on the branch's code alone (16 charts in one page, the `update()` calls of charts
0–7 and of charts 8–15 timed separately, 300 rounds, two runs per layout, alternating):

| Layout                            | Charts 0–7 (µs per call) | Charts 8–15 (µs per call) | Draws per round |
| --------------------------------- | ------------------------ | ------------------------- | --------------- |
| Rows 3 and 4 below the fold       | 0.896, 1.100             | 0.885, 0.998              | 8               |
| Every row in view (shorter cells) | 0.863, 0.856             | 0.375, 0.392              | 16              |

- The extra cost is in the calls for the charts that are out of view: 0.89–1.00 µs against
  0.38–0.39 µs for the same charts when they are in view and drawn. So it comes from not drawing
  them, not from worker sharing or the shared frame.
- The first eight calls of a round cost about 0.86–1.10 µs in both layouts, so there is also a cost
  at the start of every round that has nothing to do with visibility.
- I expected the charts out of view to cost more than the charts in view within the first layout.
  They do not: both halves cost the same there. The comparison that shows the effect is the one
  between the layouts. A likely reason is that a chart drawn in the last frame is still in the
  processor's caches when `update()` is called on it and one that was not drawn is not; this was
  not tested.
- The net is still a gain: timed JavaScript per tick, which includes these calls, fell from 30.5
  to 23.6 µs.

The experiment ran on Vite's development server (the workspace sources, not bundled), so its
absolute numbers are not those of the tables above.

## 4 charts, all in view

5 passes (two of them of this case only), 241 rounds each. Load average 3.8–6.4.

| `lumen-worker`                   | Before              | After               | Ranges  | Pairs lower after |
| -------------------------------- | ------------------- | ------------------- | ------- | ----------------- |
| Workers                          | 4                   | 4                   | same    | –                 |
| Worker heaps (MiB)               | 203.4               | 203.4               | same    | –                 |
| Renderer resident growth (MiB)   | 229 (228–229)       | 229 (229–230)       | overlap | –                 |
| Create and load loop             | 24.9 (22.9–26.5)    | 23.5 (22.6–23.7)    | overlap | 5 of 5            |
| All charts shown                 | 72 (63–87)          | 71 (61–84)          | overlap | 4 of 5            |
| Layout until shown               | 0.32 (0.29–0.47)    | 0.16 (0.15–0.17)    | apart   | 5 of 5            |
| Round: animation-frame callbacks | 4                   | 1                   | apart   | 5 of 5            |
| Round: frame JS p50              | 0.430 (0.215–0.485) | 0.450 (0.270–0.470) | overlap | 1 of 5            |
| Round: frame JS p95              | 0.610 (0.520–0.650) | 0.655 (0.525–0.665) | overlap | 1 of 5            |
| Round: main thread               | 1.25 (0.90–1.44)    | 1.29 (1.00–1.41)    | overlap | 1 of 5            |
| `update()` call per tick (µs)    | 2.77 (2.25–3.03)    | 2.82 (2.25–3.16)    | overlap | 1 of 5            |

| `lumen-main`        | Before              | After               | Ranges  | Pairs lower after |
| ------------------- | ------------------- | ------------------- | ------- | ----------------- |
| Page heap (MiB)     | 203.0 (202.8–203.0) | 203.0 (202.8–203.0) | same    | –                 |
| All charts shown    | 74 (68–88)          | 76 (64–82)          | overlap | 3 of 5            |
| Layout until shown  | 0.35 (0.26–0.40)    | 0.20 (0.16–0.25)    | apart   | 5 of 5            |
| Round: frame JS p50 | 0.420 (0.260–0.500) | 0.405 (0.225–0.425) | overlap | 4 of 5            |
| Round: frame JS p95 | 0.620 (0.545–0.725) | 0.600 (0.365–0.635) | overlap | 4 of 5            |
| Round: main thread  | 1.18 (0.94–1.39)    | 1.13 (0.85–1.20)    | overlap | 4 of 5            |

With four charts the limit of 4 changes nothing: each chart still has a worker of its own, and
every chart is drawn. Only the layout work while loading halves. Drawing four charts in one
animation-frame callback instead of four shows no difference in these runs: with workers the after
run was the slower one in 4 of 5 passes (in two of them the before run was in the fast state,
0.22 ms, and the after run was not), and with the main-thread engine it was the faster one in 4 of 5. After the first three passes the p95 with workers looked slightly worse (ranges apart by
0.025 ms); two more passes closed the gap. A cost or a gain of the shared frame below about 10% of
frame JavaScript would not show in these runs.

## Worker limit

The branch with `setMaxWorkers` at 1, 2, 4, 8 and 16 (`--max-workers`), each limit once per pass, 3
passes. Load average 4.3–5.3.

| Charts    | Limit | Workers | Renderer resident growth (MiB) | Worker heaps (MiB) | All charts shown | Round: frame JS p50 |
| --------- | ----- | ------- | ------------------------------ | ------------------ | ---------------- | ------------------- |
| 16 × 100k | 1     | 1       | 107                            | 89.6               | 61 (58–73)       | 0.380 (0.220–0.390) |
| 16 × 100k | 2     | 2       | 110 (−5–111)                   | 90.1               | 65 (54–78)       | 0.470 (0.410–0.495) |
| 16 × 100k | 4     | 4       | 118 (117–118)                  | 91.0               | 63 (47–65)       | 0.360 (0.255–0.425) |
| 16 × 100k | 8     | 8       | 130 (129–130)                  | 92.7               | 72 (63–77)       | 0.375 (0.320–0.405) |
| 16 × 100k | 16    | 16      | 155 (154–155)                  | 96.0               | 70 (69–71)       | 0.240 (0.215–0.245) |
| 4 × 1M    | 1     | 1       | 218 (218–219)                  | 202.1              | 85 (75–117)      | 0.405 (0.375–0.475) |
| 4 × 1M    | 2     | 2       | 223 (222–223)                  | 202.6              | 68 (65–71)       | 0.465 (0.420–0.465) |
| 4 × 1M    | 4     | 4       | 229                            | 203.4              | 70 (69–75)       | 0.290 (0.210–0.505) |
| 4 × 1M    | 8     | 4       | 229                            | 203.4              | 74 (68–75)       | 0.200 (0.200–0.450) |
| 4 × 1M    | 16    | 4       | 229 (229–230)                  | 203.4              | 71 (64–72)       | 0.470 (0.270–0.485) |

- **Memory grows by 3 to 4 MiB per worker**: 107, 110, 118, 130 and 155 MiB for 1, 2, 4, 8 and
  16 workers (3.2 MiB each over those 15), and 218, 223 and 229 MiB for 1, 2 and 4. One run
  reported −5 MiB, less memory after loading than before: the resident figure is coarse, see the
  caveats.
- **One worker is slower to show heavy loads**: four loads of 1M candles took 85 ms (75–117) on one
  worker against 68 ms (65–71) on two, ranges apart. For 16 light loads one worker is as fast as
  two or four.
- **Two and four workers are not told apart** by anything in this table, and more than four gains
  nothing in the time until the charts are shown.
- **Frame JavaScript does not rank the limits.** The last three rows are one and the same
  configuration and range from 0.200 to 0.505 ms. The limit of 16 gave the lowest figure in the
  16-chart case in all three runs; three runs cannot tell that from chance.

**The default of 4** (or one less than the number of cores where that is smaller) is a judgment,
not a result: the measurements say "at least 2", and that every worker beyond that costs 3 to
4 MiB. Four was chosen because a page with up to four charts then behaves exactly as before, each
chart on a thread of its own, and because loads heavier than the ones measured here (and the
indicator engine of stage 3) may have more to gain from threads than these did, which is an
expectation, not a measurement. `setMaxWorkers(2)` saves 6 to 8 MiB on pages like these.

## Single-chart gates

The changes must not cost a page with one chart anything. Two checks.

**The harness, before and after alternating**, 4 passes, `lumen-worker`, budget 3 s. Load average
7.9–11.2 in passes 1 and 2 and 4.0–4.7 in passes 3 and 4. No run failed.

| Case                        | Metric                         | Before              | After               |
| --------------------------- | ------------------------------ | ------------------- | ------------------- |
| tick, 1M candles, last 200  | `update()` mean (µs)           | 0.36 (0.28–0.56)    | 0.60 (0.30–0.79)    |
| tick, 1M candles, last 200  | Main thread per tick mean (µs) | 1.75 (1.48–2.67)    | 2.99 (1.52–3.81)    |
| tick, 1M candles, all       | `update()` mean (µs)           | 0.36 (0.29–0.68)    | 0.60 (0.28–0.69)    |
| tick, 1M candles, all       | Main thread per tick mean (µs) | 4.18 (3.46–8.10)    | 7.31 (3.52–8.35)    |
| pan, 10M line, 20k in view  | Frame JS p95                   | 0.578 (0.400–1.180) | 0.765 (0.400–1.125) |
| zoom, 10M line, 20k in view | Frame JS p95                   | 1.130 (0.425–1.220) | 1.045 (0.475–1.335) |
| pan, 10M line, all in view  | Frame JS p95                   | 0.760 (0.745–0.770) | 0.635 (0.285–0.805) |
| zoom, 10M line, all in view | Frame JS p95                   | 0.907 (0.785–0.975) | 0.895 (0.365–1.020) |
| prepend 1M to 1M candles    | Shown p50                      | 34.2 (33.3–36.9)    | 35.7 (34.0–40.4)    |
| prepend 1M to 1M candles    | Shown max                      | 39.1 (36.5–46.9)    | 44.3 (35.5–52.6)    |
| prepend 1M to 10M line      | Shown p50                      | 29.5 (24.9–30.5)    | 29.3 (27.4–30.7)    |
| prepend 1M to 10M line      | Shown max                      | 32.8 (30.1–34.6)    | 32.5 (28.6–32.9)    |
| load, 100k candles          | Warm first frame               | 17.3 (16.9–21.2)    | 17.1 (16.9–17.1)    |
| load, 1M candles            | Warm first frame               | 33.6 (17.0–35.4)    | 32.8 (16.4–33.5)    |
| load, 1M line               | Warm first frame               | 16.7 (15.5–17.0)    | 16.7 (16.4–17.3)    |
| load, 10M line              | Warm first frame               | 67.0 (65.6–83.5)    | 66.7 (50.0–67.0)    |
| load, 10M line              | Cold first frame               | 76.0 (62.7–78.3)    | 74.8 (66.7–108.9)   |
| load, 10M line              | Retained (MiB)                 | 155.6 (153.6–159.0) | 153.8 (153.6–156.7) |

Every range of a time overlaps, and the gate targets hold in every run of both sides for the cases
measured (tick average 0.1 ms, frames p95 16 ms, prepend shown 100 ms). Two things qualify that:

- **Memory.** The page heap is 0.03 to 0.05 MiB larger after, in every run of the cases that
  record it (for example 299.73–299.74 → 299.78–299.79 MiB retained after the prepends to 10M
  points). Presumably the added code; it was not broken down.
- **The tick medians are higher after**, in 6 of 8 pairs for the `update()` call and 7 of 8 for
  main-thread time per tick. The spread is the two states described under "Conditions": the tick
  figures of one side differ by a factor of two between its own runs, and the after side landed in
  the slow state more often. Four runs per side cannot tell that from a regression of the same
  size.

**A paired test in one page** shows no difference for ticks and for a pan. A chart built from
`main` and a chart built from the branch stand side by side in the same page, each with 1M candles
and its own worker, the last 200 bars in view. They take turns, round by round, and the order
alternates, so both always see the same state of the machine. One run: 300 rounds of 100 ticks per
chart, then 200 pan steps per chart.

| One page, both versions                | `main`                       | Branch                       | Branch slower in  |
| -------------------------------------- | ---------------------------- | ---------------------------- | ----------------- |
| `update()` per tick (µs)               | 0.134 (p50 0.100)            | 0.129 (p50 0.100)            | 105 of 300 rounds |
| Frame JS per round of 100 ticks        | 0.279 (p50 0.285, p95 0.430) | 0.273 (p50 0.285, p95 0.415) | 141 of 300 rounds |
| `update()` plus frame JS (µs per tick) | 2.92                         | 2.86                         | –                 |
| Pan step, frame JS                     | 0.130 (p50 0.130, p95 0.155) | 0.134 (p50 0.130, p95 0.155) | –                 |

Means, with the median and p95 in parentheses. Tick cost and frame cost of a single chart are the
same before and after. This test ran on Vite's development server with charts of 600 × 600, so its
absolute numbers are not the harness's; it is a comparison, not a gate measurement. It covers ticks
and a pan of 200 bars only: for loads, prepends and wide views the harness runs above are all there
is.

## Behavior, checked in the browser

A script outside the repository ran `main` and the branch in headless Chromium:

| Check                                                                            | `main`                                                     | Branch                                                          |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------- |
| Container with 400.6 × 300 content box, 20 px padding, 5 px border, `scale(0.5)` | chart 225 × 175: wrong, the border box after the transform | chart 400 × 300                                                 |
| The same container resized to 500 wide                                           | 275 × 175                                                  | 500 × 300                                                       |
| Sized in the first animation frame after `createChart`                           | yes                                                        | yes                                                             |
| `getBoundingClientRect()` calls during `createChart`                             | 1                                                          | 0                                                               |
| Workers for 16 charts (`setMaxWorkers(2)` on the branch)                         | 16                                                         | 2                                                               |
| Workers terminated after 15 of the 16 charts are destroyed                       | 15                                                         | 1, and the last chart still takes ticks                         |
| Workers terminated after the last chart is destroyed                             | 16                                                         | 2                                                               |
| Chart below the fold redrawn while ticks arrive                                  | yes                                                        | no                                                              |
| The same chart after it is scrolled into view                                    | –                                                          | every canvas identical to a chart that was drawn in every round |
| 12 real mouse moves and 12 wheel steps at one point: span, bar under the pointer | 126.67 → 204.70 bars, bar 4924.464 → 4924.410              | identical                                                       |
| 20 pointer moves and 20 wheel events dispatched in one task: rectangle reads     | one per event (by the code; not run)                       | 0 in the handlers, 1 in the next frame                          |

The last two rows are the whole measured effect of resolving pointer input once per frame. With
real input, where the script awaits each event, every event had a frame of its own and both
versions read the rectangle 24 times: there is nothing to save when events arrive one per frame.
The saving exists for bursts of events between two frames. No timing effect was measured.

## Examined and left unchanged

Other things created per chart, per series or per event. The buffer costs are from a Node
microbenchmark on the same machine (V8, not Chromium).

| Candidate                                                          | What there is                                                                                                                                                                                                                                                                                 | Evidence                                                                                                                                                                                                                                                               | Decision                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Return snapshot buffers to the engine for reuse                    | A window snapshot allocates one buffer per series plus the time column in the worker and transfers them; the window cache keeps them as its rows.                                                                                                                                             | Allocating and filling 8,192 rows × 5 columns: 61 µs fresh, 17 µs into a reused buffer; 5.4 and 0.8 µs for 1,024 rows.                                                                                                                                                 | Unchanged. Reuse would save up to 44 µs of worker time per window and cost the main thread a message per window to send the old buffers back. A window is requested only when the view leaves the cached one. The cost of that message was not measured. |
| Patch buffers per tick batch                                       | One buffer of about 60 numbers per batch for all levels and series, allocated in the worker and transferred.                                                                                                                                                                                  | 0.84 µs fresh, 0.04 µs reused, per batch, in the worker.                                                                                                                                                                                                               | Unchanged: against about 24 µs of main-thread JavaScript per tick it is not what limits anything, and reuse needs the same return trip.                                                                                                                  |
| Tick batch buffer in the client                                    | A `slice` of the tick buffer per flush, transferred to the engine.                                                                                                                                                                                                                            | 0.11 µs per flush on the main thread.                                                                                                                                                                                                                                  | Unchanged.                                                                                                                                                                                                                                               |
| One message for the ticks of all charts of a worker                | With shared workers, ticks issued in one task for several charts could travel as one message and be answered by one.                                                                                                                                                                          | 16 messages each way per round now; main-thread time per round is 1.6 ms, of which animation-frame callbacks are 0.36 ms. How much of the rest is message handling was not measured.                                                                                   | Not done: it needs a combined command with an acknowledgment per engine, which changes the seq/ack rules. The most promising follow-up for pages with many charts.                                                                                       |
| `LocalTransport`: a message channel and an idle callback per chart | One `MessageChannel` per main-thread engine, created with its first command and kept for its lifetime.                                                                                                                                                                                        | 7.3 µs to create and close one; nothing is created per round.                                                                                                                                                                                                          | Unchanged. Separate tasks per engine also let the browser render between two charts' slices.                                                                                                                                                             |
| Scratch arrays per chart                                           | Tick positions: two `Float32Array(64)` per chart.                                                                                                                                                                                                                                             | 512 bytes.                                                                                                                                                                                                                                                             | Unchanged.                                                                                                                                                                                                                                               |
| Coordinate buffers per series                                      | `SeriesView` keeps its items between frames and updates only the changed range.                                                                                                                                                                                                               | They are state, not scratch: sharing them would recompute every series in every frame.                                                                                                                                                                                 | Unchanged.                                                                                                                                                                                                                                               |
| Scratch arrays per engine                                          | `EngineCore` keeps three grow-only buffers.                                                                                                                                                                                                                                                   | Engines in one worker are suspended in the middle of commands, so a buffer shared between them could be overwritten by another engine.                                                                                                                                 | Unchanged, on purpose.                                                                                                                                                                                                                                   |
| Price label cache per chart                                        | A map of up to 512 formatted labels per price scale.                                                                                                                                                                                                                                          | Keyed by price at the chart's own precision; charts of different instruments share almost nothing.                                                                                                                                                                     | Unchanged.                                                                                                                                                                                                                                               |
| Closures and arrays per frame                                      | No arrays or closures on the frame path, the new shared frame included. Strings are created: the overlay formats every series' last value, and the crosshair's time, in each frame it draws, as before. With pointer input waiting there is one `DOMRect` per frame instead of one per event. | Read through; not measured.                                                                                                                                                                                                                                            | Unchanged. A one-entry cache per label would remove the strings: a follow-up.                                                                                                                                                                            |
| Canvases and bitmaps                                               | Four canvases per chart; at DPR 2 a chart of 314 × 360 holds about 3.4 MiB of bitmaps, one of 1200 × 600 about 22 MiB.                                                                                                                                                                        | By arithmetic (pane and axes cover the chart once, the overlay once more, 4 bytes per device pixel); they are part of the renderer's resident memory and were not measured apart.                                                                                      | Unchanged. Releasing the bitmaps of a chart out of view would save that memory and show an empty chart for a frame when it comes back. A follow-up, with the canvas cap of design section 6.                                                             |
| Color and font caches                                              | Parsed colors and dash patterns are module-level already. The digit width is measured once per chart and font.                                                                                                                                                                                | One `measureText` per chart.                                                                                                                                                                                                                                           | Unchanged.                                                                                                                                                                                                                                               |
| Pointer listeners                                                  | Six listeners per chart on its root element.                                                                                                                                                                                                                                                  | No cost while the pointer is elsewhere. Not measured.                                                                                                                                                                                                                  | Unchanged. Delegating them to the document would complicate pointer capture and `pointerleave`, which does not bubble.                                                                                                                                   |
| `devicePixelContentBoxSize`                                        | Would give the container's size in device pixels.                                                                                                                                                                                                                                             | The chart places its four canvases in whole CSS pixels inside the root. At a whole device pixel ratio their bitmaps are exact already; at a fractional one, exact bitmaps need the canvases themselves observed or laid out in device pixels, not the container's box. | Not used. `contentRect` is used, because its axes are physical in every writing mode.                                                                                                                                                                    |
| Framework bindings                                                 | Each creates one chart on mount and destroys it on unmount.                                                                                                                                                                                                                                   | Nothing of their own to share; they get the above through the core.                                                                                                                                                                                                    | Unchanged.                                                                                                                                                                                                                                               |

## Caveats

- **One machine, one browser, and a busy one.** Apple M1, headless Chromium. Android, x86, Firefox
  and Safari are unmeasured. The two states of the timings and the load on the machine make every
  time in this document less certain than the ranges alone suggest; counts are exact and heap sizes
  repeat to within 0.1 MiB.
- **Renderer resident memory is coarse.** It is what `ps` reports for the renderer processes.
  Three runs reported the memory after loading as lower than before (−5 MiB above, and −2 and
  −3 MiB in the discarded set below). It is here because the heaps do not show what a thread costs.
- **Main-thread time per round** includes the harness's own loop and the browser's rendering of the
  canvases. It is the same harness on both sides.
- **A first set of measurements was discarded.** Five alternations of the multi-chart scenario were
  measured before the harness waited for several charts in one step (commit `5ee2d92`). The older
  harness awaited every chart separately, which by its code adds tasks for charts that are not
  drawn, and such tasks count toward the main-thread time per round, against the branch. How much
  they added was not measured: that set also ran on a busier machine (load average 5–23). Its
  counts and heaps were the same as above; its times, for 16 charts with workers: all shown
  97 (75–126) → 64 (59–108), frame JS p50 0.410 (0.405–0.500) → 0.345 (0.230–0.480), main thread
  per round 1.80 (1.75–1.92) → 2.08 (1.44–2.65). Its files are not in the repository. Two earlier
  worker-limit studies, one from before the resident-memory probe existed and one from before the
  harness fix, were replaced as well.
- **Not measured:** the effect of pointer input in bursts on any timing; a page with real layout
  cost; many more charts than 16; a chart in a hidden tab; what a worker costs in other browsers.
- **Timing of the first paint of a chart below the fold.** A chart counts as visible until the
  observer first reports, so a chart created out of view may be drawn once before it stops.
- **Every chart gets the same data and ticks** in the multi-chart scenario. Different data per
  chart was not measured.

## Reproducing

```sh
git worktree add ../lumen-main 74052b7           # the code to compare against

# Multi-chart scenario, before and after alternately; repeat the pair for each pass
pnpm bench --scenario multi --lib lumen-worker,lumen-main --repeats 1 --budget 4 \
  --packages ../lumen-main/packages --out benchmarks/results/before-1.json
pnpm bench --scenario multi --lib lumen-worker,lumen-main --repeats 1 --budget 4 \
  --out benchmarks/results/after-1.json
pnpm bench:merge benchmarks/results/before.json benchmarks/results/before-1.json benchmarks/results/before-2.json

# Worker limits
pnpm bench --scenario multi --lib lumen-worker --max-workers 1,2,4,8,16 --repeats 1 --budget 4

# Gate cases, before and after alternately as above
pnpm bench --case tick/candles-1m,frames/line-10m/pan-all,frames/line-10m/zoom-all,frames/line-10m/pan-20k,frames/line-10m/zoom-20k,prepend/line-10m/1m,prepend/candles-1m/1m,load \
  --lib lumen-worker --repeats 1 --budget 3

pnpm bench:report docs/benchmarks/shared-resources-multi-after.json
```

All benchmark runs for this change took 27 minutes of wall time, 11 of them for the measurements
that were discarded. The paired test, the `update()` experiment and the browser checks were one-off
scripts that are not in the repository, so those three results cannot be reproduced from it; their
designs are described above.

Unit tests that back the behavior: `packages/core/test/frame.test.ts` (read and write phases,
errors, changes during a frame, release), `sizing.test.ts` (content box, padding, one layout read
for many charts, no observer), `visibility.test.ts` (data stays current, one draw on return,
`whenIdle`), `pointer-layout.test.ts` (one rectangle read per frame, anchoring, order of pans and
zooms, pinch, kinetic scrolling), `media.test.ts`, and `packages/engine/test/pool.test.ts` (sharing
and limits, order and isolation per engine, failures, transfers, release, priority of commands over
background work, fallback).
