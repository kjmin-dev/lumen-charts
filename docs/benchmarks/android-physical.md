# Physical Android device

The harness and the whole-chart image comparisons now run in Chrome on an Android device connected over USB. This document records the first physical run, on a Samsung Galaxy Z Fold7. The phone is a **flagship**, not the mid-range reference device of design section 9, so its numbers qualify nothing for mid-range phones: they show how the chart behaves on a fast mobile GPU and where it does not fit the budgets even there.

## Running on a device

```sh
adb devices -l        # lists the device's serial
SERIAL=<serial>
pnpm bench --android $SERIAL --case frames/candles-1m --lib lumen-worker,lumen-main --repeats 3 --budget 1.5
node benchmarks/runner/mark-charts.mjs --android $SERIAL --mode webgl2,native,pending,canvas-only
node benchmarks/prototypes/webgpu-specialization/transitions.mjs --android $SERIAL --sizes 3,5,7,9
```

- The computer builds and serves the pages on 127.0.0.1 at a port of its own. `adb reverse` makes that port the device's localhost, a secure context, so WebGPU and cross-origin isolation work as on the desktop. `adb forward` reaches Chrome's DevTools socket, and Playwright drives Chrome with `connectOverCDP`. Chrome is started if it does not run; USB debugging must be enabled and the computer allowed.
- Pages open as tabs in Chrome's own profile, at the device's real viewport and device pixel ratio: Chrome on Android cannot create browser contexts with an emulated window. `--viewport`, `--dpr`, `--headed` and `--channel` are refused; `--chart` still sets the chart's CSS size. The image comparisons run every mode twice, with the worker engine and with the local one, instead of once per `--dpr`.
- The probes that need the DevTools protocol work as on the desktop: garbage collection, heap and worker memory, main-thread counters and GPU timers. Renderer memory comes from the device's `ps`. `--profile` and `--allocations` were not tried on the device.
- `svc power stayon usb` keeps the screen on while USB powers the device, and the previous setting is restored at the end. Every run records the battery (level, temperature, power source) and the thermal service's status and temperatures before and after it, in `host.device` of the results file. Tabs the runner opened are closed at the end.
- Another adb client on the same computer can restart the adb server, which drops both port mappings and silences the DevTools connection. The runner then reconnects, closes the tabs left behind and runs the interrupted run again once. During these measurements this happened about every five minutes while an Android build ran on the same Mac.

## Device and method

| Item           | Value                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Device         | Samsung Galaxy Z Fold7 (SM-F966N), folded, cover display 1080 × 2520 at 420 dpi                                             |
| System on chip | Snapdragon 8 Elite (SM8750), Adreno 830 GPU, 8 cores reported to the page                                                   |
| Software       | Android 17 (SDK 37), Chrome 157.0.8103.78                                                                                   |
| WebGL2         | ANGLE on OpenGL ES 3.2 (`ANGLE (Qualcomm, Adreno (TM) 830, OpenGL ES 3.2)`)                                                 |
| WebGPU         | Hardware adapter `qualcomm` / `adreno-8xx`, with `timestamp-query`; preferred canvas format `rgba8unorm`                    |
| Page           | Device pixel ratio 2.625, cross-origin isolated, 5 µs timer step, animation frames every 16.6 ms (60 Hz)                    |
| Power and heat | USB powered and charging, 98–99% charge; thermal status 0 (none) in every run; battery 27.5–31 °C, SoC (AP) sensor 32–47 °C |

The harness chart keeps its desktop size of 1,200 × 600 CSS pixels, so every case holds the same data and view as on the desktop. At the phone's ratio that is 3,150 × 1,575 device pixels, 1.72 times the 2,400 × 1,200 of the desktop runs at DPR 2. The chart is wider than the phone's layout viewport (412 CSS pixels), so Chrome shows the page zoomed out; the page reports a 1,200 × 2,470 viewport. Frame intervals here come from a real display, unlike headless Chromium's virtual one.

