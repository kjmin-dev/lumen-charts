# Stage 5: branch-free min and max

The first step the [stage 5 profile](stage-5-profile.md) adopted, as built: every loop that takes a
highest and a lowest value on the frame or load path now uses `Math.max` and `Math.min` instead of
a comparison. This document says where, what stayed, the one rule that settles the sign of a zero,
and what the harness measures before and after.

| Measure, 1M one-minute candles with 20 indicators (25 lines) | Before           | After            | Change                                                   |
| ------------------------------------------------------------ | ---------------- | ---------------- | -------------------------------------------------------- |
| Pan frame JS p50, 20,000 bars in view                        | 5.47 (4.92–5.49) | 4.16 (3.63–4.24) | −24%                                                     |
| Pan frame JS p95, 20,000 bars in view                        | 5.62 (5.23–5.66) | 4.38 (3.98–4.40) | −22%                                                     |
| Pan frame JS p50, all bars in view                           | 4.14 (3.74–4.27) | 3.79 (3.31–3.87) | −8%                                                      |
| Pan frame JS p95, all bars in view                           | 5.56 (4.94–5.83) | 4.93 (4.51–5.11) | −11%                                                     |
| Load, indicators settled (engine in a worker)                | 431 (412–446)    | 351 (348–366)    | −19%                                                     |
| Load, indicators settled (engine on the main thread)         | 391 (382–402)    | 313 (308–315)    | −20%                                                     |
| Prepend of 1M bars, shown (worker / main thread)             | 532 / 616        | 408 / 482        | −23%                                                     |
| Frames without indicators, ticks, tick to applied            | 0.3–0.7          | 0.3–0.7          | none established (the runs spread more than they differ) |

Times in ms, `lumen-worker` unless marked; median of six runs with their range in parentheses.

## What changed

A comparison (`if (v > max) max = v`, or the same as a conditional expression) compiles to a branch
in V8, which prices mispredict. `Math.max` and `Math.min` compile to one instruction each. They
return NaN for a NaN operand where the loops skip missing values, so the value is tested first
(`v === v`), a branch that is almost never taken.

| Place                                                                       | Decision      | Why                                                                                                                               |
| --------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `SeriesView.update`: merging rows into pixel columns, line and candles      | Changed       | 1.4–2.5 times faster on noisy series, 1.05–1.4 on smooth ones                                                                     |
| `SeriesView.update`: the price range of the items (autoscale)               | Changed       | In the same measurement; 25 series × up to 2,400 items a frame                                                                    |
| `aggregate`: highest and lowest of a group (fused, `MAX`, `MIN`)            | Changed       | 1.9–3.3 times faster on noisy series, 1.2–1.5 on smooth ones                                                                      |
| `lineBuckets`: the finest level of an indicator output                      | Changed       | 1.6–4.8 times in the profile's prototype; `aggregate` builds the levels above from its buckets, and the view merges the same rows |
| `rollingExtreme`: rolling highest and lowest, Stochastic's range            | Changed       | Kernels 2.0–2.1 times faster at period 20, 1.4 at 200; Stochastic 1.5                                                             |
| `EngineCore._aligned`: bars of a secondary series merged into a main bar    | Changed       | For the rule, not for speed: almost every main bar holds one bar                                                                  |
| `atrKernel`: the larger of three ranges                                     | Left          | `Math.max` and `Math.abs` measured 0.98 times the comparisons (8.97 → 9.15 ns per row, a pass not in the file)                    |
| `SeriesView.lowestPositive`                                                 | Left          | Runs only on a logarithmic scale whose items reach zero; takes no zero, so no rule applies                                        |
| `PriceAxis.include`: the range of the series on one price axis              | Changed       | For the rule, not for speed: a call or two per series a frame. Added after the harness runs below                                 |
| `Chart._includeSeries`                                                      | Nothing to do | It reads the range of the view and already uses `Math.min` and `Math.max` for a histogram's base                                  |
| Two loops for the highest and the lowest instead of one over negated values | Not taken     | Lowest alone 13% faster (6.2 → 5.4 ns per row), highest and Stochastic unchanged: not worth a second copy of the three passes     |

