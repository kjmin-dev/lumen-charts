# Stage 5: partial redraw of tick frames

The [stage 5 profile](stage-5-profile.md) adopted two steps. This is the second: a frame drawn for
a tick redraws only the device columns the tick changed ([design](../design.md), [section 6.2](../design/stage-5.md#62-stage-5-as-decided-and-as-built)). The
first, the [min/max loops](stage-5-min-max.md), is in `main` and on both sides of every comparison
here.

| Question                                                                  | Answer                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| What does a tick's frame cost with 20 indicators and all 1M bars in view? | 0.50 ms of JavaScript instead of 4.13 ms (p50 0.33 instead of 4.09), and 1.0 ms instead of 4.3 ms in the GPU process.                                                                                                                                                    |
| Tick to applied through the worker in that view (the stage 3 gate, 4 ms)? | p99 4.02 ms (2.48–4.79 over 7 rounds) instead of 6.12 ms (4.69–9.25), on a machine under heavy load from other work. Lower in every round; under 4 ms in 3 of the 7. Not shown to hold the gate: see Limits.                                                             |
| Are the pixels those of a full redraw?                                    | Yes where Chromium rasterizes the canvas on the GPU, its default: 2,025 comparisons over 1,788 partial frames at pixel ratios 1, 1.5 and 2, no pixel different. Not for antialiased lines on its software rasterizer, where two full redraws already differ: see Pixels. |
| Do frames that pan or zoom change?                                        | No: within the noise of the runs (p50 3.56 → 3.65 ms panning and 4.09 → 3.99 ms zooming with 20 indicators and all bars in view).                                                                                                                                        |

## Conditions

Headless Chromium 156.0.8078.4 (new headless mode, GPU rasterization through ANGLE Metal) on an
Apple M1 (8 cores, 16 GiB) on AC power, viewport 1280 × 720, DPR 2, chart 1200 × 600.

**The machine was heavily loaded by other work** during every run: the one-minute load average was
between 46 and 281 (an iOS simulator was starting and running beside the benchmarks; in the stage 5
profile it was 10–44, and that document already called the machine busy). Absolute times, and
tails most of all, are worse than on a quiet machine and vary from round to round. So the two
versions were measured alternately, one invocation each per round, and tables give the median of
the rounds with their range. Benchmarks of the two worktrees in use took turns through a
machine-wide lock.

| File                                                                               | What                                                                     | Rounds | Load average (1 min) while it ran |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------ | --------------------------------- |
| [stage-5-partial-redraw-before.json](stage-5-partial-redraw-before.json)           | the ten cases below, `main` (`99d02d3`)                                  | 3      | 54–219                            |
| [stage-5-partial-redraw-after.json](stage-5-partial-redraw-after.json)             | the same, this change                                                    | 3      | 83–244                            |
| [stage-5-partial-redraw-gate-before.json](stage-5-partial-redraw-gate-before.json) | tick to applied and wide-view frames with 20 indicators again, `main`    | 4      | 166–273                           |
| [stage-5-partial-redraw-gate-after.json](stage-5-partial-redraw-gate-after.json)   | the same, this change                                                    | 4      | 46–281                            |
| [stage-5-partial-redraw-breakdown.json](stage-5-partial-redraw-breakdown.json)     | traced runs of two tick cases, before and after (`pnpm bench --profile`) | 1      | 178–240                           |
| [stage-5-partial-redraw-pixels.json](stage-5-partial-redraw-pixels.json)           | the pixel check (`pnpm bench:pixels --raster gpu,cpu`)                   | 1      | 41–329                            |

- "Before" is the `packages` directory of `99d02d3` measured with this branch's harness
  (`pnpm bench --packages`); "after" is the workspace. The results files record the commit of the
  branch at the time (`0ee7921`, before it was amended with these documents); the library sources
  are those of this change. One invocation records uncommitted changes: a scratch file of the
  software rasterizer probe below lay in `benchmarks/runner` meanwhile.
- Both adapters were measured: `lumen-worker` (data engine in a worker) and `lumen-main`
  (time-sliced on the main thread). Times are in ms.

## What a tick's frame costs

From the traced runs (one each; frame JavaScript from the trace's animation frames, the GPU
process as the time its main thread was busy per frame, shares from CPU samples as in the profile):

| Ticks through the worker, all 1M bars in view        | Frame JS mean | p50  | p95  | p99  | max  | Series drawing, sampled, in 3 s | Items and coordinates | GPU process per frame |
| ---------------------------------------------------- | ------------- | ---- | ---- | ---- | ---- | ------------------------------- | --------------------- | --------------------- |
| 20 indicators (the gate case), `main`                | 4.13          | 4.09 | 4.43 | 4.74 | 5.09 | 457 ms                          | 45 ms                 | 4.34                  |
| 20 indicators, this change                           | 0.50          | 0.33 | 0.49 | 4.52 | 4.64 | 33 ms                           | 15 ms                 | 1.03                  |
| candles only (`tick`, a frame per 100 ticks), `main` | 0.48          | 0.47 | 0.57 | 0.62 | 0.80 | 18 ms in 1.7 s                  | 2.2 ms                | 1.49                  |
| candles only, this change                            | 0.24          | 0.23 | 0.33 | 0.37 | 0.38 | 0.4 ms                          | 0.8 ms                | 0.81                  |

- **The frame is an eighth of what it was**, and what the profile's prototype predicted (about
  0.5 ms of JavaScript and 1 ms in the GPU process). Of 180 frames in the gate case, two or three
  were still drawn in full (the p99 and the maximum, 4.5–4.6 ms): frames in which a tick moved a
  price scale or added a pixel column.
- **New bars are partial frames too.** In this view a bar joins the last bucket of the level
  drawn, so the items stay; but the time ticks are computed again for it, and the first version of
  this change took that for a change of the grid: with a new bar in most frames of the scenario
  (one per 10 ticks, about 8 ticks a frame), most frames fell back, and the frame mean was 3.2 ms.
  The frame now compares where the vertical grid lines and session marks are, not whether they
  were computed again.
- **Coordinates are projected for the changed items only** (`SeriesView.project`): items and
  coordinates take 15 instead of 45 ms of the 3 s.
- What a partial frame still does: 25 view updates (the price range of each series over all its
  items), the price axes' value labels and the overlay, the time axis on a new bar (0.12 ms a
  frame for grid, axes and labels together), then about 25 `lineTo` per line inside the clip.
