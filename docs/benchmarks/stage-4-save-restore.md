# Stage 4: save and restore

The last part of stage 4 of the [design](../design.md): the state of a chart saved and restored in a
versioned format (section 7.2 describes what was built). Stage 4's gate in section 9 is about
drawings, so this part has no gate of its own. What it has to show: saving does not touch the frame
path, and restoring a state with 1,000 drawings, a series and several indicators costs one frame,
not one per item.

The harness gained a `state` scenario (see Scenario). Numbers come from these files, all headless
Chromium 156.0.8078.4 (new headless mode, GPU rasterization) on an Apple M1 on battery power,
viewport 1280 × 720, DPR 2, chart 1200 × 600:

| File                                                   | What                                                    | Code      | Runs per case | Load average (1 min), start → end |
| ------------------------------------------------------ | ------------------------------------------------------- | --------- | ------------- | --------------------------------- |
| [stage-4-save-restore.json](stage-4-save-restore.json) | save and restore with 1,000 and no drawings; 1M candles | `f5ba2c4` | 5             | 4.8 → 3.9                         |

- Other work ran on the machine (CPU idle 56–67% during the runs); benchmarks took turns through a
  machine-wide lock. Cells give the median of the five runs with their range.
- `f5ba2c4` is this branch before it was rebased onto `main`; the library sources measured are
  those of this change. The path of the results file in its recorded arguments is shortened to
  the one in the repository.

## Save and restore, 1,000 drawings

1M candles with 5 indicators on them (SMA 20, 50 and 200, EMA 12 and 26) and 1,000 drawings, half of
them in view, the last 300 bars in view. Milliseconds.

| Step                                   | lumen-worker        | lumen-main          |
| -------------------------------------- | ------------------- | ------------------- |
| `saveState()`, p50                     | 0.067 (0.065–0.070) | 0.070 (0.069–0.086) |
| `saveState()`, max                     | 0.18 (0.18–0.18)    | 0.12 (0.11–0.12)    |
| `JSON.stringify` of it (420 k chars)   | 0.39 (0.39–0.39)    | 0.39 (0.39–0.40)    |
| `JSON.parse` of that                   | 0.91 (0.91–0.91)    | 0.89 (0.88–0.91)    |
| `restoreState()` call, p50             | 1.73 (1.71–1.75)    | 1.80 (1.78–1.91)    |
| JavaScript of the frame that draws it  | 1.20 (1.18–1.23)    | 1.25 (1.23–1.27)    |
| Restore work (call + frame), p50       | 2.96 (2.91–2.98)    | 3.08 (3.02–3.16)    |
| Restore work, max                      | 4.04 (3.51–4.53)    | 3.60 (3.53–3.90)    |
| Frames the chart drew for a restore    | 1 in every round    | 1 in every round    |
| Until drawn (waits for the next frame) | 15.4 (15.3–15.4)    | 15.4 (15.3–15.4)    |

- **Saving reads and draws nothing.** `saveState` copies the options applied, the options of the
  series and outputs, and each drawing's points and options: 0.07 ms for 1,000 drawings, about 70 ns
  a drawing. It asks for no frame (a unit test counts) and nothing of the engine. Turning the state
  into a string costs more than making it.
- **A restore is one frame.** While the state is applied, invalidations are only noted, and one
  follows at the end: every round of every run drew one frame. The call is the check of the whole
  state (about a third of it), 1,000 drawings removed and 1,000 made; the frame is their geometry
  and the drawings layer drawn once, 500 drawings in view, the cost of a pan frame with them
  ([stage 4 drawings](stage-4-drawings.md)).
- **Nothing is computed again.** The series and the five indicators are those of the chart, so the
  series keeps its 1M bars and the indicators their values. During development `applyOptions` took
  parameters equal to the current ones for new ones and had the engine compute each indicator
  again, which showed here as three to five frames per restore; that comparison is fixed.
- **The view needs no round trip here.** The right edge of the saved view is past the last bar. Its
  time is placed from the bars held at that end (the 65 the engine takes the spacing from), so the
  view is set in the call. The times of drawings in older history were known to the time index from
  the rounds before; a chart that has never seen them asks the engine once for all of them, and
  draws those drawings one frame later ([stage 4 drawings](stage-4-drawings.md), known limits).

## Without drawings, and into an emptied chart

| Step, ms                            | Drawings | lumen-worker     | lumen-main       |
| ----------------------------------- | -------- | ---------------- | ---------------- |
| `saveState()`, p50                  | 0        | 0.003            | 0.003            |
| `restoreState()` call, p50          | 0        | 0.23 (0.14–0.28) | 0.26 (0.17–0.26) |
| Restore work, p50                   | 0        | 0.79 (0.45–0.94) | 0.85 (0.52–0.95) |
| Into the chart emptied: call, p50   | 0        | 0.44 (0.42–0.47) | 0.37 (0.27–0.42) |
| Into the chart emptied: work, p50   | 0        | 0.80 (0.80–0.98) | 0.60 (0.37–0.62) |
| Into the chart emptied: call, p50   | 1,000    | 3.22 (3.11–3.38) | 2.94 (2.16–3.01) |
| Into the chart emptied: work, p50   | 1,000    | 4.77 (4.53–5.01) | 4.13 (3.04–4.22) |
| Into the chart emptied: until drawn | 1,000    | 32.7 (32.4–33.6) | 15.2 (15.1–15.6) |

