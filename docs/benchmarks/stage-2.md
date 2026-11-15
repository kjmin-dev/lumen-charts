# Stage 2: level of detail and a memory limit

Stage 2 of the [design](../design.md) (section 9): level of detail, a window cache by level,
prepends, and a memory limit with a datafeed. Measured on the [stage 2 scenarios](stage-2-before.md)
and compared with the stage 1 code on the same scenarios ([stage-2-before-lumen.json](stage-2-before-lumen.json)),
and with the stage 1 gate ([stage-1-lumen.json](stage-1-lumen.json)). Old numbers were not measured
again. New numbers come from five files:

- [stage-2-lumen.json](stage-2-lumen.json): pan and zoom on 10M line points, prepends, and the new
  refetch scenario, built from commit `a081785` at the start of the run (the fixes `e001885` and
  `54b4b1a` were made in the tree while it ran). Both change behavior only right after a load, before
  any raw window has been shown, which none of these scenarios measure after their setup.
- [stage-2-load.json](stage-2-load.json): the load cases, measured again on the final code
  (`54b4b1a`), because the fixes `e001885` and `54b4b1a` change exactly that case.
- [stage-2-stage-1-gate.json](stage-2-stage-1-gate.json): the stage 1 gate cases (ticks and frames on
  1M candles), on `406bc6e` (`e001885` plus documentation). `54b4b1a` changes only when the
  main-thread engine builds levels after a load, which these cases do before they measure.
- [stage-2-check-stage-1-code.json](stage-2-check-stage-1-code.json) and
  [stage-2-check.json](stage-2-check.json): one run each of a few stage 1 gate cases with the stage 1
  code (`006ce38`) and the final code, back to back, to tell code from conditions (see "Stage 1 gate").

The files written in the repository record "uncommitted changes": this document was being written
in the tree. The stage 1 code ran from an export of `006ce38` outside git, so its file records no
commit.

The hashes in this document are the ones recorded in the JSON files, from before the branch was
rebased onto `main`. After the rebase the same commits are `260a37c` (`a081785`, the refetch
scenario), `630bb62` (`e001885`, coarse level only after raw rows), `d6887b8` (`406bc6e`, the
documentation) and `9314095` (`54b4b1a`, levels built in idle time on the main thread). `006ce38` is
the stage 2 harness, merged as `eafe131` with the same tree.

Conditions as in [stage 2 before](stage-2-before.md): Apple M1 on AC power, headless Chromium
156.0.8078.4 (new headless mode, GPU rasterization), viewport 1280 × 720, DPR 2, chart 1200 × 600,
3 runs per case and adapter (`lumen-worker`: engine in a worker; `lumen-main`: time-sliced on the
main thread). Tables give the median with the range of the runs in parentheses; times in ms.

## Stage 2 gate

| Criterion, 10M line points                 | Target | lumen-worker              | lumen-main                | Stage 2 before (worker / main) | Met on this desktop |
| ------------------------------------------ | ------ | ------------------------- | ------------------------- | ------------------------------ | ------------------- |
| Pan: frame JS p95, worst of 6 zoom levels  | 16 ms  | 1.06 ms (20,000 in view)  | 1.09 ms (20,000 in view)  | 12.0 / 12.2 ms (all 10M)       | yes                 |
| Zoom: frame JS p95, worst of 6 zoom levels | 16 ms  | 1.22 ms (20,000 in view)  | 1.17 ms (20,000 in view)  | 12.1 / 12.0 ms (all 10M)       | yes                 |
| Prepend 10k: shown p95 (worst prepend)     | 100 ms | 18.0 ms (18.5 ms)         | 18.0 ms (18.2 ms)         | 18.0 / 17.9 ms                 | yes                 |
| Prepend 1M: shown p95 (worst prepend)      | 100 ms | 31.4 ms (31.6 ms)         | 22.3 ms (31.9 ms)         | 47.8 / 46.3 ms (88.9 ms)       | yes                 |
| Frame interval p95, worst                  | –      | 16.7 ms (headless pinned) | 16.7 ms (headless pinned) | –                              | –                   |

