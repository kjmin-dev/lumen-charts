# Stage 4: time zones and sessions

One part of stage 4 of the [design](../design.md): time zones, daylight saving and trading sessions
in the display layer (section 4.3; its "As built in stage 4" note describes what was built). Stage
4's gate in section 9 is about drawings, so this part has no gate of its own. What it has to show:
converting bar times to wall-clock time costs no `Intl` call per bar per frame, a change of time zone
costs little, and pan and zoom frames at 1M bars cost what they did.

Numbers come from these files, all headless Chromium 156.0.8078.4 (new headless mode, GPU
rasterization) on an Apple M1 on AC power, viewport 1280 × 720, DPR 2, chart 1200 × 600:

| File                                                                                                                             | What                                                                   | Code                 | Runs per case        | Load average (1 min), start → end |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------- | -------------------- | --------------------------------- |
| [stage-4-time-zones-before-1.json](stage-4-time-zones-before-1.json)                                                             | pan and zoom, 1M candles, `main`                                       | `0ed57f4`            | 2                    | 224 → 129                         |
| [stage-4-time-zones-after-1.json](stage-4-time-zones-after-1.json)                                                               | the same in UTC, then in New York time with sessions, and zone changes | `f0aaf63`            | 1                    | 360 → 459                         |
| [stage-4-time-zones-before-2.json](stage-4-time-zones-before-2.json)                                                             | pan and zoom, `main` again                                             | `0ed57f4`            | 1                    | 459 → 222                         |
| [stage-4-time-zones-after-2.json](stage-4-time-zones-after-2.json)                                                               | as after-1                                                             | `81c78f2`            | 1                    | 222 → 28                          |
| [stage-4-time-zones-narrow-after.json](stage-4-time-zones-narrow-after.json), [`-before`](stage-4-time-zones-narrow-before.json) | 200 bars in view only, after and before alternately, twice             | `2866f1f`, `0ed57f4` | 2 per pass, 4 in all | 31 → 21                           |

- Before and after ran from detached checkouts of `main` and of this branch, one after the other
  through the machine's benchmark lock. `after-1` was built from `f0aaf63` but records `81c78f2`:
  the runner reads the commit when the run ends, and the checkout had moved on by then. The two
  differ only in where the first change to a zone builds its table (in the next frame, or in the
  `applyOptions` call); the total is the same. `2866f1f` (no table for daily bars) came after and
  changes nothing measured here.
- All of it was measured on `0ed57f4`. The branch was then rebased onto the price axes work
  (`2107937`), which reworked the chart's frame path; the commits named here are those before the
  rebase, and the numbers were not measured again on the new base.
