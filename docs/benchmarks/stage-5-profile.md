# Stage 5: where frame and load time goes, and which optional steps it supports

Stage 5 of the [design](../design.md) (section 9) is optional: WASM kernels, a GPU layer,
`OffscreenCanvas` and partial redraw, "each only with profiling evidence". This document is that
evidence. It profiles `main` after stage 4 (`1bc481a`), decides each candidate against the criteria
the design itself states, and implements none of them.

| Candidate                                  | Decision                   | Deciding numbers                                                                                                                                                                                                                                                     |
| ------------------------------------------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Partial redraw                             | **Adopt**, for tick frames | With 20 indicators and 1M bars in view a tick's frame takes 4.1 ms of JavaScript (p99 4.7) against the 4 ms the stage 3 gate gives a tick; 80% of it draws lines that did not change. 94–99% of tick frames could redraw the last columns only: 0.06 ms.             |
| Cheaper wide-view frames (algorithm first) | **Adopt**: min/max loops   | Not on the stage 5 list, found by the profile. The loops that take a minimum and a maximum run 1.5–4.8 times faster with `Math.max`/`Math.min` (the noisier the series, the more): they are 20–41% of a pan frame with indicators and 38% of the engine's load time. |
| WASM kernels                               | **Reject** for now         | Recursive kernels: 0.95–1.24 times JavaScript. Only the min/max loops gain (4–10 times), and JavaScript gets much of that without WASM. What is left for WASM is under a tenth of a load that has no budget to meet, and nothing in a tick (kernels: 2%).            |
| `OffscreenCanvas`                          | **Defer**                  | Drawing costs the same in a worker (3.4 against 3.5 ms). It keeps 60 frames a second under a host page that blocks the main thread, which no gate asks for, and pointer input still waits for that thread.                                                           |
| GPU layer                                  | **Defer** until its series | No heatmap or tick scatter series exists. Canvas 2D through a pixel buffer draws 1M points in 5.8 ms and 1.44M cells in 3.0 ms; rectangle by rectangle it breaks at 100k points (17.8 ms) and 14k–240k cells.                                                        |

## Conditions

Headless Chromium 156.0.8078.4 (new headless mode, GPU rasterization through ANGLE Metal) on an
Apple M1 (8 cores, 16 GiB) on AC power, viewport 1280 × 720, DPR 2, chart 1200 × 600. Node 26.13.1
(V8 14.6) for the kernel comparisons.

**The machine was busy throughout.** A process outside this work used about five cores during
every run, and the one-minute load average went from 10 to 44. Shares of time and ratios between
variants measured back to back hold; absolute times are worse than those of earlier stages on the
same machine (the worker's tick to applied p99 with all bars in view is 5.0 ms here, 3.9–4.5 ms in
[stage 3](stage-3.md)), and tails (p99, max) more so. Where a number matters for a decision, the
earlier stage's value is given next to it.

| File                                                             | What                                                             | Runs per case | Load average (1 min), start → end |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- | ------------- | --------------------------------- |
| [stage-5-profile-timings.json](stage-5-profile-timings.json)     | the cases below, timed without a trace                           | 2             | 16.0 → 26.2                       |
| [stage-5-profile-traced.json](stage-5-profile-traced.json)       | the same cases while traced (their timings, for the overhead)    | 1             | 9.9 → 16.0                        |
| [stage-5-profile-breakdown.json](stage-5-profile-breakdown.json) | the breakdown of every traced run (`summary.json` of the runner) | 1             | 9.9 → 16.0                        |
| [stage-5-tail-frames.json](stage-5-tail-frames.json)             | tick frames that keep geometry and price scales (a probe)        | 1             | 35.8 → 24.9                       |
| [stage-5-prototype-canvas.json](stage-5-prototype-canvas.json)   | prototypes: line drawing variants, tick scatter, heatmap         | 1             | 17.7 → 44.5                       |
| [stage-5-prototype-kernels.json](stage-5-prototype-kernels.json) | prototypes: kernels in JavaScript and WASM, min/max loops        | 9–400 passes  | 22.2, 21.0, 22.5, 13.2            |

Every results file records uncommitted changes: the harness changes of this document were in the
tree. The library sources are those of `1bc481a`.

Both adapters were measured: `lumen-worker` (data engine in a worker) and `lumen-main` (time-sliced
on the main thread). Tables give the median of the two runs with their range in parentheses, or
the value of the one run. Times are in ms unless marked.

## Method

**Tracing.** The runner gained `pnpm bench --profile <dir>`. It records a Chromium trace of every
run (categories `devtools.timeline`, `disabled-by-default-devtools.timeline`,
`disabled-by-default-v8.cpu_profiler`, `blink.user_timing`, `toplevel`, `v8`, `gpu`), which holds
CPU samples of every thread of the page (workers included), the tasks of every thread of every
process, the animation frames and the garbage collections. The harness page sets two performance
marks around the measured part of a run, and everything below is cut there. The page is built
without minification for these runs, so samples carry function names; a sample's function is mapped
to its source file through the build's source map, and the file (for `chart.ts`, the function)
gives its category. `benchmarks/src/profile.ts` holds this, with a test.

