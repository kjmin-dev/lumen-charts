# Firefox on the M1

`pnpm bench --browser firefox` runs the harness in headless Firefox. Firefox has no DevTools protocol, so its runs record no heap, worker or renderer memory, no main-thread counters and no forced garbage collections, and `--profile` and `--allocations` are refused; the page falls back to what it can measure itself (`harness/probes.ts`). None of the gate metrics need the protocol. The gate cases and the integrated mark cases ran in Firefox and in Chromium on the same machine, alternating the browser per invocation.

Firefox 157 keeps Playwright's device pixel ratio only until the page switches into a cross-origin isolated process: the harness page then drew at 1, not 2. Both runners now set the ratio with the `layout.css.devPixelsPerPx` preference, and the image comparisons check the ratio the page drew at. The earlier Firefox image comparisons at "DPR 2" ([integrated](integrated-mark-renderers.md), [per-chart](explicit-mark-renderers.md)) ran into the same override and most likely drew at 1 there too. Run again with the preference, every comparison passes at a real ratio of 1 and of 2: 63 with WebGL2, 39 with the native fallback (Firefox 157 returns no WebGPU adapter on this Mac), 40 with a pending adapter and 39 Canvas-only, at each ratio, 362 in all ([results](firefox-mark-charts.json)).

## Method

Apple M1 (8 cores, AC power), headless Chromium 156.0.8078.4 and headless Firefox 157.0, both from Playwright 1.64.1, viewport 1,280 × 720, DPR 2, chart 1,200 × 600 CSS pixels. The page is cross-origin isolated in both; the timer step is 5 µs in Chromium and 20 µs in Firefox, so Firefox's tick samples fall on 20 µs steps.