- Other agents were building and testing on the machine: the load average went from 18 to 459, far
  above the 2.6 to 8.8 of stage 3. Frame JavaScript time is the metric least disturbed by it (the
  harness times the library's animation-frame callbacks), and runs of the same code still spread by
  up to 25 µs at p50; compare rows within a pass and look at the spreads.
- Tables give the median with the range of the runs in parentheses, or the values of each run. Times
  in µs unless marked.

## Summary

| Measure, 1M one-minute candles                                | Before (`main`, UTC) | After, UTC      | After, New York and sessions |
| ------------------------------------------------------------- | -------------------- | --------------- | ---------------------------- |
| Pan frame JS p50, 200 / 20k / all bars in view                | 155 / 480 / 323      | 160 / 488 / 308 | 178 / 503 / 320              |
| Zoom frame JS p50, 200 / 20k / all                            | 153 / 473 / 358      | 173 / 460 / 348 | 163 / 488 / 355              |
| Pan and zoom frame JS p95, worst case of the views above      | 1,045 (zoom 20k)     | 640 (zoom 20k)  | 1,155 (zoom 20k)             |
| Zone change, main-thread work p50 (call + frames until drawn) | –                    | 0.26–0.41 ms    |                              |
| The same for a change of the text color (any option)          | –                    | 0.19–0.38 ms    |                              |
| First change to a zone in the page, work p50                  | –                    | 0.80–1.50 ms    |                              |
| First time zone of the page, once (`Intl` start-up included)  | –                    | 9.1–11.3 ms     |                              |

Medians over all runs and both engine modes (worker and main thread) for the frames, ranges over the
three views and both modes for the changes (from `after-2.json`; the first time zone of the page took
10.4–14.7 ms in `after-1.json`, under a higher load). Stage 1's gate for these frames is p95 8 ms.

- **Frames.** In UTC the time axis now goes through the zone's table (offset 0, no `Intl`), and the
  frames cost what they did, within the spread of the runs; the 200-bar rows above, 0–35 µs higher
  under the heaviest load, came out equal to `main` in a narrow pass at a lower load (see Frames).
  With New York time and an equity schedule (pre-market, regular hours, post-market, breaks drawn
  and extended hours shaded) frames cost 13–20 µs more at 200 bars, 0–40 µs more at 20k bars, where
  14 days (10 trading days) are in view with their breaks and shading, and nothing more with all
  bars in view, where days are narrower than 6 pixels and no breaks or shading are placed. Each
  label costs a few lookups in the table; nothing is computed per bar.
- **Zone changes.** A change between zones whose tables exist costs 0–0.08 ms more than a change of
  any other option, which redraws everything. The first change to a zone builds its table for the
  bars of the window held (about two years at the widest view) and costs 0.8–1.5 ms. The first zone
  a page shows also pays for starting `Intl`'s time zone support, once: 9–11 ms here, 13–31 ms for
  the first `Intl.DateTimeFormat` with a time zone in a fresh Node process.

## Converting a time

Measured in Node 26 on the same machine under a load average above 400, so only the ratios count:

| Operation                                                             | Time             |
| --------------------------------------------------------------------- | ---------------- |
| `Intl.DateTimeFormat#formatToParts`, one call                         | 11 µs            |
| `Intl.DateTimeFormat#format`, one call (what the table is built with) | 0.6–1.4 µs       |
| Table lookup, wall-clock time of an instant, in order / at random     | 18–25 / 33–71 ns |
| Table lookup, first instant at or after a wall-clock time, at random  | 12–33 ns         |
| Building the table for 1M minutes (1.9 years): 535 samples            | 1.1–1.6 ms       |

The table holds the instants where the offset changes, about two a year. It is built by sampling
the offset every two days and bisecting to the second between two samples that differ. The shortest
gap between two changes in the tz database from 1850 to 2060, found by scanning every zone `Intl`
knows every six hours, is 7 days (Brazil in 2000, Gaza and Hebron in 2040), so a two-day step finds
them all. The table grows by at least a year at a time, for the times of every window the engine
sends, before a frame needs them; the tests check that frames, pans and zone changes make no further
`Intl` call once a window has arrived.

## Zone changes

From `after-2.json`, 5 first changes and 60 later changes per case (times in ms):

| Bars in view | Adapter      | Change                 | Call p50 | Frame JS p50 | Work p50 | Work max |
| ------------ | ------------ | ---------------------- | -------- | ------------ | -------- | -------- |
| 200          | lumen-worker | first change to a zone | 0.460    | 0.305        | 0.800    | 10.1     |
| 200          | lumen-worker | later zone change      | 0.040    | 0.215        | 0.260    | 0.360    |
| 200          | lumen-worker | text color change      | 0.035    | 0.155        | 0.190    | 0.295    |
| 200          | lumen-main   | first change to a zone | 0.525    | 0.375        | 0.930    | 10.4     |
| 200          | lumen-main   | later zone change      | 0.045    | 0.250        | 0.300    | 0.425    |
| 200          | lumen-main   | text color change      | 0.045    | 0.175        | 0.220    | 0.315    |
| 20,000       | lumen-worker | first change to a zone | 0.505    | 0.480        | 0.960    | 10.2     |
| 20,000       | lumen-worker | later zone change      | 0.045    | 0.330        | 0.375    | 0.515    |
| 20,000       | lumen-worker | text color change      | 0.040    | 0.330        | 0.370    | 0.480    |
| 20,000       | lumen-main   | first change to a zone | 0.480    | 0.455        | 0.930    | 9.12     |
| 20,000       | lumen-main   | later zone change      | 0.045    | 0.335        | 0.380    | 0.500    |
| 20,000       | lumen-main   | text color change      | 0.040    | 0.325        | 0.365    | 0.500    |
| all 1M       | lumen-worker | first change to a zone | 0.830    | 0.670        | 1.50     | 11.3     |
| all 1M       | lumen-worker | later zone change      | 0.045    | 0.355        | 0.405    | 1.07     |
| all 1M       | lumen-worker | text color change      | 0.040    | 0.335        | 0.380    | 0.955    |
| all 1M       | lumen-main   | first change to a zone | 0.765    | 0.710        | 1.48     | 10.8     |
| all 1M       | lumen-main   | later zone change      | 0.045    | 0.335        | 0.380    | 0.545    |
| all 1M       | lumen-main   | text color change      | 0.040    | 0.325        | 0.365    | 0.470    |

- Work is the `applyOptions` call plus the JavaScript of the animation frames until the change is
  drawn; the wall time until drawn is one frame (16.6–16.7 ms p50), as for any change of options.
- The call builds the zone's table for the bars held around the view (with `f0aaf63`, in
  `after-1.json`, the next frame built it: frame JS p50 0.59–1.18 ms for a first change, the same
  total). The first change to a zone at the widest view covers about two years; narrower views
  cover the window around them plus a year on the side the table grows.