Nothing else changes: missing values are skipped as before, a group of only missing values is NaN,
and infinities behave as they did.

## The sign of a zero

A comparison keeps the zero it met first (`0 > -0` is false), `Math.max(-0, 0)` is `+0` in any
order. So the change needs a rule, and the same one everywhere a value can be reached two ways:

**Of values that include zeros of both signs, the highest is +0 and the lowest is −0, wherever they
are.** A set with one kind of zero keeps it. For every other input the bits are those of the
comparisons: all outputs of the loops measured below are identical before and after on the
benchmark's data (`different` is 0 in every row of the loops file).

The rule depends on neither order nor grouping, which the comparisons did not manage:

- A bucket from its 16 rows, or from the four buckets below it; a level built at once or grown by
  ticks, prepends and corrections; a pixel column merged from raw rows or from buckets of any
  level; the engine in a worker or on the main thread: the same bits. "First met" gave the same
  bits in these places too, as long as every place walked the rows in the same direction.
- **The rolling extremes did not.** They cut the rows into blocks of the window's length from
  where a slice starts, take prefix extremes forwards and suffix extremes backwards, and combine
  the two. With "first met", a window of both zeros gave +0 or −0 depending on where the blocks
  fell: on rows of random zeros, 2,978 of 7,800 values of a rolling highest of 3 differed between a
  computation from row 0 and ones started 1, 2, 3 and 7 rows later. Design section 5.1 promises the
  same bits whatever row a windowed computation started from; with the rule it holds for zeros as
  well (0 of 7,800).

Tests, all bit for bit (`Object.is`, NaN equal to NaN), on rows that are zeros of both signs with
missing values between them and a few other values. The tests of the first six items fail on the
code before, except the comparison of a level with the level below, which "first met" satisfied too:

- `aggregate`: every order of the zeros in a group, fused and as separate `MAX` and `MIN` columns;
  and levels 64 to 1,024 from the level below against the same levels straight from the rows, with
  partial groups at both ends.
- The engine's levels through eight rounds of prepends, new bars, changes of the last bar and
  corrections of old ones, against brute force over the raw rows after every round, and against a
  second engine that got the same rows in two steps.
- Bars of a secondary series that share a main bar, zeros in either order.
- Rolling highest and lowest (periods 2, 3, 20, 300) against brute force from three starting
  indexes, and highest, lowest and Stochastic from eight starting rows against the whole.
- Indicator values and their level 1 and 2 buckets through ticks across a chunk boundary and a
  prepend, against a computation from scratch.
- `SeriesView`: columns with the zeros in either order, candles and lines, and the price range.
- `SeriesView`: 200 single-row changes, each against a full rebuild.
- The range of a price axis from series in either order, with missing bounds.
- View items from raw rows and from levels 1 to 4 at every switch (prices, not pixels: a pixel
  cannot tell the zeros apart).

The comparison of level buckets with brute force in the existing level tests was by value
(`===`); it is by bits now.

## Conditions

Headless Chromium 156.0.8078.4 (new headless mode, GPU rasterization) on an Apple M1 (8 cores,
16 GiB) on AC power, viewport 1280 × 720, DPR 2, chart 1200 × 600; Node 26.13.1 for the loops.

Before is `3d38e1c` (the tree of `main` at `7b0059c`), after is this change. One build of the
harness measured both, the sources before through `pnpm bench --packages`. The two ran alternately,
three invocations each of two runs per case, through the machine's benchmark lock:
`--repeats 2 --budget 3`, 44 runs and about 170 s per invocation.

