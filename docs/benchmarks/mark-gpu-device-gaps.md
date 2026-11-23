# GPU mark renderer gaps from the phone

The [physical Android run](android-physical.md) left four questions about the GPU mark renderers: why a one-point append to a 1M-point WebGL2 scatter took 6.05 ms of JavaScript, why its zoom took 8.42 ms at p95, where the one-step pixel differences of the GPU layers come from, and why WebGPU's compute pass took 7.6–15 ms. The phone was not connected for this work. Every number below is from the Apple M1. What the changes do on the phone is stated as an expectation, and awaits a run there.

| Question                               | Cause found                                                                                                                                                                                                                              | Change                                                                                                                                                                                                        | On the M1                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| WebGL2 scatter append                  | An append drew a strip of the pane, but computed the column ranges of the whole pane and copied the strip back from the GL canvas.                                                                                                       | The points of an append of up to 32 opaque rows are written into the retained image in Canvas 2D, as WebGPU does; their records wait for the next WebGL2 draw.                                                | Frame JS p95 1.07 → 0.280 ms, lower in 3 of 3 pairs                                         |
| WebGL2 1M scatter draw (GPU)           | Each point was an instance of four vertices; ANGLE on Metal shades such small instances slowly. The column search in the vertex shader, the first suspect, is a sixth of the cost.                                                       | Points are one vertex each, drawn as point sprites without instancing, in a viewport that reaches beyond the pane; quads above the context's sprite size.                                                     | GPU draw p50 20.2 → 4.87 ms; 1M zoom back to 120 frames in 2 s; frame JS p95 4.14 → 1.74 ms |
| WebGL2 1M scatter zoom                 | Ordinary zoom frames, which set p95, spend more than half their JavaScript on the column ranges: a binary search over up to 2M rows for each of 2,400 columns.                                                                           | The search starts where the previous column suggests; the time map keeps the segment it loaded. Same results, shared with WebGPU.                                                                             | Column ranges 21–32% less in the page; frame JS p95 2.77 → 2.51 ms, lower in 3 of 3 pairs   |
| One-step differences, WebGL2           | The drawing buffer held straight colors, which the browser premultiplies on a path of its own when it copies the buffer into a 2D canvas; Canvas 2D premultiplies in `putImageData`. Rounding that differently reproduces the signature. | Colors are premultiplied before upload, by a table measured from the page's own `putImageData` with the first translucent color, into a premultiplied drawing buffer; WebGPU premultiplies by the same table. | Byte for byte in Chromium (Metal and SwiftShader), WebKit and Firefox at DPR 1 and 2        |
| One-step differences, WebGPU, state 34 | State 34 is the first whose composite runs under a clip (a second price pane). WebGPU composited its image axis-aligned; Canvas 2D and WebGL2 composite theirs transposed.                                                               | WebGPU retains its image transposed and composites it with the same transposed draw.                                                                                                                          | Byte for byte; GPU pass unchanged                                                           |
| Chrome's "extra copy" warning          | Chrome on Android copies the whole texture of a canvas configured with storage usage into a second one, and logs this warning for any such copy, whatever the format.                                                                    | The kernels write a storage texture the renderer keeps; the strip drawn is copied into a canvas configured for copies only.                                                                                   | No copy before or after on the M1: not measurable here                                      |
| WebGPU compute pass                    | Per-pixel stores and per-point workgroup atomics, which on the phone are 1.3–1.8 times the M1's work and take 5–7 times as long.                                                                                                         | Heat kernels run pixel rows across the first dimension; taller and shorter row strips were measured and left out.                                                                                             | No resolved change of the pass; WebGL2 heatmap pans: GPU draw p50 0.87–0.94 → 0.22–0.26 ms  |

## Method

The baseline is `main` at `9ee1ef4`, from a `git archive` copy measured through `--packages`; the comparison is this branch. Both ran with this branch's harness, alternating one invocation at a time (before, then after), one run per case per invocation: `lumen-worker`, a 1,200 × 600 CSS-pixel chart at DPR 2, `--budget 2`, headless Chromium 156.0.8078.4 on the Apple M1 (Metal). Other agents ran benchmarks on the same machine; each run records its one-minute load average, and the tables give the range of them. Tables give the median of the per-run values with the range of the runs in parentheses; "lower after" counts the pairs in which the after run was lower. GPU timestamps on this host fall on steps of about 0.066 ms.

| Set                         | Pairs | Cases                                                                       | Load averages, before / after |
| --------------------------- | ----: | --------------------------------------------------------------------------- | ----------------------------- |
| WebGL2, frame JS            |     3 | 1M scatter zoom, append, append with a redraw; heatmap 2400 × 600 pan, zoom | 3.5–10.8 / 4.5–11.6           |
| WebGL2, `--mark-gpu-timers` |     2 | the same                                                                    | 9.6–10.4 / 9.7–13.0           |
| WebGPU, `--mark-gpu-timers` |     3 | scatter 100k, 300k and 1M zoom; heatmap 2400 × 600 pan, zoom                | 10.1–14.3 / 10.4–12.1         |
| WebGPU, frame JS            |   2–4 | scatter 1M zoom and append, 100k and 300k zoom; heatmap pan, zoom           | 9.3–48.7 / 10.1–43.5          |

