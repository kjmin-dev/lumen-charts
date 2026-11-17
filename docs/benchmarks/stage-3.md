# Stage 3: indicators, derived series and plugins

Stage 3 of the [design](../design.md) (section 9): an indicator engine in the data engine, indicator
outputs as derived series with levels of detail, and plugins ([section 5.1](../design/stage-3-indicators.md) describes what was built).
The gate: **with 20 indicators, tick to applied patch p99 4 ms; indicators recomputed within 1 s of
a prepend.**

The harness gained four scenarios that put a set of 20 indicators on the candles (see Scenarios).
Numbers come from these files, all headless Chromium 156.0.8078.4 (new headless mode, GPU
rasterization) on an Apple M1 on AC power, viewport 1280 × 720, DPR 2, chart 1200 × 600:

| File                                                                                      | What                                                       | Code      | Runs per case | Load average (1 min), start → end |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------- | ------------- | --------------------------------- |
| [stage-3-lumen.json](stage-3-lumen.json)                                                  | load, tick to applied, prepend; 1M candles                 | `723dee3` | 2             | 2.64 → 4.72                       |
| [stage-3-frames.json](stage-3-frames.json)                                                | pan and zoom; 1M candles                                   | `723dee3` | 1             | 4.72 → 4.00                       |
| [stage-3-drawing.json](stage-3-drawing.json)                                              | frames and tick to applied again, after the drawing change | `d556a85` | 1             | 8.81 → 6.62                       |
| [stage-3-lwc-100k.json](stage-3-lwc-100k.json)                                            | Lightweight Charts against lumen-worker; 100k candles      | `723dee3` | 1             | 4.00 → 5.79                       |
| [stage-3-lwc-1m.json](stage-3-lwc-1m.json)                                                | Lightweight Charts, load of 1M candles                     | `d556a85` | 1             | 5.79 → 8.43                       |
| [stage-3-regression-1.json](stage-3-regression-1.json), [`-2`](stage-3-regression-2.json) | stage 1 and 2 gate cases on this branch                    | `d556a85` | 1 each        | 6.62 → 4.68, 4.00 → 4.00          |
| [stage-3-regression-main.json](stage-3-regression-main.json)                              | the same cases on `main`, between the two                  | `74052b7` | 1             | 4.68 → 4.00                       |
| [stage-3-rebased.json](stage-3-rebased.json)                                              | the gate cases after rebasing onto shared workers, frames  | `047a4fa` | 1             | 3.15 → 3.94                       |
| [stage-3-rebased-regression.json](stage-3-rebased-regression.json)                        | stage 1 and 2 gate cases and tick to applied, rebased      | `047a4fa` | 1             | 3.94 → 5.58                       |
| [stage-3-rebased-frames.json](stage-3-rebased-frames.json)                                | frames with indicators, rebased                            | `047a4fa` | 2             | 5.58 → 4.32                       |

- Every file records "uncommitted changes": a README paragraph pointing here was being written in the
  tree. The commit in a file is read when its run ends. `stage-3-lwc-100k.json` records `d556a85`
  because that commit (line drawing, core only) landed while it ran; its page was built from
  `723dee3` at the start. `main` ran from an export of `74052b7` outside git, so that file records no
  commit.
- The three rebased files record uncommitted changes too: a design note and a test were being
  written; the library sources are those of `047a4fa`.
- Commits are named as they were when measured. The branch was then rebased onto `591934d`:
  `723dee3` became `670f584` and `d556a85` became `59d8123` (the same changes, on the new base).
- Tables give the median with the range of the runs in parentheses, or the value of the one run.
  Times in ms unless marked.
- Other agents were building and testing on the machine: the load average went from 2.6 to 8.8.
  Rows are compared within a file, or between files of similar load, and the spreads are given.

## Stage 3 gate

| Criterion, 20 indicators on 1M candles                   | Target | lumen-worker                 | lumen-main                       | Met on this desktop           |
| -------------------------------------------------------- | ------ | ---------------------------- | -------------------------------- | ----------------------------- |
| Tick to applied patch p99, latest 200 bars in view       | 4 ms   | 3.22 (3.10–3.34); 3.03 after | 0.295 (0.260–0.330); 0.285 after | yes                           |
| Tick to applied patch p99, all 1M bars in view           | 4 ms   | 4.09 (3.92–4.26); 4.52 after | 0.242 (0.230–0.255); 0.220 after | main thread yes; worker at it |
| Indicators recomputed and shown after a 10k prepend, p95 | 1 s    | 54.0 (53.1–54.8)             | 36.2 (36.2–36.2)                 | yes                           |
| Indicators recomputed and shown after a 1M prepend, p95  | 1 s    | 542 (502–581)                | 651 (634–667)                    | yes                           |