- Without indicators the frame halves as well, and frames of the `multi` scenario (16 charts of
  100k candles, a round of ticks) take 0.22 instead of 0.28 ms at p50.

## Tick to applied (the stage 3 gate)

20 indicators on 1M candles, 2,000 ticks in 3 s, each timed from the call until its patch is
applied on the main thread. Median of 7 rounds (range):

| View, adapter            | Metric  | `main`               | This change          |
| ------------------------ | ------- | -------------------- | -------------------- |
| all in view, worker      | p50     | 0.43 (0.25–0.59)     | 0.28 (0.21–0.45)     |
| all in view, worker      | p95     | 1.83 (0.63–5.06)     | 0.81 (0.45–1.12)     |
| **all in view, worker**  | **p99** | **6.12 (4.69–9.25)** | **4.02 (2.48–4.79)** |
| all in view, worker      | mean    | 0.85 (0.51–1.17)     | 0.49 (0.40–0.67)     |
| all in view, worker      | max     | 31 (22–50)           | 24 (22–67)           |
| latest 200, worker       | p99     | 3.13 (2.79–3.46)     | 2.83 (2.66–3.36)     |
| all in view, main thread | p99     | 0.68 (0.32–3.44)     | 0.47 (0.23–0.70)     |
| latest 200, main thread  | p99     | 0.65 (0.55–0.72)     | 0.46 (0.22–0.63)     |

The p99 of the gate case, round by round (ms):

| Round       | 1    | 2    | 3    | 4    | 5    | 6    | 7    |
| ----------- | ---- | ---- | ---- | ---- | ---- | ---- | ---- |
| `main`      | 5.20 | 7.35 | 5.24 | 6.38 | 6.12 | 9.25 | 4.69 |
| This change | 4.34 | 3.53 | 4.02 | 3.93 | 2.48 | 4.79 | 4.20 |

- **The frame is out of the p99.** A reply no longer waits behind a 4 ms frame: the wide view's
  p99 comes down by a third and its p95 by more than half, in every round.
