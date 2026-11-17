# Stage 4: price axes

The price axes part of stage 4 of the [design](../design.md) (section 8, "Price axes"; [section 8.1](../design/stage-4-price-axes.md)
describes what was built): several price scales per chart, on both sides of the pane or as overlays,
in normal, logarithmic, percentage and indexed modes, with formatting by tick size. The stage 4 gate
(1,000 drawings, hover p99 1 ms) belongs to the drawings part and is not measured here. What this
part had to show: **frame time does not regress for a chart with one axis**, and what the new modes
and axes cost.

The short version:

- **One axis: no regression beyond one step of the 5 µs timer.** Five alternating before/after
  passes of the frame cases on 1M candles; every redraw makes the same canvas calls. With the stage 3
  set of 20 indicators (26 series on the one scale) the first three passes read 10–20 µs (3–6%)
  higher; looking up each series' scale only when its options change (`bdd83f6`) brought that to
  +5 µs, and candles alone to +1 and +4 µs, once the machine's drift is taken out.
- **What the features cost**, frame JavaScript p50 with three moving averages on 1M candles, against
  the same series on one normal scale: a logarithmic scale +35 µs with 200 bars in view and +210 µs
  with all 1M (a logarithm per price in every frame, +18% and +25%); a percentage scale +15 µs and
  +70 µs; three more axes +40 µs with 200 bars, and 95 µs less with all bars, since the axes take
  room from the pane and leave it 17% fewer items to draw.
- **No allocations on the frame path**: a unit test pans and moves the crosshair over a chart with
  two axes, a logarithmic and an inverted percentage scale, and checks that every typed array of the
  views and axes is the same object afterwards.
- **The machine was saturated** by other work (an Android emulator, other builds and tests): load
  average 19 to 326 on 8 cores and 0–3% CPU idle in every run. Absolute numbers are above those of
  earlier stages; compare within a pass only.

## Conditions

Apple M1 (8 cores) on AC power, headless Chromium 156.0.8078.4 (new headless mode, GPU
rasterization), viewport 1280 × 720, DPR 2, chart 1200 × 600, Node 26.13.1, `lumen-worker`. Tables
give times in µs; with several runs, the median and the range in parentheses.

- **Before** is `main` at `0ed57f4`, measured with this branch's harness through `--packages` (the
  `packages/` directory of an export of that commit, in a temporary directory written `<scratch>` in
  the files). **After** is this branch: `34e6ecc` for passes 1 and 2 and the first price axes run,
  `b66f215` (after `ef53d85`, which keeps ticks near the range of their scale) for pass 3 and the
  second price axes run, `bdd83f6` for passes 4 and 5. The commit in a file is the harness's, which
  for the before files is this branch while the library measured is `main`'s. Some files record
  "uncommitted changes": this document being written.
- **Alternating runs.** Before and after ran one invocation each, pass after pass, through the
  machine-wide benchmark lock, so no other benchmark ran meanwhile.

Files:

| File                                                                       | What                                                    | Code                 | Load average (1 min), start → end |
| -------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------- | --------------------------------- |
| [stage-4-price-axes-before.json](stage-4-price-axes-before.json)           | passes 1–3, `main`: frame cases and ticks on 1M candles | `0ed57f4`            | 58 → 116, 107 → 83, 166 → 157     |
| [stage-4-price-axes-after.json](stage-4-price-axes-after.json)             | passes 1–3, this branch                                 | `34e6ecc`, `b66f215` | 115 → 113, 94 → 79, 153 → 137     |
| [stage-4-price-axes-axes.json](stage-4-price-axes-axes.json)               | the price axes scenario, 1 and 2 runs per case          | `34e6ecc`, `b66f215` | 77 → 237, 140 → 326               |
| [stage-4-price-axes-trim-before.json](stage-4-price-axes-trim-before.json) | passes 4–5, `main`, 2 runs per case                     | `0ed57f4`            | 21 → 20, 19 → 27                  |
| [stage-4-price-axes-trim-after.json](stage-4-price-axes-trim-after.json)   | passes 4–5, this branch after `bdd83f6`                 | `bdd83f6`            | 19 → 19, 28 → 33                  |

## One axis, before and after

Frame cases of earlier stages: 1M candles panned with 200 bars in view, zoomed around 2,000 and all
bars, and the stage 3 case with 20 indicators (26 series on the one scale) panned with 200 bars.

Frame JavaScript p50 / p95 (µs), before → after, one run per side and pass:

| Case, 1M candles               | Pass 1                | Pass 2                | Pass 3                |
| ------------------------------ | --------------------- | --------------------- | --------------------- |
| pan, 200 bars                  | 165 / 215 → 170 / 380 | 165 / 215 → 160 / 235 | 160 / 220 → 155 / 210 |
| zoom, 2,000 bars               | 320 / 500 → 330 / 415 | 345 / 850 → 320 / 410 | 325 / 425 → 320 / 445 |
| zoom, all bars                 | 345 / 415 → 365 / 530 | 365 / 455 → 350 / 420 | 345 / 415 → 355 / 725 |
| 20 indicators, pan, 200 bars   | 365 / 490 → 375 / 450 | 365 / 435 → 375 / 905 | 340 / 420 → 360 / 430 |
| tick, last 200: `update()` avg | 0.29 → 0.29           | 0.29 → 0.27           | 0.27 → 0.26           |
| tick: main thread per tick avg | 1.73 → 1.81           | 1.79 → 1.81           | 1.66 → 1.62           |

- **Canvas calls are identical** before and after in every case (for example 619 `fillRect` and 14
  `fillText` per redraw of the 200-bar pan), except one grid line fewer with 20 indicators in
  pass 3: `ef53d85` keeps ticks within one spacing of their scale's range.
- **Candles alone** move by one to five timer steps (5–25 µs) either way, with no direction: after
  is lower in five of the nine pairs and higher in four. p95 and the maximum vary by a factor of two
  between runs of the same side.
- **With 20 indicators**, 26 series on the scale, after was higher in all three passes, by 10, 10
  and 20 µs (3–6%). Per series and frame the scale of the series was looked up from its options
  (`priceScaleId`) and `visible` was read twice; with 26 differently shaped options objects those
  reads are not free. `bdd83f6` looks the scale up only when the options object changes and reads
  `visible` once. Passes 4 and 5 measure it.

**After the trim**, passes 4 and 5 ran before → after → before → after at `bdd83f6`, two runs per
case, in a quieter window (load average 19–33, CPU idle 0–3%). Frame JavaScript p50 (µs), the two
runs of each invocation:

| Case, 1M candles             | Before 4 | After 4  | Before 5 | After 5  | After 4 − mean of befores |
| ---------------------------- | -------- | -------- | -------- | -------- | ------------------------- |
| pan, 200 bars                | 140, 135 | 145, 150 | 155, 155 | 160, 165 | +1                        |
| zoom, all bars               | 330, 335 | 345, 340 | 345, 345 | 350, 355 | +4                        |
| 20 indicators, pan, 200 bars | 330, 330 | 345, 350 | 345, 365 | 355, 325 | +5                        |

- **The machine drifted** within these four minutes: the pan case reads 137, 147, 155 and 162 µs in
  the order the invocations ran, whatever the side. With a steady drift, an after invocation is
  compared with the mean of the before invocations on either side of it (last column), which takes
  the drift out: one timer step or less.
- The same estimate for passes 1–3 gives +5 and −3 µs (pan), −3 and −15 (zoom 2,000), +10 and −5
  (zoom all), and +10 and +23 µs with 20 indicators, before the trim.

## Price axes scenario

`axes-frames` (new in this branch) runs the pan and zoom frames scenario on 1M candles with three
moving averages (SMA 20, 50 and 200, the first three of the stage 3 indicator set), laid out four
ways: all on one normal scale (`one`, the reference), the same on a logarithmic (`log`) or a
percentage scale (`percent`), and each average on an axis of its own, two left of the pane and one
right of the candles' axis (`four`).

Frame JavaScript (µs), three runs per case (one at `34e6ecc`, two at `b66f215`, both before the trim
of `bdd83f6`, which takes the same per-series work out of every layout); the canvas calls are those
of one redraw (`fillRect` / `lineTo` / `fillText`).

| Motion, bars in view | Layout  | p50              | p95              | Mean             | p50 against `one` | Calls               | Load average |
| -------------------- | ------- | ---------------- | ---------------- | ---------------- | ----------------- | ------------------- | ------------ |
| pan, 200             | one     | 190 (180–200)    | 290 (220–320)    | 207 (181–212)    |                   | 616 / 597 / 17      | 71–129       |
| pan, 200             | log     | 225 (215–235)    | 515 (340–570)    | 292 (232–304)    | +35               | 616 / 597 / 17      | 69–158       |
| pan, 200             | percent | 205 (205–220)    | 425 (260–430)    | 234 (209–240)    | +15               | 616 / 597 / 17      | 71–185       |
| pan, 200             | four    | 230 (205–240)    | 300 (260–545)    | 235 (209–286)    | +40               | 584 / 597 / 11      | 138–216      |
| zoom, all 1M         | one     | 850 (850–885)    | 1060 (1055–1580) | 879 (875–955)    |                   | 2,487 / 22,696 / 12 | 192–257      |
| zoom, all 1M         | log     | 1060 (1060–1130) | 1270 (1260–2950) | 1082 (1082–1371) | +210              | 2,487 / 22,696 / 12 | 206–278      |
| zoom, all 1M         | percent | 920 (890–930)    | 1305 (1100–1845) | 964 (907–1010)   | +70               | 2,478 / 22,698 / 12 | 226–307      |
| zoom, all 1M         | four    | 755 (720–790)    | 860 (845–1655)   | 761 (738–865)    | −95               | 2,071 / 19,303 / 12 | 237–326      |