- The maximum of the first changes is the first zone of the page, which starts `Intl`'s time zone
  data (above). A page that has already formatted a date in a time zone has paid it.

## Frames

Frame JS per run, p50 and p95 in µs, `before` from the two `main` files (three runs), `after` from
the two branch files (two runs):

| Case, 1M candles | Adapter      | UTC before p50 | UTC after p50 | New York + sessions p50 | UTC before p95  | UTC after p95 | New York + sessions p95 |
| ---------------- | ------------ | -------------- | ------------- | ----------------------- | --------------- | ------------- | ----------------------- |
| pan 200          | lumen-worker | 155, 145, 155  | 180, 160      | 185, 150                | 205, 185, 225   | 375, 225      | 325, 200                |
| pan 200          | lumen-main   | 160, 155, 150  | 160, 150      | 170, 190                | 210, 200, 210   | 225, 195      | 225, 240                |
| zoom 200         | lumen-worker | 170, 155, 150  | 190, 175      | 170, 160                | 235, 215, 200   | 305, 245      | 225, 220                |
| zoom 200         | lumen-main   | 150, 150, 155  | 170, 160      | 165, 155                | 210, 205, 215   | 235, 230      | 225, 215                |
| pan 20k          | lumen-worker | 455, 480, 485  | 490, 485      | 505, 485                | 495, 525, 540   | 575, 545      | 575, 535                |
| pan 20k          | lumen-main   | 475, 485, 480  | 495, 480      | 520, 500                | 530, 550, 740   | 560, 550      | 580, 555                |
| zoom 20k         | lumen-worker | 470, 480, 500  | 485, 450      | 495, 490                | 560, 610, 1,045 | 640, 545      | 1,155, 635              |
| zoom 20k         | lumen-main   | 475, 470, 455  | 470, 450      | 485, 485                | 565, 560, 560   | 570, 570      | 610, 590                |
| pan 200k         | lumen-worker |                |               | 480, 440                |                 |               | 770, 490                |
| pan 200k         | lumen-main   |                |               | 495, 435                |                 |               | 575, 480                |
| zoom 200k        | lumen-worker |                |               | 440, 430                |                 |               | 510, 495                |
| zoom 200k        | lumen-main   |                |               | 445, 460                |                 |               | 530, 530                |
| pan all          | lumen-worker | 325, 320, 305  | 320, 305      | 320, 310                | 405, 390, 370   | 450, 375      | 385, 375                |
| pan all          | lumen-main   | 330, 335, 305  | 310, 300      | 330, 320                | 385, 430, 365   | 375, 365      | 415, 375                |
| zoom all         | lumen-worker | 360, 365, 335  | 345, 340      | 360, 350                | 420, 440, 400   | 420, 410      | 450, 425                |
| zoom all         | lumen-main   | 360, 355, 340  | 350, 355      | 365, 345                | 440, 430, 400   | 435, 425      | 425, 420                |