- **Whether the gate holds is not settled by these runs.** The median is 4.02 ms against 4 ms,
  with three rounds under it, at a load average of 46–281. `main` measured 3.9–4.5 ms for this case
  on a quieter machine ([stage 3](stage-3.md)), 5.0 ms in the profile, and 4.7–9.3 ms here: the
  load alone costs it 1–5 ms. The view of 200 bars, which never had a long frame, measures
  2.8 ms here, and the wide view stays 1.2 ms above it: full frames still happen (2–3 in 180), and
  under this load a reply also waits for the main thread itself. The profile expected the wide
  view to come down to the narrow one's p99 (3.0–3.3 ms on a quiet machine); a run on a quiet
  machine has to show whether it does.
- What remains in both views is what the profile found: garbage collection on the main thread
  (89–131 ms of it in 3 s of the traced runs), which this change does not touch.

## Frames that pan or zoom

A pan or zoom moves the view, which is a full redraw as before. Their cost must not change.
JavaScript per frame, median of the rounds (range); 7 rounds for the first two rows, 3 for the
rest:

| Case (1M candles)                       | Metric    | `main`, worker   | This change, worker | `main`, main thread | This change, main thread |
| --------------------------------------- | --------- | ---------------- | ------------------- | ------------------- | ------------------------ |
| 20 indicators, pan all                  | p50       | 3.56 (3.43–4.16) | 3.65 (3.54–4.10)    | 3.56 (3.36–3.77)    | 3.66 (3.43–3.97)         |
| 20 indicators, pan all                  | p95       | 4.98 (4.48–7.74) | 5.06 (4.72–7.56)    | 4.79 (4.55–5.03)    | 4.88 (4.59–5.18)         |
| 20 indicators, zoom all                 | p50       | 4.09 (3.92–4.30) | 3.99 (3.81–4.74)    | 4.26 (4.15–4.31)    | 3.95 (3.77–4.52)         |
| 20 indicators, zoom all                 | p95       | 5.07 (4.75–5.64) | 6.36 (5.26–11.1)    | 5.18 (4.67–5.71)    | 5.18 (4.76–7.85)         |
| 20 indicators, pan 2,000                | p50       | 1.55 (1.50–1.59) | 1.51 (1.41–1.53)    | 1.48 (1.48–1.52)    | 1.51 (1.46–1.52)         |
| 20 indicators, pan 2,000                | p95       | 2.00 (1.78–3.33) | 2.94 (1.70–3.38)    | 3.33 (1.72–3.66)    | 2.86 (1.86–4.14)         |
| candles, pan all                        | p50       | 0.35 (0.32–0.35) | 0.33 (0.31–0.33)    | 0.31 (0.30–0.50)    | 0.40 (0.32–0.66)         |
| candles, pan 200                        | p50       | 0.18 (0.17–0.19) | 0.21 (0.19–0.29)    | 0.18 (0.18–0.19)    | 0.19 (0.18–0.35)         |
| candles, ticks, all in view: frame      | p50       | 0.39 (0.38–0.39) | 0.17 (0.14–0.23)    | 0.37 (0.36–0.37)    | 0.21 (0.17–0.22)         |
| candles, ticks, latest 200: frame       | p50       | 0.14 (0.13–0.17) | 0.11 (0.10–0.12)    | 0.15 (0.15–0.15)    | 0.10 (0.09–0.16)         |
| candles, ticks, all in view: `update()` | mean (µs) | 0.28 (0.28–0.29) | 0.29 (0.28–0.54)    | 0.27 (0.26–0.27)    | 0.48 (0.32–0.56)         |
| 16 charts of 100k, a round of ticks     | p50       | 0.28 (0.27–0.29) | 0.22 (0.22–0.22)    | 0.28 (0.27–0.34)    | 0.22 (0.21–0.23)         |

- **Medians are where they were**: within 3% for the wide views with indicators, in both
  directions (panning 0.09 ms up, zooming 0.10–0.31 ms down), which is less than the rounds differ
  among themselves. A full redraw does the same drawing as before plus the bookkeeping of what it
  drew: a few numbers per series.
- **Tails are the load's.** p95 values move by up to 1.3 ms between the versions and by more
  between rounds of the same version (5.26–11.1 ms for one cell); with a load average in the
  hundreds they say nothing about the change in either direction.
- The 200-bar tick case, which had nothing to gain from a narrower clip in JavaScript terms,
  still takes a third less per frame: the 200 candles and the grid are not drawn again.
- The candles-only pan cells differ by up to 0.09 ms at p50 in either direction, with ranges that
  overlap.