The worst frame is now a view of 20,000 points: raw rows merged per pixel column (8.7 bars per
device pixel), the one zoom level where level of detail does not apply (it starts at 16 bars per
pixel). It is the same as before. With all 10M points in view, frame JS p95 went from 12.0–12.2 ms
to 0.79–0.89 ms. The gate names two reference devices; the mid-range Android one is not measured.
The margin, which was 3.8 ms at stage 1, is now 14.8 ms: a device whose JavaScript ran 13 times
slower than this M1 would still meet 16 ms (arithmetic, assuming frame time scales with CPU speed).

## Pan and zoom, 10M line points

Frame JS p95, before (stage 1 code) and after:

| Bars in view (bars per device pixel) | Level drawn | Pan, worker   | Pan, main     | Zoom, worker  | Zoom, main    |
| ------------------------------------ | ----------- | ------------- | ------------- | ------------- | ------------- |
| 200 (0.09)                           | raw         | 0.440 → 0.415 | 0.440 → 0.420 | 0.365 → 0.405 | 0.350 → 0.385 |
| 2,000 (0.9)                          | raw         | 0.475 → 0.520 | 0.415 → 0.535 | 0.725 → 0.670 | 0.700 → 0.740 |
| 20,000 (8.7)                         | raw, merged | 1.11 → 1.06   | 1.06 → 1.09   | 1.13 → 1.22   | 1.17 → 1.17   |
| 200,000 (87)                         | 64 bars     | 2.74 → 0.890  | 2.73 → 0.885  | 3.39 → 0.860  | 3.42 → 0.920  |
| 2,000,000 (870)                      | 256 bars    | 4.88 → 0.945  | 4.80 → 0.950  | 6.25 → 0.900  | 6.26 → 0.890  |
| all 10M (4,350)                      | 4,096 bars  | 12.0 → 0.785  | 12.2 → 0.790  | 12.1 → 0.890  | 12.0 → 0.865  |

- Bars per device pixel are for a pane of about 2,300 device pixels, as in the stage 2 before notes.
  The zoom motion goes from half to twice each level, so zoom runs cross into the neighboring level
  (the 20,000 case crosses the switch from raw rows to 16-bar buckets).
- Every run measured all 300 frames, with a library draw in every frame; redraws issue the same
  `lineTo` calls as before (9,083–9,087 against 9,089 from 20,000 points up; 199 and 1,999 below).
- The longest frame of any run with 200,000 or more points in view took 1.36 ms; the outliers of
  26–40 ms when zooming with all 10M in view at stage 1 are gone.

The full table, with p50, p99, max and intervals, is in the JSON and in `pnpm bench:report`.

## Prepend

| Base + batch, bars in view | Adapter      | Shown p50               | Shown p95               | Shown max               | First frame p50 | Call max      | Cold shown  |
| -------------------------- | ------------ | ----------------------- | ----------------------- | ----------------------- | --------------- | ------------- | ----------- |
| line 10M + 10k, 20k        | lumen-worker | 17.2 → 17.2             | 18.0 → 18.0             | 18.3 → 18.2             | 17.1 → 17.2     | 0.175 → 0.305 | 17.2 → 16.7 |
| line 10M + 10k, 20k        | lumen-main   | 17.3 → 17.1             | 17.9 → 18.0             | 18.1 → 18.2             | 17.3 → 17.1     | 0.115 → 0.105 | 16.9 → 16.8 |
| line 10M + 1M, 2M          | lumen-worker | 35.0 → 26.2 (26.0–28.3) | 47.8 → 31.4 (31.3–31.6) | 47.8 → 31.4 (31.3–31.6) | 13.2 → 26.2     | 3.16 → 2.49   | 36.3 → 33.0 |
| line 10M + 1M, 2M          | lumen-main   | 32.6 → 17.6 (16.5–17.6) | 46.3 → 22.3 (21.9–31.9) | 46.3 → 22.3 (21.9–31.9) | 15.4 → 17.6     | 2.66 → 2.44   | 36.0 → 33.1 |
| candles 1M + 10k, 20k      | lumen-worker | 17.3 → 17.3             | 18.0 → 17.9             | 18.5 → 18.3             | 17.3 → 17.3     | 0.270 → 0.240 | 16.4 → 16.1 |
| candles 1M + 10k, 20k      | lumen-main   | 17.3 → 17.1             | 18.1 → 17.9             | 18.2 → 18.0             | 17.3 → 17.1     | 0.175 → 0.135 | 16.8 → 16.1 |
| candles 1M + 1M, 1M        | lumen-worker | 43.8 → 32.7 (31.3–36.5) | 48.4 → 43.0 (37.6–55.8) | 48.4 → 43.0 (37.6–55.8) | 19.7 → 32.7     | 7.13 → 6.80   | 37.3 → 33.1 |
| candles 1M + 1M, 1M        | lumen-main   | 46.6 → 34.9 (32.6–35.5) | 50.3 → 36.4 (36.2–39.1) | 50.3 → 36.4 (36.2–39.1) | 24.4 → 32.6     | 6.54 → 6.53   | 35.7 → 33.1 |