| File                                                       | What                                               | Runs per case | Load average (1 min), start → end of each invocation |
| ---------------------------------------------------------- | -------------------------------------------------- | ------------- | ---------------------------------------------------- |
| [stage-5-min-max-before.json](stage-5-min-max-before.json) | the cases below, sources of `3d38e1c`              | 6             | 10.6 → 6.9, 5.9 → 5.3, 7.4 → 4.5                     |
| [stage-5-min-max-after.json](stage-5-min-max-after.json)   | the same, this change                              | 6             | 6.9 → 5.9, 5.3 → 7.5, 4.5 → 5.5                      |
| [stage-5-min-max-loops.json](stage-5-min-max-loops.json)   | the loops alone in Node, before and after in turns | 11–41 passes  | 19.2 → about the same                                |

- **The machine was busy.** Other work ran on it throughout: the load average was 4.5–10.6 during
  the harness runs and 19 during the loops (stage 3 measured at 2.6–8.8). Runs of the same code
  spread by 10–15% in the cases with indicators and by a factor of two in the frames without
  (0.32–0.71 ms at p50 on both sides, in two clusters). Differences under about 10% are not
  established by these runs; the ones in the summary are larger than the spread, or their ranges
  do not overlap.
- The files record the environment of their first invocation and commit `d7911da` with uncommitted
  changes: that is this change before its documents were committed and before it was rebased onto
  `main`; its sources are the ones merged.
- Tables give the median of the six runs with their range in parentheses. Times in ms unless
  marked.

## Frames

| Case, 1M candles          | Metric | Worker, before   | Worker, after    | Main, before     | Main, after      |
| ------------------------- | ------ | ---------------- | ---------------- | ---------------- | ---------------- |
| 20 indicators, pan 2,000  | JS p50 | 2.07 (1.47–2.25) | 1.88 (1.47–1.96) | 2.04 (1.81–2.17) | 1.87 (1.46–2.23) |
| 20 indicators, pan 2,000  | JS p95 | 2.56 (1.68–2.81) | 2.30 (1.66–2.74) | 2.52 (2.37–2.75) | 2.24 (1.62–2.55) |
| 20 indicators, pan 20,000 | JS p50 | 5.47 (4.92–5.49) | 4.16 (3.63–4.24) | 5.41 (4.83–5.50) | 4.06 (3.60–4.12) |
| 20 indicators, pan 20,000 | JS p95 | 5.62 (5.23–5.66) | 4.38 (3.98–4.40) | 5.58 (5.17–5.64) | 4.30 (3.90–4.34) |
| 20 indicators, pan all    | JS p50 | 4.14 (3.74–4.27) | 3.79 (3.31–3.87) | 3.98 (3.75–4.21) | 3.82 (3.33–3.91) |
| 20 indicators, pan all    | JS p95 | 5.56 (4.94–5.83) | 4.93 (4.51–5.11) | 5.41 (4.91–5.65) | 4.92 (4.37–5.03) |
| 20 indicators, zoom all   | JS p50 | 4.34 (3.86–4.50) | 4.33 (3.90–4.35) | 4.35 (3.87–4.51) | 4.32 (3.90–4.38) |
| 20 indicators, zoom all   | JS p95 | 5.74 (4.98–5.95) | 5.18 (4.59–5.23) | 5.50 (4.95–5.82) | 5.13 (4.65–5.22) |
| candles only, pan 2,000   | JS p50 | 0.52 (0.35–0.69) | 0.42 (0.32–0.63) | 0.38 (0.32–0.67) | 0.63 (0.33–0.71) |
| candles only, pan 2,000   | JS p95 | 0.85 (0.73–0.91) | 0.82 (0.58–0.94) | 0.83 (0.70–0.93) | 0.81 (0.60–0.92) |
| candles only, pan all     | JS p50 | 0.59 (0.46–0.70) | 0.36 (0.32–0.45) | 0.63 (0.36–0.71) | 0.47 (0.32–0.63) |
| candles only, pan all     | JS p95 | 0.92 (0.86–1.09) | 0.77 (0.40–0.93) | 0.96 (0.79–1.08) | 0.85 (0.42–0.99) |