The WebGL2 GPU timer is a `TIME_ELAPSED` query from the clear or draw that starts a series' paint to the end of its last draw (`EXT_disjoint_timer_query_webgl2`); the WebGPU timer brackets the compute pass.

## WebGL2 scatter append

A profile of the append on `main` (`pnpm bench --profile`, unminified build) shows that the WebGL2 renderer did not redraw the whole layer, as the physical-device document said: it drew only a strip of the pane around the new point (0.12 ms on the GPU at p50, `EXT_disjoint_timer_query_webgl2`). But for that strip it computed the column ranges of all 2,400 columns (`scatterBounds`, the first row whose center is at or right of each pixel column), 0.46–0.84 ms of the profiled 1.0–1.1 ms frames, uploaded them, drew, and copied the strip from the GL canvas into its retained image. The Canvas 2D path writes the point into its pixel buffer and hands over the pixels it changed; the WebGPU path fills the point's square into its retained 2D canvas and leaves the rows for its next dispatch.

The WebGL2 path now does what WebGPU does ([renderer](../../packages/core/src/marks/gl/renderer.ts), `appendPatch`). An append of at most 32 rows at the finest level whose colors are all opaque is written into the retained image with `fillRect`, in row order, as a square or as the columns of a disc (`makeStamp`), at each point's own size; the rows' records are uploaded with the next WebGL2 draw. A WebGL2 draw writes each covered pixel with the color of the last row that covers it, which for opaque colors is what the `fillRect`s leave. Translucent colors, densities, a coarse level, an append that changes the record layout (the first point with a size of its own) and larger appends are drawn by WebGL2 as before. The image comparisons' appends take the new path: offsetting its squares by a pixel fails the comparison at "point appended to large squares".

Frame JS in milliseconds, three alternating pairs ([before](mark-gpu-gaps-webgl2-before.json), [after](mark-gpu-gaps-webgl2-after.json)):

| WebGL2, 1M-point cloud                                   |       p95 before |           p95 after | Lower after |          p50 before |           p50 after |
| -------------------------------------------------------- | ---------------: | ------------------: | ----------: | ------------------: | ------------------: |
| Append (`tick`)                                          | 1.07 (1.07–1.18) | 0.280 (0.265–0.455) |         3/3 |  0.965 (0.950–1.08) | 0.235 (0.230–0.245) |
| Append, every eighth frame a view change (`tick-redraw`) | 1.19 (1.17–1.21) |    1.15 (1.12–1.23) |         2/3 | 0.975 (0.945–0.980) | 0.225 (0.215–0.225) |