With 200 bars in view the branch came out 0–35 µs higher in some runs above. The narrow pass, at a
load average of 18 to 31, ran only those cases, after and before alternately, twice, 4 runs each
(p50 in µs, median and range of the runs):

| Case, 1M candles | Adapter      | UTC before    | UTC after     | New York + sessions |
| ---------------- | ------------ | ------------- | ------------- | ------------------- |
| pan 200          | lumen-worker | 140 (140–145) | 140 (140–145) | 153 (150–155)       |
| pan 200          | lumen-main   | 145 (140–150) | 145 (140–150) | 158 (150–160)       |
| zoom 200         | lumen-worker | 153 (150–155) | 150 (150–165) | 170 (165–170)       |
| zoom 200         | lumen-main   | 150 (145–150) | 153 (145–155) | 165 (155–170)       |

In UTC the branch costs what `main` did, to the 5 µs step of the timer. New York time with the
equity schedule costs 13–20 µs more at this zoom, where labels are minutes apart and every session
start is a candidate.

- Draw calls per redraw (counted untimed): 2,501 `fillRect` at 20k bars in New York time with
  sessions against 2,483 in UTC, the 18 shaded runs of extended hours (the data trades around the
  clock, so the night separates each post-market from the next pre-market; the breaks are one dashed
  stroke); 2,684 at 200k bars, where 139 days are 8.6 pixels wide; the same 2,484 with all bars in
  view, where no marks are placed.
- The 1,045 and 1,155 µs p95 values are single runs out of three and two; the other runs of the same
  cases are at 560–640 µs.

## Scenarios

`tz-frames` is the frames scenario of earlier stages with the chart in New York time
(`localization.timeZone`) and the extended hours of a New York equity exchange as the session
schedule: pre-market 04:00 to 09:30, regular hours to 16:00, post-market to 20:00, Monday to Friday,
with breaks drawn and extended hours shaded. The data is the usual one-minute series from 2000-01-01,
which trades around the clock: bars outside the sessions belong to the trading day before, and 1M
bars span almost two years, with four changes to and from summer time.

`tz-change` loads the 1M candles, shows 200, 20k or all bars from the middle of the history, and
changes `localization.timeZone`: once to each of New York, London, Kolkata (UTC+5:30), Lord Howe
(half-hour summer time) and Tokyo, then 60 times through them and UTC, then changes the text color 60
times as the baseline. Each change is timed from the call until `settle()` resolves with it drawn;
the JavaScript of the animation frames in between is added to the call.

Lightweight Charts has no time zones (its documentation converts times in application code), so the
adapters of the other libraries leave these scenarios out.

## Known limits

- **The first time zone of a page costs 9–11 ms**, most of it `Intl` starting its time zone data,
  in the call that sets it (or in `createChart`). Later zones cost about a millisecond, and a zone
  shown before costs a redraw.
- **Two offset changes less than two days apart that cancel out would be missed.** None exist in
  the tz database from 1850 to 2060 (the closest are 7 days apart); a future rule could add some.
- **The table grows for the bars in the windows the engine sends**, by a year at least. Daily and
  longer bars need none (they are dates, below). Minute bars over decades would cost about
  0.5 ms per year of history in view, once per zone and page.