"After" is the single run of `stage-3-drawing.json`, after the line drawing change and under a load
average of 6.6–8.8 instead of 2.6–4.7.

- **Tick to applied patch** is timed from `series.update()` until `chart.whenApplied()` resolves:
  the engine has answered and the main thread has applied the patch, which carries the bar, every
  level's bucket and the latest value of all 25 outputs (243 patches per tick). Ticks are spaced at
  random by up to 2 ms, so they arrive at random points of the frame cycle; 1,600–2,600 ticks per
  run.
- **With the worker and all 1M bars in view the p99 sits at the gate, not under it.** The median is
  0.21–0.25 ms, but a reply that arrives while the main thread draws a frame waits for that frame,
  and with 25 lines over 1M bars a frame takes 3.6–5.6 ms of JavaScript (see Frames). A few percent
  of the replies meet a frame, so the p99 lands on the frame time. With 200 bars in view frames take
  less and the p99 is 3.0–3.3 ms. The main-thread engine applies a tick within one task of about
  0.1 ms, which a frame rarely gets in front of, so its p99 stays at 0.22–0.33 ms. Its longest
  ticks, 8–10 ms in the four runs of the first file, are the same frame waits; the busier single run
  after the drawing change had two outliers of 67 and 238 ms, not investigated.
- **Prepends.** The latency runs from `prepend()` until `chart.whenIdle()`: the bars, then every
  indicator recomputed, swapped in and drawn. The bars themselves are on screen in the first frame
  (17.6–20.9 ms for 10k, 42–61 ms for 1M). Each 1M prepend adds to the history (the measured ones
  find 2M to 4M bars and leave 5M), and the latency does not grow with it: cumulative indicators
  stop once their state converges (section 5.1). The worker's 10k prepend takes longer than the
  main thread's because its host waits 20 ms after a command before background work, so that a
  window request can come first.
- The gate names two reference devices; the mid-range Android one is not measured. The 1 s prepend
  bound has room for a device about 1.5 times slower than this M1; the 4 ms tick bound with the
  worker and a wide view has none (see Known limits).

## Scenarios

`ind-load`, `ind-apply`, `ind-frames` and `ind-prepend` are the load, frames and prepend scenarios
of earlier stages, plus a tick-to-applied scenario, with the indicator set below on the candles
(`benchmarks/src/indicators.ts`). Their case ids carry their own scenario names, so the case
selections of earlier stages are unchanged.

| #   | Indicators                                                                                      | Outputs |
| --- | ----------------------------------------------------------------------------------------------- | ------- |
| 3   | SMA 20, 50, 200                                                                                 | 3       |
| 3   | EMA 12, 26, 100                                                                                 | 3       |
| 1   | WMA 20                                                                                          | 1       |
| 2   | RSI 14, RSI 7                                                                                   | 2       |
| 1   | MACD 12/26/9                                                                                    | 3       |
| 1   | Bollinger 20/2                                                                                  | 3       |
| 1   | ATR 14                                                                                          | 1       |
| 1   | Stochastic 14/1/3                                                                               | 2       |
| 1   | VWAP (daily)                                                                                    | 1       |
| 2   | Highest 20 (high), lowest 20 (low)                                                              | 2       |
| 4   | Chains and other inputs: SMA 9 of RSI 14, EMA 9 of ATR, WMA 9 of the MACD line, EMA 50 of highs | 4       |

Ten are windowed (SMA, WMA, Bollinger, Stochastic, highest, lowest) and ten cumulative (EMA, RSI,
MACD, ATR, VWAP, and the chains on them). With indicators the candles keep their volume, for VWAP.

**Lightweight Charts** has no indicators, so its adapter computes them in application code with the
same kernels and driver as lumen, incrementally (the last bar from the state at the bar before it),
and gives each output a line or histogram series of its own: 25 series besides the candles. Its
computation costs what lumen's does; what differs is what the library does with the values. That
is a best case for it: applications usually recompute indicators over whole arrays. A prepend
recomputes everything and hands every series over again, since it has no prepend.

## Load