- **Gates**: `tick/candles-1m`, `frames/candles-1m` (the ten pan and zoom cases) and `drawings/candles-1m/1000/hover`, with `lumen-worker` and `lumen-main`, `--budget 1.5`, one run per case per invocation, three rounds with the browser order chromium–firefox, firefox–chromium, chromium–firefox. Twenty indicators on 1M candles (`ind-apply/candles-1m/all/20`) take minutes to load in Firefox, so that case ran three times in Chromium and once per engine in Firefox, after the rounds.
- **Mark cases**: the nine cases of the [Android table](android-physical.md#mark-series-frames), `lumen-worker`, `--budget 2`, Chromium with WebGL2, WebGPU and Canvas 2D and Firefox with WebGL2 and Canvas 2D (Firefox 157 has no WebGPU adapter on this Mac), five invocations per round in a rotated order, two rounds.
- **Load.** The machine ran an Android emulator and builds of other projects throughout: one-minute load averages of 14 to 238, recorded per run in the JSON. Absolute times are inflated for both browsers; the comparison rests on the alternation and on differences much larger than the spread of the runs.

## Gates

Per round: the one-minute load average at the start and end of the invocation, then the gate metrics, worker / local engine. Tick values in microseconds, the rest in milliseconds.

| Round, browser | Load average | Tick average (latest, all bars): worker / local | Tick p99 | Frame JS p95, worst of 10 pan and zoom cases | Hover frame JS p99 (hit test p99) |
| -------------- | ------------ | ----------------------------------------------- | -------- | -------------------------------------------- | --------------------------------- |
| 1, Chromium    | 40 → 107     | 0.33, 0.30 / 0.35, 0.33                         | 5 / 5    | 1.09 / 1.26                                  | 0.65 (0.05) / 0.65 (0.03)         |
| 1, Firefox     | 125 → 164    | 0.46, 0.40 / 0.76, 0.98                         | 20 / 20  | **148 / 107**                                | **19.6 (0.04) / 33.8 (0.14)**     |
| 2, Firefox     | 174 → 238    | 2.17, 1.42 / 0.42, 1.05                         | 20 / 20  | **342 / 322**                                | **105 (5.9) / 32.3 (0.14)**       |
| 2, Chromium    | 233 → 108    | 0.36, 0.43 / 0.37, 0.30                         | 5 / 5    | 1.21 / 1.26                                  | 0.62 (0.04) / 0.60 (0.03)         |
| 3, Chromium    | 99 → 58      | 0.31, 0.30 / 0.30, 0.33                         | 5 / 5    | 1.26 / 1.07                                  | 0.60 (0.16) / 0.55 (0.03)         |
| 3, Firefox     | 59 → 32      | 0.66, 0.36 / 0.48, 0.55                         | 20 / 20  | **54.3 / 34.8**                              | **17.3 (0.34) / 7.00 (0.32)**     |
| 4, Firefox     | 16 → 44      | not run                                         | –        | **94.0 / 84.7**                              | **19.5 (0.22) / 16.4 (0.04)**     |
| 4, Chromium    | 42 → 29      | not run                                         | –        | 1.09 / 1.29                                  | 0.80 (0.24) / 0.74 (0.03)         |

Twenty indicators on all 1M candles, tick to applied patch p99 against the 4 ms gate: Chromium 3.22, 1.50 and 1.76 ms with the worker and 0.75, 0.60 and 0.80 ms with the local engine (load 32–50); Firefox **26.1 ms** with the worker and **13.3 ms** with the local engine (load 50 at the start, 18 at the end), one run each. A Firefox run spent 3–6 minutes loading the indicators before it measured anything; a Chromium run takes 3–6 seconds in all.

Round 4 waited for the load average to fall below 15, then ran the frame and hover cases once more, Firefox first; the load rose again during the Firefox run.

- **Chromium meets every gate in every round**, whatever the load: tick average 0.30–0.43 µs and p99 one timer step (5 µs), worst pan or zoom frame 1.07–1.29 ms against 8 ms, hover 0.55–0.80 ms against 1 ms, 20 indicators 0.6–3.2 ms against 4 ms.
- **Firefox meets the tick gates** (average 0.36–2.2 µs, p99 one 20 µs step) **and misses the others in every round.** Its worst pan or zoom frame ranged from 35 to 342 ms, and even its best cases took 7–10 ms in round 4; hover took 7–105 ms, almost all of it the overlay redraw (the hit test stays under 0.4 ms except once); with 20 indicators a tick reached its patch at p99 13–26 ms.
- **Firefox degrades with load far more than Chromium.** Between round 3 (load 59 → 32) and round 2 (174 → 238) Firefox's worst frame grew from 54 to 342 ms while Chromium's stayed between 1.07 and 1.26 ms. An earlier single Firefox run on a load of about 24 took 3.5 ms at p95 for the 200-bar pan, against 6.3–79 ms in these rounds. The numbers above are an upper bound for this Mac; a quiet machine is needed to tell how much of Firefox's time is the browser and how much the load.

## Mark-series frames

Frame JS p95 in milliseconds, median of the two rounds with their range; bold over the budget. Load averages 19–40 during these runs. The last column is Firefox's frame interval p95 with WebGL2: the frames really are that far apart, not only measured so.

| Workload                  | Budget | Chromium WebGL2 JS  | Firefox WebGL2 JS    | Chromium Canvas 2D JS | Firefox Canvas 2D JS | Firefox WebGL2 interval |
| ------------------------- | ------ | ------------------- | -------------------- | --------------------- | -------------------- | ----------------------- |
| Scatter 100k zoom         | 8 ms   | 2.02 (1.89–2.14)    | **164 (113–216)**    | **10.5 (8.06–12.9)**  | **113 (58.9–167)**   | 174 (116–233)           |
| Scatter 300k zoom         | 8 ms   | 2.90 (2.88–2.92)    | **94.1 (87.9–100)**  | **15.2 (14.3–16.2)**  | **148 (73.7–222)**   | 92.5 (84.9–100)         |
| Scatter 1M zoom           | 8 ms   | 4.07 (3.87–4.27)    | **198 (166–230)**    | **44.2 (39.5–48.8)**  | **228 (227–228)**    | 175 (166–183)           |
| Scatter 1M append         | 4 ms   | 1.80 (1.58–2.02)    | **63.2 (62.5–63.9)** | 0.282 (0.270–0.295)   | **37.3 (26.4–48.2)** | 67.0 (66.7–67.3)        |
| Scatter 1M mixed          | 8 ms   | 1.86 (1.46–2.26)    | **89.4 (76.3–102)**  | **16.5 (16.4–16.5)**  | **72.9 (55.3–90.5)** | 83.6 (67.3–100)         |
| Heatmap 1.44M pan         | 8 ms   | 1.50 (1.43–1.58)    | **74.5 (62.3–86.7)** | **8.56 (7.83–9.30)**  | **67.8 (42.6–93.0)** | 83.9 (67.7–100)         |
| Heatmap 1.44M zoom        | 8 ms   | 1.01 (0.940–1.08)   | **106 (49.1–163)**   | **18.0 (16.6–19.4)**  | **153 (130–175)**    | 109 (50.9–167)          |
| Heatmap 1.44M last column | 4 ms   | 0.428 (0.400–0.455) | **47.5 (28.6–66.4)** | 0.468 (0.305–0.630)   | **8.30 (6.42–10.2)** | 58.7 (34.0–83.3)        |
| Heatmap 1.44M mixed       | 8 ms   | 0.988 (0.770–1.20)  | **62.9 (49.3–76.5)** | **9.97 (9.31–10.6)**  | **43.1 (38.1–48.0)** | 58.1 (49.5–66.7)        |

- Every mark case misses its budget in Firefox, with either backend, by 2 to 30 times; Chromium on the same machine at the same time fits every WebGL2 budget. Even replacing one heatmap column takes 28–66 ms with WebGL2 in Firefox, against 0.4–0.5 ms in Chromium.
- Firefox's WebGL2 path is slower than its own Canvas 2D path in six of the nine cases, which points at the cost of getting the GL image into the pane's 2D canvas, or at the canvas itself, rather than at the mark shaders. This run does not separate the two: headless Firefox's `about:support` did not load under Playwright, so whether its Canvas 2D or WebGL ran on the GPU is not recorded.

## Raw runs

- Gates, three rounds merged per browser: [Chromium](firefox-gates-chromium.json), [Firefox](firefox-gates-firefox.json); round 4: [Chromium](firefox-quiet-chromium.json), [Firefox](firefox-quiet-firefox.json)
- Twenty indicators: [Chromium](firefox-indicators-chromium.json), [Firefox](firefox-indicators-firefox.json)
- Mark cases, two rounds merged: [Firefox WebGL2](firefox-marks-webgl2.json), [Firefox Canvas 2D](firefox-marks-canvas2d.json); Chromium in [automatic selection](mark-renderer-auto.md#raw-runs)
- Image comparisons at real ratios 1 and 2: [Firefox](firefox-mark-charts.json)

## Reproduce

```sh
CASES=tick/candles-1m,frames/candles-1m,drawings/candles-1m/1000/hover
pnpm bench --browser chromium --lib lumen-worker,lumen-main --case $CASES --repeats 1 --budget 1.5 --out gates-chromium-1.json
pnpm bench --browser firefox --lib lumen-worker,lumen-main --case $CASES --repeats 1 --budget 1.5 --out gates-firefox-1.json
pnpm bench --browser firefox --lib lumen-worker,lumen-main --case ind-apply/candles-1m/all/20 --repeats 1 --budget 1.5
MARKS=scatter/candles-2k/cloud-100k/zoom,scatter/candles-2k/cloud-300k/zoom,scatter/candles-2k/cloud-1m/zoom,scatter/candles-2k/cloud-1m/tick,scatter/candles-2k/cloud-1m/tick-redraw,heatmap/candles-4800/2400x600/pan,heatmap/candles-4800/2400x600/zoom,heatmap/candles-4800/2400x600/tick,heatmap/candles-4800/2400x600/tick-redraw
pnpm bench --browser firefox --lib lumen-worker --mark-renderer webgl2 --case $MARKS --repeats 1 --budget 2
pnpm bench:merge gates-firefox.json gates-firefox-*.json
node benchmarks/runner/mark-charts.mjs --browser firefox --mode webgl2,native,pending,canvas-only --dpr 1,2
```