- **Daily and longer bars are dates and keep their UTC date** in every zone (bars at least 20 hours
  apart, measured per bar), as TradingView's datafeed convention stamps them at 00:00 UTC. Daily
  bars stamped at local midnight east of UTC (Tokyo's midnight is 15:00 UTC the day before) show the
  day before; stamp them at 00:00 UTC.
- **Sessions:** whole-day holidays only, no early closes. Session times are wall-clock times: a
  session starting in the hour skipped by a change to summer time starts when the hour ends. The
  trading day of a bar outside every session is the one before it.
- Breaks and shading are placed only while a day is at least 6 CSS pixels wide, and at a coarse
  level of detail they sit on the bucket that holds the first bar of a day (less than a pixel off).
- VWAP's daily anchor in the engine stays at UTC midnight: the engine never sees the zone.
  `anchor` takes another period in milliseconds, not a zone.
- `local` is resolved when the option is applied; a change of the system's time zone while the page
  runs is not followed.
- The crosshair's time label is sized for digits; labels of a locale with wider characters can
  overflow its box.
- One desktop machine, headless, under a load average of 18 to 459 from other work. Firefox and
  Safari, whose `Intl` may cost more or less per call, x86 and the mid-range Android reference
  device are not measured.

## Reproducing

```sh
pnpm bench --case frames/candles-1m/pan-200,frames/candles-1m/zoom-200,frames/candles-1m/pan-20k,frames/candles-1m/zoom-20k,frames/candles-1m/pan-all,frames/candles-1m/zoom-all \
  --lib lumen-worker,lumen-main --repeats 2 --out benchmarks/results/stage-4-time-zones-before-1.json   # on main
pnpm bench --case frames/candles-1m/pan-200,frames/candles-1m/zoom-200,frames/candles-1m/pan-20k,frames/candles-1m/zoom-20k,frames/candles-1m/pan-all,frames/candles-1m/zoom-all,tz-frames/candles-1m/pan-200,tz-frames/candles-1m/zoom-200,tz-frames/candles-1m/pan-20k,tz-frames/candles-1m/zoom-20k,tz-frames/candles-1m/pan-200k,tz-frames/candles-1m/zoom-200k,tz-frames/candles-1m/pan-all,tz-frames/candles-1m/zoom-all,tz-change/candles-1m \
  --lib lumen-worker,lumen-main --repeats 1 --out benchmarks/results/stage-4-time-zones-after-2.json
pnpm bench --case frames/candles-1m/pan-200,frames/candles-1m/zoom-200,tz-frames/candles-1m/pan-200,tz-frames/candles-1m/zoom-200 \
  --lib lumen-worker,lumen-main --repeats 2 --out benchmarks/results/stage-4-time-zones-narrow-after-1.json
pnpm bench:merge benchmarks/results/stage-4-time-zones-narrow-after.json benchmarks/results/stage-4-time-zones-narrow-after-1.json benchmarks/results/stage-4-time-zones-narrow-after-2.json
pnpm bench --quick --scenario tz-frames,tz-change --lib lumen-worker   # smoke test, under a minute
pnpm bench:report docs/benchmarks/stage-4-time-zones-after-2.json
```

Unit tests that back the claims above: `packages/core/test/time-zone.test.ts` (offsets against
`Intl.DateTimeFormat#formatToParts` at random instants from 1850 to 2050 in 14 zones, every change
from 2000 to 2026 to the second in 27 zones, half-hour and 45-minute offsets, historical changes, DST gaps and
overlaps, a bounded number of `Intl` calls), `packages/core/test/time-ticks.test.ts` (labels and
weights across both changes of New York, the repeated hour, Kolkata and Kathmandu, years in a zone,
daily bars, sessions, trading days of sessions spanning midnight, locales and formatters),
`packages/core/test/sessions.test.ts` (sessions through DST, holidays, sessions spanning midnight,
overnight sessions, malformed schedules, breaks and shading) and `packages/core/test/chart.test.ts`
(zone changes at run time on the axis and the crosshair, no `Intl` call in the frames after a zone
change, errors that change nothing, breaks and shading drawn, session queries, daily bars).