- **1M prepends are shown one to two frames sooner.** Before, the chart drew the old window first
  and the bars a frame or two later, once the engine had copied 6M raw rows (line) or 3M (candles)
  around the view. A 2M-bar view now draws from level 3 (256 bars per bucket), whose window around
  the view is about 39,000 buckets. "First frame" equals "shown" now: the first frame that draws
  after a prepend already shows the batch (it rose because it is no longer an early frame showing the
  old window). The engine also rebuilds the buckets of the 1M new rows before it answers; that is
  inside these latencies.
- **10k prepends are unchanged**: still in the next frame. A 20,000-bar view stays below 16 bars per
  pixel and draws raw rows.
- The 55.8 ms worst prepend (candles, worker) is one run; the other two runs' worst were 37.6 and
  43.0 ms. Not investigated further.

## Memory

| Case                           | Adapter      | Retained before → after | Page before → after | Workers before → after |
| ------------------------------ | ------------ | ----------------------- | ------------------- | ---------------------- |
| line 10M, after 1M prepends    | lumen-worker | 337 → 300               | 92.1 → 1.52         | 245 → 298              |
| line 10M, after 1M prepends    | lumen-main   | 337 → 299               | 337 → 299           | 0 → 0                  |
| candles 1M, after 1M prepends  | lumen-worker | 483 → 351               | 161 → 1.25          | 322 → 350              |
| candles 1M, after 1M prepends  | lumen-main   | 482 → 351               | 482 → 351           | 0 → 0                  |
| line 10M, after 10k prepends   | lumen-worker | 158 → 192               | 1.56 → 1.70         | 157 → 191              |
| candles 1M, after 10k prepends | lumen-worker | 59.7 → 65.3             | 3.39 → 3.57         | 56.3 → 61.7            |

MiB. "After 1M prepends" is sampled at the end of the run with the view at the new first bar (a 2M-
or 1M-bar view).

- **The page no longer holds raw rows for wide views.** After the 1M prepends, the page held 92.1 MiB
  (16M points) and 161 MiB (7M candles) of raw rows around a 2M- or 1M-bar view; it now holds
  1.5 and 1.3 MiB, the level window included.
- **The engine holds the levels on top of the rows**: 53 MiB more for 16M points and 28 MiB for 7M
  candles in the worker. By the layout, levels take 20.8% of a line's raw bytes (four 8-byte columns
  per 16 rows, a third more for the coarser levels, plus the bucket times) and 8.3% of OHLCV's; 16M
  points need 51 MiB by that count, 7M candles 27 MiB. In total the worker case uses less memory
  than before, because the page copy was larger than the levels.
- With a 20,000-bar view (raw rows), nothing moves out of the page and the levels are pure overhead:
  +34 MiB for 10.21M points, +5.4 MiB for 1.21M candles.

## Refetch under a memory limit

The new `refetch` scenario: 10M line points with a datafeed and `memoryLimit` of 128 MiB. After the
load the engine builds its levels and lets go of the value columns of the chunks farthest from the
view. Then the view jumps to 21 regions spread over the oldest 90% of the history, 2,000 bars in
view (raw rows), and each jump is timed until the region is drawn. The datafeed is in the page and
answers at once, so the latency is the chart's own.

| Adapter      | Shown p50        | Shown p95        | Shown max        | Fetches per jump | Rows per fetch | Jumps without fetch | Retained after load (page / workers) | After the jumps (page / workers) |
| ------------ | ---------------- | ---------------- | ---------------- | ---------------- | -------------- | ------------------- | ------------------------------------ | -------------------------------- |
| lumen-worker | 33.3 (33.0–33.3) | 34.1 (33.9–34.3) | 34.2 (34.1–34.6) | 1                | 16,384         | 4 of 20             | 130 MiB (0.4 / 130)                  | 131 MiB (0.8 / 130)              |
| lumen-main   | 33.3 (33.3–33.4) | 34.1 (33.9–34.2) | 34.3 (34.0–34.5) | 1                | 16,384         | 4 of 20             | 130 MiB (130 / 0)                    | 130 MiB (130 / 0)                |

