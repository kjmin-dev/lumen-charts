# Stage 0 baseline: Lightweight Charts 5.3.0

Baselines for load time, tick cost, pan and zoom frames and memory, measured with the harness in
`benchmarks/` on one Apple M1 in headed Chromium 156 at DPR 2. Every number below comes from
[stage-0-baseline.json](stage-0-baseline.json) (median over 5 runs, with the range of the runs in
parentheses in the full tables). The run took 141 minutes on commit `222ca7b`.

## Summary: 1 million candles

| Metric                                                     | Conflation on       | Conflation off      |
| ---------------------------------------------------------- | ------------------- | ------------------- |
| Load: first painted frame                                  | 1133 ms             | 1178 ms             |
| Load including conversion to objects                       | 1169 ms             | 1221 ms             |
| Memory retained by the chart                               | 517 MiB             | 513 MiB             |
| Tick, last 200 bars in view: avg / p99                     | 9476 µs / 17410 µs  | 9061 µs / 15845 µs  |
| Tick, all bars in view: avg / p99                          | 11103 µs / 37770 µs | 9611 µs / 18520 µs  |
| Main thread per tick incl. paint, last 200 bars: avg / p99 | 13832 µs / 17753 µs | 12870 µs / 16042 µs |
| Pan, 200 bars in view: JS p95 / interval p95               | 1.74 ms / 17.3 ms   | 2.36 ms / 17.3 ms   |
| Zoom, 200 bars in view: JS p95 / interval p95              | 9.15 ms / 17.6 ms   | 9.00 ms / 17.6 ms   |
| Pan, all bars in view: JS p95 / interval p95               | 5.49 ms / 17.6 ms   | 845 ms / 850 ms     |
| Zoom, all bars in view: JS p95 / interval p95              | 9.25 ms / 17.4 ms   | 864 ms / 867 ms     |

**Per-tick cost is O(N).** The open question from the design (section 10) is settled: the average
cost of one `update()` grows linearly with the number of bars, from 76.7–82.7 µs at 10,000 candles to
855–888 µs at 100,000, 2372–2571 µs at 300,000 and 9061–11103 µs at 1 million (×10.4–11.4, ×30.7–31.3
and ×116–134 the 10,000-bar cost for 10, 30 and 100 times the bars). It holds with conflation on and
off, with 200 bars or all bars in view, and for ticks that update the last bar as well as ticks that
add one. The paint that follows ticks is O(N) too (see Observations).

## Environment

|                                            |                                                                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| File                                       | docs/benchmarks/stage-0-baseline.json                                                                                 |
| Created                                    | 2026-11-15T03:14:46.445Z                                                                                              |
| Runner arguments                           | `--out benchmarks/results/stage-0-baseline.json`                                                                      |
| Run duration                               | 141 min                                                                                                               |
| Browser                                    | Chromium 156.0.8078.4 (playwright-bundled, headed)                                                                    |
| User agent                                 | Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 |
| WebGL renderer                             | ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)                                                    |
| Machine                                    | Apple M1, 8 cores, 16 GiB, darwin 25.5.0                                                                              |
| Power                                      | Now drawing from 'AC Power'                                                                                           |
| Load average (1, 5, 15 min) at start / end | 4.52, 6.95, 24.55 / 9.88, 8.70, 8.39                                                                                  |
| Viewport, DPR, chart                       | {"width":1280,"height":720}, 2, {"width":1200,"height":600}                                                           |
| Timer                                      | smallest step 5.00 µs, median step 5.00 µs, cross-origin isolated true                                                |
| Idle frame interval                        | p50 16.7 ms, p95 17.0 ms                                                                                              |
| Build                                      | production                                                                                                            |
| Packages                                   | lightweight-charts 5.3.0, playwright 1.64.1, vite 8.3.8                                                               |
| Git                                        | 222ca7bb8c46c10f89b366683892ffe311d9b873                                                                              |

Run headed in Playwright's bundled Chromium (a real window composited on the GPU), with the default
runner options.

## Method

### Harness