Each mark case ran three times per renderer, one renderer per invocation, rotating the order of the three renderers in each round. The tables give the median over runs of the per-run p95, with the range of the runs in parentheses. The library is this branch, including the [projection threshold](projection-threshold.md).

## Whole-chart image comparisons

The [qualification page](explicit-mark-renderers.md#whole-chart-image-comparisons) compares every canvas layer of a chart against an explicit Canvas 2D chart after each operation. On the phone, only Canvas-only operation matches byte for byte. Every layer drawn through WebGL2 or WebGPU differs from Canvas 2D by one step of a channel value in places, and by two in one state:

| Mode on the phone, worker and local engine  | Byte for byte                                                                                         | Within 2 per channel: checks passed | States with differences | Largest difference |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------: | ----------------------: | -----------------: |
| `webgl2` (default)                          | fails at the first state: 20,595 channel values differ by 1                                           |                              63 × 2 |                45 of 63 |                  2 |
| `native` (hardware WebGPU on Adreno)        | fails at the 34th state (an oscillator pane added): 15 values differ by 1; the 33 states before match |                              58 × 2 |                23 of 58 |                  2 |
| `unavailable`, `rejected` (WebGL2 fallback) | fails at the first state, as `webgl2`                                                                 |                         39 × 2 each |                26 of 39 |                  1 |
| `pending` (WebGL2 while waiting)            | fails at the first state, as `webgl2`                                                                 |                              40 × 2 |                27 of 40 |                  1 |
| `canvas-only`                               | passes, 39 × 2                                                                                        |                              39 × 2 |                       0 |                  0 |

Within the tolerance, 556 comparisons passed in all, at the phone's ratio of 2.625; 78 of them, the Canvas-only ones, also pass byte for byte.

- Canvas-only operation passes byte for byte, so the reference itself is stable on this device. The differences come from the GPU paths, all in layer 0, the pane canvas that holds the marks.
- The WebGL2 path differs from the first state on, in 18,000–20,800 channel values per state through the fractional zooms, opacity, log scale and resize, by one step each. Hardware WebGPU matches byte for byte through the first 33 states (fractional zooms, opacity, logarithmic scale, resize, palette and gain, fixed and automatic value ranges, column updates, the dirty tail, partial compositions) and differs by one step from the state that adds an oscillator pane on. The largest difference is 2, in the dense 390,000-point scatter, with WebGL2 and with WebGPU.
- Within a tolerance of 2, every functional check passes: fallback reasons, budget fallback and recovery, shared GL context and WebGPU device, context and device loss, upload sizes of palette-only and one-column changes, the wide WebGPU kernel at 9 device pixels, renderer resources released after teardown. On the M1, headless Chromium (hardware WebGPU and WebGL2) and Firefox still pass byte for byte with the same suite (`--tolerance 0`, the default).
- The cause of the one-step differences is not isolated. They are consistent with rounding in Adreno's blending or format conversion of the semi-transparent heatmap and scatter colors, but this run does not show which operation rounds differently. Until it is found, the Android qualification of image equality is "within 2 per channel", not byte for byte.
  - Later, on the M1 ([GPU mark renderer gaps](mark-gpu-device-gaps.md#one-step-differences)): the WebGL2 drawing buffer held straight colors, which the browser premultiplies on a path of its own when it draws the buffer into a 2D canvas, while Canvas 2D premultiplies in `putImageData`. Rounding that premultiplication differently reproduces this signature exactly on the M1. WebGL2 now uploads colors premultiplied by the page's own `putImageData` into a premultiplied buffer, and WebGPU premultiplies by the same rule instead of in its kernels. The WebGPU path differed from the first state with a price pane clip on; it now composites its image with the same transposed draw as the other paths. Both await a run on the phone.
- In the WebGPU modes Chrome logs "WebGPU canvas configured with a different format than is preferred by this device ("rgba8unorm"). This requires an extra copy, which may impact performance." The device's preferred format is `rgba8unorm` and the renderer configures that format for its canvas, so what the warning refers to is not settled here.
  - Later, from Chromium's source ([GPU mark renderer gaps](mark-gpu-device-gaps.md#the-extra-copy)): on Android Chrome copies the texture of a canvas configured with storage usage into a second one, and logs this warning for any such copy, whatever its cause. The renderer's canvas no longer has storage usage.

## Mark-series frames

The cases of the [WebGL2 frame table](explicit-mark-renderers.md#webgl2-frame-time) and of the [integrated qualification](integrated-mark-renderers.md#integrated-frame-measurements): a worker chart with candles, a drawing and a scatter or heatmap series, `--budget 2`. Frame JS p95 and frame interval p95 in milliseconds; bold where the median exceeds the design's budget (8 ms for pan, zoom and mixed, whose p95 falls on the redraw in every eighth frame; 4 ms for an update). The WebGPU pass column is the compute pass p95 from separate runs with `--mark-gpu-timers`, two per case.

| Workload                  | Budget | WebGL2 JS            | WebGPU JS            | Canvas 2D JS         | WebGL2 interval  | WebGPU interval  | Canvas 2D interval | WebGPU pass         |
| ------------------------- | ------ | -------------------- | -------------------- | -------------------- | ---------------- | ---------------- | ------------------ | ------------------- |
| Scatter 100k zoom         | 8 ms   | 5.75 (5.72–6.55)     | 4.09 (3.51–4.47)     | **14.4 (14.0–15.3)** | 16.6 (16.6–16.6) | 33.2 (33.2–33.2) | 16.6 (16.6–16.6)   | 7.63 (6.62–8.65)    |
| Scatter 300k zoom         | 8 ms   | 6.56 (6.44–6.78)     | 3.95 (2.59–5.60)     | **17.6 (16.9–22.7)** | 16.6 (16.6–16.6) | 33.2 (33.2–49.7) | 16.6 (16.6–16.6)   | 8.03 (7.67–8.39)    |
| Scatter 1M zoom           | 8 ms   | **8.42 (8.34–8.75)** | 6.80 (6.67–7.92)     | **65.9 (50.4–66.5)** | 33.2 (33.2–33.2) | 49.8 (49.8–51.1) | 66.5 (51.1–66.7)   | 15.1 (13.3–16.9)    |
| Scatter 1M append         | 4 ms   | **6.05 (5.97–6.14)** | 1.14 (1.09–1.23)     | 1.19 (1.15–1.21)     | 16.6 (16.6–16.6) | 16.6 (16.6–16.6) | 16.6 (16.6–16.6)   | –                   |
| Scatter 1M mixed          | 8 ms   | 7.03 (5.68–7.07)     | **8.61 (8.56–9.42)** | **83.6 (48.5–91.4)** | 16.6 (16.6–16.6) | 33.2 (33.2–33.2) | 82.9 (49.7–82.9)   | 12.7 (12.6–12.7)    |
| Heatmap 1.44M pan         | 8 ms   | 3.67 (3.44–3.84)     | 2.98 (2.86–3.12)     | **19.4 (14.7–19.4)** | 16.6 (16.6–16.6) | 49.7 (33.2–49.7) | 16.6 (16.6–16.6)   | 7.96 (7.21–8.72)    |
| Heatmap 1.44M zoom        | 8 ms   | 4.24 (4.22–4.26)     | 3.69 (3.41–3.79)     | **18.4 (17.2–22.4)** | 16.6 (16.6–16.6) | 49.7 (49.7–49.7) | 16.6 (16.6–33.2)   | 10.2 (10.2–10.2)    |
| Heatmap 1.44M last column | 4 ms   | 1.61 (1.53–1.76)     | 0.680 (0.620–0.710)  | 1.50 (1.34–1.58)     | 16.6 (16.6–16.6) | 16.6 (16.6–16.6) | 16.6 (16.6–16.6)   | 0.164 (0.131–0.197) |
| Heatmap 1.44M mixed       | 8 ms   | 5.10 (5.00–5.23)     | 5.08 (1.36–5.20)     | **50.4 (47.3–54.6)** | 16.6 (16.6–16.6) | 33.1 (16.6–33.1) | 49.7 (33.2–49.7)   | 6.78 (6.68–6.88)    |

The WebGPU column holds three runs per case, except scatter 300k zoom and scatter 1M append: one of their three rounds lost its run to an adb restart, and a fourth invocation replaced it (the merged file keeps the failed runs). That replacement 300k zoom took 2.59 ms with 102 frames in 2 seconds, against 3.95–5.60 ms and 64–65 frames in the other two runs.

- **WebGL2, the default,** keeps the phone at 60 Hz in eight of the nine cases and fits the budgets in seven. It misses on the 1M-point zoom (8.42 ms against 8 ms; 87 frames in the 2-second budget instead of 120) and on the 1M-point append (6.05 ms against the 4 ms update budget). An append redraws the whole WebGL2 layer; Canvas 2D and WebGPU patch the cached image instead and take 1.1–1.2 ms. (Later, on the M1: a WebGL2 append drew a strip of the pane, but computed the column ranges of the whole pane and copied the strip back from the GL canvas; it now writes into its retained image as the other two do, [GPU mark renderer gaps](mark-gpu-device-gaps.md#webgl2-scatter-append).) On the M2 Pro the same append took 1.95 ms with WebGL2 ([per-chart renderers](explicit-mark-renderers.md#webgl2-frame-time)).
- **WebGPU** takes the least JavaScript per frame (13–40% less than WebGL2 in pan and zoom), but its compute pass alone takes 7.6–15 ms on the Adreno 830, against 0.8–2.2 ms on the M1 ([integrated measurements](integrated-mark-renderers.md#integrated-frame-measurements)). In 14 of the 15 WebGPU pan and zoom runs, every viewport redraw therefore spanned two or three display frames: 56–66 frames in 2 seconds, frame interval p50 33 ms and p95 33–50 ms, where WebGL2 holds 16.6 ms. The fifteenth, the replacement 300k zoom, held 16.6 ms at p50 with 102 frames; what changed in the phone's state for that run is not known. The mixed scatter case also misses on JavaScript (8.61 ms). Updates that redraw one column or patch one point stay at 60 Hz.
- **Canvas 2D** misses every pan and zoom budget, by 2–8 times (14–66 ms); the 1M-point zoom shows 38 frames in 2 seconds. It fits the update budgets: 1.19 ms for a scatter append, 1.50 ms for a heatmap column.
- **Palette slots** halve the heatmap's GPU time on Adreno as on the M1: with a fixed value range the compute pass p95 falls from 7.96 to 4.72 ms in pan and from 10.2 to 6.59 ms in zoom. The pan still drops frames (interval p95 33 ms).
- Chrome on this phone exposes no `EXT_disjoint_timer_query_webgl2`, so the WebGL2 runs with `--mark-gpu-timers` recorded no GPU samples.

## Core gates

The gate cases of design section 9 that a phone changes: tick cost with 1M candles, pan and zoom frames over 1M candles, ticks applied with 20 indicators, and hover over 1,000 drawings. Three runs per case and engine, `--budget 1.5` (a tick run then measures 9,100 ticks rather than 10,000). Medians over runs, with the range of the runs; bold where the median misses the gate.

| Criterion (1M candles)                               | Gate   | lumen-worker          | lumen-main            | Met on the phone   |
| ---------------------------------------------------- | ------ | --------------------- | --------------------- | ------------------ |
| Tick average, latest 200 / all bars in view          | 0.1 ms | 2.2 / 2.2 µs          | 2.3 / 2.1 µs          | yes                |
| Tick p99, latest 200 / all bars in view              | 1 ms   | 10 / 10 µs            | 10 / 10 µs            | yes                |
| Frame JS p95, worst of 10 pan and zoom cases         | 8 ms   | 4.26 (zoom, 20k bars) | 4.29 (zoom, 20k bars) | yes                |
| Tick to applied patch p99, 20 indicators, latest 200 | 4 ms   | 3.73 (3.60–4.03)      | 2.55 (1.16–3.93)      | yes (one run over) |
| Tick to applied patch p99, 20 indicators, all bars   | 4 ms   | **4.39 (3.83–4.77)**  | 1.00 (0.73–1.15)      | main thread only   |
| Hover frame JS p99, 1,000 drawings                   | 1 ms   | **1.38 (1.29–1.42)**  | **1.41 (1.34–1.54)**  | no                 |

Frame JS p95 of the ten pan and zoom cases, worker / local engine, in milliseconds: 200 bars 1.47 / 1.46 (pan) and 1.64 / 1.62 (zoom); 2,000 bars 2.71 / 2.70 and 3.77 / 3.80; 20,000 bars 3.50 / 3.53 and 4.26 / 4.29; 200,000 bars 3.62 / 3.61 and 3.80 / 3.94; all bars 3.09 / 3.17 and 3.05 / 3.03. The runs of a case lie within 0.15 ms of each other, except one worker zoom over all bars at 0.86 ms. Frame interval p95 is 16.6 ms in every case. On the M1 the worst of these cases was 2.98 ms in stage 1 (headed) and 1.2 ms in this branch's headless runs.

- Tick samples fall on the 5 µs timer step and are mostly 0; the p99 of 10 µs is two steps. The main thread spends 7.8–10.5 µs per tick including paint, the most with all bars in view.
- With 20 indicators and all 1M bars in view, a tick applied through the worker waits for the frame in progress, as on the M1 before the [idle wait and packed patches](gc-floor.md): here the frame is longer, and the worker's p99 is 3.8–4.8 ms against 0.67–0.98 ms on the M1 (1.5–3.2 ms in this branch's runs on the loaded M1, [Firefox comparison](firefox-frames.md)). The local engine stays at 0.7–1.2 ms.
- Hover misses by 0.3–0.5 ms. The overlay redraw is the cost (p50 0.95 ms, p99 1.25–1.53 ms); hit testing over the 1,000 drawings takes 12 µs on average and 0.09–0.36 ms at p99, so a spatial index would not change the result. Stage 4 predicted this split for a slower device ([stage 4 drawings](stage-4-drawings.md)). The 1,200 × 600 CSS-pixel overlay is 3,150 × 1,575 device pixels here; a chart the width of the phone's screen (412 CSS pixels) clears about a third of that area per redraw, which this run did not measure.
- **Since then** ([slow-device gates](slow-device-gates.md)): the overlay of a hover frame draws only what changed (about 17 Canvas 2D calls instead of about 470), and a tick frame with 20 indicators takes the views' price ranges from the rebuilt items only. On the M1 with the page's CPU slowed four times, hover on `main` had a frame JS p99 of 1.20–1.47 ms, near this phone's, and the change did not make it measurably faster (1.14–1.26 ms); the tick-to-applied p99 did not change beyond the spread of the runs. Both still have to be measured on the phone.

## WebGPU dispatch thresholds on Adreno

The [workload study](webgpu-workload-specialization.md) set two dispatch rules on the M1: the single-pass ("wide") column kernel for whole-pane scatter draws of squares from 5 device pixels, and palette slots for heatmaps with a fixed value range. The study fixture ran on the phone through `transitions.mjs --android`, before (`main` at `bf975a1`: the row kernel at every width, heatmaps drawn from values) and after (this branch), three alternating rounds. The study page now sets square sizes in device pixels at any ratio. Its nine whole-chart comparisons against Canvas 2D passed byte for byte in all six runs on the phone.

GPU pass p95 in milliseconds over 48 alternating fractional viewport changes, one million source points: the median of three runs, with their range. Uniform draws 1,000,000 marks at level 0, burst 539,027 at level 1.

| Square (device pixels) | Uniform, before     | Uniform, after      | Lower after | Burst, before       | Burst, after        | Lower after |
| ---------------------: | ------------------- | ------------------- | ----------: | ------------------- | ------------------- | ----------: |
|            3 (control) | 7.60 (7.60–9.31)    | 7.67 (7.60–9.57)    |         1/3 | 5.77 (4.26–5.77)    | 5.77 (5.64–5.77)    |         1/3 |
|            4 (control) | 12.71 (12.65–12.71) | 12.71 (12.65–12.78) |         1/3 | 9.44 (7.14–9.77)    | 9.24 (7.54–9.90)    |         1/3 |
|                      5 | 16.71 (16.65–16.71) | 13.57 (13.57–13.63) |         3/3 | 11.73 (9.70–12.52)  | 12.85 (12.71–12.85) |         0/3 |
|                      6 | 21.56 (21.56–21.63) | 15.40 (15.40–15.40) |         3/3 | 14.68 (14.09–14.94) | 15.07 (14.68–15.14) |         0/3 |
|                      7 | 27.39 (19.86–27.39) | 17.17 (17.17–17.24) |         3/3 | 18.61 (13.44–19.20) | 16.38 (16.32–16.97) |         2/3 |
|                      9 | 30.28 (30.21–41.75) | 20.78 (20.78–20.84) |         3/3 | 26.54 (19.73–27.66) | 19.86 (19.79–20.71) |         2/3 |

- **The 5-pixel threshold holds for dense draws.** With a million marks at level 0, the wide kernel takes 19% less GPU time at 5 pixels, 29% at 6, 37% at 7 and 31% at 9, in every round. Below 5 both sides run the same kernel.
- **For the burst it does not.** At 5 and 6 pixels the wide kernel took 3–10% more (0.4–1.1 ms) in every round; from 7 pixels it gains 12–25%. On the M1 the 5-pixel burst difference was within a timestamp step. On this GPU a threshold of 7 would suit both distributions but give up the dense case's 19–29% at 5 and 6 pixels; the size alone cannot serve both. The shipping threshold stays at 5: the dense case gains more than the burst loses. A rule that also weighs visible marks or the level of detail would need the same evidence from more GPUs.
- Every pass takes 5–7 times as long as on the M1 (7.6 ms for 3-pixel squares here, 1.3–1.6 ms on the M1; 3.7 against 20.8 ms at 9 pixels), on 1.72 times the device pixels. The harness's 1.5-CSS-pixel points are 4 device pixels at this ratio, below the threshold, so the integrated runs above use the row kernel.
- **Palette slots hold on Adreno.** With a fixed value range the heatmap's compute pass p95 falls by 41% in pan (7.96 to 4.72 ms) and 35% in zoom (10.2 to 6.59 ms) in the integrated runs, about the halving seen on the M1. The cost is the same as on the M1, larger: in the study fixture (local engine, 1.44M cells), a change of `valueMax` takes 11.5–17.3 ms of JavaScript at p95 with slots against 2.0–2.8 ms with values, three to four times the 4 ms update budget; it uploads 1,477,016 bytes instead of 38,040. A palette change takes 1.4–2.9 ms (1.9–2.8 before) and a replaced column 1.2–1.9 ms (1.0–1.3 before), with the same upload sizes as on the M1.

## Still open

- **The hover and indicator gates after the [slow-device changes](slow-device-gates.md)**: measured on the M1 only, with CPU throttling as a stand-in; this phone has to run `tick/candles-1m,ind-apply/candles-1m,drawings/candles-1m/1000/hover` again.
- **A mid-range Android device**, the reference of design section 9 and of stage 5 step 5. This flagship misses the hover gate, the worker's indicator gate and two mark budgets; a mid-range phone will miss more. No such device was available.
- **Byte-for-byte image equality on Android.** The cause of the one-step pixel differences of the WebGL2 path is explained and changed, and the one new path of the WebGPU differences (a composite under the price pane clip) is changed, on the M1 only ([GPU mark renderer gaps](mark-gpu-device-gaps.md)): `mark-charts.mjs --android` with the default tolerance of 0 decides both.
- **The changes of [GPU mark renderer gaps](mark-gpu-device-gaps.md) on the phone**, measured on the M1 only: the WebGL2 scatter append (6.05 ms here) and 1M-point zoom (8.42 ms, and a frame every 33 ms), the WebGL2 scatter drawn as point sprites without instancing, whose GPU draw of 1M points fell to a quarter on the M1 (and brought that zoom back to every display frame there), the WebGPU canvas without Chrome's extra copy, and the WebGPU compute pass, which those changes do not shorten on the M1. Whether the Adreno draws the sprites byte for byte and how large its sprites may be (`ALIASED_POINT_SIZE_RANGE`) are also for the phone to show.
- **A phone-sized chart.** Every case here kept the desktop's 1,200 × 600 CSS-pixel chart. A chart the width of the screen draws a third of the device pixels, which matters for the overlay redraw of hover and for the GPU passes.
- **Thermal behavior over longer runs.** The thermal service reported no throttling (status 0) in any run, with the phone charging over USB; sustained use on battery was not measured.
- x86 machines and desktop discrete GPUs, where the WebGPU thresholds were also meant to be checked.

## Raw runs

- Image comparisons: [byte for byte](android-mark-charts-exact.json), [within 2](android-mark-charts.json)
- Mark frames, three rounds merged per renderer: [WebGL2](android-marks-webgl2.json), [WebGPU](android-marks-webgpu.json), [Canvas 2D](android-marks-canvas2d.json)
- GPU timers: [WebGPU](android-marks-gpu.json), [WebGL2, no samples](android-marks-gpu-webgl2.json)
- Gates: [tick, indicators and hover](android-gates.json), [pan and zoom frames](android-frames.json)
- WebGPU study: [before, `bf975a1`](android-study-before.json), [after](android-study-after.json)
- Projection threshold on the phone: [0](android-projection-0.json), [0.4](android-projection-0.4.json)

## Reproduce

```sh
SERIAL=<serial>
MARKS=scatter/candles-2k/cloud-100k/zoom,scatter/candles-2k/cloud-300k/zoom,scatter/candles-2k/cloud-1m/zoom,scatter/candles-2k/cloud-1m/tick,scatter/candles-2k/cloud-1m/tick-redraw,heatmap/candles-4800/2400x600/pan,heatmap/candles-4800/2400x600/zoom,heatmap/candles-4800/2400x600/tick,heatmap/candles-4800/2400x600/tick-redraw
node benchmarks/runner/mark-charts.mjs --android $SERIAL --mode webgl2,native,unavailable,rejected,pending,canvas-only
node benchmarks/runner/mark-charts.mjs --android $SERIAL --mode webgl2,native,unavailable,rejected,pending,canvas-only --tolerance 2
# One renderer per invocation, rotating the order each round, then merge each renderer's rounds:
pnpm bench --android $SERIAL --lib lumen-worker --mark-renderer webgl2 --case $MARKS --repeats 1 --budget 2 --out marks-webgl2-1.json
pnpm bench:merge android-marks-webgl2.json marks-webgl2-*.json
pnpm bench --android $SERIAL --lib lumen-worker --mark-renderer webgpu --mark-gpu-timers --case $MARKS,heatmap/candles-4800/2400x600-fixed --repeats 2 --budget 1.5
pnpm bench --android $SERIAL --lib lumen-worker,lumen-main --case tick/candles-1m,ind-apply/candles-1m,drawings/candles-1m/1000/hover --repeats 3 --budget 1.5
pnpm bench --android $SERIAL --lib lumen-worker,lumen-main --case frames/candles-1m --repeats 3 --budget 1.5
node benchmarks/prototypes/webgpu-specialization/transitions.mjs --android $SERIAL --packages <bf975a1>/packages --sizes 3,4,5,6,7,9
node benchmarks/prototypes/webgpu-specialization/transitions.mjs --android $SERIAL --sizes 3,4,5,6,7,9
```

Let the phone cool between long runs and read `host.device` in each results file for its state.