- **Sampling.** V8 samples every 155–177 µs. On this machine the sampler was late now and then, so
  a sample stands for the time until the next one but for no more than two intervals; what ran
  meanwhile is left out. Samples cover about 70% of the frame time the trace's own events report.
  Tables therefore give **shares of the sampled time**, and times per frame as that share of the
  frame's JavaScript time.
- **Canvas 2D calls** do not appear as functions of their own. `lineTo` and `moveTo` are compiled
  into their caller, so their time is in `drawLine`; other calls (`fillRect`, `stroke`, `fillText`)
  show up as native code without a function. "Drawing" below is therefore the drawing function
  with its canvas calls, and "native code" is what remains unattributed inside a frame. The
  prototype further down separates the two for lines: 27% loop, 73% canvas.
- **Rasterization** runs in the GPU process, after the frame's JavaScript. Its cost is the time
  the GPU process's main thread was busy per frame. Headless frame intervals stay at the refresh
  interval whatever that cost is (see [stage 0](stage-0-baseline.md#reproducing)), so it is reported
  but no gate measures it.
- **Tracing overhead.** Frame JavaScript p50 with the trace on is within 0.05 ms of the runs
  without it (3.84 against 3.77 ms, 0.34 against 0.29 ms). All timings below come from the runs
  without a trace.

**Prototypes** were written outside the repository and are not part of it: a page that draws
synthetic data with several variants of one job, each for 120 frames after a warm-up in a fresh
document, timed in the page and traced for the GPU process; Rust ports of eight kernels compiled to
WASM (`wasm32-unknown-unknown`, `opt-level=3`, raw pointers into linear memory, one build with
`simd128`), run in Node against the repository's JavaScript kernels over 1M rows sliced like the
engine's runner (chunks of 8,192 rows with the carry in front), alternating, with every output bit
compared; and a probe in `Chart.frameWrite` (not committed) that counts the frames whose geometry
and price scale versions are those of the frame before.

## Timings against the budgets

| Case (1M candles unless marked)             | Metric                 | Budget (design section 9) | lumen-worker            | lumen-main              |
| ------------------------------------------- | ---------------------- | ------------------------- | ----------------------- | ----------------------- |
| tick, all in view                           | sync avg (µs)          | 100 (stage 1)             | 0.26 (0.26–0.27)        | 0.26 (0.25–0.27)        |
| tick, all in view                           | frame JS per round p99 | –                         | 0.48 (0.44–0.51)        | 0.45 (0.43–0.46)        |
| 20 indicators, tick to applied, latest 200  | p99                    | 4 (stage 3)               | 3.68 (3.52–3.85)        | 0.42 (0.40–0.45)        |
| 20 indicators, tick to applied, all in view | p99                    | 4 (stage 3)               | **5.03 (5.00–5.07)**    | 0.53 (0.44–0.61)        |
| 20 indicators, tick to applied, all in view | p50                    | –                         | 0.32 (0.28–0.36)        | 0.10 (0.10–0.10)        |
| frames, pan 2,000                           | JS p95                 | 8 (stage 1)               | 0.34 (0.34–0.34)        | 0.58 (0.34–0.82)        |
| frames, pan all                             | JS p95                 | 8 (stage 1)               | 0.40 (0.40–0.40)        | 0.39 (0.39–0.40)        |
| frames, 10M line points, pan all            | JS p95                 | 16 (stage 2)              | 0.30 (0.30–0.31)        | 0.31 (0.30–0.33)        |
| 20 indicators, pan 2,000                    | JS p50 / p95           | 8                         | 1.48 / 1.60             | 1.49 / 1.59             |
| 20 indicators, pan 20,000                   | JS p50 / p95           | 8                         | 4.89 / 5.03             | 4.82 / 5.07             |
| 20 indicators, pan all                      | JS p50 / p95           | 8                         | 3.77 / 5.07             | 3.77 / 5.02             |
| 20 indicators, zoom all                     | JS p50 / p95           | 8                         | 4.04 / 6.46 (5.71–7.20) | 4.17 / 6.69 (5.13–8.25) |
| 20 indicators, load: first frame / settled  |                        | –                         | 14.3 / 474 (464–483)    | 17.6 / 368 (363–373)    |
| 20 indicators, 1M prepend, shown            | p95                    | 1,000 (stage 3)           | 767 (711–823)           | 786 (767–804)           |
| 1,000 drawings, hover frame                 | JS p99                 | 1 (stage 4)               | 0.34 (0.24–0.44)        | 0.30 (0.28–0.32)        |
| 1,000 drawings, pan frame                   | JS p99                 | –                         | 0.61 (0.61–0.62)        | 0.61 (0.60–0.62)        |
| 16 charts of 100k candles, a round of ticks | frame JS p95           | –                         | 0.33 (0.32–0.35)        | 0.35 (0.33–0.37)        |

- **One budget is exceeded: a tick through the worker with 20 indicators and all bars in view**,
  the open question of design section 10. Its p99 is the frame the reply waits for: 5.0 ms here
  under load, 3.9–4.5 ms in stage 3, against 4 ms. Everything else has room: frames with 20
  indicators take 1.5–5.1 ms at p95 against 8 ms (one zoom run reached 8.25 ms at p95 on the busy
  machine; stage 3 measured 4.7–5.6), frames without indicators 0.3–0.6 ms, hover 0.3 ms against
  1 ms, the prepend 0.77–0.79 s against 1 s (0.50–0.67 s in stage 3).
- Load has no gate. The bars are on screen after 14–18 ms; the 20 indicators follow after
  0.37–0.47 s (0.32–0.42 s in stage 3).

## Where a frame goes

Shares of the sampled time inside animation-frame callbacks, and the same as time per frame (share
× mean frame JavaScript of the traced run). `lumen-worker`; `lumen-main` is within two points in
every column (the breakdown file has both).

| Case                                     | Frame JS mean | Series drawing (with its canvas calls) | Items and coordinates | Grid, axes, labels | Scales, ticks, autoscale | Native code | Rest     | GPU process per frame |
| ---------------------------------------- | ------------- | -------------------------------------- | --------------------- | ------------------ | ------------------------ | ----------- | -------- | --------------------- |
| pan 2,000 candles                        | 0.41          | 18% 0.07                               | 5% 0.02               | 2% 0.01            | 4% 0.02                  | 63% 0.26    | 8% 0.03  | 1.42                  |
| pan all 1M candles                       | 0.41          | 15% 0.06                               | 8% 0.03               | 2% 0.01            | 4% 0.01                  | 64% 0.26    | 7% 0.03  | 1.41                  |
| pan all 10M line points                  | 0.36          | 12% 0.04                               | 2% 0.01               | 2% 0.01            | 3% 0.01                  | 73% 0.26    | 8% 0.03  | 1.09                  |
| ticks, all 1M candles in view            | 0.47          | 28% 0.13                               | 3% 0.01               | 15% 0.07           | 4% 0.02                  | 41% 0.19    | 9% 0.04  | 1.64                  |
| 20 indicators, pan 2,000                 | 1.58          | 45% 0.72                               | 21% 0.34              | 2% 0.04            | 2% 0.03                  | 25% 0.39    | 4% 0.06  | 1.90                  |
| 20 indicators, pan 20,000                | 5.04          | 37% 1.89                               | 48% 2.42              | 1% 0.05            | 1% 0.04                  | 11% 0.57    | 2% 0.07  | 2.69                  |
| 20 indicators, pan all 1M                | 3.99          | 59% 2.37                               | 25% 1.00              | 1% 0.05            | 1% 0.02                  | 12% 0.50    | 2% 0.05  | 3.24                  |
| 20 indicators, zoom all 1M               | 4.38          | 73% 3.21                               | 12% 0.52              | 1% 0.06            | 1% 0.04                  | 11% 0.49    | 2% 0.06  | 3.93                  |
| **20 indicators, ticks, all 1M in view** | **4.08**      | **80% 3.25**                           | 7% 0.28               | 4% 0.15            | 1% 0.03                  | 8% 0.33     | 1% 0.04  | **5.19**              |
| 20 indicators, ticks, latest 200         | 0.38          | 22% 0.08                               | 5% 0.02               | 15% 0.06           | 3% 0.01                  | 50% 0.19    | 5% 0.02  | 1.15                  |
| 1,000 drawings, hover                    | 0.28          | 0%                                     | 0%                    | 7% 0.02            | 0%                       | 76% 0.21    | 15% 0.04 | 0.63                  |
| 1,000 drawings, pan                      | 0.43          | 7% 0.03                                | 1%                    | 4% 0.02            | 3% 0.01                  | 67% 0.29    | 19% 0.08 | 1.21                  |
| 16 charts, a round of ticks              | 0.34          | 16% 0.05                               | 1%                    | 17% 0.06           | 4% 0.01                  | 48% 0.16    | 14% 0.05 | 2.28                  |

- **Without indicators a frame is 0.3–0.5 ms and has nothing to take out.** About 0.26 ms of it is
  native code: the canvas calls of candles, grid, axes and overlay (`fillRect`, `fillText`), which
  no function claims. The series drawing loops take 0.04–0.13 ms.
- **With 20 indicators a frame is line drawing and column merging.** `drawLine` alone is 47–57% of
  a wide pan or zoom frame and 70% of a tick's (25 outputs, 180,000 `lineTo` calls a frame, as
  stage 3 counted). `SeriesView.update` is the other large part while panning: 41% of the frame
  (2.1 ms) with 20,000 bars in view, where every frame merges 20,000 raw rows of 25 series into
  pixel columns, and 20% (0.8 ms) with all bars in view; `project` is 3–4%.
- In the drawings rows, "rest" holds the drawings layer (14% of a pan frame, 2% of a hover) and the
  overlay.
- **A tick redraws everything though almost nothing changed.** With all 1M bars in view the tick's
  frame costs what a pan frame costs (4.1 against 4.0 ms), 80% of it in `drawLine`, `drawHistogram`
  and the candles. The view itself is cheap on a tick, as designed: `update` re-merges only the
  changed columns (0.1 ms), `project` runs over all items (0.2 ms). The GPU process then rasterizes
  all 25 lines again: 5.2 ms of its main thread per frame, more than the JavaScript.
- **Garbage collection** takes no part in frames: 0–1.1 ms in 3 s of panning. During tick to
  applied the main thread collects for 41–129 ms in 3 s (1.4–4.3%), which is mostly the harness
  (its pause between ticks runs a task per loop turn).
- Model work (scales, ticks, autoscale), the overlay and the hit test are each under 0.1 ms.

## Where a tick goes

CPU per tick with 20 indicators and all 1M bars in view, engine in the worker, from 1,407 traced
ticks (µs per tick, sampled):

| Thread | Part                                            | µs per tick     |
| ------ | ----------------------------------------------- | --------------- |
| Worker | Store and commands (rows, patch assembly)       | 51              |
| Worker | Host: messages and scheduling                   | 47              |
| Worker | Indicator engine and runner                     | 32              |
| Worker | Levels of detail (rebuilding the last buckets)  | 12              |
| Worker | `postMessage` (structured clone of the reply)   | 7               |
| Worker | **Indicator kernels**                           | **3.5**         |
| Main   | Engine client: receiving and applying the patch | 38              |
| Main   | The frame that draws it (one per 8 ticks here)  | 4,080 per frame |

- The engine answers a tick in about 150 µs of worker time, of which the 20 kernels take 3.5 µs
  (2%). Messaging (the host's part, the clone and the client) is about 90 µs; the compact patch
  encoding stage 3 named would cut into that, and it lowers the average (0.6 ms here), not the p99.

A reply waits behind whatever the main thread is doing when it arrives. The main-thread tasks of
1.5 ms or more in the 3 s of the two traced runs through the worker:

| Task                                    | All 1M bars in view: count, mean (max) | Latest 200 bars: count, mean (max) |
| --------------------------------------- | -------------------------------------- | ---------------------------------- |
| A frame (callbacks and rendering steps) | 178, 4.60 (5.71)                       | none (frames take 0.4)             |
| Major garbage collection                | 6, 12.8 (17.2)                         | 9, 12.7 (16.2)                     |
| Minor garbage collection                | 5, 3.5 (6.5)                           | 4, 2.3 (2.6)                       |
| A microtask checkpoint                  | 6, 3.6 (5.0)                           | 8, 3.0 (3.7)                       |
| All, of the 3,001 ms                    | 196 tasks, 935 ms                      | 21 tasks, 147 ms                   |

- **With all bars in view the p99 is the frame.** Every frame is a task of 4.6 ms, and frames take
  27% of the main thread's time, so about a quarter of the replies wait for one: the p99 lands at
  the top of the frame's duration (5.0 ms here).
- **With 200 bars in view the p99 is garbage collection.** No frame is long there; about 21 of the
  2,000 ticks, the last percent, meet a collection of 2–16 ms or a microtask checkpoint of 3 ms.
  That gives the 3.0–3.9 ms p99 of this view in every stage, and the 17–27 ms maximum. Stage 3
  put this p99 down to frames as well; the trace does not bear that out.
- So frames cost the wide view 1.3–1.5 ms of p99 over the narrow one, and what remains in both is
  the collector. How much of the garbage is the library's (243 patch objects per tick, cloned from
  the worker) and how much the harness's (its pause between ticks posts a message per loop turn,
  138,000 tasks in 3 s) was not separated. Without the pause loop (the `tick` scenario) the main
  thread collects for 1.6 ms in 1.7 s.

