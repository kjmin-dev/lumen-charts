# Stage 4: drawings, primitives and custom renderers

Part of stage 4 of the [design](../design.md) (section 9): drawings, pane primitives and custom
series renderers (sections 6.1, 7.1 and 8 describe what was built). The gate: **with 1,000
drawings, hover p99 1 ms.**

The harness gained a `drawings` scenario (see Scenario). Numbers come from these files, all headless
Chromium 156.0.8078.4 (new headless mode, GPU rasterization) on an Apple M1 on AC power, viewport
1280 × 720, DPR 2, chart 1200 × 600:

| File                                                                               | What                                                    | Code                 | Runs per case    | Load average (1 min), start → end |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------- | ---------------- | --------------------------------- |
| [stage-4-drawings.json](stage-4-drawings.json)                                     | hover, drag and pan with drawings; 1M candles           | `f6504fe`            | 3                | 29.3 → 5.4                        |
| [stage-4-drawings-regression-main.json](stage-4-drawings-regression-main.json)     | tick, frames and price axes cases on `main`             | `2107937` (main)     | 2                | 5.4 → 4.5                         |
| [stage-4-drawings-regression-branch.json](stage-4-drawings-regression-branch.json) | the same cases on this branch, right after              | `f6504fe`            | 2                | 4.5 → 3.0                         |
| `stage-4-drawings-ab-*.json` (four files)                                          | the regression cases again, main and branch interleaved | `2107937`, `f6504fe` | 1 each, 2 rounds | 13.8 → 8.1                        |

- Other agents were building, testing and measuring on the machine. Benchmarks took turns through a
  machine-wide lock, but builds and tests did not: CPU idle during a run ranged from 0% to 70%, and
  the first runs of the drawings file started at a load average of 29. Rows give the median of the
  runs with their range; read the ranges.
- `main` ran from an export of `2107937` outside git, so its files record no commit. The interleaved
  branch files record uncommitted changes: this write-up was being written in the tree; the library
  sources are those of `f6504fe`. Temporary paths
  in the files are replaced by `<scratch>`.

## Stage 4 gate

| Criterion, 1,000 drawings (500 in view), 1M candles, 300 bars in view | Target | lumen-worker     | lumen-main       | Met on this desktop |
| --------------------------------------------------------------------- | ------ | ---------------- | ---------------- | ------------------- |
| Hover frame JavaScript p99                                            | 1 ms   | 0.30 (0.27–0.63) | 0.33 (0.28–0.77) | yes                 |
| Hover frame JavaScript p50                                            |        | 0.21 (0.18–0.22) | 0.22 (0.20–0.53) |                     |
| Hit test of one hover, mean                                           |        | 1.9 µs           | 1.9 µs           |                     |

- **What a hover frame holds.** The pointer moves once per frame along a path over the pane (two
  sines of different periods, so it sweeps it). The frame's JavaScript is the pointer event (the
  harness dispatches it in a timed frame callback) and the chart's frame: the layout read, the
  crosshair, the hit test against the 1,000 drawings, and the overlay (crosshair, labels, the
  highlight of the hovered drawing). The path is over a drawing at 537 of 600 positions.
- **Hit testing and redraw, separately.** After the frames, the run times the library's public hit
  test (`chart.drawings().hitTest`, the same scan the hover runs) alone at every position of the
  path: 1.8–3.8 µs on average over 20 passes, p99 15 µs per call, which is the timer's resolution
  (5 µs) on a single call. The rest of the frame, frame minus hit test at the same position, is the
  overlay redraw and the event: p50 0.21 ms, p99 0.30–0.33 ms. Hit testing is about 1% of a hover
  frame.
- **Without drawings** the same hover frames took p50 0.28–0.35 ms and p99 0.52–0.58 ms in this
  file, more than with 1,000 drawings. Those runs came after the first six, under different load;
  the frame without drawings does strictly less work (no hit test, no highlight), so the difference
  is the machine, and it shows how much the absolute numbers move here. The smoke runs during
  development, back to back on a quieter machine, gave p99 0.19–0.25 ms without drawings and
  0.24–0.30 ms with them.