- **Logarithmic.** The only mode that is not a multiply-add per price: every frame of a pan or zoom
  projects every item again, four prices per candle or merged pixel column, each through
  `Math.log10`. With all 1M bars in view that is about 2,500 candle columns and 2,400 columns of each
  average, some 40,000 logarithms per frame.
- **Percentage.** The projection is the same multiply-add as on a normal scale. The additions are
  small: a scan from the first visible bar to each series' first value for its base, and the value
  labels, formatted again in every frame since their base moves with the view. The difference was
  not broken down further; at all bars the percentage runs also had the highest load average of
  their motion but one.
- **Four axes.** At 200 bars the work is the same items plus three more axes, whose labels change in
  every frame of a pan because each autoscaled range does. With all bars in view the three axes take
  about 150 of the 1,200 pixels, the pane draws 17% fewer columns, and the frame is cheaper.
- Every layout keeps the frame far below the 16 ms of a 60 Hz frame; the worst p95 is 2.95 ms
  (logarithmic, all bars, one run at load average 278).

## Known limits

- **Noise and drift.** With 0–3% CPU idle, differences of one timer step (5 µs) are not resolved,
  p95 and maximum vary by a factor of two between runs of the same code, and the machine drifts by
  several steps within minutes. The comparison rests on medians of alternating runs, with the drift
  taken out where it showed, and on identical canvas calls. A remaining cost of a few µs per frame
  with many series cannot be ruled out.
- **A logarithmic scale takes a logarithm per price** every time the series are projected, which is
  every frame of a pan or zoom: four per candle or merged column. The other modes project with one
  multiply-add, as before.
- **Value labels can overlap**: labels of series at nearby prices, or of overlays on the default axis,
  are drawn over each other (Lightweight Charts moves them apart). The crosshair label of a scale kept
  in a band by its margins shows values outside the band when the pointer is outside it.
- **One pane.** Scales share the price pane; separate panes are not part of this stage.
- One desktop machine, headless; the mid-range Android reference device, x86, Firefox and
  `lumen-main` are not measured (the frame code is the same with the engine on the main thread).
  Frame intervals stay at the refresh interval in headless runs (see the
  [stage 0 notes](stage-0-baseline.md#reproducing)).

## Reproducing

```sh
# Before: main's packages exported to <scratch>/main-export
git archive -o <scratch>/main.tar main packages && tar -x -f <scratch>/main.tar -C <scratch>/main-export
CASES=frames/candles-1m/pan-200,frames/candles-1m/zoom-2k,frames/candles-1m/zoom-all,ind-frames/candles-1m/pan-200,tick/candles-1m/latest
pnpm bench --case $CASES --lib lumen-worker --repeats 1 --packages <scratch>/main-export/packages --out <scratch>/before-1.json
pnpm bench --case $CASES --lib lumen-worker --repeats 1 --out <scratch>/after-1.json
# ... alternating, three passes; then passes 4 and 5 of three cases with two runs each
TRIM=ind-frames/candles-1m/pan-200,frames/candles-1m/pan-200,frames/candles-1m/zoom-all
pnpm bench --case $TRIM --lib lumen-worker --repeats 2 --packages <scratch>/main-export/packages --out <scratch>/before-4.json
pnpm bench --case $TRIM --lib lumen-worker --repeats 2 --out <scratch>/after-4.json
# The price axes scenario
pnpm bench --case axes-frames/candles-1m/pan-200,axes-frames/candles-1m/zoom-all --lib lumen-worker --repeats 2 \
  --out <scratch>/axes-2.json
# One file per side, a run per invocation
pnpm bench:merge docs/benchmarks/stage-4-price-axes-before.json <scratch>/before-1.json <scratch>/before-2.json <scratch>/before-3.json
pnpm bench:report docs/benchmarks/stage-4-price-axes-axes.json
```

Unit tests that back the claims above: `packages/core/test/price-scale.test.ts` (round trips of every
mode, inverted or not; ticks of every mode, logarithmic ticks on round prices at least the spacing
apart; formats), `packages/core/test/series-view.test.ts` (logarithmic and inverted projection),
`packages/core/test/price-axes.test.ts` (layout of several axes, overlays, assignment at run time,
autoscale with several series, every mode on a chart, axis drag and double click, crosshair and value
labels, indicators on their own scale, formatting by tick size, reuse of the frame path's arrays).