## Where a load goes

Loading 1M candles with 20 indicators: the bars are drawn in the first frame, and the engine then
computes the indicators and their levels of detail in the background. Sampled CPU of the engine's
thread during that, `lumen-worker` (the main-thread engine has the same order):

| Part                        | Share | Largest functions (ms sampled, of 197)                                                                               |
| --------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------- |
| Indicator kernels           | 56%   | `rollingExtreme` 28.9, Stochastic 12.4, EMA 10.8 (+5.1), Bollinger 9.6, ATR 9.6, SMA 8.4, RSI 7.6, WMA 5.9, MACD 5.4 |
| Indicator engine and runner | 17%   | `lineBuckets` 26.3 (the finest level of each output)                                                                 |
| Store and commands          | 13%   | `createChunk` 11.0, `copy` 8.6                                                                                       |
| Levels of detail            | 10%   | `aggregate` 19.9                                                                                                     |
| Garbage collection          | 2%    |                                                                                                                      |

- **Kernels are a meaningful share of the load: 56% of the engine's time**, which is what the
  design asks before WASM is considered (section 5). That is why the comparison below was made.
- **38% of the engine's time is three loops that take a minimum and a maximum**: `rollingExtreme`
  (the rolling highest and lowest, and Stochastic's range), `lineBuckets` and `aggregate`
  (first, highest, lowest and last of 16 rows, then of 4 buckets): 75 of 197 ms.
- A 1M prepend spends its engine time the same way: `lineBuckets` 23%, `copy` 20%,
  `rollingExtreme` 9%, `aggregate` 8% of 844 ms sampled.

## Partial redraw: adopt, for tick frames

The design leaves partial redraw out of the baseline and reconsiders it "only if Light invalidation
exceeds its budget" (section 6). It does in one place: the Light frame of a tick with 20 indicators
and all bars in view takes 4.1 ms (p99 4.7 ms) inside a 4 ms budget for the whole tick.

**What redrawing only the last bar saves.** A prototype draws 24 lines over 2,270 merged pixel
columns with lumen's own path loop (about 3 `lineTo` per column) and changes the last column of
every line each frame, as a tick does:

| Variant, 24 lines                                                  | JS per frame (mean / p95) | GPU process per frame |
| ------------------------------------------------------------------ | ------------------------- | --------------------- |
| Full redraw, as now                                                | 3.52 / 4.66               | 3.02                  |
| The same with bevel joins                                          | 3.34 / 4.05               | 3.17                  |
| The path loops alone (calls go to an object that only counts)      | 0.96 / 0.99               | 0.48 (an idle frame)  |
| Paths kept as `Path2D`, stroked again; only the last segment built | 0.06 / 0.12               | 2.87                  |
| **Partial: clip to the last 4 device columns, clear, redraw them** | **0.06 / 0.09**           | **0.54**              |
| Full redraw, 5 lines                                               | 0.69 / 0.71               | 1.17                  |
| Partial, 5 lines                                                   | 0.03 / 0.04               | 0.52                  |

- The prototype's full redraw matches the real frame (3.5 against 3.25 ms of series drawing), so
  its other rows carry over: **a tick's frame would drop from about 4.1 to about 0.5 ms** (what a
  tick frame costs without indicators is 0.35–0.47 ms: axes, overlay, model), and the GPU process
  from 5.2 to about 1 ms. The tick's p99 through the worker would no longer be a frame: it would
  be what the 200-bar view has, which garbage collection sets (see "Where a tick goes").