| Data set   | Adapter           | First frame                                       | Settled (all computed and drawn) | Retained (MiB)             |
| ---------- | ----------------- | ------------------------------------------------- | -------------------------------- | -------------------------- |
| 1M candles | lumen-worker      | 16.3 (16.3–16.4)                                  | 408 (400–417)                    | 317 (page 1.0, worker 316) |
| 1M candles | lumen-main        | 22.9 (22.8–23.1)                                  | 333 (317–350)                    | 315                        |
| 100k       | lumen-worker      | 15.9                                              | 117                              | 40.5                       |
| 100k       | lwc-conflation-on | 1,648                                             | 1,661                            | 676                        |
| 1M         | lwc-conflation-on | failed: the renderer crashed while loading (30 s) |                                  |                            |

- The first frame shows the bars; the indicators follow when computed in the background: 20 of
  them over 1M bars in about 0.3–0.4 s, values and levels of detail of 25 outputs included.
- **Memory: 330 bytes per bar** with 20 indicators, against about 50 for the candles alone at
  stage 2. Each output keeps 8 bytes per bar of values plus about 2.7 bytes of levels; 25 outputs
  make about 270 bytes. This is the price of keeping every output as a series (section 5.1); outputs are never let
  go, and a 1M-bar prepend run that ends with 5M bars holds 1.57 GiB.
- Lightweight Charts with 26 series of 100k points holds 676 MiB, 7,089 bytes per bar, most of it in
  JavaScript objects (625 MiB of heap); with 1M bars its renderer runs out of memory.

## Tick to applied patch

| Data set, view   | Adapter           | Avg                                                                 | p50                 | p99                 | Max  | Ticks |
| ---------------- | ----------------- | ------------------------------------------------------------------- | ------------------- | ------------------- | ---- | ----- |
| 1M, latest 200   | lumen-worker      | 0.372 (0.361–0.384)                                                 | 0.207 (0.205–0.210) | 3.22 (3.10–3.34)    | 18.5 | 2,133 |
| 1M, latest 200   | lumen-main        | 0.098 (0.089–0.106)                                                 | 0.073 (0.070–0.075) | 0.295 (0.260–0.330) | 9.91 | 2,573 |
| 1M, all          | lumen-worker      | 0.429 (0.420–0.438)                                                 | 0.220 (0.215–0.225) | 4.09 (3.92–4.26)    | 18.9 | 1,710 |
| 1M, all          | lumen-main        | 0.111 (0.111–0.111)                                                 | 0.075 (0.075–0.075) | 0.242 (0.230–0.255) | 9.34 | 2,094 |
| 100k, latest 200 | lumen-worker      | 0.356                                                               | 0.190               | 1.79                | 82.4 | 2,152 |
| 100k, latest 200 | lwc-conflation-on | over 150 ms per tick: 1,200 ticks did not finish in 180 s (timeout) |                     |                     |      |       |

- For lumen the update call itself takes about 1 µs; the rest is the round trip to the engine and
  applying the answer. The worker's average is about 0.27 ms above the main thread's: posting the
  tick, and copying 243 patch objects back, which a compact encoding could cut (Known limits).
- Lightweight Charts applies each update synchronously, but each of its 26 `update()` calls costs
  time proportional to the series (stage 0 measured O(N)), and a frame draws 26 series; its run
  could not finish the minimum number of ticks in three minutes.

## Prepend

| Base + batch, view      | Adapter           | Shown p50        | Shown p95        | Bars on screen (first frame) p50 | Cold shown |
| ----------------------- | ----------------- | ---------------- | ---------------- | -------------------------------- | ---------- |
| 1M + 10k, 20k in view   | lumen-worker      | 52.8 (52.7–52.8) | 54.0 (53.1–54.8) | 17.7 (17.6–17.7)                 | 50.0       |
| 1M + 10k, 20k in view   | lumen-main        | 28.0 (20.7–35.4) | 36.2 (36.2–36.2) | 20.8 (20.7–20.9)                 | 34.3       |
| 1M + 1M, 1M in view     | lumen-worker      | 513 (501–526)    | 542 (502–581)    | 42.9 (42.0–43.8)                 | 508        |
| 1M + 1M, 1M in view     | lumen-main        | 605 (553–657)    | 651 (634–667)    | 51.4 (41.5–61.3)                 | 580        |
| 100k + 10k, 20k in view | lumen-worker      | 52.4             | 52.8             | 17.5                             | 47.0       |
| 100k + 10k, 20k in view | lwc-conflation-on | 3,255            | 3,795            | 3,250                            | 2,868      |