- The harness page (`benchmarks/index.html`) is built with `vite build` and served by `vite preview` with
  `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Cross-origin
  isolation gives `performance.now()` its finest step in Chromium; the effective step is measured on the
  page and recorded (5 µs in this run).
- The build resolves the `production` export condition, so Lightweight Charts runs from
  `lightweight-charts.production.mjs`, not from its development build with assertions.
- Every run gets a new browser context and page (a new renderer process), loads the page, generates its
  data and runs one job. Runs of the two adapters alternate within each repeat.
- Chart: 1200 × 600 CSS pixels at device pixel ratio 2 in a 1280 × 720 viewport. One series:
  candlesticks (the volume column is not drawn) or a line.
- Lightweight Charts options: library defaults except `timeScale.enableConflation` (the variant),
  `timeScale.minBarSpacing: 1e-6` (the default of 0.5 CSS px allows at most two bars per pixel, so
  neither "all bars in view" nor conflation could be reached) and `timeScale.timeVisible: true`.
- The adapter converts columns to arrays of `{ time, open, high, low, close }` or `{ time, value }`
  objects with time in seconds. Conversion is timed separately from `setData`.

### Settling and frame instrumentation

The page replaces `window.requestAnimationFrame` before any chart exists. Every callback a library
schedules is timed, and pending callbacks are counted.

- `afterNextFrame()`: a callback in the next animation frame posts a message; the message arrives after
  that frame's style, layout, paint and commit work on the main thread.
- `settle()` for Lightweight Charts repeats `afterNextFrame()` until no library callback is pending.
  Updates are applied synchronously and drawing happens in `requestAnimationFrame`, so this is the point
  where everything submitted is painted. GPU rasterization and display are not awaited.
- Frame JavaScript time is the sum of all animation-frame callback durations with the same frame
  timestamp. Frame interval is the difference between consecutive frames' rAF timestamps.

### Load

Data is generated in the page first (`Generate`, not part of any load time). Then, in a fresh page:

1. Cold: create a chart, wait until the empty chart is painted, convert, `setData`, settle. Destroy.
2. Full GC, memory sample `before`.
3. Warm: the same with a new chart in the same page (library code already compiled). This is the
   headline load.
4. Full GC, memory sample `after`.

Times are measured from the `setData` call:

- First frame: until the main thread has finished the first frame in which the library ran an
  animation-frame callback after `setData`. This is "time until the first painted frame".
- Settled: until `settle()` resolves. After the first draw, Lightweight Charts schedules further draws
  in the next frames, so this is later by up to a few refresh intervals.
- `+ conversion` adds the conversion time measured just before.

### Tick

A chart is loaded with N candles and a view is set: `latest` shows the last 200 bars, `all` shows every
bar. Ticks continue the series from its last bar; every 10th tick starts a new bar, the others replace
the last bar. 500 warm-up ticks are applied first, then 10,000 measured ticks in rounds of 100: a round
applies 100 ticks back to back, then calls `settle()`.

- Sync: the duration of each `applyTick` call (`series.update` plus building one bar object). A timestamp
  is taken between consecutive calls, so each sample includes one `performance.now()` call and loop
  overhead (well below 1 µs). Samples are multiples of the 5 µs timer step, so a sample is off by less
  than 5 µs.
- p99 is the nearest-rank 99th percentile of the 10,000 per-tick samples: the 9,900th smallest value. No
  interpolation, so it is always an observed duration. It is meaningful as long as it is much larger
  than the timer step, which holds for every case below.
- Sub-batch p99: the same percentile over the 100 round means (round sync time / 100). It does not
  depend on timer resolution and is the one to compare with browsers that have a coarse timer.
- Paint JS per round: JavaScript time in animation-frame callbacks during each round's `settle()`, that
  is the draw that shows the round.
- Main thread per tick (the cost including `settle()`): (round sync time + paint JS) / 100 per round,
  averaged and p99 over the 100 rounds. It leaves out idle time spent waiting for the next frame and work
  off the main thread.
- Settle: wall time from the round's last call until `settle()` resolves, including the wait for the
  next frame (up to one refresh interval). This is the latency until the round is on screen.

### Pan and zoom frames

A chart with 1M candles is loaded and a range of bars is put in view: 200, 2,000, 20,000, 200,000 or all
1M. Then one step of a scripted motion is applied in each animation frame through
`setVisibleLogicalRange`:

- Pan: start at the latest bar and move into history by 1% of the width per frame. Turn around when the
  view would leave the data by more than half a width on the left or pass the latest bar on the right
  (with all bars in view, the data slides between fully and half visible).
- Zoom: keep the latest bar at the right edge and change the bar count between half and twice the level
  geometrically (factor 2^(1/75) per frame, 75 frames per leg: out, back, in, back).

The harness calls the library at the end of each frame's callbacks, and the library draws in the next
frame, so every measured frame contains one draw and one step. 30 warm-up frames are dropped, then 300
frames are measured. After the measurement, one more redraw is made with Canvas 2D calls counted
(`fillRect per redraw`); this pass is not timed.

### Memory

After a full garbage collection (CDP `HeapProfiler.collectGarbage`), CDP `Runtime.getHeapUsage` gives:

- `usedSize`: the V8 heap (JavaScript objects, including compiled code),
- `backingStorageSize`: ArrayBuffer and typed array backing stores, and external strings,
- `embedderHeapUsedSize`: Blink's garbage-collected heap (DOM nodes and other browser objects).

Retained memory is `after - before` of their sum, so the harness's own data columns, present in both
samples, cancel out. A check before the baseline confirmed that a 100 MiB `Float64Array` shows up in
`backingStorageSize` and not in `usedSize`.

Not included: canvas bitmaps and GPU textures (GPU process), memory Blink or Skia allocates outside its
garbage-collected heap (paint recordings, font and glyph caches), the browser and GPU processes, and
allocator overhead. Canvas memory depends on chart size and DPR, which are fixed, not on the data set.

### Repeats and spread

Each case runs 5 times per adapter (see the run arguments in the environment table). Tables give the
median over runs, with the minimum and maximum in parentheses.

### Run length

This baseline measured every tick and frame of every run, which took 141 minutes: one run of the
slowest cases (all 1M bars in view without conflation) took over 4 minutes, because 10,000 ticks or
300 frames at several hundred milliseconds each were measured where 500 or 30 already show the same
distribution. The runner now stops a tick or frames run once it has measured for 10 s and has at least
500 ticks or 30 frames, and stops warm-up after 2 s (`--budget`). Here that would have shortened the
Lightweight Charts tick runs from 100k bars up and its frames runs without conflation at 200k bars and
more; every other run measures for less than 10 s and is unaffected. `pnpm bench:report` lists how
many ticks and frames each case measured. `--budget 0` restores the fixed lengths used here.

## Results

Values are the median over 5 runs per adapter, with the minimum and maximum run in parentheses.
`Host CPU idle` is the share of the whole machine's CPU time that was idle during the runs.

### Load

| Data set     | Adapter            | First frame (ms) | + conversion (ms) | Settled (ms)     | Conversion (ms)  | setData (ms)     | Frame JS (ms)    | Cold first frame (ms) | Generate (ms)    | Host CPU idle |
| ------------ | ------------------ | ---------------- | ----------------- | ---------------- | ---------------- | ---------------- | ---------------- | --------------------- | ---------------- | ------------- |
| candles-100k | lwc-conflation-on  | 115 (112–121)    | 119 (116–132)     | 130 (124–130)    | 4.12 (3.66–10.9) | 63.0 (57.4–64.3) | 57.6 (52.0–58.2) | 172 (142–246)         | 27.5 (26.6–30.0) | 17% (14–24%)  |
| candles-100k | lwc-conflation-off | 120 (114–121)    | 123 (118–126)     | 130 (130–132)    | 3.64 (3.45–4.61) | 60.6 (59.4–66.5) | 57.7 (55.4–60.9) | 143 (134–157)         | 28.4 (26.5–31.9) | 24% (19–34%)  |
| candles-1m   | lwc-conflation-on  | 1133 (1105–1283) | 1169 (1145–1320)  | 1134 (1106–1286) | 37.0 (34.0–45.8) | 600 (575–684)    | 530 (528–600)    | 1106 (1078–1156)      | 240 (231–259)    | 24% (17–27%)  |
| candles-1m   | lwc-conflation-off | 1178 (1140–1256) | 1221 (1184–1302)  | 1179 (1141–1257) | 44.3 (35.6–47.2) | 643 (607–677)    | 535 (527–578)    | 1114 (1068–1247)      | 236 (231–254)    | 19% (13–23%)  |
| line-1m      | lwc-conflation-on  | 1003 (860–1070)  | 1023 (887–1107)   | 1004 (860–1071)  | 19.9 (14.8–37.5) | 633 (522–715)    | 360 (337–385)    | 979 (894–1141)        | 92.2 (91.9–96.0) | 17% (0–24%)   |
| line-1m      | lwc-conflation-off | 960 (925–1020)   | 973 (940–1034)    | 960 (926–1021)   | 14.4 (13.8–24.7) | 599 (591–652)    | 367 (326–374)    | 1082 (896–1115)       | 92.8 (90.4–98.9) | 15% (0–30%)   |
| line-10m     | lwc-conflation-on  | failed: crash    | failed: crash     | failed: crash    | failed: crash    | failed: crash    | failed: crash    | failed: crash         | failed: crash    | 18% (1–27%)   |
| line-10m     | lwc-conflation-off | failed: crash    | failed: crash     | failed: crash    | failed: crash    | failed: crash    | failed: crash    | failed: crash         | failed: crash    | 11% (6–17%)   |

runs per row: 5

### Memory after load

| Data set     | Adapter            | Retained (MiB)   | Bytes per point | JS heap (MiB)    | Backing stores (MiB) | Embedder heap (MiB) | Page total after (MiB) |
| ------------ | ------------------ | ---------------- | --------------- | ---------------- | -------------------- | ------------------- | ---------------------- |
| candles-100k | lwc-conflation-on  | 52.5 (52.5–52.7) | 550             | 52.2 (52.2–52.2) | 0.000 (0.000–0.000)  | 0.221 (0.221–0.447) | 110 (110–110)          |
| candles-100k | lwc-conflation-off | 52.1 (52.0–52.1) | 546             | 51.9 (51.9–51.9) | 0.000 (0.000–0.000)  | 0.221 (0.118–0.221) | 109 (107–109)          |
| candles-1m   | lwc-conflation-on  | 517 (517–517)    | 542             | 517 (517–517)    | 0.000 (0.000–0.000)  | 0.233 (0.140–0.236) | 1069 (1068–1069)       |
| candles-1m   | lwc-conflation-off | 513 (513–513)    | 538             | 513 (513–513)    | 0.000 (0.000–0.000)  | 0.194 (0.082–0.245) | 1061 (1061–1061)       |
| line-1m      | lwc-conflation-on  | 425 (425–426)    | 446             | 425 (425–425)    | 0.000 (0.000–0.000)  | 0.251 (0.110–0.284) | 855 (855–855)          |
| line-1m      | lwc-conflation-off | 422 (422–422)    | 442             | 421 (421–421)    | 0.000 (0.000–0.000)  | 0.178 (0.149–0.354) | 847 (847–847)          |
| line-10m     | lwc-conflation-on  | failed: crash    | –               | failed: crash    | failed: crash        | failed: crash       | failed: crash          |
| line-10m     | lwc-conflation-off | failed: crash    | –               | failed: crash    | failed: crash        | failed: crash       | failed: crash          |

### Tick

Sync and main-thread columns in µs, paint and settle in ms; definitions in Method.

| Data set, view      | Adapter            | Sync avg (µs)      | Sync p50 (µs)    | Sync p99 (µs)       | Sync max (ms)      | Sub-batch p99 (µs)  | Update avg (µs)    | New bar avg (µs)  | Paint JS per round (ms) | Main thread avg (µs) | Main thread p99 (µs) | Settle p99 (ms)  | Host CPU idle |
| ------------------- | ------------------ | ------------------ | ---------------- | ------------------- | ------------------ | ------------------- | ------------------ | ----------------- | ----------------------- | -------------------- | -------------------- | ---------------- | ------------- |
| candles-10k latest  | lwc-conflation-on  | 79.8 (77.0–83.2)   | 80.0 (75.0–80.0) | 120 (115–130)       | 1.22 (0.890–1.56)  | 93.0 (85.8–97.9)    | 79.1 (75.8–82.4)   | 87.3 (85.6–91.0)  | 2.58 (2.42–2.68)        | 105 (101–109)        | 139 (112–145)        | 12.8 (11.4–13.6) | 30% (1–49%)   |
| candles-10k latest  | lwc-conflation-off | 77.9 (76.4–81.1)   | 75.0 (75.0–80.0) | 115 (110–115)       | 1.30 (0.935–2.18)  | 87.1 (84.3–88.6)    | 77.1 (75.5–80.2)   | 86.5 (85.0–88.6)  | 2.42 (2.28–2.45)        | 102 (99.2–106)       | 114 (113–115)        | 11.2 (10.2–11.3) | 34% (18–46%)  |
| candles-10k all     | lwc-conflation-on  | 82.7 (81.9–85.8)   | 75.0 (75.0–80.0) | 175 (140–220)       | 1.35 (1.18–1.55)   | 92.5 (90.2–111)     | 82.3 (81.6–85.2)   | 87.0 (85.1–90.7)  | 2.57 (2.47–2.68)        | 108 (107–113)        | 135 (118–147)        | 9.79 (9.51–11.2) | 30% (26–47%)  |
| candles-10k all     | lwc-conflation-off | 76.7 (76.1–78.4)   | 75.0 (75.0–75.0) | 120 (115–135)       | 0.850 (0.800–2.20) | 90.4 (80.7–94.7)    | 75.8 (75.2–77.4)   | 84.5 (83.7–87.8)  | 5.25 (5.15–5.39)        | 129 (128–132)        | 151 (141–162)        | 11.2 (10.7–11.3) | 40% (22–45%)  |
| candles-100k latest | lwc-conflation-on  | 855 (826–901)      | 795 (760–835)    | 2935 (2530–3165)    | 11.0 (8.97–12.3)   | 979 (960–1068)      | 858 (829–902)      | 826 (797–893)     | 24.9 (23.9–25.5)        | 1104 (1065–1155)     | 1288 (1226–1406)     | 39.0 (37.7–52.2) | 31% (23–47%)  |
| candles-100k latest | lwc-conflation-off | 888 (833–898)      | 810 (770–830)    | 3295 (2960–3815)    | 13.1 (9.63–17.1)   | 1065 (972–1100)     | 891 (836–901)      | 856 (807–869)     | 24.4 (22.5–25.2)        | 1131 (1064–1145)     | 1406 (1262–1570)     | 41.2 (32.8–44.3) | 28% (20–43%)  |
| candles-100k all    | lwc-conflation-on  | 861 (835–959)      | 775 (750–810)    | 2760 (2300–6025)    | 19.4 (16.2–30.5)   | 1073 (991–1166)     | 865 (838–971)      | 823 (795–919)     | 10.7 (10.5–11.0)        | 967 (941–1066)       | 1210 (1106–1277)     | 17.3 (16.5–24.2) | 41% (18–50%)  |
| candles-100k all    | lwc-conflation-off | 866 (817–907)      | 800 (755–845)    | 2765 (2475–2870)    | 9.36 (7.73–12.1)   | 1015 (945–1051)     | 869 (820–910)      | 842 (794–878)     | 107 (106–113)           | 1941 (1872–2034)     | 2244 (2081–2289)     | 132 (128–137)    | 32% (16–44%)  |
| candles-300k latest | lwc-conflation-on  | 2447 (2410–2607)   | 2325 (2275–2520) | 6905 (6495–7285)    | 19.6 (14.8–23.5)   | 2760 (2686–2953)    | 2455 (2418–2616)   | 2383 (2335–2530)  | 77.6 (75.9–79.4)        | 3223 (3169–3402)     | 3877 (3681–3957)     | 137 (108–141)    | 41% (17–43%)  |
| candles-300k latest | lwc-conflation-off | 2443 (2377–2582)   | 2315 (2250–2450) | 6780 (6615–7030)    | 16.0 (12.8–21.1)   | 2679 (2640–2963)    | 2450 (2378–2590)   | 2379 (2373–2512)  | 74.9 (72.2–77.2)        | 3192 (3100–3354)     | 3655 (3546–4004)     | 130 (124–140)    | 43% (27–46%)  |
| candles-300k all    | lwc-conflation-on  | 2571 (2526–2878)   | 2315 (2275–2610) | 11750 (10405–13915) | 62.9 (41.6–94.0)   | 3009 (2840–3288)    | 2587 (2542–2895)   | 2434 (2362–2722)  | 30.6 (29.4–33.1)        | 2877 (2821–3209)     | 3296 (3199–3596)     | 56.8 (43.9–63.3) | 45% (2–50%)   |
| candles-300k all    | lwc-conflation-off | 2372 (2333–2497)   | 2285 (2240–2400) | 4365 (4060–5115)    | 18.1 (17.1–26.7)   | 2766 (2668–3035)    | 2375 (2336–2501)   | 2347 (2307–2459)  | 326 (321–340)           | 5636 (5540–5900)     | 6383 (6157–7244)     | 404 (384–429)    | 41% (30–45%)  |
| candles-1m latest   | lwc-conflation-on  | 9476 (8961–9841)   | 8755 (8295–9070) | 17410 (16635–19035) | 75.2 (56.7–97.1)   | 11724 (10764–12238) | 9499 (8956–9857)   | 9269 (9005–9693)  | 436 (406–471)           | 13832 (13118–14549)  | 17753 (16238–19719)  | 773 (707–888)    | 1% (0–5%)     |
| candles-1m latest   | lwc-conflation-off | 9061 (8686–10015)  | 8495 (8145–9065) | 15845 (15495–20175) | 47.4 (37.4–83.1)   | 10956 (10159–11999) | 9079 (8705–9922)   | 9492 (8515–10852) | 386 (381–456)           | 12870 (12504–14577)  | 16042 (15786–19724)  | 686 (662–899)    | 4% (0–9%)     |
| candles-1m all      | lwc-conflation-on  | 11103 (9493–11901) | 8930 (8125–9050) | 37770 (26045–84485) | 414 (289–607)      | 13657 (11619–15859) | 11241 (9590–12111) | 9670 (8615–10011) | 180 (142–251)           | 12907 (10909–14415)  | 16932 (13068–18352)  | 418 (321–558)    | 2% (0–17%)    |
| candles-1m all      | lwc-conflation-off | 9611 (8473–9966)   | 8725 (8090–8985) | 18520 (14595–21070) | 113 (54.1–131)     | 11923 (9823–12647)  | 9636 (8453–9909)   | 9394 (8544–10470) | 1458 (1293–1510)        | 24232 (21408–25066)  | 30018 (25116–33329)  | 1968 (1622–2070) | 5% (0–19%)    |

runs per row: 5

### Tick cost against data set size

Sync average per tick, and its ratio to the 10,000-bar case.

| Data set     | lwc-conflation-on latest | lwc-conflation-off latest | lwc-conflation-on all | lwc-conflation-off all |
| ------------ | ------------------------ | ------------------------- | --------------------- | ---------------------- |
| candles-10k  | 79.8 µs (×1.00)          | 77.9 µs (×1.00)           | 82.7 µs (×1.00)       | 76.7 µs (×1.00)        |
| candles-100k | 855 µs (×10.7)           | 888 µs (×11.4)            | 861 µs (×10.4)        | 866 µs (×11.3)         |
| candles-300k | 2447 µs (×30.7)          | 2443 µs (×31.3)           | 2571 µs (×31.1)       | 2372 µs (×30.9)        |
| candles-1m   | 9476 µs (×119)           | 9061 µs (×116)            | 11103 µs (×134)       | 9611 µs (×125)         |

### Pan and zoom frames (1M candles)

| Motion, bars in view | Adapter            | JS avg           | JS p50            | JS p95           | JS p99           | JS max           | Interval avg     | Interval p50     | Interval p95     | Interval p99     | Interval max     | fillRect per redraw       | Host CPU idle |
| -------------------- | ------------------ | ---------------- | ----------------- | ---------------- | ---------------- | ---------------- | ---------------- | ---------------- | ---------------- | ---------------- | ---------------- | ------------------------- | ------------- |
| pan 200              | lwc-conflation-on  | 1.38 (1.09–1.50) | 1.26 (1.02–1.35)  | 1.74 (1.39–2.63) | 3.61 (2.46–4.28) | 4.34 (3.02–5.27) | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 17.3 (17.0–17.7) | 17.6 (17.5–17.7) | 17.7 (17.5–17.7) | 2796 (2796–2796)          | 43% (41–52%)  |
| pan 200              | lwc-conflation-off | 1.18 (1.02–1.54) | 1.04 (0.970–1.35) | 2.36 (1.34–3.29) | 2.77 (2.23–4.06) | 3.72 (2.80–6.55) | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 17.3 (17.2–17.4) | 17.6 (17.6–17.7) | 17.7 (17.6–17.7) | 2796 (2796–2796)          | 47% (33–48%)  |
| zoom 200             | lwc-conflation-on  | 2.41 (2.34–2.71) | 1.31 (1.24–1.52)  | 9.15 (9.06–10.2) | 10.5 (9.65–12.0) | 12.2 (11.5–14.7) | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 17.6 (17.0–17.7) | 17.6 (17.6–17.7) | 17.7 (17.6–17.7) | 2796 (2796–2796)          | 49% (32–54%)  |
| zoom 200             | lwc-conflation-off | 2.37 (1.73–2.37) | 1.26 (0.950–1.34) | 9.00 (6.58–9.22) | 10.4 (7.52–10.9) | 11.0 (9.15–12.2) | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 17.6 (17.2–17.7) | 17.6 (17.6–17.7) | 17.7 (17.6–17.7) | 2796 (2796–2796)          | 51% (40–52%)  |
| pan 2000             | lwc-conflation-on  | 1.17 (1.10–1.25) | 1.14 (1.09–1.23)  | 1.38 (1.27–1.49) | 1.53 (1.40–1.58) | 2.65 (1.73–3.06) | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 17.1 (16.8–17.7) | 17.5 (17.5–17.7) | 17.6 (17.6–17.7) | 12010 (12010–12010)       | 53% (40–61%)  |
| pan 2000             | lwc-conflation-off | 1.16 (1.11–1.18) | 1.13 (1.10–1.16)  | 1.37 (1.27–1.63) | 1.49 (1.38–2.68) | 1.70 (1.46–2.80) | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 17.1 (16.8–17.4) | 17.6 (17.4–17.7) | 17.6 (17.6–17.7) | 12010 (12010–12010)       | 52% (24–57%)  |
| zoom 2000            | lwc-conflation-on  | 7.11 (5.73–7.60) | 7.43 (6.02–7.82)  | 8.48 (6.51–9.33) | 9.26 (6.66–12.7) | 9.84 (8.31–15.8) | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 17.6 (17.2–17.6) | 17.6 (17.6–17.7) | 17.6 (17.6–17.7) | 12010 (12010–12010)       | 49% (21–50%)  |
| zoom 2000            | lwc-conflation-off | 7.81 (5.64–8.13) | 7.94 (5.93–8.10)  | 9.64 (6.37–11.7) | 11.3 (6.59–15.1) | 13.2 (6.92–20.1) | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 17.6 (17.0–17.7) | 17.6 (17.6–17.7) | 17.7 (17.7–17.7) | 12010 (12010–12010)       | 26% (16–45%)  |
| pan 20000            | lwc-conflation-on  | 1.28 (1.28–1.34) | 1.27 (1.25–1.29)  | 1.54 (1.47–1.65) | 1.98 (1.58–2.87) | 3.01 (1.74–3.23) | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 17.6 (17.6–17.7) | 17.7 (17.6–17.7) | 17.7 (17.7–17.7) | 15010 (15010–15010)       | 35% (32–53%)  |
| pan 20000            | lwc-conflation-off | 6.14 (6.09–7.21) | 6.12 (6.02–6.57)  | 6.55 (6.49–11.1) | 7.51 (6.73–12.9) | 8.80 (8.56–16.4) | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 17.6 (17.3–17.7) | 17.7 (17.6–17.7) | 17.7 (17.7–33.3) | 120010 (120010–120010)    | 38% (14–42%)  |
| zoom 20000           | lwc-conflation-on  | 8.20 (5.94–8.30) | 7.59 (5.37–7.63)  | 8.42 (5.98–8.81) | 29.4 (27.4–30.2) | 78.8 (77.5–79.2) | 16.9 (16.9–16.9) | 16.7 (16.7–16.7) | 17.7 (17.6–18.7) | 17.7 (17.6–18.7) | 66.7 (65.8–68.7) | 15010 (15010–15010)       | 46% (43–49%)  |
| zoom 20000           | lwc-conflation-off | 13.9 (11.9–14.8) | 12.3 (10.0–12.7)  | 20.4 (19.4–21.6) | 21.4 (20.5–25.8) | 25.9 (21.6–27.1) | 17.8 (17.7–18.5) | 16.7 (16.7–16.7) | 32.4 (32.3–33.3) | 34.0 (33.3–35.3) | 34.3 (34.2–51.1) | 120010 (120010–120010)    | 38% (28–41%)  |
| pan 200000           | lwc-conflation-on  | 1.76 (1.71–1.87) | 1.76 (1.70–1.82)  | 2.01 (1.92–2.80) | 2.50 (2.03–4.09) | 4.16 (2.23–4.65) | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 17.4 (17.0–18.6) | 17.6 (17.6–18.6) | 17.7 (17.7–18.6) | 18760 (18760–18760)       | 48% (23–52%)  |
| pan 200000           | lwc-conflation-off | 141 (138–146)    | 139 (136–142)     | 189 (185–191)    | 203 (197–214)    | 215 (200–227)    | 149 (145–153)    | 150 (133–150)    | 199 (183–200)    | 201 (200–217)    | 218 (201–233)    | 1200010 (1200010–1200010) | 36% (30–43%)  |
| zoom 200000          | lwc-conflation-on  | 8.15 (7.73–8.71) | 7.91 (7.50–8.53)  | 9.19 (8.53–12.8) | 13.8 (12.3–17.8) | 19.7 (18.3–20.8) | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 17.6 (17.1–17.7) | 17.6 (17.6–17.7) | 17.6 (17.6–17.7) | 18760 (18760–18760)       | 36% (18–56%)  |
| zoom 200000          | lwc-conflation-off | 161 (157–178)    | 139 (133–162)     | 315 (314–338)    | 340 (336–400)    | 361 (342–438)    | 171 (165–189)    | 167 (150–167)    | 318 (317–334)    | 350 (333–400)    | 399 (350–433)    | 1200010 (1200010–1200010) | 42% (19–51%)  |
| pan all candles-1m   | lwc-conflation-on  | 4.53 (2.89–4.56) | 4.50 (2.86–4.55)  | 5.49 (3.51–5.53) | 5.72 (4.89–5.90) | 6.03 (5.43–7.53) | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 17.6 (16.7–17.7) | 17.6 (17.4–17.7) | 17.7 (17.6–17.7) | 23446 (23446–23446)       | 48% (23–53%)  |
| pan all candles-1m   | lwc-conflation-off | 631 (619–657)    | 626 (615–656)     | 845 (835–871)    | 875 (851–919)    | 934 (887–1039)   | 639 (627–665)    | 633 (617–667)    | 850 (833–883)    | 900 (850–917)    | 933 (884–1051)   | 6000010 (6000010–6000010) | 47% (32–54%)  |
| zoom all candles-1m  | lwc-conflation-on  | 8.41 (8.30–8.81) | 8.40 (8.21–8.69)  | 9.25 (9.01–9.78) | 10.2 (9.74–11.2) | 13.9 (12.6–15.0) | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 17.4 (16.7–18.7) | 17.6 (17.0–18.7) | 17.7 (17.4–18.7) | 23446 (23446–23446)       | 48% (41–59%)  |
| zoom all candles-1m  | lwc-conflation-off | 719 (701–750)    | 798 (790–824)     | 864 (848–925)    | 882 (856–948)    | 907 (871–1017)   | 723 (707–753)    | 815 (800–831)    | 867 (850–919)    | 883 (867–950)    | 917 (867–1015)   | 6000010 (6000010–6000010) | 53% (35–60%)  |

All times in ms. runs per row: 5

### Failed runs

- load/line-10m lwc-conflation-on run 1: crash after 18.3 s: Renderer process crashed (often out of memory)
- load/line-10m lwc-conflation-on run 2: crash after 15.8 s: Renderer process crashed (often out of memory)
- load/line-10m lwc-conflation-on run 3: crash after 21.6 s: Renderer process crashed (often out of memory)
- load/line-10m lwc-conflation-on run 4: crash after 21.3 s: Renderer process crashed (often out of memory)
- load/line-10m lwc-conflation-on run 5: crash after 21.3 s: Renderer process crashed (often out of memory)
- load/line-10m lwc-conflation-off run 1: crash after 20.7 s: Renderer process crashed (often out of memory)
- load/line-10m lwc-conflation-off run 2: crash after 17.1 s: Renderer process crashed (often out of memory)
- load/line-10m lwc-conflation-off run 3: crash after 24.9 s: Renderer process crashed (often out of memory)
- load/line-10m lwc-conflation-off run 4: crash after 21.3 s: Renderer process crashed (often out of memory)
- load/line-10m lwc-conflation-off run 5: crash after 22.0 s: Renderer process crashed (often out of memory)

## Observations

Statements marked [source] or [profile] explain a measurement with the Lightweight Charts 5.3.0 source
or with a CPU profile taken outside the baseline (development build, not part of the JSON); only the
measurements themselves are numbers from the JSON.

### Ticks

- Per-tick cost is linear in the bar count (summary above). Update and new-bar ticks cost the same
  (at 1M bars, last 200 in view, conflation off: 9079 µs and 9492 µs). Every `update()` replaces the
  series' plot list and rebuilds its index array over all rows (`rows.map(...)` in
  `PlotList._internal_setData`) [source]; the profile puts most of the tick time there [profile].
- At 1M bars the tail grows: sync max 47.4–414 ms and p99 15845–37770 µs, against an average of
  9061–11103 µs. Garbage collection pauses are the likely cause (not confirmed with a trace): each tick
  allocates an array as long as the series, on a page that holds 1061–1069 MiB after loading 1M
  candles. The host idle share of 1–5% during these runs was mostly the renderer's own parallel GC
  threads (seen with `ps` during the run, not recorded in the JSON).
- The paint after ticks is O(N) as well, even with 200 bars in view: paint JavaScript per round of
  100 ticks is 2.42–2.58 ms at 10k bars, 24.4–24.9 ms at 100k, 74.9–77.6 ms at 300k and 386–436 ms at
  1M. After any data change the next draw rebuilds a renderer item for every row, not only the visible
  ones (`_fillRawPoints`) [source]. With a live feed on 1M bars, every repaint costs about 0.4 s of
  main-thread time.
- Conflation makes ticks with every bar in view worse in the tail: p99 11750 µs against 4365 µs at
  300k and 37770 µs against 18520 µs at 1M, sync max 414 ms against 113 ms at 1M. The first tick
  after each paint finds the conflated data cached and rebuilds it with a copy of all rows [source];
  with rounds of 100 ticks that is 1 tick in 100, exactly the p99 rank. On the other hand, conflation
  makes the paint cheaper (180 ms against 1458 ms per round at 1M).
- Against the stage 1 gate (1M bars: tick average 0.1 ms, p99 1 ms), Lightweight Charts is at 9061–
  9476 µs average and 15845–17410 µs p99 with the last 200 bars in view.

### Pan and zoom

- Conflation only changes anything when bars are narrower than about half a device pixel. With 200
  and 2,000 bars in view both variants issue the same number of `fillRect` calls per redraw (2796 and 12010) and their frame times overlap. With 20,000 bars: 15010 against 120010 calls; 200,000: 18760
  against 1200010; all 1M: 23446 against 6000010. This is the in-browser confirmation that the option
  works.
- Without conflation, frames become unusable beyond about 20,000 bars in view: pan JS p95 6.55 ms at
  20k, 189 ms at 200k and 845 ms with all 1M bars; with conflation 1.54, 2.01 and 5.49 ms.
- Zoom costs more than pan at the same level, also below the conflation threshold: JS p50 7.43–7.94 ms
  zooming around 2,000 bars against 1.13–1.14 ms panning. Changing the bar spacing rebuilds the time
  axis tick marks over all time points [source, profile], so zoom frames are O(N) too.
- Zooming around 20,000 bars with conflation has outliers: JS max 78.8 ms and frame interval max
  66.7 ms. A conflation level is built from all rows the first time it is needed [source].
- Against the stage 1 gate (pan and zoom p95 8 ms), Lightweight Charts with conflation meets it for pan
  at every level (p95 at most 5.49 ms) but not for zoom (8.42–9.25 ms p95 from 2,000 bars to all bars,
  9.15 ms at 200).
- Frame intervals are vsync-bound: p50 is 16.7 ms everywhere frames keep up; p95 of 17.1–17.7 ms is
  timestamp jitter (17.0 ms p95 on the idle page). Dropped frames show as intervals of 33 ms and more,
  for example zoom around 20,000 bars without conflation (interval p95 32.4 ms).

### Load and memory

- Loading 1M candles takes 1133–1178 ms to the first painted frame: `setData` 600–643 ms, then the first
  draw (530–535 ms of frame JavaScript). Converting columns to objects adds 37.0–44.3 ms. With 100k
  candles the first frame comes after 115–120 ms and the chart settles at 130 ms, after further draws.
- Cold loads (first in the page) are not consistently slower than warm ones at 1M (1106–1114 ms).
- The chart retains 538–550 bytes per candle and 442–446 bytes per line point, all in the JavaScript
  heap; nothing is stored in typed arrays (backing stores 0.000 MiB). 1M candles take 513–517 MiB.
- 10 million line points could not be loaded: the renderer process crashed in all 10 runs, 15.8–24.9 s
  after the run started. The crash reason was not captured. Ten times the 1M line retention would be
  about 4.1 GiB, so running out of JavaScript heap is the likely cause, but it is not confirmed.
- Conflation does not change load time or memory measurably.

### Noise

- Memory repeats to within 1% (517–517 MiB for 1M candles). Heavy frames repeat within a few percent
  (pan over all bars without conflation: JS p95 835–871 ms); light frames vary more in relative terms
  (pan over 200 bars with conflation: JS p95 1.39–2.63 ms). Tick averages at 1M vary by about 10%
  (8961–9841 µs with conflation, last 200 bars) and loads by up to 16% (1105–1283 ms).
- The tick p99 with conflation and all 1M bars in view varies most (26045–84485 µs).
- The machine was shared with other work during the day. The baseline started once the machine was
  quiet (load average 4.52 at the start, 9.88 at the end); the host idle share of every run is in the
  JSON and the tables.

## Caveats and what was not measured

- One machine, one browser. Firefox, Safari, x86 and the mid-range Android reference device are not
  measured. The page can be run by hand on a phone (see Reproducing).
- Frame rate is capped by vsync. In a check before the baseline, Chromium 156 on this machine ignored
  `--disable-frame-rate-limit` and `--disable-gpu-vsync` (the idle frame interval did not change, headed
  or headless), so the harness has no uncapped mode. Frame intervals are multiples of the refresh
  interval and cannot show headroom below it. Frame JavaScript time is the sensitive frame metric; the interval shows dropped frames.
- Frame JavaScript time counts animation-frame callbacks only. Microtasks queued by those callbacks run
  after the timed callback returns and are not counted; style, layout, paint and commit are not counted
  either. The frame interval includes all of them.
- `settle()` ends when the main thread has finished the frame. GPU rasterization and display happen
  later and are only reflected in frame intervals.
- The machine was shared. Each run records the share of CPU time the whole machine had idle (`Host CPU
  idle`), which includes the browser's own threads: V8 runs garbage collection on several threads, so
  heavy cases show low idle shares even without other load. A system daemon (`BTLEServer`) was busy
  throughout (seen with `ps`, not recorded in the JSON).
- Load times are warm (second load in the page, library code already compiled); cold first loads are
  listed separately.
- Memory excludes canvas and GPU memory and the browser and GPU processes (see Memory).

## Reproducing

```sh
pnpm install
pnpm bench:install                 # Playwright's Chromium, once
pnpm bench --budget 0 --out benchmarks/results/stage-0-baseline.json
pnpm bench:report benchmarks/results/stage-0-baseline.json
```

The baseline used the default options except the time budget, which did not exist yet: headed
Playwright Chromium, viewport 1280 × 720, DPR 2, chart 1200 × 600, 5 repeats. `pnpm bench --headless` uses Chromium's new headless mode, which still
rasterizes on the GPU; Playwright's default headless shell renders with SwiftShader on the CPU and is
not used. `--channel chrome` runs the installed Google Chrome instead.

To measure a phone by hand: run `pnpm bench:serve` (production build on port 4173) and forward the port
with `adb reverse tcp:4173 tcp:4173`, so the phone opens the page as `http://localhost:4173/`
(cross-origin isolation needs a secure context, which a LAN address is not). Choose the cases and press
Run; the results can be downloaded as JSON in the same format. Use `?width=360&height=600` for a chart that fits the
screen. Without the runner, memory comes from `performance.measureUserAgentSpecificMemory` (JavaScript
heap and ArrayBuffers, no DOM) and garbage collection is not forced, so memory numbers from the page are
less precise than the runner's.