- The worst single runs (p99 0.63 and 0.77 ms) were runs 5 and 6, while the machine was busiest
  (CPU idle 30% and 70% swinging); the 1 ms gate held in every run.
- **No spatial index.** Design section 7 adds one only if measurement shows the gate missed
  without it. A linear scan over a typed array of bounds, with each drawing's time span filtered
  first, costs about 2 µs for 1,000 drawings: 1/500 of the budget.
- The gate names two reference devices; the mid-range Android one is not measured. A device ten
  times slower would still be under 1 ms for the hit test and the scan; the overlay redraw, mostly
  canvas calls for the crosshair and its labels, is what would grow.

## Drag and pan

| Case, 1,000 drawings | Adapter      | Frame JS p50     | p95              | p99              | Max              |
| -------------------- | ------------ | ---------------- | ---------------- | ---------------- | ---------------- |
| Drag one drawing     | lumen-worker | 0.32 (0.29–0.33) | 0.58 (0.55–0.59) | 0.69 (0.64–0.76) | 0.77 (0.76–0.77) |
| Drag one drawing     | lumen-main   | 0.33 (0.29–0.33) | 0.56 (0.52–0.56) | 0.66 (0.59–0.69) | 0.96 (0.74–1.16) |
| Pan                  | lumen-worker | 0.61 (0.49–0.70) | 1.08 (0.88–1.19) | 1.23 (1.08–1.39) | 1.77 (1.36–2.47) |
| Pan                  | lumen-main   | 0.51 (0.50–0.58) | 0.99 (0.95–1.13) | 1.26 (1.12–1.30) | 1.42 (1.26–1.94) |

- **Drag** presses a drawing in view and moves the pointer once per frame. The dragged drawing is
  drawn on the overlay, so the drawings layer is drawn twice per drag (when the drawing leaves it
  and when it comes back) and never in between; the unit tests count this. A drag frame is a hover
  frame plus the dragged drawing's new points (their times from the bars held, no round trip) and
  its geometry. During development the drag cost p50 0.55 ms until an edited drawing's updates
  stopped marking its layer for redraw (0.19 ms after, in a smoke run).
- **Pan** moves the view once per frame, so all three layers are drawn: the series, the 500
  drawings in view (lines, fills, 50 texts and 50 Fibonacci retracements with seven labels each)
  and the overlay. Drawings out of view cost a time filter each. Against the same pan without
  drawings (`frames/candles-1m/pan-200`, below: p50 0.35–0.44 ms), 1,000 drawings add about
  0.1–0.2 ms at p50 and 0.5–0.7 ms at p99, nearly all of it canvas calls.

## Scenario

`drawings` cases (`benchmarks/src/harness/scenarios.ts`, `runDrawings`):

| Case                             | What                                                      |
| -------------------------------- | --------------------------------------------------------- |
| `drawings/candles-1m/1000/hover` | the gate: hover along the path with 1,000 drawings        |
| `drawings/candles-1m/0/hover`    | the same without drawings: crosshair and overlay alone    |
| `drawings/candles-1m/1000/drag`  | press a drawing found on the path, drag it along the path |
| `drawings/candles-1m/1000/pan`   | pan as `frames` does, at 300 bars in view                 |

- The drawing set (`benchmarks/src/drawings.ts`) cycles through the ten tools. Even-numbered drawings
  have their points on bars of the view (the last 300 bars), the others in the 15,000 bars of
  history before it, at least a view's width away. Spans run from 3 to 150 bars, prices around the
  bars' range. Rays, extended lines and horizontal lines from history can cross the view, as they do
  on real charts.
- 600 measured frames per run after 60 warm-up frames, or 10 s; every run here reached 600.
- Libraries without drawings (Lightweight Charts has none built in) are skipped.

## Regression check

The cases a change of the frame or tick path would show, on `main` and on this branch: ticks at the
latest 200 bars of 100k and 1M candles, pan at 200 bars and zoom at 20,000 bars of 1M candles, and
the price axes scenario with four axes. Charts without drawings do not create the drawings layer, the
time index asks nothing, and the frame adds a few comparisons.