10 prepends of 10k or 3 of 1M per run, after a cold one. "Shown" includes every indicator; for
Lightweight Charts the first frame and "shown" coincide (it recomputes and hands everything over in
the call, which takes 3.0 s).

- **Convergence keeps prepends from growing with the history.** On the code before it (the first run
  of this stage, stopped and not kept), each 1M prepend recomputed the cumulative indicators over the
  whole history: p50 948–968 ms and p95 1,129–1,400 ms with the worker, against p50 501–526 and p95
  502–581 ms now. A 10k prepend went from p50 219–269 ms to 21–53 ms: windowed indicators recompute
  10k rows plus a chunk, cumulative ones stop within a chunk or two of the old first bar.
- That first run also found a bug: the main-thread engine could stop its background work when a
  command ended exactly as its 4 ms slice did, and `whenIdle` then waited forever (a 1M prepend with
  20 indicators timed out now and then). Fixed in `723dee3`, with a test that makes every slice end
  that way.

## Frames

Frame JavaScript time with all 20 indicators drawn (25 outputs: 24 lines and a histogram), 1M
candles. Before is `stage-3-frames.json`, after is `stage-3-drawing.json` (one run each, load
average 4.0–4.7 before, 6.6–8.8 after).

| Bars in view (bars per device pixel) | p50 before → after (worker) | p95 before → after (worker) | p95 after (main) | `lineTo` per redraw before → after |
| ------------------------------------ | --------------------------- | --------------------------- | ---------------- | ---------------------------------- |
| pan 2,000 (0.9)                      | 2.26 → 2.54                 | 2.80 → 2.94                 | 2.87             | 47,976 → 47,976                    |
| pan 20,000 (8.7)                     | 5.68 → 4.70                 | 5.87 → 4.93                 | 4.74             | 156,032 → 100,591                  |
| zoom 200,000 (87)                    | 5.32 → 4.73                 | 5.78 → 5.06                 | 5.07             | 204,818 → 155,702                  |
| pan all 1M (435)                     | 3.79 → 3.58                 | 4.88 → 4.73                 | 4.68             | 208,808 → 181,542                  |
| zoom all 1M (435)                    | 3.94 → 4.33                 | 5.16 → 5.61                 | 5.45             | 208,808 → 181,542                  |
| Lightweight Charts, pan all 100k     | 6.07 (lumen 4.05)           | 7.13 (lumen 5.32)           |                  |                                    |

- Without indicators, the same views took 0.39–1.55 ms at stage 2. The 25 outputs add 2–4 ms, almost
  all of it in building one path per line: in a view merged per pixel column, a line visits up to
  four points per column (first value, both extremes, last value).
- **Line drawing change** (`d556a85`): a merged column now sweeps to the nearer extreme first and
  leaves out points within half a pixel of the pen. The same pixels with 13–36% fewer `lineTo` calls;
  frame JS dropped by about 1 ms at 20,000 and 0.6 ms at 200,000 bars in view. In the widest views
  most indicator buckets still span a pixel or more, so fewer points can be dropped, and the change
  there is within the noise of a busier machine.
- Frame JS stays far under 16 ms in every view, and under the 8 ms of the stage 1 frame gate.

## Regression check

The stage 1 and stage 2 gate cases, without indicators, on this branch (`d556a85`, the line
drawing change included) and on `main` (`74052b7`), run as branch, main, branch with one run each
(load average 6.6 → 4.7, 4.7 → 4.0, 4.0 → 4.0). Cells are branch / main / branch.

