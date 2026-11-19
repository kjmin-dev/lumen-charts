# Integrated mark renderer qualification

The public chart API renders a candlestick series, a drawing and either a scatter or heatmap series. The worker supplies real level-of-detail windows. Pan and zoom move the chart's time scale. A scatter tick appends after the final timestamp in the generated dataset. A heatmap tick replaces the last column. The mixed case issues seven updates and moves the visible range on the eighth frame.

## Desktop capability and correctness

| Environment on Apple M1    | Coverage                                                                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Headless Chromium 156      | Hardware WebGPU at DPR 1, 1.5 and 2. Adapter absence and rejected initialization at all three DPRs.                                                  |
| Playwright WebKit 27.2     | Hardware WebGPU at DPR 1 and 2. WebKit reported its isolation policy blocking the module worker, exercising the chart's main-thread engine fallback. |
| Headless Firefox 157       | Native adapter request returned no usable adapter on this host. Canvas 2D fallback passed at DPR 1 and 2.                                            |
| Physical mid-range Android | No physical device was connected during qualification. Mobile performance and an Android-specific crossover remain unmeasured.                       |

The suite compares every byte of each chart canvas against the Canvas 2D reference after each operation. A separate readback canvas avoids changing the production rasterizer. Checks include 16 fractional zoom positions, session gaps, resize, log axes, variable gain and opacity, identical timestamps, a dense scatter, reduced heatmap cells, layering, public data queries, save/restore and live preference changes. Hardware tests destroy the shared device during an update. They also exhaust and restore the page budget, verify shared device ownership across charts, and check rendering-budget accounting after teardown. The first-frame and ready times in these files include fixture setup and settling. Peak bytes sum the two series' observed high-water estimates for mark GPU buffers and backend canvases. [Chromium](mark-charts-chromium.json) · [WebKit](mark-charts-webkit.json) · [Firefox](mark-charts-firefox.json)

## Reproduction

```sh
node benchmarks/runner/mark-charts.mjs --mode hardware,unavailable,rejected --dpr 1,1.5,2
node benchmarks/runner/mark-charts.mjs --browser webkit --mode native --dpr 1,2
node benchmarks/runner/mark-charts.mjs --browser firefox --mode native --dpr 1,2
pnpm bench --scenario scatter,heatmap --lib lumen-worker --mark-renderer webgpu --repeats 3 --budget 2
```

Select `canvas2d` or `auto` with the same fixtures for a paired comparison. Add `--mark-gpu-timers` in a separate WebGPU run to sample the mark compute pass on devices supporting timestamp queries. Uploads, cache composition and the rest of the chart fall outside that counter. Frame JS and compositor/animation cadence are distinct metrics. Headless Chromium has a virtual display.

On a physical phone, serve the harness with `pnpm bench:serve`, forward the printed port to device localhost (for example `adb reverse tcp:4173 tcp:4173`) and open `http://localhost:4173/mark-renderers.html?run` in the device browser. The page uses its native DPR and emits a JSON correctness report. Record the phone model, browser, power mode, thermal state and repeated motion measurements before making a mobile performance claim.