- **20,000 bars in view: 1.3 ms less a frame** (5.4–5.5 → 4.1–4.2 ms at p50, −24%; the ranges do
  not overlap). This is the view where every frame merges 20,000 raw rows of 25 series into pixel
  columns. The profile put `SeriesView.update` at 2.1 ms of that frame and expected about twice the
  speed on this mix of series (18 of the 25 outputs are smooth averages, where a comparison was
  cheap already): the frame lost 1.3 ms.
- **All bars in view: 0.2–0.35 ms less at p50** (−4 to −8%, about the spread of the runs) **and
  0.5–0.6 ms less at p95** (−9 to −11%). The view merges the buckets of a coarse level here, far fewer than
  20,000 rows, and drawing the lines is the larger part of the frame, which this change does not
  touch.
- **Zooming with all bars in view: p50 as before, p95 0.4–0.6 ms less.** Why the median does not
  move was not looked into.
- **2,000 bars in view: no merging happens** (every bar is an item); what remains is the range
  loop. The medians are 0.2 ms lower, inside the spread.
- **Candles only: nothing established.** These frames take 0.3–0.7 ms on both sides, in two
  clusters that depend on the run, not on the code; the medians move both ways (pan 2,000 on the
  main thread 0.38 → 0.63, pan all in the worker 0.59 → 0.36). The lowest run of every row is the
  same before and after within 0.04 ms, except pan all in the worker (0.46 → 0.32). Stage 1's gate
  for these frames is p95 8 ms.

## Load, prepend and ticks

| Case, 1M candles with 20 indicators        | Metric                  | Worker, before   | Worker, after    | Main, before     | Main, after      |
| ------------------------------------------ | ----------------------- | ---------------- | ---------------- | ---------------- | ---------------- |
| Load, first page load                      | settled                 | 431 (412–446)    | 351 (348–366)    | 391 (382–402)    | 313 (308–315)    |
| Load again in the same page                | settled                 | 416 (400–468)    | 348 (333–484)    | 349 (332–381)    | 264 (249–280)    |
| Prepend of 1M bars                         | shown                   | 532 (516–582)    | 408 (398–432)    | 616 (582–642)    | 482 (463–483)    |
| Tick to applied, latest 200 bars in view   | p50                     | 0.23 (0.21–0.24) | 0.26 (0.22–0.38) | 0.09 (0.07–0.10) | 0.09 (0.08–0.13) |
| Tick to applied, latest 200 bars in view   | p99                     | 3.44 (2.93–4.54) | 2.98 (2.74–3.18) | 0.36 (0.29–0.49) | 0.41 (0.39–0.53) |
| Tick to applied, all bars in view          | p50                     | 0.26 (0.24–0.33) | 0.30 (0.24–0.41) | 0.10 (0.08–0.10) | 0.09 (0.08–0.12) |
| Tick to applied, all bars in view          | p99                     | 4.88 (4.67–5.36) | 4.99 (4.54–5.38) | 0.38 (0.27–0.52) | 0.39 (0.36–0.60) |
| Ticks without indicators, all bars in view | sync per round p99 (µs) | 0.77 (0.75–1.05) | 0.88 (0.65–0.95) | 0.95 (0.80–1.10) | 0.88 (0.70–1.15) |
| Ticks without indicators, all bars in view | frame JS p50            | 0.54 (0.47–0.64) | 0.58 (0.36–0.67) | 0.53 (0.43–0.77) | 0.56 (0.40–0.79) |

- **Load: about 80 ms less until the indicators are there** (−16 to −24%; the ranges of the first
  load do not overlap). "Settled"
  is the time from `setData` until all 20 indicators and their levels are computed and drawn; the
  bars themselves are on screen after 10–20 ms as before, and the rest is the engine. The profile
  attributed 38% of the engine's time to these loops and expected a fifth less.
