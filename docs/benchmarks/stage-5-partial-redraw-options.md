# Stage 5: partial redraw, an option to turn it off and dashed lines from the columns

The [partial redraw of tick frames](stage-5-partial-redraw.md) left two limits that this change
closes ([design](../design/stage-5.md#62-partial-redraw-an-option-to-turn-it-off-and-dashed-lines-from-the-columns)):
a page could not turn partial frames off where its canvases are rasterized in software, and a
dashed or dotted line cost its whole path in every tick.

| Question                                                             | Answer                                                                                                                                                                                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does `redraw: 'full'` give the pixels of a full redraw everywhere?   | Yes: every frame is a full redraw, and 2,430 comparisons on each rasterizer find no difference. Without it the software rasterizer differs in 1,075 of 2,430, as before.                                                        |
| Are dashed lines drawn from the columns still pixel for pixel equal? | Yes on the GPU: 2,430 comparisons over 2,284 partial frames at pixel ratios 1, 1.5 and 2, no pixel different; 405 of them on a chart of dashed and dotted lines alone.                                                          |
| What does a tick's frame cost with dashed lines?                     | With five dashed lines over 1M points in view: 0.26 ms of JavaScript instead of 1.39 ms, 215 `lineTo` calls instead of 44,050, and 3.6 ms instead of 7.7 ms in the GPU process. With 200 bars in view: 15 calls instead of 995. |
| Does anything else change?                                           | No. The gate case (20 indicators, all 1M bars in view, no dashed line) and frames of solid lines and candles are within the spread of the rounds.                                                                               |

## Conditions

Headless Chromium 156.0.8078.4 (new headless mode, GPU rasterization through ANGLE Metal) on an
Apple M1 (8 cores, 16 GiB) on AC power, viewport 1280 × 720, DPR 2, chart 1200 × 600; the pixel
check runs charts of 640 × 360 at pixel ratios 1, 1.5 and 2.

**The machine was loaded by other work** (an iOS simulator, and benchmarks of other worktrees,
which took turns with these through a machine-wide lock): the one-minute load average was 15–18
during the pixel check, 21–44 during the first three invocations and the last six, and 60–369 in
between. So the two versions were measured alternately, one invocation each per round; tables give
the median of the rounds with their range, means and counts of work rather than tails, and the load
is given where it explains a difference.

| File                                                                                               | What                                                                                        | Rounds | Load average (1 min) while it ran |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------ | --------------------------------- |
| [stage-5-partial-redraw-options-before.json](stage-5-partial-redraw-options-before.json)           | the eight cases below, `main` (`16b70c2`); the candles case three rounds more               | 3 (6)  | 26–23, 21–44, 206–352; 23–27      |
| [stage-5-partial-redraw-options-after.json](stage-5-partial-redraw-options-after.json)             | the same, this change                                                                       | 3 (6)  | 24–21, 60–155, 369–333; 21–26     |
| [stage-5-partial-redraw-options-breakdown.json](stage-5-partial-redraw-options-breakdown.json)     | traced runs of two cases, before and after, and one of solid lines (`pnpm bench --profile`) | 2      | 190–306; 23 for the last          |
| [stage-5-partial-redraw-options-pixels.json](stage-5-partial-redraw-options-pixels.json)           | the pixel check (`pnpm bench:pixels --raster gpu,cpu`)                                      | 1      | 18–16                             |
| [stage-5-partial-redraw-options-pixels-full.json](stage-5-partial-redraw-options-pixels-full.json) | the same with the option (`--redraw full`)                                                  | 1      | 16–15                             |

- "Before" is the `packages` directory of `16b70c2` measured with this branch's harness
  (`pnpm bench --packages`); "after" is the workspace. The results files record that commit with
  uncommitted changes: the change was measured before it was committed.
- One adapter was measured, `lumen-worker` (data engine in a worker): the change is in drawing,
  which is the same with the engine on the main thread. Times are in ms.

## The option

`redraw: 'full'` makes a frame asked for by data alone draw the whole series layer. The pixel check
(`pnpm bench:pixels`, described in the [first round](stage-5-partial-redraw.md#pixels)) runs every
case with and without it, on both rasterizers of Chromium:

| Rasterizer (Chromium 156)      | `redraw` | Cases | Partial frames | Full  | Layer kept | Comparisons | Different                                             |
| ------------------------------ | -------- | ----- | -------------- | ----- | ---------- | ----------- | ----------------------------------------------------- |
| GPU (the default for a canvas) | `auto`   | 108   | 2,284          | 1,344 | 692        | 2,430       | **0**                                                 |
| Software (`--raster cpu`)      | `auto`   | 108   | 2,284          | 1,344 | 692        | 2,430       | 1,075 (candles: 0 of 405; with lines: 1,075 of 2,025) |
| GPU                            | `full`   | 108   | 0              | 4,320 | 0          | 2,430       | **0**                                                 |
| Software (`--raster cpu`)      | `full`   | 108   | 0              | 4,320 | 0          | 2,430       | **0**                                                 |

- **With the option no frame is partial and no comparison differs**, on either rasterizer. With
  `--redraw full` the check fails on a partial frame and on any difference, also in software.
- **Without it the software rasterizer differs as it did**: 791 of the 1,620 comparisons of the four
  setups with lines that the first round had, the same number as then, plus 284 of the 405 of the
  new setup of dashed lines. Differing comparisons have 72 pixels different on average, by up to
  46 levels of 255 in four setups and up to 139 in `lines`, the one with lines of every style.
- A frame that would leave the layer alone (nothing in view changed) is drawn in full with the
  option too: 692 such frames in the first row are among the 4,320 of the third.
- **The rasterizer is not detected.** Two ways were looked at and neither tells how the chart's
  canvases are rasterized: the WebGL renderer string describes WebGL, and costs a context; a probe
  has to read a canvas back, which is what moves a canvas to the software rasterizer in Chromium
  (the pixel check itself copies every canvas to another one before reading, for that reason).

## Dashed lines

### Why a dash offset is not enough

Dashes are counted along a subpath from its start. The first version of this change drew a dashed
line from the items at the dirty columns with `lineDashOffset` set to the length of the path before
them, and failed the pixel check: 180 of 405 comparisons of the new setup differed, by up to 152
levels. Two probes outside the repository (a page with two canvases in headless Chromium, the second
drawing the path from a later point through the same clip) show why and what works:

| Path drawn from a later point, compared inside the clip       | Paths that differ | Pixels  |
| ------------------------------------------------------------- | ----------------- | ------- |
| the whole path again (the control)                            | 0 of 64           | 0       |
| dash offset: the length before the point, in single precision | 51 of 64          | 99,268  |
| dash offset: the same length in double precision              | 53 of 64          | 86,655  |
| a level lead of that length before the point, no offset       | 0 of 64           | 0       |
| lead, 384 other paths: lengths summed as Skia sums them       | 0 of 384          | 0       |
| lead, lengths with the squares added before rounding          | 2 of 384          | 2       |
| lead, exact lengths (double precision)                        | 294 of 384        | 952,825 |

- The 64 paths are four polylines (200 and 1,200 smooth points, 1,200 columns of four points with
  small and with large swings; 4,400 to 533,000 pixels long) with four dash patterns and widths,
  each drawn from four points; the 384 are six kinds of random polylines (300 to 3,000 points,
  1,800 to 505,000 pixels long), four of each, with four patterns from four points.
- **Skia places a dash by the sum of the segment lengths before it, in single precision.** A path
  that starts later sums from zero and rounds otherwise, so its dashes are thousandths of a pixel
  off; at a path length of 160,000 pixels the single-precision sum is up to 0.09 pixels from the
  exact one, at 500,000 up to 0.67. That is enough to flip antialiasing samples at dash ends:
  differences are a quarter of the line's color in a pixel, or a multiple of it.
- **A lead as long as the sum makes the rasterizer continue from the same sum.** The path starts
  left of its first point and level with it, so the lead's length is the difference of two x
  coordinates in single precision, which the chart computes exactly, and every later sum is the
  one of the whole path. The lengths have to be summed as Skia sums them (per segment, the two
  squares and their sum each rounded to single precision): a sum that differs in the last bit now
  and then is not enough (2 of 384), an exact one is far off (294 of 384).

### Pixels

The pixel check has a sixth setup, `dashes`: five dashed and dotted lines (three pixels wide and
translucent; dotted and stepped; with gaps, one of them opening and closing at the last bar; one
pixel wide with swings of 3% from bar to bar, whose path through merged columns is many times as
long as the pane is wide; four pixels wide, dotted and translucent), with ticks, new bars, moves
that change autoscale and corrections of older points, in the three views.

| Setup, GPU rasterization                    | Cases | Partial frames | Clips (device px) | Comparisons | Different |
| ------------------------------------------- | ----- | -------------- | ----------------- | ----------- | --------- |
| `dashes` (dashed and dotted lines alone)    | 18    | 496            | 7–495             | 405         | **0**     |
| `lines` (a dashed and a dotted line of six) | 18    | 352            | 7–557             | 405         | **0**     |
| the other four                              | 72    | 1,436          | 5–16              | 1,620       | **0**     |

Every pixel is equal, also where a correction of an older point makes the frame redraw two
fifths of the pane from a lead, and where a gap splits the range (the piece after a gap
starts its dashes at zero in both paths).

### What a tick's frame costs

The `line-ticks` scenario puts five line series of one style on a chart (1M points each; ticks
change the last bar of one of them), draws a frame per tick, and counts the canvas calls of 20
ticks in an untimed pass. Median of 3 rounds (range), about 180 ticks each:

| View, style (5 lines)   | Frame JS mean, `main` | Frame JS mean, this change | `lineTo` per tick, `main` | `lineTo` per tick, this change |
| ----------------------- | --------------------- | -------------------------- | ------------------------- | ------------------------------ |
| all 1M in view, solid   | 0.30 (0.23–0.31)      | 0.24 (0.23–0.26)           | 210                       | 210                            |
| **all in view, dashed** | **1.39 (1.37–1.40)**  | **0.26 (0.24–0.29)**       | **44,050**                | **215**                        |
| all in view, dotted     | 1.46 (1.42–1.51)      | 0.24 (0.24–0.24)           | 44,050                    | 215                            |
| latest 200, solid       | 0.22 (0.20–0.24)      | 0.25 (0.22–0.37)           | 10                        | 10                             |
| latest 200, dashed      | 0.26 (0.25–0.36)      | 0.25 (0.23–0.38)           | 995                       | 15                             |
| latest 200, dotted      | 0.27 (0.24–0.27)      | 0.25 (0.23–0.28)           | 995                       | 15                             |

- **A dashed line costs a tick what a solid one does**: its path in the frame is the lead and the
  segments at the columns (three calls a line with 200 bars in view, 43 with merged columns)
  instead of all of it (199 and 8,810 a line). With all bars in view the frame takes a fifth of
  the JavaScript it took, in every round; `stroke` is called five times a tick on both sides.
- With 200 bars in view the 980 calls saved are about 0.01 ms, less than the rounds differ.
- The solid rows are the noise of the measurement: nothing in their path changed, and they move
  by 0.03 ms one way and 0.06 ms the other.

From traced runs of the dashed case with all bars in view, 181 frames each (two per side, at a load
average of 190–306; the GPU process as the time its main thread was busy per frame):

| Five lines over 1M points, all in view | Frame JS mean | Series drawing, sampled, in 3 s | GPU process per frame |
| -------------------------------------- | ------------- | ------------------------------- | --------------------- |
| dashed, `main`                         | 1.71, 1.74    | 235, 243 ms                     | 8.1, 7.3              |
| dashed, this change                    | 0.37, 0.38    | 4.8, 6.4 ms                     | 3.6, 3.6              |
| solid, this change (one run)           | 0.36          | –                               | 1.0                   |
| dashed, this change (in that run)      | 0.35          | –                               | 3.4                   |

- **The GPU process does less than half of what it did** for such a frame, and still three times
  what it does for solid lines (1.0 ms): Skia dashes the lead, which is as long as the path was up
  to the columns, and the clip discards those dashes afterwards. That part is a limit of the
  approach (see Limits).
- Traced frames take longer than untraced ones (0.37 against 0.26 ms): tracing and sampling cost.

## The gate case, and candles

Nothing in these cases is dashed; they must not change. Median of the rounds (range):

| Case (1M candles, all in view)                       | Metric                  | `main`           | This change      |
| ---------------------------------------------------- | ----------------------- | ---------------- | ---------------- |
| 20 indicators, tick to applied (the stage 3 gate)    | mean                    | 0.51 (0.43–0.68) | 0.55 (0.46–0.67) |
| 20 indicators, tick to applied                       | p50                     | 0.28 (0.24–0.43) | 0.33 (0.26–0.47) |
| 20 indicators, tick to applied                       | p99                     | 3.71 (3.30–3.89) | 3.63 (3.12–5.05) |
| 20 indicators, frame JS of a tick (traced, two runs) | mean                    | 0.59, 0.66       | 0.58, 0.58       |
| 20 indicators, GPU process per frame (traced)        | mean                    | 1.19, 1.18       | 1.35, 1.27       |
| candles only, 100 ticks a frame                      | frame JS mean, 6 rounds | 0.15 (0.13–0.16) | 0.14 (0.14–0.27) |

- **The gate case is where it was**: means and medians of the two sides overlap in every round
  (round by round the mean was 0.51, 0.43, 0.68 on `main` and 0.46, 0.55, 0.67 with this change),
  and the traced frame of a tick takes 0.59 and 0.66 ms on `main` and 0.58 ms twice with this
  change, 177–180 frames each.
- The p99 is given because it is the gate's metric (4 ms): 3.3–3.9 ms on `main` and 3.1–5.1 ms
  with this change, the 5.05 in the round measured at a load average of 369. It is a tail under
  load and says nothing about the change.
- **Candles only** takes about 0.15 ms a frame on both sides. Round by round: 0.14, 0.13, 0.16,
  0.16, 0.16, 0.14 on `main` and 0.14, 0.27, 0.20, 0.15, 0.14, 0.14 with this change. The two high
  values are the invocations during which the load average rose from 60 to 155 and stood at
  333–369; the three rounds added afterwards at a steady load of 21–27 give 0.16 against 0.14.
  The change adds one comparison of an option per frame to this path.

## What changed in the repository

- `ChartOptions.redraw` (`'auto' | 'full'`, default `auto`); `PaneRenderer._dirtyColumns` answers
  "full" when it is `full`.
- `drawLine` starts a dashed path that begins at a later item with a lead (`dashLead`), from the
  lengths `lineLengths` keeps per item in the `SeriesView` (`pathLength`); the pane renderer no
  longer starts dashed lines at their first item.
- `pnpm bench:pixels`: the `dashes` setup and `--redraw full`. The `line-ticks` scenario, for
  adapters that can style line series (`lineStyle`).
- 10 tests were added (601 in all): the option at three pixel ratios; dashed lines over every range
  of items in four kinds of path (a lead of exactly the length of the path before it, or the whole
  line); the fallback where no lead has the exact length; the lengths kept and dropped by ticks,
  corrections and projections; the plan of the scenario. The model of the partial redraw tests
  sums the length of a dashed line in single precision, and fails with a lead a pixel off or none.

## Limits

- **Exact where it was measured**: Chromium 156 on an Apple M1, GPU rasterization. The lead relies
  on summing lengths as the browser's rasterizer does. A rasterizer that sums otherwise (another
  browser, another build of Skia) places the dashes of a partial frame thousandths of a pixel off,
  which can show as a few antialiased pixels at dash ends until the next full redraw;
  `redraw: 'full'` avoids it. Firefox and Safari are unmeasured, as in the first round.
- **The rasterizer still dashes the lead.** A dashed line costs the GPU process the dashes of its
  whole path up to the columns in every tick (3.4–3.6 ms a frame for five lines whose paths are
  many times the width of the pane, against 7.3–8.1 ms before and 1.0 ms for solid lines).
  Skipping them would need a dash offset, which is not exact.
- **A short piece of a dashed line after a gap** is sometimes drawn from the line's first item:
  where no x coordinate left of the piece is exactly as far away as the piece is long in single
  precision. Correct, at the earlier cost.
- **The columns of a dashed line still reach to the right edge** of the pane: a correction of an
  older point redraws the line from there on.
- **Software rasterization is not detected**: the page sets `redraw: 'full'`. With it every tick
  costs a full redraw (4.1 ms of JavaScript instead of 0.5 ms with 20 indicators and all 1M bars
  in view, as measured in the [first round](stage-5-partial-redraw.md)).
- **A new bar on a chart that follows the last bar** is still a full redraw. Shifting the layer by
  a bar is exact only for bars a whole number of device pixels wide, and the layer holds what does
  not move with the bars (see the design).
- One machine and one browser; three rounds, one of them and half of another under heavy load.
  Traced numbers come from two runs per side.

## Reproducing

```sh
CASES=line-ticks/line-1m,ind-apply/candles-1m/all,tick/candles-1m/all
# "Before": the packages of main in a directory of their own, measured with this harness.
mkdir -p benchmarks/results/baseline && git archive 16b70c2 packages | tar -x -C benchmarks/results/baseline
# Alternately, one round each; then join the rounds of a side.
pnpm bench --case $CASES --lib lumen-worker --repeats 1 --budget 3 --timeout 120 \
  --packages benchmarks/results/baseline/packages --out benchmarks/results/before-1.json
pnpm bench --case $CASES --lib lumen-worker --repeats 1 --budget 3 --timeout 120 \
  --out benchmarks/results/after-1.json
pnpm bench:merge benchmarks/results/before.json benchmarks/results/before-*.json
# The frame of a tick and the GPU process, from a trace:
pnpm bench --case ind-apply/candles-1m/all,line-ticks/line-1m/all/dashed --lib lumen-worker --repeats 1 --budget 3 \
  --profile benchmarks/results/traces --out benchmarks/results/traced.json
# Pixels: partial frames on both rasterizers (software is reported without failing), then with the option.
pnpm bench:pixels --raster gpu,cpu --out benchmarks/results/pixels.json
pnpm bench:pixels --raster gpu,cpu --redraw full --out benchmarks/results/pixels-full.json
```