- The synchronous cost of `series.update()` is 0.3–0.5 µs in every cell, against a budget of
  100 µs. The cells differ by fractions of a microsecond, under a timer of 5 µs and this load;
  the change does not touch that path.

## Pixels

A frame drawn through the partial path has to leave the canvas a full redraw would leave. Two
tests check that, at two levels.

**A model, in the unit tests** (`packages/core/test/partial-redraw.test.ts`). No canvas rasterizes
under the test runner, so the test keeps every shape a frame draws, with its style and the clip it
was drawn through, and decides what can color the pixels of a range of columns: a filled rectangle
that overlaps it; a stroke's segments that come within half the line width and a pixel of
antialiasing, each with the neighbor it joins at an end that close (or a cap), with the length of
the path before it when the line is dashed, and with whether the path is a single segment; text
always. After every change the frame is checked against full redraws of the state before and
after: a partial frame must draw, inside its columns, exactly what the full redraw draws there, and
the two full redraws must agree everywhere outside them; a frame that leaves the layer alone needs
full redraws that agree everywhere. 42 tests at pixel ratios 1, 2 and 1.5 cover the last candle
(with borders and translucent bodies), lines that are solid, wide and translucent, stepped, dashed
and dotted, lines with gaps that open and close at the last bar, a histogram, points corrected
away from the last bar (what an output drawn shifted would dirty), merged pixel columns and a
coarse level, an update against a new bar, logarithmic, percentage, indexed and inverted scales,
the watermark, dashed grid lines, session breaks and shading, the last-value label on the overlay,
and every fallback: a tick that moves a price scale (with and without an axis), a new item, a tick
together with a change of options, view, size, visibility or the set of series, a custom renderer,
a `bottom` primitive, a restored canvas. Mutations of the implementation (a narrower clip, a path
started or ended one item later, dashes not counted from the start, a skipped check) fail them.

**Pixels, in headless Chromium** (`pnpm bench:pixels`, `benchmarks/src/pixels/main.ts`). Five charts
(candles with borders and translucent bodies; six lines of every style, one with gaps, and a
translucent histogram on a scale of its own; candles with six indicators on three scales;
logarithmic, inverted and percentage scales with axes; a watermark, dashed and dotted grid lines,
session breaks and shading under candles on a fixed price scale) in three views of 200,000 bars
(200 bars, 20,000 bars in merged columns, all bars through a coarse level) take 40 steps each:
ticks on the last bar, a new bar every fifth step, a move that changes autoscale every seventh,
corrections of older points. After every step all canvases are read, the chart is made to draw
everything again, and they are read again; a second pass lets partial frames follow one another
and compares every eighth step. Every byte must be equal.

| Rasterizer (Chromium 156)      | Pixel ratios | Cases | Partial frames | Full  | Layer kept | Comparisons | Different                                         |
| ------------------------------ | ------------ | ----- | -------------- | ----- | ---------- | ----------- | ------------------------------------------------- |
| GPU (the default for a canvas) | 1, 1.5, 2    | 90    | 1,788          | 1,216 | 596        | 2,025       | **0**                                             |
| Software (`--raster cpu`)      | 1, 1.5, 2    | 90    | 1,788          | 1,216 | 596        | 2,025       | 791 (candles: 0 of 405; with lines: 791 of 1,620) |

- **On the GPU every pixel is equal**, with clips from 5 to 557 device pixels wide.
- **One difference was found on the way, and is fixed.** A partial path that came down to a single
  segment (a line that ends at a gap just left of the clip) differed from the full redraw by up to
  65 levels in a few pixels at the cap: Chromium strokes a path of one segment as another shape
  than a longer path, and antialiases its ends beyond the cap. `drawLine` now widens such a range
  until it holds two segments or the whole line.
- **On Chromium's software rasterizer the comparison cannot hold for antialiased lines**, for any
  partial redraw. The chart's canvases are rasterized in software when a page asks for
  `willReadFrequently` (the chart does not) or the browser runs without GPU rasterization. There,
  a full redraw is not a local function of the path: a probe outside the repository strokes a
  polyline of 194 points with round joins on two software canvases, the second with only its last
  point moved, and 5–9 pixels up to 190 columns away from that point differ (by up to 10 levels of
  255; none when the line is one pixel wide, none between two draws of the same path, and none
  with any width on the GPU). So after a tick, a full redraw itself changes pixels in columns
  where nothing changed, and no frame that keeps those columns can equal it. In the charts above
  the differences are in 40–108 pixels per differing comparison on average (of 190,000–770,000 in
  the pane), by up to 46 levels in three of the setups and up to 139 in the one with dashed,
  stepped and translucent lines, which was not looked into further. Shapes
  on whole pixels (candles, bars, solid grid lines) are equal there too. Nothing accumulates:
  every partial frame clears its columns first.