- **History that was let go is back on screen two frames after the jump.** The first frame after the
  jump asks the engine for the raw window, which waits for the rows; the engine asks for them (two
  chunks of 8,192 rows: the window around a 2,000-bar view), the chart calls the datafeed and hands
  them back, and the next frame draws them. Asking for the window when the view changes instead of
  in the next frame would save one frame; not done.
- **The engine stays at its limit.** Retained memory is 130 MiB before the first jump and after the
  last, against a 128 MiB limit. The limit counts the engine's chunks and levels; the 2 MiB on top
  are what it does not count (scratch buffers, JavaScript objects, and on the main thread the
  windows). Without the limit, 10M points with levels take 187 MiB (see Load).
- The 4 jumps without a fetch landed in the newest part of the history, which still fit under the
  limit. A fetch is never sent twice for the same rows, and rows that differ from those let go are
  refused (unit tests; the in-page datafeed always returns the right rows).
- **The time column stays.** A chunk that is let go keeps its times (8 bytes per bar), so fetched
  rows are checked bar by bar against the global indexes they replace and every time lookup keeps
  working. For a line that is half of the raw bytes: 10M points keep 76 MiB of times and about
  33 MiB of levels whatever the limit, which is why 128 MiB lets go of about three quarters of the values
  rather than all of them. For OHLCV the time column is a sixth. Dropping it for single-series charts
  (with a checksum of the times per chunk to check refetched rows) is the obvious next step.

## Load

| Data set   | Adapter      | First frame, before → after         | Settled, before → after             | Retained after load (MiB)      |
| ---------- | ------------ | ----------------------------------- | ----------------------------------- | ------------------------------ |
| line 10M   | lumen-worker | 50.0 (49.5–66.7) → 66.9 (66.9–83.5) | 50.1 (49.5–66.7) → 67.0 (66.9–83.5) | 154 → 154 (187 with levels)    |
| line 10M   | lumen-main   | 50.2 (50.1–50.4) → 52.1 (50.4–66.9) | 50.2 (50.1–50.4) → 52.2 (50.4–67.0) | 153 → 158 (186 with levels)    |
| candles 1M | lumen-worker | 33.6 (17.3–40.3) → 33.7 (33.6–33.7) | 33.7 (17.3–40.4) → 33.7 (33.6–33.7) | 46.8 → 49.3 (51.2 with levels) |
| candles 1M | lumen-main   | 17.4 (16.7–17.7) → 16.9 (16.9–17.0) | 17.4 (16.8–17.8) → 17.0 (17.0–17.0) | 46.5 → 49.0 (50.8 with levels) |

Warm load, latest bars in view, from [stage-2-load.json](stage-2-load.json) (final code).

- **A load is answered before its levels are built.** The engine stores the rows, answers, and builds
  the levels afterwards: in the worker between commands, on the main thread in idle time. The first
  frame shows the latest raw bars, as before.
- Load times move in steps of a frame (16.7 ms). With the worker, the same worker code measured 50.1
  ms (10M points) and 16.9 ms (1M candles) in a run nine minutes earlier on `e001885` (that file was
  overwritten), and 66.9 and 33.7 ms here, under a load average of 5.7–6.4; stage 1's own runs
  spread over the same two frames. On the main thread, building levels right after answering held
  the first frame back by about 6 ms (56.4 and 23.1 ms on `e001885`); `54b4b1a` moved that work to
  idle time, which gives 52.1 and 16.9 ms.
- **Memory.** The memory sample after a load comes before the background build has finished, so it
  shows mostly raw rows. With the levels built (in [stage-2-lumen.json](stage-2-lumen.json), whose
  code built them during the load), 10M points take 187 MiB (+33 MiB, 22%) and 1M candles 51.2 MiB
  (+4.4 MiB, 9.5%), close to the layout's 20.8% and 8.3% plus chunk granularity.

## Stage 1 gate

The design asks for, with 1M candles: tick average 0.1 ms and p99 1 ms; pan and zoom frames p95 8 ms.
Stage 1 was measured headed ([stage-1-lumen.json](stage-1-lumen.json)); these runs are headless.