- **A 1M prepend is shown 0.12–0.13 s sooner** (−22 to −23%), against the 1 s gate of stage 3.
- **Ticks: no change established.** A tick rebuilds one bucket per level and one window per
  rolling kernel; the medians differ by 0.03 ms either way and the ranges overlap. The p99 through
  the worker with all bars in view stays where the profile found it (4.9–5.0 ms against the 4 ms
  gate): that is the tick's frame, which partial redraw addresses, not these loops.

## The loops alone

Node 26.13.1 (V8 14.6), the functions of the two versions imported side by side and run in turns
on 1M rows of the benchmark's candles and of indicator outputs computed from them; ns per row,
median of the passes. Every output was compared bit for bit: no difference.

| Loop                                                            | Before | After | Faster by |
| --------------------------------------------------------------- | ------ | ----- | --------- |
| `aggregate`, candles (5 columns), 16 rows per bucket            | 13.34  | 5.45  | 2.4 ×     |
| `aggregate`, candles, 4 buckets per bucket (per input bucket)   | 14.98  | 7.71  | 1.9 ×     |
| `aggregate`, a line, 16 rows: raw closes                        | 6.06   | 1.94  | 3.1 ×     |
| the same: SMA 20                                                | 3.28   | 2.19  | 1.5 ×     |
| the same: EMA 100                                               | 2.81   | 2.36  | 1.2 ×     |
| the same: RSI 14                                                | 6.27   | 2.06  | 3.0 ×     |
| the same: MACD histogram                                        | 6.52   | 2.01  | 3.3 ×     |
| `SeriesView.update`, 20,000 rows into 2,270 columns: raw closes | 7.14   | 3.62  | 2.0 ×     |
| the same: SMA 20                                                | 4.91   | 3.42  | 1.4 ×     |
| the same: EMA 100                                               | 4.79   | 4.58  | 1.05 ×    |
| the same: RSI 14                                                | 9.77   | 3.86  | 2.5 ×     |
| the same: MACD histogram                                        | 6.01   | 2.88  | 2.1 ×     |
| the same: candles (highs and lows)                              | 5.33   | 2.80  | 1.9 ×     |
| Rolling highest of 20 (the whole kernel, in chunks of 8,192)    | 12.86  | 6.29  | 2.0 ×     |
| Rolling lowest of 20                                            | 12.53  | 6.09  | 2.1 ×     |
| Rolling highest of 200                                          | 8.68   | 6.38  | 1.4 ×     |
| Stochastic 14, 3, 3                                             | 45.30  | 30.05 | 1.5 ×     |
| ATR 14 (the same code on both sides: the noise of a row)        | 8.81   | 8.90  | 0.99 ×    |

- The gain follows the series, as the profile found: a comparison is cheap where its branch is
  predictable (a smooth average), expensive on prices and oscillators. After the change a loop
  takes about the same time on every series.
- `SeriesView.update` includes finding each column's rows and its first and last value, so its
  rows cost more than a bucket's and its gain is smaller than the profile's loop-only prototype
  gave (1.5–3.7 times).
- The load average was 19 during these passes; medians of some rows are up to 50% above the
  fastest pass (both are in the file). The ratios between the two versions, taken in turns, are
  steadier than the times.

## Limits

- Three invocations of two runs a side, on a machine that other work kept busy: enough for the
  differences of 10% and more, not for smaller ones. The cases without indicators and the ticks
  show no change, which is the expected result (their loops are short or do not run), but a
  regression of a few percent there would not have been seen.
- Stage 3's gates (frames p95 8 ms with 20 indicators, the tick's 4 ms) were not run as a full
  matrix again, only the cases above.
- The numbers were measured before the branch was rebased onto `main` (`7b0059c`), whose tree is
  the one it was built on; the sources did not change.
- The harness ran before `PriceAxis.include` got the rule (two `Math` calls instead of two
  comparisons per series a frame); the frames were not measured again after it.
- `lineBuckets` is not exported and has no row of its own in the loops table: its gain is the
  profile's (1.6–4.8 times) and shows in the load and prepend times.
- V8 only. Other engines were not measured; `Math.max` and `Math.min` have the same results
  everywhere, so only the speed is open there.
