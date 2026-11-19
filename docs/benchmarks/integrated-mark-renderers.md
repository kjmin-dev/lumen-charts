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

## Integrated frame measurements

Apple M1, hardware Metal, Chromium 156 headless, 1,200 × 600 CSS pixels at DPR 2 with the worker engine. Each column gives the median of three within-run p95s in milliseconds. JS covers the public operation and chart work in the animation callbacks. The GPU pass column uses a separate timestamp-query run. The auto path is the effective series path at the end of each run.

| Workload                  | Parent Canvas JS | Canvas JS | WebGPU JS | Auto JS | Auto path       | WebGPU pass |
| ------------------------- | ---------------: | --------: | --------: | ------: | --------------- | ----------: |
| Scatter 100k zoom         |             4.02 |      4.18 |      1.12 |    4.19 | canvas2d        |        0.79 |
| Scatter 300k zoom         |             9.88 |     10.05 |      1.22 |    1.19 | scatter-columns |        0.98 |
| Scatter 1M zoom           |            30.83 |     31.54 |      2.76 |    2.69 | scatter-columns |        2.16 |
| Scatter 1M append         |             0.22 |      0.24 |      0.29 |    0.30 | scatter-columns |           — |
| Scatter 1M mixed          |            15.13 |     16.79 |      1.26 |    1.24 | scatter-columns |           — |
| Heatmap 1.44M pan         |             9.42 |      7.77 |      0.78 |    0.79 | heatmap         |           — |
| Heatmap 1.44M zoom        |            16.12 |     15.02 |      0.85 |    0.86 | heatmap         |        1.31 |
| Heatmap 1.44M last column |             0.43 |      0.48 |      0.72 |    0.49 | canvas2d        |           — |
| Heatmap 1.44M mixed       |             9.84 |      9.11 |      0.77 |    0.79 | heatmap         |           — |

All nine median frame p95s fit the 8 ms pan/zoom and 4 ms update targets with explicit WebGPU and with adaptive selection on this desktop. The three auto runs had zero backend transitions inside every measured interval after warm-up. In this test, 100k scatter zoom and isolated heatmap column replacement stayed on Canvas 2D. Expensive scatter zooms and heatmap viewport redraws chose WebGPU. The fixed-range Canvas pan also improved against its parent, while dense zoom remains a reason to request acceleration.

Chromium compared 297 whole-chart states, WebKit 74 and Firefox 62. The DPR 2 Chromium paired fixture reached its first settled frame at about 107 ms and its first verified accelerated image at about 193 ms in this run. Its mark renderer high-water estimate was 7.8 MB. These startup numbers include constructing two charts, acquiring their data and scheduling frames.

The parent control used the unmodified library at `b86ac7a`. All four product matrices used the same public inputs, drawing and isolated preview build. The prototype tables elsewhere start with preprojected mark coordinates. The product results here include time and price mapping, window replacement, actual uploads and layer composition. The adaptive samples include its own decisions. Transition counts, path counts, held marks, LOD, sample counts, host load and browser cadence are in the run files. Window requests and workers can run between animation callbacks. Physical presentation latency requires an on-device display measurement.

[Parent Canvas 2D](integrated-marks-baseline.json) · [Canvas 2D](integrated-marks-canvas2d.json) · [WebGPU](integrated-marks-webgpu.json) · [Auto](integrated-marks-auto.json) · [GPU timestamp runs](integrated-marks-pass.json)

## Reproduction

```sh
node benchmarks/runner/mark-charts.mjs --mode hardware,unavailable,rejected --dpr 1,1.5,2
node benchmarks/runner/mark-charts.mjs --browser webkit --mode native --dpr 1,2
node benchmarks/runner/mark-charts.mjs --browser firefox --mode native --dpr 1,2
pnpm bench --scenario scatter,heatmap --lib lumen-worker --mark-renderer webgpu --repeats 3 --budget 2
```

Select `canvas2d` or `auto` with the same fixtures for a paired comparison. Add `--mark-gpu-timers` in a separate WebGPU run to sample the mark compute pass on devices supporting timestamp queries. Uploads, cache composition and the rest of the chart fall outside that counter. Frame JS and compositor/animation cadence are distinct metrics. Headless Chromium has a virtual display.

On a physical phone, serve the harness with `pnpm bench:serve`, forward the printed port to device localhost (for example `adb reverse tcp:4173 tcp:4173`) and open `http://localhost:4173/mark-renderers.html?run` in the device browser. The page uses its native DPR and emits a JSON correctness report. Record the phone model, browser, power mode, thermal state and repeated motion measurements before making a mobile performance claim.