| Criterion (1M candles)                       | Target | lumen-worker           | lumen-main             | Stage 1 (worker / main)        | Met |
| -------------------------------------------- | ------ | ---------------------- | ---------------------- | ------------------------------ | --- |
| Tick average, last 200 / all bars in view    | 0.1 ms | 0.80 µs / 0.69 µs      | 0.84 µs / 0.70 µs      | 0.31 / 0.33 µs, 0.33 / 0.28 µs | yes |
| Tick p99, last 200 / all bars in view        | 1 ms   | ≤ 5 µs / ≤ 5 µs        | ≤ 5 µs / ≤ 5 µs        | ≤ 5 µs                         | yes |
| Frame JS p95, worst of 10 pan and zoom cases | 8 ms   | 1.55 ms (zoom, 20,000) | 1.53 ms (zoom, 20,000) | 2.98 / 3.03 ms (all bars)      | yes |

| Bars in view | Pan, worker   | Pan, main     | Zoom, worker  | Zoom, main    |
| ------------ | ------------- | ------------- | ------------- | ------------- |
| 200          | 0.190 → 0.510 | 0.200 → 0.505 | 0.360 → 0.390 | 0.410 → 0.445 |
| 2,000        | 0.715 → 0.770 | 0.540 → 0.825 | 0.550 → 0.940 | 1.02 → 0.960  |
| 20,000       | 1.47 → 1.37   | 1.11 → 1.38   | 1.25 → 1.55   | 1.09 → 1.53   |
| 200,000      | 2.15 → 1.13   | 1.86 → 1.12   | 2.23 → 1.19   | 2.51 → 1.16   |
| all 1M       | 2.98 → 0.975  | 2.93 → 1.03   | 2.88 → 1.15   | 3.03 → 1.09   |

Frame JS p95 in ms, stage 1 (headed) → stage 2 (headless).

- **Wide views are 2–3 times faster**, as on 10M points: 200,000 bars draw from 64-bar buckets and
  all 1M from 256-bar buckets.
- **Views of 200 to 20,000 bars and ticks look slower than stage 1, but the code is not the cause.**
  Main-thread time per tick including the paint it causes went from 1.6 to 4.0 µs (last 200 bars)
  and from 4.2–4.4 to 7.9–8.4 µs (all bars), and even the `update()` call itself, whose code did not
  change, went from 0.3 to 0.7–0.8 µs. One run each of the stage 1 code and the final code, back to
  back on the same machine minutes later, gave the same numbers for both: pan 200 p95 0.18 ms (main)
  and 0.50 ms (worker) with the stage 1 code against 0.20 and 0.19 ms, zoom 200 0.20 against 0.20–0.21 ms, main
  thread per tick 1.5 against 1.6–1.7 µs (last 200 bars) and 4.8–9.6 against 3.7 µs (all bars). So
  the gap to stage 1 is the measuring conditions (headed then, headless and a busier machine now),
  not stage 2. On 10M points, where stage 2 before gives a headless baseline of the stage 1 code,
  the views of 200 to 20,000 points moved by −0.06 to +0.12 ms.
- Per tick batch the engine now also rebuilds the last bucket of every level and patches it; that is
  work per batch of ticks, not per tick, and it did not show in the comparison above.

## Observations

- **Frame time no longer grows with the points in view.** From 200,000 points up every redraw reads
  a few thousand buckets at most, and frame JS p95 stays at 0.79–0.95 ms on 10M points; the most
  expensive views are now the ones just below 16 bars per pixel, merged from raw rows (1.1–1.2 ms).
- **The swap between raw rows and a level is not visible.** Unit tests compare the projected items of
  both sides at the switches to levels 1 to 4 (exact equality), and headless screenshots of the
  example (10M line, 1M candles) at 1% below and above each switch look the same. Off a whole pixel
  origin they would differ, which is why the origin snaps below one pixel per bar.
- **Autoscale is exact for what is drawn.** A coarse level draws whole buckets only, so the price range
  is the extreme of the drawn rows, tested against brute force; the rows drawn differ from those
  inside the pane by less than one bucket (under a device pixel) at either end, instead of a raw scan
  of the partial buckets, which would need raw rows the main thread no longer holds.

## What changed