| Case                                 | Metric                    | lumen-worker       | lumen-main           | Stage 2 (worker / main) |
| ------------------------------------ | ------------------------- | ------------------ | -------------------- | ----------------------- |
| tick, 1M candles, last 200 in view   | sync avg (µs)             | 0.54 / 0.70 / 0.65 | 0.70 / 0.80 / 0.69   | 0.80 / 0.84             |
| tick, 1M candles, all in view        | sync avg (µs)             | 0.63 / 0.67 / 0.62 | 0.61 / 0.69 / 0.60   | 0.69 / 0.70             |
| tick, 1M candles, both views         | sync p99 (µs)             | ≤ 5 everywhere     | ≤ 5, 10 once on main | ≤ 5                     |
| tick, 1M candles, all in view        | main thread per tick (µs) | 8.75 / 8.24 / 8.57 | 7.82 / 7.91 / 7.97   | 7.9–8.4                 |
| frames, 10M line, pan 20k            | JS p95                    | 1.19 / 1.11 / 1.16 | 1.19 / 1.12 / 1.12   | 1.06 / 1.09             |
| frames, 10M line, zoom 20k           | JS p95                    | 1.28 / 1.23 / 1.38 | 1.17 / 1.26 / 1.23   | 1.22 / 1.17             |
| frames, 10M line, pan all            | JS p95                    | 0.80 / 0.80 / 0.65 | 0.82 / 0.78 / 0.29   | 0.79 / 0.79             |
| frames, 10M line, zoom all           | JS p95                    | 0.93 / 0.94 / 0.33 | 1.12 / 1.09 / 0.93   | 0.89 / 0.87             |
| prepend 10k to 10M line, 20k in view | shown p95                 | 19.2 / 18.0 / 17.8 | 17.7 / 18.0 / 18.3   | 18.0 / 18.0             |
| prepend 1M to 10M line, 2M in view   | shown p95                 | 31.4 / 31.1 / 30.1 | 21.5 / 21.9 / 28.7   | 31.4 / 22.3             |
| prepend 1M to 1M candles, 1M in view | shown p95                 | 37.8 / 38.0 / 50.4 | 38.3 / 39.3 / 38.0   | 43.0 / 36.4             |

- **No regression.** The differences between branch and main go both ways and are of the size of
  the difference between the two branch runs, and the values match the stage 2 numbers. The stage 1
  gate (tick average 0.1 ms, p99 1 ms, frames p95 8 ms on 1M candles) and the stage 2 gate (frames
  p95 16 ms on 10M points, prepend shown within 100 ms) hold with the same margins. Without indicators the tick path pays one call into an empty
  indicator engine per batch.
- The low values of the second branch run with all 10M points in view (0.29–0.65 ms against
  0.8–1.1 ms) came with the line drawing change in both branch runs, so they are not that change;
  they stay unexplained run-to-run variance of a single run.
- Frames, ticks and prepends were measured with the time budget of 3 s and one run per case and side,
  enough to show the absence of a step change, not to resolve differences of a few percent.

## On shared workers and frames

While this branch was open, `main` gained shared page resources (`591934d`, see
[shared-resources.md](shared-resources.md)): charts share workers, one worker host serves several
engines in turn, and one animation frame draws every chart. The branch was rebased onto it. In the
shared host, indicator jobs are part of each engine's background turn, and what a turn finished
goes out as a notice tagged with that engine's id. The indicator code did not change otherwise.

The gate cases, the stage 1 and 2 cases and the wide frames were run again on the rebased branch
(`047a4fa`): tick to applied twice (once in each of the first two files below), frames twice, the
rest once. Before comes from the tables above.

| Criterion, 20 indicators on 1M candles                   | Target | lumen-worker, before → rebased            | lumen-main, before → rebased |
| -------------------------------------------------------- | ------ | ----------------------------------------- | ---------------------------- |
| Tick to applied patch p99, latest 200 bars in view       | 4 ms   | 3.10–3.34 → 3.05, 3.60                    | 0.260–0.330 → 0.295, 0.310   |
| Tick to applied patch p99, all 1M bars in view           | 4 ms   | 3.92–4.26 (4.52 busier) → 4.44, 4.26      | 0.230–0.255 → 0.275, 0.265   |
| Indicators recomputed and shown after a 10k prepend, p95 | 1 s    | 53.1–54.8 → 53.0                          | 36.2 → 35.7                  |
| Indicators recomputed and shown after a 1M prepend, p95  | 1 s    | 502–581 → 543                             | 634–667 → 601                |
| Load: first frame / settled                              |        | 16.3 / 400–417 → 14.9 / 400               | 22.9 / 317–350 → 19.1 / 333  |
| Retained after load (MiB)                                |        | 317 → 317                                 | 315 → 315                    |
| Frame JS p95, pan 20,000 bars                            |        | 4.93 → 4.81–4.89                          | 4.74 → 4.73–4.80             |
| Frame JS p95, pan all 1M bars                            |        | 4.73 → 4.74–4.77 (5.55 in the first file) | 4.68 → 4.67–4.69 (5.46)      |
| Frame JS p95, zoom all 1M bars                           |        | 5.61 → 4.74–4.76                          | 5.45 → 4.71                  |

