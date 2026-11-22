# Visible-row projection threshold

The WebGPU scatter column kernel reads only the rows in view. When a draw starts over (a new engine window, a new price projection, a style change, or a view outside the rows projected so far), it projects the rows in view, and later pans project the rows that come into view ([WebGPU specialized paths](webgpu-specialized-paths.md#scatter-projection)). That halved the trade-history pan but moved work on the raw 1M cloud: there, p95 rose by 0.1–0.2 ms and the mean fell. The study proposed a threshold, "below a minimum share of held rows saved, project them all", and left it uncalibrated.

This branch calibrates and implements it. A draw that starts over now projects every row held when the rows in view would leave out fewer than `MIN_UNPROJECTED_SHARE` = 0.4 of them (`startRows` in [the renderer](../../packages/core/src/marks/gpu/renderer.ts), unit-tested in [mark-gpu-projection.test.ts](../../packages/core/test/mark-gpu-projection.test.ts)). The tile path builds its index from every row and is unchanged.

## What the fixtures hold when a draw starts over

An instrumented copy of the renderer at `aef336f` recorded, for every column draw that started over, the rows in view and the rows held. Headless Chromium on the Apple M1, DPR 2, 1,200 × 600 CSS pixels, `lumen-worker`, `--mark-renderer webgpu`, one run of each case. [Recorded draws](projection-threshold-shares.json)

| Case                      | Draws | Start-overs (new projection / new window) |  Rows held | Share of held rows in view at each start-over, in order          | Rows a pan projects, mean |
| ------------------------- | ----: | ----------------------------------------- | ---------: | ---------------------------------------------------------------- | ------------------------: |
| cloud, 1M, pan            |   145 | 7 (5 / 3)                                 | 1.50–1.98M | 0.67 0.57 0.57 0.51 0.51 0.47 0.34                               |                     6,368 |
| cloud, 1M, zoom           |   149 | 7 (5 / 3)                                 | 1.50–2.00M | 0.70 0.67 0.74 0.73 0.66 0.48 0.36                               |                     6,374 |
| trades, 5M, pan (level 3) |   152 | 34 (32 / 3)                               |   268–354k | nine at 1.00, then 0.56 0.56 0.56, 0.50–0.51 (15), 0.30–0.34 (7) |                       863 |

- The 1M cloud does not have nearly every held row in view, as the earlier document assumed: the engine holds up to 2M rows around the 1M in view. What sets it apart from the trade pan is how often a draw starts over: about one draw in 21 on the cloud, one in 4.5 on the trades, whose price projection changes as the view moves.
- On the cloud, a start-over is rare enough to stay above p95, and the rows it leaves out come back a strip at a time on the following frames: those strips are what raised p95. On the trades, start-overs are the p95 frames, and projecting half the rows is what made them cheaper.
- A share alone cannot tell the cloud pan (0.34–0.67, median 0.51) from the trade pan (median 0.51). It does separate the cloud zoom, whose start-overs mostly see 0.66–0.74 of the rows, from every trade start-over with rows out of view (at most 0.56). Any minimum left-out share above 0.34 and at most 0.44 draws the same on these fixtures; 0.4 is in the middle.

## Paired runs

Three copies of this branch's packages that differ only in `MIN_UNPROJECTED_SHARE`: 0 (never project all: `main`'s behavior), 0.4 and 0.5. They alternated one invocation at a time in four rounds, rotating the order, through `--packages`: `lumen-worker`, `--mark-renderer webgpu`, `--budget 2`, one run per case per invocation, headless Chromium 156 on the Apple M1 (8 cores). Frame JS in milliseconds: the median of the four per-run values, then the runs in round order.

Set 1 ran while the machine's one-minute load average was 5.3–12.9. It ran before the runners served each run on a port of its own (see [the Android harness](android-physical.md#running-on-a-device)): another checkout's preview server on the default port could in principle have answered a run, which the consistent 0.5 results make unlikely but do not exclude. Set 2 repeated the four rounds with isolated servers, under a load average of 23–126 from an Android build and emulator on the same machine; its absolute times are higher.

| Case          | Metric | Set | Share 0                       | Share 0.4                     | Share 0.5                     |
| ------------- | ------ | --- | ----------------------------- | ----------------------------- | ----------------------------- |
| cloud 1M zoom | p95    | 1   | 2.29 [2.88, 2.30, 2.19, 2.28] | 2.11 [2.71, 2.13, 2.10, 2.09] | 2.11 [2.11, 2.12, 2.12, 2.02] |
| cloud 1M zoom | p95    | 2   | 3.70 [3.26, 3.84, 3.94, 3.56] | 3.45 [2.85, 3.53, 3.63, 3.37] | 3.44 [2.75, 4.91, 3.55, 3.32] |
| cloud 1M zoom | mean   | 1   | 1.96 [2.11, 1.99, 1.93, 1.84] | 2.05 [2.09, 2.14, 1.93, 2.00] | 1.98 [2.07, 2.22, 1.87, 1.90] |
| cloud 1M zoom | mean   | 2   | 2.11 [1.95, 2.32, 2.21, 2.02] | 2.39 [2.23, 2.72, 2.54, 2.13] | 2.40 [2.11, 3.14, 2.49, 2.31] |
| cloud 1M pan  | p95    | 1   | 1.72 [1.63, 1.97, 1.74, 1.70] | 1.87 [2.05, 3.16, 1.63, 1.69] | 1.85 [1.79, 1.92, 1.61, 1.93] |
| cloud 1M pan  | p95    | 2   | 3.30 [3.40, 3.12, 3.89, 3.20] | 3.56 [3.46, 2.86, 3.69, 3.67] | 2.88 [1.68, 3.38, 3.01, 2.74] |
| trades 5M pan | p95    | 1   | 3.43 [3.68, 3.92, 3.17, 3.10] | 3.38 [3.59, 3.57, 3.19, 3.20] | 5.62 [6.47, 5.59, 5.64, 5.36] |
| trades 5M pan | p95    | 2   | 3.55 [3.52, 3.30, 3.75, 3.58] | 3.31 [3.32, 3.30, 3.24, 3.36] | 6.52 [5.31, 8.44, 7.73, 5.27] |
| trades 5M pan | mean   | 2   | 1.50 [1.50, 1.50, 1.49, 1.59] | 1.46 [1.49, 1.35, 1.46, 1.46] | 1.99 [1.56, 2.39, 2.35, 1.63] |

- **0.5 is too high.** It projects every held row at the trade pan's start-overs that see half the rows, and the pan's p95 rises by 1.7–5.1 ms in all eight rounds: the gain of visible-row projection is gone.
- **0.4 keeps the trade pan** (p95 3.38 against 3.43 and 3.31 against 3.55; mean unchanged) and **lowers the cloud zoom's p95 in all eight rounds**, by 0.09–0.41 ms. As the cost model above predicts, it raises the cloud zoom's mean, by up to 0.4 ms (higher in six of the eight rounds): the start-over frames, above p95, now project all the rows. The budget is a p95, so the threshold trades mean for p95 there, about the 0.1–0.2 ms the visible-row change had added to p95.
- **The cloud pan does not change in a way the runs resolve** (lower in four rounds of eight). Under 0.4 only its first start-over, in the warm-up, sees more than 0.6 of the rows.
- All values stay far inside the 8 ms budget. The threshold is a tuning of where work falls, not a fix of a budget miss.

## On the phone

The same three cases ran on the [physical Android phone](android-physical.md) (Snapdragon 8 Elite, Chrome 157, DPR 2.625, the same 1,200 × 600 CSS-pixel chart), shares 0 and 0.4 alternating in three rounds. Frame JS in milliseconds, median and runs in round order:

| Case          | Metric | Share 0                 | Share 0.4               |
| ------------- | ------ | ----------------------- | ----------------------- |
| cloud 1M zoom | p95    | 6.92 [9.50, 6.91, 6.92] | 7.53 [6.02, 7.53, 8.20] |
| cloud 1M pan  | p95    | 7.79 [6.07, 8.47, 7.79] | 8.16 [5.69, 8.82, 8.16] |
| trades 5M pan | p95    | 8.69 [9.43, 8.69, 8.48] | 8.28 [9.40, 7.92, 8.28] |
| trades 5M pan | mean   | 3.44 [3.66, 3.44, 3.36] | 3.30 [3.43, 3.30, 3.22] |

On the phone the three runs of one side spread over 1.0–3.1 ms, more than any effect of the threshold: the cloud cases do not resolve. The trade pan was lower with 0.4 in all three rounds, by 0.03–0.77 ms. With WebGPU, these cases sit at the 8 ms budget on this phone, and the GPU holds every frame for two or three display refreshes (frame interval p95 33–50 ms), as in the other [WebGPU runs on the phone](android-physical.md#mark-series-frames).

## Correctness

The image comparisons gained two states for this branch: a view over most of a 1.32M-point scatter, whose draw starts over with more than 0.6 of the held rows in view and projects them all, then a pan inside those rows, which projects none. A copy of the renderer that throws on that branch fails exactly at the first of the two, so the suite reaches it. Headless Chromium on the M1 passes byte for byte with hardware WebGPU (58 checks) and WebGL2 (63) at DPR 1, 1.5 and 2.

## Raw runs

- Start-overs in the instrumented copy: [shares](projection-threshold-shares.json)
- Set 1: [0](projection-threshold-set1-0.json), [0.4](projection-threshold-set1-0.4.json), [0.5](projection-threshold-set1-0.5.json)
- Set 2: [0](projection-threshold-0.json), [0.4](projection-threshold-0.4.json), [0.5](projection-threshold-0.5.json)
- Phone: [0](android-projection-0.json), [0.4](android-projection-0.4.json)

## Reproduce

```sh
S=$(mktemp -d)
for share in 0 0.4 0.5; do
  mkdir -p "$S/$share" && git archive HEAD packages | tar -x -C "$S/$share"
  sed -i '' "s/^export const MIN_UNPROJECTED_SHARE = .*/export const MIN_UNPROJECTED_SHARE = $share;/" \
    "$S/$share/packages/core/src/marks/gpu/renderer.ts"
done
CASES=scatter/candles-2k/cloud-1m/pan,scatter/candles-2k/cloud-1m/zoom,scatter/candles-2k/trades-5m/pan
# One invocation per copy, rotating the order each round:
pnpm bench --packages "$S/0.4/packages" --lib lumen-worker --mark-renderer webgpu --case $CASES --repeats 1 --budget 2 --out t40-1.json
pnpm bench:merge threshold-0.4.json t40-*.json
pnpm bench --android <serial> --packages "$S/0.4/packages" --lib lumen-worker --mark-renderer webgpu --case $CASES --repeats 1 --budget 2
node benchmarks/runner/mark-charts.mjs --mode hardware --dpr 1,1.5,2
```