First the two files run one after the other (two runs each), then two rounds of main and branch
interleaved, one run each (`stage-4-drawings-ab-main-1.json`, `-ab-branch-1`, `-ab-main-2`,
`-ab-branch-2`; load average 13.8 → 15.4 → 12.3, then 11.5 → 11.3 → 8.1). Cells are main → branch,
µs.

| Case, metric                             | Adapter      | Back to back  | Interleaved, round 1 | Round 2   |
| ---------------------------------------- | ------------ | ------------- | -------------------- | --------- |
| tick 1M latest, main thread per tick avg | lumen-worker | 3.1 → 4.4     | 1.7 → 1.8            | 2.0 → 1.9 |
| tick 1M latest, main thread per tick avg | lumen-main   | 2.8 → 4.1     | 1.7 → 2.1            | 3.6 → 2.9 |
| tick 1M latest, `update()` call avg      | lumen-worker | 0.5 → 0.7     | 0.3 → 0.3            | 0.4 → 0.3 |
| tick 100k latest, main thread per tick   | lumen-worker | 3.3 → 4.4     |                      |           |
| pan 200 bars, frame JS p50               | lumen-worker | 353 → 440     | 160 → 175            | 175 → 150 |
| pan 200 bars, frame JS p50               | lumen-main   | 403 → 425     | 170 → 165            | 155 → 265 |
| zoom 20,000 bars, frame JS p50           | lumen-worker | 1,323 → 1,308 |                      |           |
| zoom 20,000 bars, frame JS p50           | lumen-main   | 1,328 → 1,318 |                      |           |
| four price axes, pan 200, frame JS p50   | lumen-worker | 518 → 578     | 210 → 210            | 200 → 380 |
| four price axes, pan 200, frame JS p50   | lumen-main   | 540 → 580     | 220 → 195            | 190 → 290 |

- **No regression shows.** In the back-to-back pass the branch came out up to 1.3 µs per tick and
  25–90 µs per pan frame slower, but so did the `update()` call itself (0.5 → 0.7 µs), whose code
  this branch does not change: the machine got slower between the two files. Interleaved, main and
  branch differ by as much in one direction as in the other, and both halved against the first pass,
  so the differences are the machine's.
- What the branch adds to a chart without drawings: per engine event, two calls of the time index
  that return at once without drawings; per frame, a few comparisons and a cursor check. Charts
  with drawings pay for them only when the view or the drawings change (see Drag and pan).

## Known limits

- **Measured on one desktop under load from other work.** The mid-range Android device of the gate
  is not measured; the machine was shared, so absolute numbers moved by up to a factor of two
  between runs (see the hover without drawings).
- **Pan with many drawings in view costs canvas calls.** 500 drawings in view add 0.1–0.2 ms per pan
  frame at p50 and up to 0.7 ms at p99; text and Fibonacci labels are the expensive part. No
  batching of strokes across drawings of the same style is done.
- **A drawing far from the bars held appears a round trip later.** Its points are looked up in the
  data engine: with the engine in a worker, one message there and back, usually the next frame.
  After a new history (a new epoch) all drawings wait for that answer. Inside history the memory
  limit let go, points between bars are placed between the times the levels keep (every 16th bar).
- **Future times use the median spacing of the last 64 bars.** Sessions and holidays are not known,
  so a point a week ahead on daily bars sits seven bar slots ahead, not five.
- **Merged layers redraw drawings with the series.** Past the canvas budget (48M device pixels by
  default), a chart draws its drawings into the series layer: a hover still redraws the overlay
  alone, but every tick frame redraws the drawings too.
- **Dragging seeds the time index with every bar crossed** (a map entry per new time), and a time
  far outside the bars held is shifted by whole bars only where the bars or the ends are known.
- **Primitives and renderers take no part in autoscale and draw nothing on the axes yet**, and a
  series primitive stays on the scale its series had when it was attached.
- Rectangles and price ranges have handles at their two points, not at all four corners.