- Keeping the paths as `Path2D` objects saves the JavaScript just as well, but the GPU process
  still rasterizes every line, and two strokes meeting at the last column blend twice where a line
  is translucent. Partial redraw saves both and draws the same pixels.
- Join style is not the cost: bevel joins change nothing.

**Do the design's breakers apply?** They decide when a frame falls back to a full redraw, and a
probe counted how often that is (Light frames whose geometry and price scale versions are those of
the frame before, over whole runs of the tick scenarios):

| Scenario                                       | Light frames | Could redraw the tail only | Price scale changed | Geometry changed | Window replaced |
| ---------------------------------------------- | ------------ | -------------------------- | ------------------- | ---------------- | --------------- |
| 20 indicators, 1M, all in view (the gate case) | 622          | 586 (94%)                  | 17                  | 3                | 15              |
| 20 indicators, 1M, latest 200                  | 632          | 608 (96%)                  | 4                   | 3                | 16              |
| 20 indicators, 100k, all in view               | 599          | 591 (99%)                  | 2                   | 2                | 3               |
| ticks, 1M candles, all in view                 | 110          | 105 (95%)                  | 0                   | 4                | 0               |
| 16 charts of 100k candles (set-up included)    | 2,678        | 2,160 (81%)                | 208                 | 294              | 0               |

