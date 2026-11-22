# Should `markRenderer: 'auto'` choose a backend?

Today `auto` resolves to the WebGL2 default ([renderer guide](../guide/heatmap-scatter.md#choosing-a-renderer)). Stage 5's step 6 allows an automatic choice only if paired whole-chart runs show a repeatable benefit across the intended devices, including the cost of switching. This compares the three backends on the same nine integrated cases on the Apple M1 and on the [physical Android phone](android-physical.md), measured with this branch.

**Recommendation: keep `auto` on WebGL2.** No workload shows a crossover that holds on both devices. Where WebGPU takes less JavaScript per frame, the phone's GPU needs longer than a frame for the compute pass, and WebGL2 is the only backend that keeps the phone at 60 Hz in pan and zoom. Canvas 2D is faster than WebGL2 only on a one-point scatter append, which is a gap in the WebGL2 renderer rather than a reason to switch backends. (Since closed on the M1: WebGL2 writes an append into its retained image as the other two paths do, [GPU mark renderer gaps](mark-gpu-device-gaps.md#webgl2-scatter-append); the phone is still to be measured.)

## Frame JS p95 by backend

The nine cases of the [per-chart](explicit-mark-renderers.md#webgl2-frame-time) and [integrated](integrated-mark-renderers.md#integrated-frame-measurements) tables, `lumen-worker`, 1,200 × 600 CSS pixels, `--budget 2`, one backend per invocation in rotated order. M1: headless Chromium 156 at DPR 2, two rounds, under one-minute load averages of 18–39 from other work ([Firefox comparison](firefox-frames.md#method)). Phone: Chrome 157 at DPR 2.625, three rounds ([physical Android](android-physical.md#mark-series-frames)). Medians of the per-run p95 in milliseconds; bold over the budget. The last column is the phone's frame interval p95 (16.6 ms is every display frame); headless Chromium's virtual display gives no comparable cadence.

| Workload                  | Budget | M1 WebGL2 | M1 WebGPU | M1 Canvas 2D | Phone WebGL2 | Phone WebGPU | Phone Canvas 2D | Phone interval p95, WebGL2 / WebGPU |
| ------------------------- | ------ | --------- | --------- | ------------ | ------------ | ------------ | --------------- | ----------------------------------- |
| Scatter 100k zoom         | 8 ms   | 2.02      | 1.82      | **10.5**     | 5.75         | 4.09         | **14.4**        | 16.6 / 33.2                         |
| Scatter 300k zoom         | 8 ms   | 2.90      | 2.66      | **15.2**     | 6.56         | 3.95         | **17.6**        | 16.6 / 33.2                         |
| Scatter 1M zoom           | 8 ms   | 4.07      | 3.58      | **44.2**     | **8.42**     | 6.80         | **65.9**        | 33.2 / 49.8                         |
| Scatter 1M append         | 4 ms   | 1.80      | 0.530     | 0.282        | **6.05**     | 1.14         | 1.19            | 16.6 / 16.6                         |
| Scatter 1M mixed          | 8 ms   | 1.86      | 2.00      | **16.5**     | 7.03         | **8.61**     | **83.6**        | 16.6 / 33.2                         |
| Heatmap 1.44M pan         | 8 ms   | 1.50      | 1.62      | **8.56**     | 3.67         | 2.98         | **19.4**        | 16.6 / 49.7                         |
| Heatmap 1.44M zoom        | 8 ms   | 1.01      | 2.11      | **18.0**     | 4.24         | 3.69         | **18.4**        | 16.6 / 49.7                         |
| Heatmap 1.44M last column | 4 ms   | 0.428     | 0.785     | 0.468        | 1.61         | 0.680        | 1.50            | 16.6 / 16.6                         |
| Heatmap 1.44M mixed       | 8 ms   | 0.988     | 0.952     | **9.97**     | 5.10         | 5.08         | **50.4**        | 16.6 / 33.1                         |

Where one backend beat another in every run on both devices:

- **WebGPU over WebGL2, JavaScript only**: the 1M-point zoom (M1 3.51 and 3.64 against 4.27 and 3.87 ms; phone 6.67–7.92 against 8.34–8.75 ms) and the one-point append (M1 0.46–0.60 against 1.58–2.02 ms; phone 1.09–1.23 against 5.97–6.14 ms). On the phone the zoom's WebGPU frames arrive every 50 ms at p95, against 33 ms with WebGL2: lower JavaScript, fewer frames.
- **WebGL2 over WebGPU**: heatmap zoom and the one-column heatmap update on the M1 (0.94–1.08 against 2.05–2.17 ms, 0.40–0.46 against 0.76–0.81 ms). On the phone WebGPU's JavaScript is lower for both, and its zoom shows 56–59 frames in 2 seconds against 121 with WebGL2.
- **Canvas 2D** beats WebGL2 only on the one-point append, on both devices (M1 0.27–0.29 ms, phone 1.15–1.21 ms), and misses every pan, zoom and mixed budget on both, by up to ten times.

Every other difference changes sign between runs or between devices. The 300k-point zoom, which the stage 5 roadmap singled out, fits the budget with WebGL2 on both devices (2.90 and 6.56 ms).

## What a rule would need

- **A signal other than main-thread time.** The former adaptive policy compared blocks of GPU draws with the Canvas median by frame JavaScript ([stage 5 roadmap](../design/stage-5-mark-renderers.md#original-implementation-decisions)). On the phone that signal points the wrong way: WebGPU's JavaScript is lower in every pan and zoom case while its frames come at half or a third of the display rate. A policy would have to read GPU time (timestamp queries, which Chrome on this phone has for WebGPU and not for WebGL2) or frame cadence, and frame cadence in a page is what the chart is trying to protect.
- **A crossover on more than one device.** The one place WebGPU beats WebGL2 on both devices without a cadence cost is an update that touches little: the one-point scatter append and the one-column heatmap update. Both are already within budget with WebGL2 on the M1, and the append's miss on the phone has a narrower fix: patch the cached image in the WebGL2 renderer as the Canvas 2D and WebGPU paths do, instead of redrawing a million points.
- **The cost of switching.** A switch rebuilds the series' GPU resources (index, uploads, pipelines on first use) and the first frames after it draw through the fallback. None of the measured workloads gains enough on both devices to pay that back.

Rule to adopt now: `auto` = WebGL2, as today. Revisit with a mid-range Android device, an x86 machine with a discrete GPU and a WebGL2 append patch in place; until then, applications that measure a benefit on their own target can still request `webgpu` explicitly.

The WebGL2 append patch is now in place ([GPU mark renderer gaps](mark-gpu-device-gaps.md#webgl2-scatter-append)): on the M1 the 1M-point append takes 0.280 ms of frame JS at p95 with WebGL2 (three runs, 0.265–0.455), against 1.07 ms before, and does the same work as the Canvas 2D and WebGPU patches. That removes the one place where the M1 table above favored WebGPU without a cadence cost only because of WebGL2's append; the phone's numbers, and with them the rule, await a run on the device.

## Raw runs

- M1, Chromium: [WebGL2](mark-renderer-auto-m1-webgl2.json), [WebGPU](mark-renderer-auto-m1-webgpu.json), [Canvas 2D](mark-renderer-auto-m1-canvas2d.json)
- Phone: [WebGL2](android-marks-webgl2.json), [WebGPU](android-marks-webgpu.json), [Canvas 2D](android-marks-canvas2d.json), [WebGPU timers](android-marks-gpu.json)