- **Without drawings** the state is 2.9 k characters; a restore into the chart it came from costs
  0.2 ms in the call (the check, the options compared and found equal, the view) and a frame like
  any redraw.
- **Into an emptied chart** the restore makes the series and the five indicators again: six
  commands to the engine and six series objects, 0.2 ms more than keeping them. The series have
  no bars, so nothing is computed and the view waits for bars. With the engine in a worker the
  answers to the new series bring a second frame.
- **Open: 1.3 ms unexplained with 1,000 drawings.** Into the emptied chart the call takes 2.9–3.2 ms
  where 1.9 ms would be expected (the 1.7 ms above, less the removals, plus 0.2 ms). One extra run
  with the same restore split into two calls (everything but the drawings, then the drawings; not
  in the results file) gave 0.18 ms + 1.6 ms, so no single part is slower; the code path per
  drawing is the same as above, and in Node the emptied case is the cheaper one (1.7 ms against
  1.9 ms). A garbage collection that falls into the one larger call is the likely cause, not
  shown.

## Scenario

`state` cases (`benchmarks/src/harness/scenarios.ts`, `runState`):

| Case                    | What                                             |
| ----------------------- | ------------------------------------------------ |
| `state/candles-1m/1000` | 5 indicators and 1,000 drawings on 1M candles    |
| `state/candles-1m/0`    | the same without drawings: options, series, view |

- The drawings are those of the `drawings` scenario (`benchmarks/src/drawings.ts`): the ten tools
  in turn, half on the 300 bars in view, half in the 15,000 bars before.
- Each run does 30 measured rounds after 3 warm-up rounds of each step. A save, a `JSON.stringify`
  and a `JSON.parse` sample is the mean of ten calls, as one call is near the timer's 5 µs step. A
  restore gets a freshly parsed state, as an application gets it from storage, and is timed like
  the changes of the `tz-change` scenario: the call, the JavaScript of the frames until the chart
  is idle, and the frames the chart drew in between. After the restores into the chart it came
  from, the run checks that the state saved again is the same JSON, character for character.
- For the emptied case the chart's series, indicators and drawings are removed before each round
  (untimed), by restoring a state with three empty lists.
- Libraries that save no chart state (Lightweight Charts) are skipped.

## Regression check

The frame and tick paths gained a flag test in `invalidate`, a null test per engine event and a
search from the end where a layer removes a primitive. Three cases on the branch this one started
from (`b97d646`, an export outside git) and on this branch, interleaved, two rounds of one run
each, 4 s per run; load average 2.7 → 4.1. These short files are not in the repository. Cells are
base → branch, round 1, round 2.

| Case, metric                                  | lumen-worker         | lumen-main           |
| --------------------------------------------- | -------------------- | -------------------- |
| tick 1M latest, main thread per tick avg (µs) | 4.5 → 4.2, 3.9 → 4.1 | 3.9 → 4.0, 3.7 → 4.0 |
| pan 200 bars of 1M, frame JS p50 (µs)         | 385 → 415, 420 → 395 | 375 → 385, 420 → 405 |
| hover over 1,000 drawings, frame JS p50 (µs)  | 395 → 520, 525 → 530 | 505 → 520, 505 → 530 |
| hover over 1,000 drawings, frame JS p99 (µs)  | 690 → 785, 765 → 785 | 800 → 730, 740 → 765 |

- **No regression shows.** Ticks and pans differ by as much in one direction as in the other. The
  hover frames are within 5% but for one base run (395 µs) that the other three base runs do not
  repeat; one run each on a shared machine cannot tell less than that apart. The 1 ms hover gate
  holds in all of them.

## Known limits

- **Measured on one desktop, on battery, under load from other work.** Absolute numbers move
  between runs; the mid-range Android device of the stage 4 gate is not measured.
- **Drawings are replaced, not matched.** A restore removes every drawing and makes those of the
  state, also when most are the same: 1.7 ms and 2,000 events for 1,000 drawings. Matching by id
  would save the work for unchanged ones.
- **Indicators after the first one that differs are computed again**, also those that did not
  change, because the engine keeps indicators in creation order. On 1M bars that is the stage 3
  load cost per indicator, in the background.
- **A view zoomed out to a coarse level is saved approximately** past the ends of the data: the
  main thread holds no raw rows there, so the time of an edge beyond the last bar comes from the
  spacing of the last buckets. Inside the data, and with the raw rows of an end held, it is exact
  to the millisecond.
- **A view cannot be restored wider than the chart allows**: where the loaded history does not
  cover the saved times, the time scale's limits apply (all bars fit; two bars stay in view).
- **A logarithmic scale's range goes through `10 ** log10(x)`**, so its saved ends can differ from
  the restored ones in the last digit.
- **Not saved:** bars, datafeeds, custom renderers, primitives, formatter functions, the chart's
  size, `worker` and `memoryLimit` (design section 7.2).