- **Autoscale change**: applies, and is rare. A tick moved a price scale in 0–3% of the frames.
  Those frames are redrawn in full, as now; the chart already tells them apart (design [section 6.1](../design/stage-4-drawings.md#61-as-built-in-stage-4-drawings),
  "a tick that leaves both scales as they were").
- **An indicator drawn shifted into the future**: no built-in has an offset today. The dirty
  range would come from the items each view rebuilt (`SeriesView.update` already knows them: at
  most 2 elements per frame with all bars in view, 11 with 200), not from "the last bar", so a
  shifted output dirties the columns it is drawn in.
- **Line joins**: apply, and are handled by widening the clip: the columns redrawn start one join
  and half a line width before the first changed item, and the path is drawn from two items
  earlier, so the pixels inside the clip are those of a full redraw.
- **New breakers since the design was written**: a custom series renderer, a primitive of order
  `bottom`, and drawings merged into the series layer (the canvas budget) draw what the chart
  cannot bound. A chart with any of them keeps the full redraw.
- In the harness's `latest` view new bars arrive beyond the right edge (the view does not follow),
  so its count says little about a chart that follows the last bar: there, a new bar scrolls the
  view and is a full redraw, once per bar.

**Scope of the implementation** (a separate PR):

- In `Chart.frameWrite`, a Light frame takes the tail path when: the geometry, the pane size, the
  pixel ratio, every price scale's `version`, the time ticks and the session marks are those of the
  last frame drawn; the window source is the same (`version`), with a non-empty dirty range; and
  the series layer holds no custom renderer, `bottom` primitive or merged drawings.
- `SeriesView.update` reports the item range it rebuilt. The union over the series, in device
  pixels, widened by the widest line (or candle body) and one join, is the clip.
- Inside the clip: background, session shading, grid and watermark as now (they are a few calls),
  then each series from two items before its first changed one (`drawLine`, `drawCandles`,
  `drawHistogram` gain a `from` item). Axes and overlay are drawn as now.
- Expected gain: tick frames with indicators 4.1 → about 0.5 ms of JavaScript and 5.2 → about 1 ms
  in the GPU process; tick to applied p99 through the worker with all bars in view from 3.9–4.5 ms
  (5.0 here) to that of the 200-bar view, 3.0–3.3 ms (3.7 here), which is under the 4 ms gate but
  not far under: the rest of that p99 is garbage collection, which this change does not touch.
  Frames that pan or zoom do not change.
- Risks: pixels that differ from a full redraw at the clip edge (antialiasing of a line that ends
  there, a dashed line's phase, a translucent color drawn twice). The PR needs a test that compares
  the canvas after N tail redraws with a full redraw of the same state, for solid, dashed, step and
  translucent lines, candles with borders and histograms, on normal, inverted and logarithmic
  scales; and the gate case measured again.

## Cheaper wide-view frames: adopt the min/max change

The design names "cheaper wide-view frames" next to partial redraw (section 10), and its second
principle puts algorithms before low-level work. The profile and the WASM comparison found one
such change: every loop that takes a running minimum and maximum does it with a comparison
(`if (v > max) max = v`, or the same as a conditional expression), which V8 compiles to a branch
that real prices mispredict often.
`Math.max` and `Math.min` compile to one instruction each without a branch. They return NaN for a
NaN operand, where the loops skip missing values, so the value is tested first (a branch that is
almost never taken).

| Loop (ns per row; comparisons as now → `Math.max`/`Math.min`)   | Raw prices         | SMA 20             | EMA 100            | Bollinger upper    | MACD histogram     | RSI 14             | Stochastic %K      |
| --------------------------------------------------------------- | ------------------ | ------------------ | ------------------ | ------------------ | ------------------ | ------------------ | ------------------ |
| `lineBuckets`: first, highest, lowest, last of 16 rows, 1M rows | 4.64 → 1.18, 3.9 × | 2.30 → 1.18, 1.9 × | 1.87 → 1.18, 1.6 × | 3.60 → 1.29, 2.8 × | 4.03 → 1.18, 3.4 × | 5.69 → 1.18, 4.8 × | 4.33 → 1.17, 3.7 × |
| `SeriesView.update`: 20,000 rows into 2,270 pixel columns       | 5.69 → 1.57, 3.6 × | 2.75 → 1.57, 1.8 × | 2.33 → 1.57, 1.5 × | 3.84 → 1.57, 2.4 × | 4.42 → 1.57, 2.8 × | 5.75 → 1.57, 3.7 × | 5.58 → 1.57, 3.6 × |

| Loop on raw prices, 1M rows (ns per row)              | Comparisons (now) | `Math.max` / `Math.min` | Gain  | WASM                | WASM SIMD |
| ----------------------------------------------------- | ----------------- | ----------------------- | ----- | ------------------- | --------- |
| Minimum and maximum of 16 rows, nothing else          | 5.75              | 0.87                    | 6.6 × | 0.73                | 0.26      |
| Rolling highest of 20 (the loops of `rollingExtreme`) | 10.75             | 5.69                    | 1.9 × | 1.82 (whole kernel) | –         |

Every variant gave the same bits as the comparisons on this data.

- **The gain depends on the series.** A comparison costs little where its branch is predictable: a
  smooth average rises or falls for many rows in a row (1.5–1.9 times), raw prices and oscillators
  do not (2.8–4.8 times). The branch-free loops take the same time on every series. Of the 25
  outputs of the indicator set, 18 are smooth.
- **Frames**: `SeriesView.update` is 41% of a pan frame with 20 indicators at 20,000 bars in view
  (2.1 of 5.0 ms) and 20% with all bars in view (0.8 of 4.0 ms). At about twice the speed on this
  mix of series, those frames would take about 4 and 3.6 ms.
- **Load and prepend**: `lineBuckets` and `aggregate` are 23% of the engine's time in a load
  (46 of 197 ms sampled) and 31% in a 1M prepend; `rollingExtreme` another 15% and 9%. At about
  twice the speed, a load's engine time would drop by about a fifth.
- **Scope** (a separate PR): the min/max loops of `SeriesView.update` (both branches) and its
  range loop, `lineBuckets`, `aggregate` (fused, MAX and MIN), `rollingExtreme`, and
  `Chart._includeSeries` where it applies; nothing else changes.
- **Risk**: the bits of a zero. `Math.max(-0, 0)` is `+0` whatever the order, while a comparison
  keeps the first of the two. A bucket or a column that holds both zeros can get the other zero
  than today. Both are correct extremes, but the engine's guarantees are bit for bit (incremental
  against full computation, design [section 5.1](../design/stage-3-indicators.md)), so the PR has to use one rule in every place a
  value can be computed two ways, and its tests need rows with both zeros.

## WASM kernels: reject for now

The design adopts WASM for a kernel when the kernel takes a meaningful share of frame or load time,
an equivalence test passes, and a JavaScript fallback exists (section 5). The share is there for
loads (56% of the engine's time), not for ticks (2%) and not for frames (no kernel runs in one).
So the kernels were ported and timed:

| Kernel, 1M rows (ns per row, median of 9 alternating passes) | JavaScript | WASM             | WASM is faster by | Different values |
| ------------------------------------------------------------ | ---------- | ---------------- | ----------------- | ---------------- |
| SMA 20                                                       | 3.22       | 3.40             | 0.95 ×            | 0                |
| EMA 12                                                       | 6.48       | 6.12             | 1.06 ×            | 0                |
| WMA 20                                                       | 3.50       | 3.43             | 1.02 ×            | 0                |
| RSI 14                                                       | 10.63      | 9.78             | 1.09 ×            | 0                |
| MACD 12/26/9                                                 | 8.00       | 7.19             | 1.11 ×            | 0                |
| Bollinger 20/2                                               | 5.46       | 4.41             | 1.24 ×            | 0                |
| Highest 20                                                   | 18.36      | 1.82             | 10.1 ×            | 0                |
| Stochastic 14/1/3                                            | 46.12      | 11.91            | 3.9 ×             | 0                |
| Buckets of 16 (minimum, maximum, first, last)                | 5.35       | 0.72 (SIMD 0.27) | 7.4 × (SIMD 20 ×) | 0                |

- **The design's claim holds**: recursive kernels run at 0.95–1.24 times JavaScript (the design
  measured 0.97–1.5). Every output matched bit for bit, NaN included, over 1M rows.
- **The two kernels that gain are the min/max loops again**: rolling extremes, and Stochastic,
  which is two rolling extremes and two short sums. LLVM compiles the comparisons without branches;
  V8 does not. The JavaScript change above gets the buckets to the speed of scalar WASM (0.87
  against 0.73 ns per row) and the rolling extremes halfway (5.7 against 1.8), without a second
  implementation of every kernel, a build step, a loader and a CSP fallback.
- **What would be left for WASM** after that change: rolling extremes at 1.8 against about 5.7 ns
  per row (4 passes of 1M rows in the indicator set: about 15 ms) and SIMD buckets at about 0.3
  against 1.2 ns per row (25 outputs: about 20 ms): under a tenth of a load that settles in
  0.37–0.47 s, in the background, with the bars on screen since the first frame, and that has no
  budget to meet (the one budget on a recomputation, 1 s after a 1M prepend, is met at 0.5–0.8 s).
  Not a share that carries a second implementation.
- The prototype was 62 KB because it links Rust's standard library; the design measured 5.1 KB
  for 11 kernels on a plain C ABI. Size did not decide this.
- **Reconsider** when a kernel that V8 compiles badly cannot be fixed in JavaScript, or when loads
  get a gate that the JavaScript kernels miss.

## `OffscreenCanvas`: defer

Rendering in a worker takes the drawing off the main thread. How much is there to take, and what
would it buy?

| 24 lines, full redraw every frame                          | Where it draws | JS per frame (mean / p95) | Main thread busy per frame | Frames in the run, mean interval |
| ---------------------------------------------------------- | -------------- | ------------------------- | -------------------------- | -------------------------------- |
| Main thread                                                | main           | 3.52 / 4.66               | 4.04                       | 120, 16.67                       |
| `OffscreenCanvas` in a worker                              | worker         | 3.40 / 4.53               | 0.27                       | 120, 16.67                       |
| Host page blocks the main thread 100 ms of every 110, main | main           | 3.54 / 4.80               | 45.2                       | 44, 46.9                         |
| The same host, `OffscreenCanvas` in a worker               | worker         | 3.89 / 6.36               | 19.4                       | 120, 16.67                       |

- **Drawing costs the same in a worker.** It moves 0.3–5 ms per frame off the main thread: the
  whole frame of the table "Where a frame goes". No measured case misses a frame budget because
  of it: frame JavaScript p95 is 0.3–6.7 ms against 8 ms, and after the two changes adopted above
  the largest frames are about 4 ms and tick frames about 0.5 ms.
- **What it buys is independence from the host page.** With the main thread blocked 91% of the
  time, the worker still presents 60 frames a second where the main thread presents 21. That
  helps a chart that only displays (ticks keep flowing). It does not help input: pointer and wheel
  events are delivered on the main thread, so the crosshair, a pan and a drag wait for the host
  either way, and take one more hop to reach the worker.
- **What it costs**: the model, the views, the window cache and the renderers would have to live
  in the worker with the canvases, with input, sizes, the pixel ratio, the color scheme and fonts
  bridged to it, and every public call that returns a value (coordinates, hit tests, `saveState`)
  answered across threads or from a copy. Custom renderers and primitives are functions of the
  page and could not draw there. And the main-thread path stays: principle 4 forbids requiring
  workers, and `OffscreenCanvas` with a 2D context in a worker needs Chrome 69, Firefox 105 or
  Safari 16.4.
- The design's portable renderer (a renderer receives only a context and coordinate buffers) keeps
  this open. **Reconsider** when a display-only use under a busy host page is a requirement, or
  when frames exceed their budget after the changes above.
- Not measured: input latency (the harness dispatches synthetic pointer events inside the frame
  callback), and headed frame intervals.

## GPU layer: defer until its series exist

The GPU layer is a feature module for heatmaps and tick scatter plots (design section 6), not a
faster way to draw what exists. Neither series type exists. The question measured is at what scale
Canvas 2D stops being enough for them, on a 2,400 × 1,200 device-pixel pane, every frame drawing
changed data (the scatter scrolls, the heatmap gains a column):

| Tick scatter, 3 × 3 pixel marks in two colors (JS / GPU process, ms per frame) | 10,000 points | 100,000 points  | 1,000,000 points |
| ------------------------------------------------------------------------------ | ------------- | --------------- | ---------------- |
| Canvas 2D, `fillRect` per point                                                | 0.77 / 2.55   | **17.8 / 19.4** | 285 / 212        |
| Canvas 2D, one path of rectangles per color                                    | 0.53 / 1.19   | 5.51 / 6.89     | 62.3 / 0.84      |
| Canvas 2D, points written into a pixel buffer, one `putImageData`              | 0.81 / 1.49   | 1.27 / 1.55     | 5.84 / 1.85      |
| WebGL2 points, buffer kept, a uniform moves them                               | 0.02 / 0.47   | 0.02 / 0.52     | 0.02 / 0.57      |
| WebGL2 points, buffer uploaded every frame                                     | 0.03 / 0.52   | 0.08 / 0.66     | 1.99 / 1.71      |

| Heatmap (JS / GPU process, ms per frame)                                | 240 × 60 = 14,400 cells | 1,200 × 200 = 240,000 | 2,400 × 600 = 1,440,000 |
| ----------------------------------------------------------------------- | ----------------------- | --------------------- | ----------------------- |
| Canvas 2D, a fill style and a `fillRect` per cell                       | 4.33 / 6.60             | **73.3 / 60.0**       | 722 / 348               |
| Canvas 2D, 16 colors, runs of a color as one rectangle                  | 0.96 / 3.20             | 48.9 / 49.7           | 468 / 280               |
| Canvas 2D, cells as the pixels of a small image, one scaled `drawImage` | 0.06 / 0.75             | 0.37 / 0.81           | 3.00 / 1.76             |
| WebGL2, cells as a texture, colors looked up in the shader              | 0.03 / 0.68             | 0.04 / 0.70           | 0.15 / 1.08             |

- **Drawn the direct way, Canvas 2D breaks early**: a scatter at 100,000 points (17.8 ms of
  JavaScript and as much in the GPU process), a heatmap between 14,400 and 240,000 cells.
- **Drawn through a pixel buffer, Canvas 2D holds to the size of the pane**: 1M points in 5.8 ms
  and 1.44M cells in 3.0 ms, inside the 8 ms frame budget, with no WebGL context, no shader and no
  fallback. This is the algorithm-first form of both series, and what they should be built on.
- **WebGL2 is 20 to 300 times cheaper in JavaScript** and is needed where the pixel buffer stops:
  more than about a million marks or cells changing every frame (a heatmap never needs more cells
  than the pane has pixels, 2.9M here; beyond that it is aggregated first), marks that blend
  (translucent or antialiased circles, which a pixel buffer cannot composite cheaply), or several
  such panes on one page.
- **Decision**: no GPU module now. When heatmap and scatter series are built, they start on the
  pixel-buffer path as custom series renderers (the stage 4 interface), with a scenario in the
  harness; the GPU layer follows if a scale above is a requirement. One WebGL2 context per page
  stays the plan (design section 1.2).
- Not measured: WebGL on a device without a GPU, context loss, and the cost of compositing a WebGL
  canvas between the chart's 2D layers in a headed browser.

## What changed in the repository

- `pnpm bench --profile <dir>` traces every run and writes `<dir>/<run>.trace.json`, a breakdown
  per run and `summary.json`; `pnpm bench:profile <dir>` summarizes the traces of a directory
  again. The harness page marks the measured part of each scenario (`performance.mark`, outside
  the timed calls).
- `benchmarks/src/profile.ts` turns a trace into the breakdown (samples by category, frames, busy
  time per thread, garbage collection), with `benchmarks/test/profile.test.ts`.
- No published package changed.

## Limits

- **One busy desktop machine.** Load average 10–44 during the runs; every absolute time is an
  upper bound for this M1, and tails are noisy (zoom-all p95 5.1–8.3 ms between two runs). The
  decisions rest on shares and on ratios between variants run back to back, which were stable.
- **Samples are incomplete.** They cover about 70% of frame time, and Canvas 2D calls are not
  separable from their callers except through the prototype.
- **Headless.** Frame intervals do not show rasterization or presentation stalls. The GPU
  process's time per frame (1–5 ms) is reported, but whether it ever costs a frame on screen was
  not measured; a headed run on an idle machine would tell.
- **Prototypes are synthetic**: one pane, opaque colors, random-walk data. They bound what an
  implementation can gain; the implementation PRs measure what it does gain, on the gate cases.
- Not measured: the mid-range Android reference device, x86, Firefox and Safari (the same gaps as
  earlier stages); input latency; whose garbage the collections during tick to applied are (the
  library's patch objects or the harness's pause loop), which decides what the tick p99 can reach
  after partial redraw.

## Reproducing

```sh
CASES=ind-apply/candles-1m,ind-frames/candles-1m/pan-all,ind-frames/candles-1m/zoom-all,ind-frames/candles-1m/pan-20k,ind-frames/candles-1m/pan-2k,frames/candles-1m/pan-all,frames/candles-1m/pan-2k,frames/line-10m/pan-all,ind-load/candles-1m,tick/candles-1m/all,drawings/candles-1m/1000/hover,drawings/candles-1m/1000/pan,multi/candles-100k/16-charts,ind-prepend/candles-1m/1m
pnpm bench --case $CASES --lib lumen-worker,lumen-main --repeats 1 --budget 3 --timeout 240 \
  --profile benchmarks/results/stage-5-traces --out benchmarks/results/stage-5-profile-traced.json
pnpm bench --case $CASES --lib lumen-worker,lumen-main --repeats 2 --budget 3 --timeout 240 \
  --out benchmarks/results/stage-5-profile-timings.json
# The breakdowns again from the traces (needs the unminified build the traces were made with):
LUMEN_BENCH_PROFILE=1 pnpm --filter @lumen-charts/benchmarks build
pnpm bench:profile benchmarks/results/stage-5-traces
```

A trace opens in Chrome's Performance panel or in Perfetto. The traces of this document (12–270 MB
each) are not in the repository.