- **The gate stands as it was.** The prepend bound is met with the same margin, and the main-thread
  tick p99 stays at 0.27–0.31 ms. The worker's tick p99 with all 1M bars in view is still at the
  gate, not under it: 4.26 and 4.44 ms against 3.92–4.52 before, for the reason given above (a
  reply that arrives during a frame waits for it).
- The main-thread engine again had single long ticks of 73 and 233 ms in two of the four runs
  (its averages, 0.13–0.20 ms, include them), as in the busier run before the rebase; not
  investigated.
- Frames: before is the run after the line drawing change. The single pan-all run of the first
  rebased file (p95 5.55 and 5.46 ms) was above the two runs of the frames file (4.67–4.77 ms),
  which match the run before; for one chart the shared frame adds nothing measurable.

The stage 1 and 2 gate cases without indicators, rebased (`stage-3-rebased-regression.json`), next
to the branch and `main` runs of the regression check above:

| Case                                 | Metric                    | lumen-worker: before (branch, main, branch) → rebased | lumen-main: before → rebased |
| ------------------------------------ | ------------------------- | ----------------------------------------------------- | ---------------------------- |
| tick, 1M candles, last 200 in view   | sync avg (µs)             | 0.54–0.70 → 0.67                                      | 0.69–0.80 → 0.72             |
| tick, 1M candles, all in view        | sync avg (µs)             | 0.62–0.67 → 0.47                                      | 0.60–0.69 → 0.60             |
| tick, 1M candles, all in view        | main thread per tick (µs) | 8.24–8.75 → 6.24                                      | 7.82–7.97 → 7.98             |
| frames, 10M line, pan 20k            | JS p95                    | 1.11–1.19 → 1.20                                      | 1.12–1.19 → 1.22             |
| frames, 10M line, zoom 20k           | JS p95                    | 1.23–1.38 → 1.35                                      | 1.17–1.26 → 1.34             |
| frames, 10M line, pan all            | JS p95                    | 0.65–0.80 → 0.81                                      | 0.29–0.82 → 0.84             |
| frames, 10M line, zoom all           | JS p95                    | 0.33–0.94 → 0.94                                      | 0.93–1.12 → 0.88             |
| prepend 10k to 10M line, 20k in view | shown p95                 | 17.8–19.2 → 18.6                                      | 17.7–18.3 → 18.3             |
| prepend 1M to 10M line, 2M in view   | shown p95                 | 30.1–31.4 → 33.5                                      | 21.5–28.7 → 21.5             |
| prepend 1M to 1M candles, 1M in view | shown p95                 | 37.8–50.4 → 36.9                                      | 38.0–39.3 → 39.2             |

- No step change: every rebased value is within or next to the range of the three runs before,
  differences go both ways, and the stage 1 and 2 gates hold with the same margins.

## What changed

- **Indicators in the data engine.** Built-ins: SMA, EMA, WMA, RSI, MACD (3 outputs), Bollinger bands
  (3), ATR, Stochastic (2), VWAP (daily by default), highest and lowest. Kernels take
  `(buffer, offset, length, state, carry, params)`, with the carry in the buffer in front of
  `offset`; one runner drives them in slices that never cross a chunk boundary and restarts windowed
  kernels at every boundary, which makes their values independent of where a computation began.
- **Derived series.** Every output is a series on the main timeline with values in chunks and a
  level-of-detail pyramid, carried by the existing window and patch protocol; a tick's patch carries
  the bar and the latest value of every output.
- **Background recomputation, swapped in at once.** Load, new parameters or inputs recompute an
  indicator in slices into storage of its own, and the result replaces the live values at once, which
  keep ticking meanwhile. After a prepend windowed indicators recompute the new rows and the old first
  chunk; cumulative ones recompute until their state equals, bit for bit, the checkpoint the old
  computation kept at a chunk boundary. A notice (an event that answers no command) reports the swap.
- **Memory limit.** Outputs are never let go; a recomputation over rows the limit let go fetches them
  through the datafeed, one window ahead, and eviction spares the rows it has yet to read.
- **Plugins.** `chart.registerIndicators(url)` imports a module of definitions in the engine (worker or
  main thread) and reports the metadata back.
- **Core.** `series.addIndicator`, `chart.addIndicator`, indicator and output handles, a histogram
  series type, `chart.whenApplied()`; line drawing with fewer points per merged column.