- Not compared: Firefox and Safari (the harness runs Chromium), and a headed window.

## What changed in the repository

- `Chart._renderPane` draws the series layer in full, through a clip over the dirty columns, or
  not at all (`Chart._dirtyColumns` decides); `SeriesView` reports the items it rebuilt and counts
  a generation when it replaces them; `drawLine`, `drawCandles` and `drawHistogram` take a range of
  items. Frames asked for by engine events go through `Chart._schedule`, every other change
  through `invalidate`, which marks the layer stale.
- All layers are drawn again when the browser restores a lost canvas context (`contextrestored`).
  Before, the axes and the drawings layer stayed empty until something changed them; with partial
  frames the series layer would have too.
- `pnpm bench:pixels` and its page (`benchmarks/pixels.html`).
- 53 tests were added (580 in all): the 42 above, 6 on `SeriesView` (dirty items, generations,
  partial projection against a full one, the search for items by column) and 5 on `drawLine` over a
  range; one existing test now expects a tick to draw a few candles through a clip instead of all
  of them.

## Limits

- **The gate is not shown to hold.** The runs say the frame left the p99 and the p99 fell by a
  third; they do not say it is under 4 ms on the reference machine, because the machine was not
  in a state to say so. The cases to run again on a quiet machine are in Reproducing.
- **One machine, one browser**, as in every stage: Chromium on an Apple M1. x86, Android, Firefox
  and Safari are unmeasured, for time and for pixels.
- **Software-rasterized canvases** differ from a full redraw in a few antialiased pixels per frame
  (see Pixels). The chart has no switch to turn partial frames off; if one is wanted for such
  pages it is an option away, since a stale layer already forces the full redraw.
- **Full redraw kept** with a custom series renderer, a `bottom` primitive, or drawings merged
  into the series layer; for a tick that changes a price scale; and for a new bar that adds an item
  or scrolls the view, which is every new bar of a chart that follows the last bar with bars wider
  than a pixel.
- **A dashed or dotted line** is drawn from its first item in a partial frame, and its columns
  reach to the right edge: correct, but such a line costs its path every tick (the stroke is
  still clipped). The indicator set of the gate has none.
- A layout whose `layout.background` is not opaque shows what was drawn before through it; full
  redraws accumulate there, and partial frames accumulate in their columns only. The pane canvas
  is opaque, so such a background was not usable before either.
- Traced numbers come from one run per side; the trace samples cover part of the frame time, as
  described in the profile.

## Reproducing

```sh
CASES=ind-apply/candles-1m/all,ind-apply/candles-1m/latest,tick/candles-1m/all,tick/candles-1m/latest,ind-frames/candles-1m/pan-all,ind-frames/candles-1m/zoom-all,ind-frames/candles-1m/pan-2k,frames/candles-1m/pan-all,frames/candles-1m/pan-200,multi/candles-100k/16-charts
# "Before": the packages of main in a directory of their own, measured with this harness.
mkdir -p benchmarks/results/baseline && git archive 99d02d3 packages | tar -x -C benchmarks/results/baseline
# Alternately, one round each; then join the rounds of a side.
pnpm bench --case $CASES --lib lumen-worker,lumen-main --repeats 1 --budget 3 --timeout 240 \
  --packages benchmarks/results/baseline/packages --out benchmarks/results/before-1.json
pnpm bench --case $CASES --lib lumen-worker,lumen-main --repeats 1 --budget 3 --timeout 240 \
  --out benchmarks/results/after-1.json
pnpm bench:merge benchmarks/results/before.json benchmarks/results/before-*.json
# The frame of a tick, from a trace:
pnpm bench --case ind-apply/candles-1m/all,tick/candles-1m/all --lib lumen-worker --repeats 1 --budget 3 \
  --profile benchmarks/results/traces --out benchmarks/results/traced.json
# Pixels: GPU rasterization by default; the software rasterizer is reported without failing.
pnpm bench:pixels
pnpm bench:pixels --raster gpu,cpu --out benchmarks/results/pixels.json
```