- The append is about four times cheaper at p95 and p50, in the range of the Canvas 2D (0.27–0.29 ms) and WebGPU (0.46–0.60 ms) appends measured on the M1 for [automatic selection](mark-renderer-auto.md#frame-js-p95-by-backend).
- `tick-redraw`'s p95 falls on the redraw in every eighth frame, which draws the whole pane, so it barely moves; its p50, the appends between, falls as the append's does.
- With the GPU timer, `main` drew the append's strip in 0.12–0.14 ms at p50; the branch issues no WebGL2 draw for these appends ([before](mark-gpu-gaps-webgl2-timers-before.json), [after](mark-gpu-gaps-webgl2-timers-after.json)).

Expected on the phone: the append now does the work of the Canvas 2D and WebGPU appends there, which took 1.1–1.2 ms against WebGL2's 6.05 ms. Not measured.

## WebGL2 1M scatter zoom

The p95 of the 1M-point zoom falls on ordinary zoom frames. The three frames per run that pack every held row again for a new price scale (up to 2M rows, 16–20 ms on the M1) lie above p95, on the phone as here (87 frames per run there). In an ordinary frame the column ranges are the largest part: in the page, timed with user-timing marks around `scatterBounds` in an instrumented copy of each side (CPU profiler off), they took 1.4–1.8 ms per frame at the median of frames of 2.3–2.9 ms on `main` ([ranges in the page](mark-gpu-gaps-zoom-ranges.json)).

Each column's first row came from a binary search over the window's rows: about 20 reads spread over 8–16 MB, most of them cache misses, and two binary searches over the bars of the time map. The change ([geometry](../../packages/core/src/marks/gpu/geometry.ts), [time map](../../packages/core/src/marks/time-map.ts)):

- The search starts at the row the previous column suggests (its row plus the previous column's number of rows) and doubles its step away from it before it bisects, so it reads rows close together. For rows in time order it finds the row the binary search found.
- The time map keeps the segment it loaded last, and a time or position in it, or a position in the next one, loads nothing.

Unit tests check both against the old search and a fresh map, over session gaps, duplicate times and buckets that start before the timeline, so the pixels do not change. WebGPU's column and tile paths use the same ranges.

The ranges in isolation: the bundled `scatterBounds` and `TimeMap` of each side in headless Chromium, 2,403 columns (a 2,400-pixel pane and 3-pixel squares), rows uniform over the bars, two alternating rounds; warm calls back to back, cold calls after touching 64 MB ([column ranges](mark-gpu-gaps-column-ranges.json)). Microseconds per call, the two rounds:

| Rows, bars                | Warm, `main` | Warm, branch | Cold, `main` | Cold, branch |
| ------------------------- | -----------: | -----------: | -----------: | -----------: |
| 1,000,000 over 1,000 bars |     488, 518 |     176, 168 |     724, 910 |     561, 595 |
| 2,000,000 over 2,000 bars |     576, 754 |     182, 192 | 1,122, 1,520 |     793, 732 |
| 100,000 over 1,000 bars   |     462, 464 |     136, 130 |     488, 490 |     141, 144 |

In the page the ranges took 21% and 32% less in two alternating pairs: mean per frame 1.35 → 1.06 and 1.84 → 1.24 ms, p95 2.02 → 1.43 and 2.79 → 1.52 ms (load averages 9.0–12.6). The cold calls in isolation are closer to the page than the warm ones: a frame's other work evicts the rows between frames.

Frame JS in milliseconds, the same three pairs:

| WebGL2, 1M-point cloud |       p95 before |        p95 after | Lower after |       p50 before |        p50 after |
| ---------------------- | ---------------: | ---------------: | ----------: | ---------------: | ---------------: |
| Zoom                   | 2.77 (2.70–3.87) | 2.51 (2.23–2.79) |         3/3 | 2.08 (2.00–2.41) | 2.02 (1.93–2.10) |

The same ranges serve the WebGPU column and tile kernels, whose zooms also take less JavaScript ([WebGPU frame JS](mark-gpu-gaps-webgpu-before.json), [after](mark-gpu-gaps-webgpu-after.json); the 1M zoom also from the [timer pairs](mark-gpu-gaps-webgpu-timers-before.json)):

| WebGPU zoom        |        Pairs |       p95 before |         p95 after | Lower after |        p50 before |           p50 after |
| ------------------ | -----------: | ---------------: | ----------------: | ----------: | ----------------: | ------------------: |
| 1M cloud           |            4 | 2.00 (1.91–2.30) |  1.73 (1.51–2.19) |         4/4 |  1.44 (1.40–1.49) |    1.25 (1.21–1.32) |
| 1M cloud           | 3, timers on | 2.83 (2.50–3.99) |  1.98 (1.72–2.31) |         3/3 |  1.49 (1.48–1.85) |    1.34 (1.21–1.40) |
| 300k cloud         |            4 | 1.28 (1.24–1.36) |  1.23 (1.13–1.37) |         3/4 |  1.06 (1.06–1.08) |  0.965 (0.885–1.03) |
| 100k cloud (tiles) |            3 | 1.36 (1.35–1.37) | 1.19 (0.980–1.22) |         3/3 | 1.05 (0.985–1.08) | 0.755 (0.730–0.755) |

Expected on the phone: lower by what the ranges take of its zoom frames, which this run cannot size. If they take the share they take here (more than half of an ordinary frame) and fall by the same 21–32%, the 8.42 ms p95 falls by roughly 12–18%, to about 6.9–7.4 ms, under the 8 ms budget. Not measured.

What was not changed: the frames that pack every held row again. WebGPU projects only the rows in view when that leaves out enough of them ([projection threshold](projection-threshold.md)); the same would shorten these WebGL2 frames, which are above p95.

## WebGL2 scatter draw on the GPU

The WebGL2 GPU timer showed a cost of its own: drawing the 1M-point scatter took 16.6–25.2 ms at p50 on the M1, on `main` and on the branch of the measurements above, more than a display frame. Headless Chromium shows it in the frame interval: the 1M WebGL2 zoom came every 33–50 ms at p95 on the M1 (63–91 frames in the 2-second budget instead of 120), as it came every 33 ms on the phone.

Each point was an instance of a four-corner quad whose vertex shader searches the column ranges for the point's column (about 12 texture reads), four times per point. That search was the first suspect and is not the cost. Variants of the draw, one run each of the 1M and 300k zooms with `--mark-gpu-timers`, GPU time p50 in milliseconds (load averages 7.1–12.7):

| Draw of each point                                              |         1M |     300k | Pixels                       |
| --------------------------------------------------------------- | ---------: | -------: | ---------------------------- |
| Instance of a quad, column searched (`main`)                    | 17.0, 19.7 | 5.3, 5.5 | reference                    |
| The same, column not searched (a stand-in of the same locality) |       18.0 |      5.0 | wrong: timing only           |
| The same, no `discard` in the fragment shader                   |       16.6 |      5.8 | wrong for discs: timing only |
| Instance of one point sprite                                    |       41.3 |      9.0 | byte for byte                |
| Six vertices of two triangles, not instanced                    |       23.7 |      6.2 | timing only                  |
| **One point sprite vertex, not instanced**                      |    **5.8** |  **1.6** | byte for byte                |
| The same, column not searched                                   |        4.8 |      1.8 | wrong: timing only           |

The search takes about a sixth of the point-sprite draw; the cost was the instancing of a few vertices per instance. ANGLE on the M1's Metal shaded a million one-vertex instances in twice the time of a million four-vertex ones, and a million vertices of one draw in a quarter to a third of it. Which GPUs shade instances apart, and the Adreno's cost of each form, are for the device to show.

The change ([context](../../packages/core/src/marks/gl/context.ts) `drawScatter` and `pointGuard`, [shaders](../../packages/core/src/marks/gl/shaders.ts) `scatterVertex`): where the context draws point sprites as large as the widest point in view (`ALIASED_POINT_SIZE_RANGE`, up to 256 device pixels) and viewports that large, each point is one vertex of a `drawArrays(POINTS)` draw, whose shader takes the row from `gl_VertexID`. A point sprite covers the pixels whose centers lie inside the square around its center; the square's edges lie on whole or half pixels, never on a pixel center, so it covers the quad's pixels. A point is clipped by its center, not its area, so the viewport reaches the widest point's size beyond the pane on each side and the scissor keeps the draw to the pane: a point centered just outside the pane still draws its part inside. Discs keep their fragment test, and densities sum from the same sprites. Wider points than the context's sprites draw as instanced quads, as before, and so do the cells of a coarse level drawn over the area of their points (`scatterCellArea`), whose boxes are not square; their colors are premultiplied by the same rule.

Three alternating pairs against `main`, one run per case per invocation: with `--mark-gpu-timers` ([before](mark-gpu-gaps-draw-timers-before.json), [after](mark-gpu-gaps-draw-timers-after.json); load averages 13.4–19.6 / 13.4–18.9) and without ([before](mark-gpu-gaps-draw-before.json), [after](mark-gpu-gaps-draw-after.json); 13.5–27.4 / 15.4–23.5). Milliseconds, median (range):

| WebGL2                        | GPU draw p50, before |            after | GPU draw p95, before |            after |
| ----------------------------- | -------------------: | ---------------: | -------------------: | ---------------: |
| Cloud 1M zoom                 |     20.2 (20.0–20.3) | 4.87 (4.83–5.23) |     25.6 (25.0–25.8) | 7.21 (6.96–8.59) |
| Cloud 300k zoom               |     4.88 (4.70–5.73) | 1.80 (1.64–2.39) |     7.81 (6.40–8.21) | 4.43 (2.47–5.33) |
| Cloud 1M append with a redraw |                    – |                – |     16.5 (14.8–16.8) | 5.62 (5.53–7.93) |

| WebGL2, without timers        | Frame JS p95, before |            after | Frame interval p95, before | after | Frames in 2 s, before | after        |
| ----------------------------- | -------------------: | ---------------: | -------------------------: | ----: | --------------------: | ------------ |
| Cloud 1M zoom                 |     4.14 (3.91–4.40) | 1.74 (1.54–2.45) |           33.3 (33.3–50.0) |  16.7 |            63, 74, 91 | 120 (3 of 3) |
| Cloud 300k zoom               |     1.40 (1.40–1.42) | 1.28 (1.16–1.64) |                       16.7 |  16.7 |               120–121 | 120–121      |
| Cloud 1M append with a redraw |     1.32 (1.23–1.40) | 1.21 (1.21–1.25) |                       16.7 |  16.7 |                   121 | 120–121      |

- The 1M draw takes a quarter of the GPU time, and the zoom is back to every display frame: interval p95 16.7 ms and 120 frames in each run, where `main` dropped to every second or third.
- The 1M zoom's frame JS fell with it, by more than the column ranges account for (p50 2.76 → 1.24 ms): with the GPU 20 ms behind, the main thread most likely waited for it, in the copy of the GL canvas into the retained image, which the browser orders after the draw. The traces here do not show where it waited.
- The append with a redraw every eighth frame draws the whole pane in those frames: its GPU p95 is the full draw (16.5 → 5.6 ms); its p50 is the append, which issues no WebGL2 draw (above). Its p50 frame JS is 1.05 → 0.24 ms, from the append patch.

Expected on the phone: its 1M WebGL2 zoom came every 33 ms with 8.42 ms of JavaScript. If the Adreno shades instances the way the M1's ANGLE does, the draw shrinks as here and the zoom's JavaScript falls with the wait; if not, sprites still shade one vertex instead of four per point. Not measured.

## One-step differences

### WebGL2: the browser's premultiplication

Canvas 2D, the reference, writes a series' pixels as straight colors with `putImageData`, and the canvas stores them premultiplied: the browser multiplies each channel by alpha and rounds. The WebGL2 renderer drew the same straight colors into a drawing buffer created with `premultipliedAlpha: false` and copied the buffer into its retained 2D canvas with `drawImage`, where the browser premultiplies the buffer itself, on a path of its own (in Chromium, a GPU copy of the drawing buffer). The WebGPU kernels premultiply in 32-bit floats and store the result rounded to the nearest byte.

Browsers do not round `putImageData` the same way. Putting every channel value at every alpha (65,536 pairs) into a canvas and reading back what it holds, on the M1 ([premultiplication by browser](mark-gpu-gaps-premultiply.json)):

| Browser, headless on the M1         | Pairs rounded to the nearest byte | Pairs rounded up |
| ----------------------------------- | --------------------------------: | ---------------: |
| Chromium 156, Metal and SwiftShader |                            65,536 |           33,766 |
| WebKit 27.2                         |                            65,536 |           33,766 |
| Firefox 157                         |                            33,766 |           65,536 |

(Both rules give the same value for 33,766 pairs.)

A change of the rounding alone reproduces the phone's signature on the M1. With the shaders premultiplying in whole numbers and rounding down, the WebGL2 comparison in Chromium fails at the first state, with 224,390 channel values different by one and none by more; on the phone the WebGL2 path failed at the first state with 18,000–20,800 values different by one. The fixture's heatmap palette is translucent at its low end (`rgba(12,96,120,0.4)`), so every state has translucent pixels. Hardware WebGPU, which premultiplies to the nearest byte as Chromium's `putImageData` does, matched on the phone for 33 states. The phone's WebGL2 path therefore most likely premultiplied the drawing buffer with a rounding other than Canvas 2D's; which operation on the phone rounds differently is not shown here.

The change: the WebGL2 context is created with `premultipliedAlpha: true`, and every color the renderer uploads (scatter records, the fallback color, heatmap palettes and slot colors, density palettes) is premultiplied first by a table of how the page's own Canvas 2D premultiplies ([premultiply.ts](../../packages/core/src/marks/premultiply.ts)). The shaders write the colors as they are, and the browser copies the buffer without a conversion. The table: 256 × 256 pixels put into a canvas and drawn over an opaque black one, where a premultiplied color reads back as itself. It falls back to rounding to the nearest byte where the measurement cannot be made or reads back what no premultiplication gives.

Opaque and fully transparent colors premultiply the same under every rounding, so the table is measured once per document only when the first translucent color is uploaded; a page whose mark colors are all opaque never measures it. First frames of a WebGL2 scatter (20,000 points over 500 candles, 1,200 × 600 CSS pixels at DPR 2, local engine), in fresh pages of headless Chromium 156, eight alternating pairs under load averages of 15.4–16.7 ([first frames](mark-gpu-gaps-first-frame.json)):

| Palette                         | Measured | First mark frame, ms, median (range) |
| ------------------------------- | -------: | -----------------------------------: |
| Opaque (`#ab3232` to `#77ac86`) |   0 of 8 |                     14.3 (12.2–25.7) |
| Translucent low end             |   8 of 8 |                     24.0 (22.3–25.9) |

The measurement itself, timed in a further document of the same pages, took 9.9–15.8 ms the first time in a page (4.1–5.2 ms when the page had measured once already). It is a one-time cost of the first frame with a translucent mark color, beside the shader compilation of that frame.

WebGPU now premultiplies by the same table ([renderer](../../packages/core/src/marks/gpu/renderer.ts)): the scatter records, the fallback color and the heatmap's slot colors go to the GPU premultiplied, and the kernels store them as they are, where they multiplied in 32-bit floats and rounded to the nearest byte. On the M1 that is the same rounding as Chromium's and WebKit's, so the pixels did not change; a browser with hardware WebGPU that rounds as Firefox does now matches too. Skipping the premultiplication of the heatmap's colors fails the WebGPU comparison at the first state, so the translucent colors take this path. The pass did not change: in two timer pairs ([before](mark-gpu-gaps-webgpu-premultiply-before.json), [after](mark-gpu-gaps-webgpu-premultiply-after.json); load averages 19.2–24.8), the 1M zoom's p50 was 1.51 and 1.57 ms against 1.51 and 1.44, the heatmap pan's and zoom's p95 one step lower.

Firefox shows why the table is measured rather than assumed: with colors rounded to the nearest byte in the shader, Firefox's WebGL2 comparison failed at the first state (197,594 values different by one). With the measured table it passes byte for byte, as it did with straight colors, when it premultiplied the buffer with the same routine as `putImageData`.

### WebGPU: the first state under a clip

On the phone WebGPU matched Canvas 2D for 33 states and differed from the 34th, "independent oscillator pane", on, in 15 channel values by one. Of the paths a difference could start on there (a second pane, a canvas resize, a 2D patch, a copy), that state takes one the 33 before it did not:

- **A clip.** The state adds a second price pane to the pane, and from then on the chart clips every mark series to its price pane before it composites it (`clipPricePane`): the fixture's first composite under a clip. The clip rectangle lies on whole device pixels.
- **Not a canvas resize.** A price pane shares the pane's canvas, so a series' images keep the pane's device size; the earlier "resize" state had resized them.
- **Not a 2D patch or a translated image.** The state changes the price projection, so every series draws in full.
- **No new copy.** Every redraw already copied the drawn strip from the WebGPU canvas into the retained 2D canvas.

Under the clip the WebGPU path's composite differed in form from the reference's: WebGPU drew its retained image onto the layer axis-aligned, Canvas 2D and WebGL2 draw theirs transposed (x and y swapped, pixel onto pixel). The same image drawn the two ways can round differently: the WebGL2 renderer was made transposed after Firefox rounded opacity differently in the two forms. This is the one operation that set the WebGPU path apart in that state; whether Chrome on the Adreno rounds the clipped axis-aligned draw differently is not shown here.

The change: WebGPU now retains its image transposed, as the other two do, and composites it with the same transposed `drawImage`; the kernels store texel (y, x) for pixel (x, y) ([shaders](../../packages/core/src/marks/gpu/shaders.ts)). All three paths now hand the layer the same kind of image in the same way, so a device's rounding of that draw applies to all of them.

### Verification

`node benchmarks/runner/mark-charts.mjs` with the default tolerance of 0, worker engine, DPR 1 and 2, and `node benchmarks/runner/heat-grid.mjs` at DPR 1 and 2; every check passed byte for byte:

| Browser on the M1         | Image comparisons: modes, checks per ratio                                                                  | Checks | Heat grids                 | Checks |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- | -----: | -------------------------- | -----: |
| Chromium 156, hardware    | `webgl2` 87, `native` (hardware WebGPU) 82, `unavailable` 63, `rejected` 63, `pending` 64, `canvas-only` 63 |    844 | WebGL2 and WebGPU, 59 each |    236 |
| Chromium 156, SwiftShader | `webgl2` 87, `pending` 64, `canvas-only` 63                                                                 |    428 |                            |        |
| WebKit 27.2               | `webgl2` 87, `native` (hardware WebGPU) 82, `pending` 64, `canvas-only` 63                                  |    592 | WebGL2 and WebGPU, 59 each |    236 |
| Firefox 157               | `webgl2` 87, `native` (no adapter: fallback) 63, `pending` 64, `canvas-only` 63                             |    554 | WebGL2 (no WebGPU adapter) |    118 |

[Chromium](mark-gpu-gaps-charts-chromium.json) · [SwiftShader](mark-gpu-gaps-charts-swiftshader.json) · [WebKit](mark-gpu-gaps-charts-webkit.json) · [Firefox](mark-gpu-gaps-charts-firefox.json) · heat grids: [Chromium](mark-gpu-gaps-heat-grid-chromium.json), [WebKit](mark-gpu-gaps-heat-grid-webkit.json), [Firefox](mark-gpu-gaps-heat-grid-firefox.json)

The qualification fixture gained seven states (87 checks with WebGL2 instead of 80): a bar spacing of four device pixels on a fixed price scale, five pans by whole bars, and the automatic price scale again. Before them no state panned by whole device pixels, so neither GPU renderer's translation of a retained heatmap image was compared; shifting the translated image by one pixel more now fails the comparison at the first such pan, with WebGL2 and with WebGPU.

## The extra copy

On the phone Chrome logged "WebGPU canvas configured with a different format than is preferred by this device ("rgba8unorm"). This requires an extra copy", although the renderer configured that very format. Chromium's `GPUCanvasContext` (`third_party/blink/renderer/modules/webgpu/gpu_canvas_context.cc` on Chromium's main branch, read in November 2026) explains it:

- `configure` sets `copy_to_swap_texture_required_` on Android when the format is `bgra8unorm` or when the usage includes `STORAGE_BINDING` ("Storage images are not supported on some AHB/gralloc versions"), on macOS when the format is `rgba8unorm`, and on Linux when it is `bgra8unorm`.
- With that flag, `getCurrentTexture` hands out a texture of its own, and each time it hands out a new one, `CopyToSwapTexture` copies the previous one, whole, into the texture the compositor takes, with `CopyTextureForBrowser`. The snapshot that `drawImage` takes of the canvas uses `CopyTextureForBrowser` instead of a plain texture copy too.
- `CopyToSwapTexture` adds the warning `kNonPreferredFormat`, once per device, whatever set the flag. On the phone it was the storage usage.

The renderer configured its canvas with `STORAGE_BINDING` because its kernels wrote the canvas texture. The copy is real: one copy of the whole canvas, 3,150 × 1,575 pixels on the phone, for each WebGPU redraw.

The change ([renderer](../../packages/core/src/marks/gpu/renderer.ts)): the kernels write a storage texture the renderer keeps (`lumen-marks-image`), and a redraw copies the strip it drew into the canvas texture with `copyTextureToTexture`; the canvas is configured with `COPY_DST` only. On the M1 the format is `bgra8unorm` with `bgra8unorm-storage`, which needed no copy before either, so the change cannot be measured here, and the timed compute pass does not include copies. The retained texture adds the pane's pixels once more to the renderer's estimate (12 instead of 8 bytes per pixel). A redraw of the whole pane now covers the canvas texture with its copy, so that texture needs no clear before it; a redraw of a strip still leaves the rest of it to be cleared.

## WebGPU compute pass

On the phone the compute pass took 7.6–15 ms against 0.8–2.2 ms on the M1, for 1.72 times the device pixels. What a redraw of the whole pane does (about 2,280 × 1,150 device pixels on the M1 at DPR 2, about 3,000 × 1,500 on the phone):

- **Heatmaps** (`heatmap`, `heatmap-slots`): one invocation per pane pixel in 8 × 8 workgroups. Each reads the ranges of its pixel column and row (four words), the cells they cover (about one at 2,400 columns by 600 rows), with values a binary search of eight dependent reads over 255 thresholds, then stores one texel. All of it per pixel: 1.72 times as much on the phone.
- **Scatter squares below 5 device pixels** (`scatter-columns`; the integrated cases draw 3 device pixels on the M1, 4 on the phone): one 64-lane workgroup per pane column and 1,024-row strip, two strips at both sizes. A workgroup reads every point centered within the square's width of its column, once per strip, so each point is read `2 × size` times; each point takes one workgroup atomic per pixel it covers, `size²`; every pane pixel is stored once; and the implementation zeroes each workgroup's 1,024 atomics. For the 1M cloud the phone does 1.33 times the M1's point reads, 1.78 times its atomics and 1.72 times its stores.
- **Scatter tiles** (`scatter-tiles`, up to 300k rows): one workgroup per 16 × 16 tile, binary searches into the price bands and the column ranges per point, `size²` atomics per point and tile, one store per pixel.

The phone's work is 1.3–1.8 times the M1's and its pass 5–7 times as long: per operation the Adreno 830 is about four times slower in these kernels. Which operation dominates there (stores to a storage texture, workgroup atomics or their zeroing) cannot be told from timestamps around the whole pass; it needs a GPU profile on the device.

Compute pass in milliseconds with `--mark-gpu-timers`, three alternating pairs ([before](mark-gpu-gaps-webgpu-timers-before.json), [after](mark-gpu-gaps-webgpu-timers-after.json)):

| WebGPU case             | Kernel            |          p95 before |           p95 after | p95 lower after |          p50 before |           p50 after |
| ----------------------- | ----------------- | ------------------: | ------------------: | --------------: | ------------------: | ------------------: |
| Scatter 100k zoom       | `scatter-tiles`   |  0.918 (0.786–1.05) | 0.786 (0.786–0.786) |             2/3 | 0.721 (0.721–0.721) | 0.721 (0.721–0.721) |
| Scatter 300k zoom       | `scatter-columns` |  0.983 (0.983–1.05) | 0.852 (0.852–0.852) |             3/3 | 0.852 (0.786–0.852) | 0.655 (0.590–0.721) |
| Scatter 1M zoom         | `scatter-columns` |    2.03 (2.03–2.10) |    2.23 (2.16–4.72) |             0/3 |    1.44 (1.25–1.51) |    1.57 (1.18–2.29) |
| Heatmap 2400 × 600 pan  | `heatmap-slots`   | 0.524 (0.524–0.524) | 0.459 (0.459–0.459) |             3/3 | 0.066 (0.000–0.066) | 0.066 (0.066–0.066) |
| Heatmap 2400 × 600 zoom | `heatmap-slots`   |  0.786 (0.786–3.80) |   1.18 (0.983–1.25) |             1/3 | 0.590 (0.590–0.655) | 0.590 (0.524–0.590) |

The differences are one to three timestamp steps and go both ways: the 300k zoom and the heatmap pan were lower in every pair, the 1M zoom's p95 higher in every pair (by two steps, once by 41). The pass is unchanged within what this host resolves. Each change, separately:

- **The transposed image** stores texel (y, x): the lanes of a column kernel store neighboring texels of a row rather than of a column. Measured alone (one run, before the heat kernel change) against two runs of `main` on the 100k and 1M zooms and the heatmap pan and zoom, the pass p50 was the same and its p95 within the spread of `main`'s runs.
- **Heat kernels with pixel rows across the first dimension.** Neighboring invocations now read neighboring cells of one column (cells are stored column by column) and store neighboring texels of the transposed image. Against the same kernels without it, two pairs: pass p50 the same, p95 one step lower on the 2400 × 600 pan in both and lower on the zoom in both (0.918 and 0.721 against 1.25 and 1.18 ms).
- **Strip heights, measured and left out.** One strip of 2,048 rows reads each point once instead of twice but holds 8 KB of atomics per workgroup: the 1M zoom's pass p50 rose from 1.51 to 1.90 ms and the 300k zoom's from 0.72 to 0.92 ms. Strips of 512 rows read each point three times: 1.90 against 1.64 ms on the 1M zoom. The strips stay at 1,024 rows.
- **Outside the pass.** The retained texture spares a redraw of the whole pane the clear of a fresh canvas texture, and, on Android, Chrome's copy of the whole canvas (above). Neither is in the timed pass, and neither can be measured on the M1.
- **WebGL2 heatmap pans.** Canvas 2D and WebGPU translate a heatmap's retained image on a pan by whole device pixels and draw the columns it exposes; WebGL2 drew the whole pane. It now translates its image too (the same `HeatPan` test of the overlapping columns and rows). With the WebGL2 timer on the M1 the GL work of the 2400 × 600 pan fell from 0.87 and 0.94 to 0.22 and 0.26 ms at p50 in two pairs; the frames that draw the whole pane remain (p95 0.92 and 3.99 against 0.90 and 2.07 ms). The translation costs some JavaScript: Chrome copies a canvas drawn onto itself first. In rotated runs of `main`, the branch and the branch without the translation, the pan's frame JS p50 was 0.640–0.670 ms on `main`, 0.705–0.780 on the branch and 0.670–0.750 without the translation ([variants](mark-gpu-gaps-heat-variants.json)); a variant with a straight-alpha drawing buffer was no faster than the branch. Chrome on the phone exposes no WebGL2 timer.

What to expect on the phone: the compute pass of a whole-pane redraw is unchanged, so WebGPU viewport redraws will still span two or three display frames there; each redraw loses one copy of the whole canvas. A pass that fits a 16.6 ms frame on this phone needs less work per pixel or fewer pixels: a phone-sized chart (a third of the pixels), or kernels shaped for the device after a profile there.

## Pending on the device

- `node benchmarks/runner/mark-charts.mjs --android <serial> --mode webgl2,native,unavailable,rejected,pending,canvas-only` at the default tolerance of 0: whether the premultiplied WebGL2 path and the transposed WebGPU composite match Canvas 2D byte for byte on the Adreno 830.
- The nine mark cases of the [physical Android run](android-physical.md#mark-series-frames) with WebGL2 and WebGPU, and WebGPU with `--mark-gpu-timers`: the WebGL2 append (expected near the 1.1–1.2 ms of the other two paths, which do the same work), the WebGL2 1M zoom (expected lower by the share of the column ranges, which this run cannot size on the phone), and whether Chrome still logs the extra-copy warning (expected not).
- The first-frame cost of the premultiplication measurement on the phone, with a translucent palette.
- The WebGL2 point sprites on the Adreno: whether they match the quads byte for byte (the image comparisons above at tolerance 0), the largest sprite its context draws (`ALIASED_POINT_SIZE_RANGE`; 511 on the M1's ANGLE, 1,023 with SwiftShader, 64 in Firefox), and the GPU time and frame interval of the 1M and 300k zooms.

## Raw runs

- Alternating pairs against `main`: WebGL2 frame JS [before](mark-gpu-gaps-webgl2-before.json), [after](mark-gpu-gaps-webgl2-after.json); WebGL2 timers [before](mark-gpu-gaps-webgl2-timers-before.json), [after](mark-gpu-gaps-webgl2-timers-after.json); WebGPU timers [before](mark-gpu-gaps-webgpu-timers-before.json), [after](mark-gpu-gaps-webgpu-timers-after.json); WebGPU frame JS [before](mark-gpu-gaps-webgpu-before.json), [after](mark-gpu-gaps-webgpu-after.json)
- Column ranges: [in isolation](mark-gpu-gaps-column-ranges.json), [in the page](mark-gpu-gaps-zoom-ranges.json)
- WebGL2 heatmap pan variants: [rotated runs](mark-gpu-gaps-heat-variants.json)
- WebGL2 scatter draw: alternating pairs with timers [before](mark-gpu-gaps-draw-timers-before.json), [after](mark-gpu-gaps-draw-timers-after.json) and without [before](mark-gpu-gaps-draw-before.json), [after](mark-gpu-gaps-draw-after.json); the variants, one run each: [instanced quads](mark-gpu-gaps-gl-draw-instanced-quads.json), [quads without the search](mark-gpu-gaps-gl-draw-quads-no-search.json), [quads without `discard`](mark-gpu-gaps-gl-draw-quads-no-discard.json), [instanced sprites](mark-gpu-gaps-gl-draw-instanced-points.json), [triangles](mark-gpu-gaps-gl-draw-triangles.json), [sprites](mark-gpu-gaps-gl-draw-points.json), [sprites without the search](mark-gpu-gaps-gl-draw-points-no-search.json)
- WebGPU colors premultiplied on upload: timer pairs [before](mark-gpu-gaps-webgpu-premultiply-before.json), [after](mark-gpu-gaps-webgpu-premultiply-after.json)
- First frames with opaque and translucent palettes: [runs](mark-gpu-gaps-first-frame.json)
- Premultiplication by browser: [measured](mark-gpu-gaps-premultiply.json)
- Image comparisons: [Chromium](mark-gpu-gaps-charts-chromium.json), [SwiftShader](mark-gpu-gaps-charts-swiftshader.json), [WebKit](mark-gpu-gaps-charts-webkit.json), [Firefox](mark-gpu-gaps-charts-firefox.json); heat grids [Chromium](mark-gpu-gaps-heat-grid-chromium.json), [WebKit](mark-gpu-gaps-heat-grid-webkit.json), [Firefox](mark-gpu-gaps-heat-grid-firefox.json)
- WebGPU experiments, one invocation each unless merged, `sources: workspace` being the branch at the time: the transposed image alone [after](mark-gpu-gaps-transposed-after.json) against `main` [before](mark-gpu-gaps-transposed-before.json); heat kernels with pixel [rows](mark-gpu-gaps-heat-kernel-rows.json) or [columns](mark-gpu-gaps-heat-kernel-columns.json) across the first dimension; column strips of [512](mark-gpu-gaps-strips-512.json), [1,024](mark-gpu-gaps-strips-1024.json) and [2,048](mark-gpu-gaps-strips-2048.json) rows

## Reproduce

```sh
# Baseline sources: git archive 9ee1ef4 packages | tar -x -C <dir>
pnpm bench --lib lumen-worker --mark-renderer webgl2 --case scatter/candles-2k/cloud-1m/zoom,scatter/candles-2k/cloud-1m/tick,scatter/candles-2k/cloud-1m/tick-redraw,heatmap/candles-4800/2400x600/pan,heatmap/candles-4800/2400x600/zoom --repeats 1 --budget 2 [--packages <dir>/packages]
pnpm bench --lib lumen-worker --mark-renderer webgl2 --mark-gpu-timers --case <the same> --repeats 1 --budget 2 [--packages <dir>/packages]
pnpm bench --lib lumen-worker --mark-renderer webgpu --mark-gpu-timers --case scatter/candles-2k/cloud-1m/zoom,scatter/candles-2k/cloud-300k/zoom,scatter/candles-2k/cloud-100k/zoom,heatmap/candles-4800/2400x600/pan,heatmap/candles-4800/2400x600/zoom --repeats 1 --budget 2 [--packages <dir>/packages]
node benchmarks/runner/mark-charts.mjs --dpr 1,2
node benchmarks/runner/mark-charts.mjs --software-gl --mode webgl2,pending,canvas-only --dpr 1,2
node benchmarks/runner/mark-charts.mjs --browser webkit --mode webgl2,native,pending,canvas-only --dpr 1,2
node benchmarks/runner/mark-charts.mjs --browser firefox --mode webgl2,native,pending,canvas-only --dpr 1,2
node benchmarks/runner/heat-grid.mjs --browser chromium --dpr 1,2   # and firefox, webkit
```