- **Speed work found by profiling** (kernels and levels, in Node over 1M rows, 20 indicators): full
  computation went from 683 to about 360 ms, and a 1M prepend on 1M bars from 770–900 to about
  460 ms before convergence was added. Rolling extremes moved from a deque in the state to the van
  Herk/Gil-Werman algorithm (29 → 7 ns per row; Stochastic 62–86 → 34), and the finest level of a
  derived series is built in one pass per output (3.2 → 1.3 ns per row and output). These are Node
  measurements on the busy machine, for direction only.

## Known limits

- **Tick to applied with the worker and a wide view is at the gate** (p99 3.9–4.5 ms with all 1M bars
  in view). The time is the frame the reply waits for, not the engine. Cheaper frames (drawing wide
  indicator lines with fewer path calls, partial redraw, or rendering off the main thread, all stage 5
  candidates) would lower it, and a compact patch encoding would lower the worker's average; neither
  is done here.
- **Memory.** 25 outputs at 10.7 bytes per bar each dominate: 330 bytes per bar with 20 indicators,
  1.57 GiB after 1M prepends grow the history to 5M bars. A recomputation in full also holds a second
  copy of one indicator's values and levels until it is swapped in.
- Oscillators share the price scale (overlay only; separate panes are not part of this stage), so
  RSI or MACD on a price chart compress the candles. A histogram's base is always in range.
- The Lightweight Charts tick run did not finish; it gives a lower bound only.
- One desktop machine, headless, under a load average of 2.6–8.8 from other work; the mid-range
  Android reference device, x86 and Firefox are not measured. Frame intervals stay at the refresh
  interval in headless runs (see the [stage 0 notes](stage-0-baseline.md#reproducing)).
- Frame JavaScript time covers animation-frame callbacks; the engine's work in the worker, and the
  main-thread engine's tasks between frames, are not in it.

## Reproducing

```sh
pnpm bench --scenario ind-load,ind-apply,ind-prepend --size 1m --lib lumen-worker,lumen-main \
  --repeats 2 --budget 3 --out benchmarks/results/stage-3-lumen.json
pnpm bench --case ind-frames/candles-1m/pan-2k,ind-frames/candles-1m/pan-20k,ind-frames/candles-1m/zoom-200k,ind-frames/candles-1m/pan-all,ind-frames/candles-1m/zoom-all \
  --lib lumen-worker,lumen-main --repeats 1 --budget 3 --out benchmarks/results/stage-3-frames.json
pnpm bench --case ind-load/candles-100k,ind-apply/candles-100k/latest,ind-frames/candles-100k/pan-all,ind-prepend/candles-100k \
  --lib lwc-conflation-on,lumen-worker --repeats 1 --budget 3 --timeout 180 --out benchmarks/results/stage-3-lwc-100k.json
pnpm bench --case tick/candles-1m,frames/line-10m/pan-20k,frames/line-10m/zoom-20k,frames/line-10m/pan-all,frames/line-10m/zoom-all,prepend/line-10m,prepend/candles-1m/1m \
  --lib lumen-worker,lumen-main --repeats 1 --budget 3 --out benchmarks/results/stage-3-regression-1.json
pnpm bench --case ind-load/candles-1m,ind-apply/candles-1m,ind-prepend/candles-1m,ind-frames/candles-1m/pan-all \
  --lib lumen-worker,lumen-main --repeats 1 --budget 3 --out benchmarks/results/stage-3-rebased.json
pnpm bench --case ind-frames/candles-1m/pan-20k,ind-frames/candles-1m/pan-all,ind-frames/candles-1m/zoom-all \
  --lib lumen-worker,lumen-main --repeats 2 --budget 3 --out benchmarks/results/stage-3-rebased-frames.json
pnpm bench:report docs/benchmarks/stage-3-lumen.json
```

Unit tests that back the claims above: `packages/engine/test/indicators.test.ts` (every kernel against
brute force, warm-up, chains, windowed values independent of the start),
`packages/engine/test/indicator-engine.test.ts` (incremental against full computation bit for bit,
prepends, corrections, parameter changes, convergence, levels), `packages/engine/test/indicator-memory.test.ts`
(recomputation under the memory limit, failing fetches), `packages/core/test/indicator-cache.fuzz.test.ts`
(engine and window cache with indicators against full computation), `packages/engine/test/client.test.ts`
(plugins in a worker and on the main thread, the transport fix).