- **Level of detail in the engine.** Every series keeps a pyramid of buckets over the main
  timeline: 16, 64, 256, ... rows, bucket `index >> shift` (a floor, also for negative indexes),
  stored in chunks of 512 buckets aligned with the raw chunks. OHLC: first open, highest high,
  lowest low, last close, largest volume; line: first, highest, lowest, last; the main timeline
  keeps the time of each bucket's first row. Missing values are skipped. A load is answered as soon
  as its rows are stored and the pyramid is built in the background (in the worker between
  commands, on the main thread in idle-time slices of at most 4 ms); the first command that needs it
  finishes the build first.
  Prepends and ticks rebuild only the buckets that hold changed rows, from all of their members.
- **Window cache by level.** Window requests and patches carry a level. Every tick patches the
  changed bucket of every level, so any window the chart holds stays current. Above 16 bars per
  device pixel the chart asks for the coarsest level whose buckets fit a pixel column and merges
  whole buckets per pixel column; it keeps only windows next to that level, so a wide view holds no
  raw rows. Below one pixel per bar the origin sits on a whole device pixel, which makes raw rows and
  buckets give exactly the same pixels at every switch (tested at the switch to levels 1 to 4).
- **Memory limit with a datafeed.** With a datafeed and `memoryLimit`, the engine lets go of the
  value columns of chunks far from the last raw window once the levels are built, keeps the time
  column, the levels, the first and last chunk and the window's rows, and asks for rows again when
  a raw window needs them. The chart calls the datafeed, the engine checks the rows bar by bar
  against the times it kept, and the raw window comes when they are back; the finest level is drawn
  meanwhile.

## Caveats

- One desktop machine, headless. The mid-range Android reference device of the gate, x86 and Firefox
  are unmeasured, so the gate is shown to be met on the desktop reference only.
- Headless frame intervals stay at the refresh interval and miss rasterization and presentation
  stalls (see the [stage 0 notes](stage-0-baseline.md#reproducing)); only frame JavaScript time is
  compared. Stage 1 was measured headed: its frame JavaScript time and tick cost are comparable, its
  intervals are not.
- Frame JavaScript time covers animation-frame callbacks on the main thread. The engine's work in
  the worker, and the main-thread engine's time slices between frames, are not in it.
- Memory excludes canvas and GPU memory and the browser and GPU processes, as in stage 0.
- The memory limit is a target, not a cap on allocation: a load larger than the limit is held in full
  until its levels are built, and the rows of the window around the view, the first and last chunk,
  the levels and the time column always stay. For now it applies only to a series with a datafeed
  while it is the only series with data. Corrections through the datafeed, deletions, resolution
  changes and cancelling requests (design section 8) are not implemented.
- The refetch scenario's datafeed lives in the page and answers at once, so its latency is the
  chart's own; a network adds its round trip. Its memory figures leave out the data set the datafeed
  serves from: it exists before the chart is created, so it is in both samples.
- The diagnostic runs (`stage-2-check*.json`) are one run each, and the load average rose to 14
  while they ran; they show the stage 1 and stage 2 code side by side, not new reference numbers.

## Reproducing

```sh
pnpm bench --quick --lib lumen-worker,lumen-main            # smoke test, under a minute
pnpm bench --case frames/line-10m,prepend,load/line-10m,load/candles-1m,refetch \
  --lib lumen-worker,lumen-main --repeats 3 --out benchmarks/results/stage-2-lumen.json
pnpm bench --case load/line-10m,load/candles-1m --lib lumen-worker,lumen-main --repeats 3 \
  --out benchmarks/results/stage-2-load.json
pnpm bench --case tick/candles-1m,frames/candles-1m --lib lumen-main,lumen-worker --repeats 3 \
  --out benchmarks/results/stage-2-stage-1-gate.json
pnpm bench:report docs/benchmarks/stage-2-lumen.json
```

Runs are headless by default. Unit tests that back the claims above: `packages/engine/test/pyramid.test.ts`
(every level against brute force, prepends, tail corrections, level growth),
`packages/core/test/level-switch.test.ts` (same pixels at each switch, price range against brute force),
`packages/core/test/engine-cache.fuzz.test.ts` (engine and window cache at every level against a model),
`packages/engine/test/memory.test.ts` and `packages/core/test/memory-cap.fuzz.test.ts` (memory limit
and datafeed against a model with late, failing and mismatching answers).
