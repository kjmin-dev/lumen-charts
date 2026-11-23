# Slow-device gates

On the [physical Android phone](android-physical.md#core-gates) two gates of design section 9 are
missed that the M1 meets: hover over 1,000 drawings (frame JS p99 1.38 ms through the worker, 1.41
ms on the main thread, against 1 ms) and a tick with 20 indicators and all 1M bars in view applied
through the worker (p99 4.39 ms against 4 ms). Headless Firefox on the M1 misses every frame budget
([Firefox](firefox-frames.md)). The phone was not connected for this work: the first two are traced
on the M1 with the page's CPU slowed down (`pnpm bench --cpu-throttle`), and checking them on the
phone is still to do. Headless Firefox has a section of its own.

| Question                               | Answer                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| What does a hover frame spend?         | On `main`, about 470 Canvas 2D calls: dashed lines are one rectangle per dash (the price line and both crosshair lines, at DPR 2), all redrawn after a full clear, and a loop over the 1,000 drawings for their geometry. The overlay was 60% of the frame's JavaScript.                                                                                                             |
| What changed for hover?                | The overlay draws only what changed, with the pixels of a full redraw; dashed lines in opaque colors are copied from a strip of their dashes; the drawings' loop is skipped while no view changed. A hover frame makes about 17 calls.                                                                                                                                               |
| Is hover faster?                       | Not measurably on the M1 in Chromium (frame JS 0.20–0.22 ms at p50 on both sides, p99 within the spread of the runs; at 4× throttling p99 1.14–1.26 against 1.20–1.47 ms). What remains is mostly native time in the frame callback that does not depend on the calls (about 180 µs of 260). Whether the phone, where each call costs more, gains more is open until it is measured. |
| What makes a worker tick wait?         | The frame in progress when the engine's reply arrives. Tick frames there take 0.5–0.6 ms at p50 on `main` (0.17–0.23 the views' price ranges, 0.16 the 25 value labels, all of which change every tick, 0.08 accessibility, 0.1 the changed columns); one in nine is a full redraw of 3.6–3.9 ms because a tick moved the default price scale.                                       |
| What changed for ticks?                | A tick takes the price range of the items it rebuilt instead of every merged column of every series (the views' part of a tick frame falls from 170–225 to 60–85 µs at p50), and value labels that did not change are kept. The tick-to-applied p99 is not distinguishable from `main` in these runs.                                                                                |
| Does headless Firefox draw on the GPU? | WebGL yes (`Apple M1`); Canvas 2D no, by default: it rasterizes in software on the page's thread. Forced on (`gfx.canvas.accelerated`), the same calls take 3–150 times less. Copying a WebGL canvas into a 2D canvas costs 13 ms in the default configuration, a transposed copy 11 ms.                                                                                             |

## Method

Apple M1 (8 cores, AC power), headless Chromium 156.0.8078.4 and headless Firefox 157.0 from
Playwright 1.64.1, viewport 1,280 × 720 at DPR 2, chart 1,200 × 600 CSS pixels (2,400 × 1,200 device
pixels). Before is `main` at `9ee1ef4` through `--packages`, after is this branch, with the same
harness, alternating per invocation (after, before, before, after), one run per case and engine per
invocation, `--budget 1.5`. Other work ran on the machine throughout; the tables give the one-minute
load averages the runs recorded.

- **`--cpu-throttle <rate>`** (new) has Chromium slow the page down by `rate` through the DevTools
  protocol (`Emulation.setCPUThrottlingRate`) for the whole life of each page, set-up included, and
  records the rate in the results file (`environment.cpuThrottlingRate`). It is refused for Firefox
  and with `--android`. It slows the page's threads, not the GPU process. Chromium throttles by
  suspending the thread in short slices, so a frame shorter than a slice either runs unslowed or
  takes a suspension: means scale by about the rate, a percentile of single frames is coarse.
- **`--firefox-pref <name=value,...>`** (new) sets Firefox preferences for a run and records them
  (`environment.browser.firefoxPrefs`).
- **Canvas 2D calls** of a hover step are now counted by the `drawings` scenario in an untimed pass
  of 60 more steps (`drawCalls`): they do not depend on the load.
- **Breakdowns** of frames come from runs with temporary timing marks around the parts of a frame
  (a `performance.now()` around each, not part of the change) and from traced runs
  (`--profile`), stated where used.

## Hover over 1,000 drawings

### What the redraw spent

A run of `main` with timing marks around the parts of a frame (lumen-main, unthrottled, load 2.9;
[raw](slow-device-gates-hover-breakdown.json)) put 198 of the frame's 322 µs of JavaScript in the
overlay, the layer of price lines, value labels, highlights and the crosshair:

| Part of a hover frame (mean, µs)                                            | `main` |
| --------------------------------------------------------------------------- | -----: |
| Reading the layout and the pointer                                          |     17 |
| Primitive layers brought up to date: a loop over the 1,000 drawings         |     27 |
| Hit test and hover state                                                    |     29 |
| Overlay: clearing the whole layer                                           |      7 |
| Overlay: the price line and value label of the candles (unchanged by hover) |     63 |
| Overlay: the hovered drawing's handles                                      |     18 |
| Overlay: crosshair lines                                                    |     57 |
| Overlay: crosshair labels (price and time)                                  |     52 |
| The rest of the frame (the harness's pointer event, scheduling)             |    ~50 |

- **Dashed lines are a rectangle per dash.** The price line and both crosshair lines are dashed by
  default, 6 device pixels on and 6 off at DPR 2: 190 rectangles for a horizontal line across the
  pane and 95 for the vertical one. A hover frame on `main` made 926 `fillRect` calls per pointer
  step in the counting pass (its overlay is drawn twice per step there, once for the move and once
  for the hover state the move changed), almost all of them dashes. On the phone (DPR 2.625) a line
  across the pane is 250 rectangles.
- **Everything was drawn again after a full clear**, though a hover changes only the crosshair and
  sometimes the highlight: the price line and its label were redrawn 60 times a second unchanged.
- **The 1,000 drawings were looked at in every frame** to find those whose view changed, though
  none had (27 µs). The hit test itself takes 2–3 µs on average here (12 µs on the phone).

### What changed

- **The overlay draws only what changed** (`render/overlay.ts`). It keeps what it drew as items
  (lines, labels, markers, the handles of highlighted drawings), each with the box of pixels it can
  color: a label's box reaches to the outer edge of the layer beside its axis and as far above and
  below as glyphs reach (0.8 of the font size from the middle), a circle's a pixel beyond its edge.
  A frame compares the crosshair's items and the highlights with those it drew; the price lines
  and value labels too after new data (below). It clears the boxes of what changed, the old and the
  new, widens them until everything they reach lies inside them, and draws again everything inside
  them, in the order of a full redraw. Lines are drawn as the pieces of their dashes inside the
  boxes, each piece once. Nothing is drawn through a clip: Chromium antialiases circles and text
  otherwise under a clip made of several rectangles, which the first version did and the pixel
  check found (up to a whole channel value at the crosshair's markers). A frame where nothing moved
  draws nothing.
- **Dashed lines in opaque colors are copied** from a strip that holds their dashes, one
  `drawImage` per line instead of one rectangle per dash. The copy places the same pixels: the
  dashes are whole pixels of an opaque color and the gaps are transparent. Lines in colors that are
  not opaque stay rectangles, since a copy would round their blending once more.
- **Full frames remain** for a size, ratio or option change, for primitives on the top layer, while
  a drawing is edited, and for the highlight of an application's primitive: the overlay cannot
  bound what those draw. The frame after them is full too.
- **The primitive layers skip their entries** while no view of the pane changed and no entry asked
  for an update (`PrimitiveLayer.update`, an epoch the views advance).
- A hover frame now makes 3.6 `fillRect`, 2.0 `fillText`, 1.9 `drawImage` and 9.7 `clearRect`
  calls per pointer step, against 926, 5.8, 0 and 1.9 on `main`.

### Is it the pixels of a full redraw?

- **Unit tests** (`packages/core/test/overlay-partial.test.ts`) rasterize a model: every pixel keeps
  a hash of the shapes drawn on it since it was last cleared, in order, so a pixel drawn twice, in
  another order, not cleared or left out differs from a full redraw. Text is modeled wider and taller
  than glyphs reach, circles a pixel beyond their edge, and shapes drawn through a clip of several
  rectangles as other pixels. After every pointer step, or every fourth, along a path over all ten
  drawing tools, their handles, the last price and off the pane, with two axes, crosshair markers,
  a selected and a hovered drawing, magnet and nearest modes, dotted, dashed and solid lines, a
  font of 28 pixels, hidden labels and lines, a drag, a primitive on top and ticks that move the
  scale, at DPR 1, 1.5 and 2, the overlay must equal a full redraw. Mutations of the change fail
  them: dashes drawn twice where boxes overlap (17 of 24 tests), no margin for text (3), handle
  boxes without their outline (18), labels on the left axis bounded too narrowly (12), damage not
  widened to what it reaches (15), price lines not compared after new data (3). The first version,
  which drew through a clip of several rectangles, fails 15 of them with the model of such clips.
- **Software rasterization**: with Chromium's software rasterizer (`--raster cpu`) the overlay case
  has differences (102 of 405 comparisons), and in every case the first one is in the series layer
  only, where software rasterization is known to differ ([partial redraw](stage-5-partial-redraw.md));
  the check reports the canvases of a case's first difference only, so the overlay is not shown
  equal in all of them ([raw](slow-device-gates-pixels-software.json)).
- **In the browser**, `pnpm bench:pixels` has a case `overlay` (a crosshair moving over drawings,
  selections, ticks, a line with markers on a left axis) besides the cases of ticks, whose frames
  now compare price lines and labels too. In headless Chromium on the GPU, at DPR 1, 2 and 1.5:
  126 cases, 2,835 comparisons, 4,896 overlay frames that cleared part of the layer, no pixel
  different ([raw](slow-device-gates-pixels.json)).

### Frame time

Frame JS of the hover gate case, worker / local engine, in ms. Two rounds, alternating; the load is
the one-minute load average at the start and end of the invocation.

| CPU | Round, side    | Load        | p50           | p99           | Mean          |
| --- | -------------- | ----------- | ------------- | ------------- | ------------- |
| 1×  | 1, this branch | 12.7 → 12.6 | 0.190 / 0.200 | 0.520 / 0.390 | 0.200 / 0.204 |
| 1×  | 1, `main`      | 12.6 → 11.9 | 0.215 / 0.215 | 0.320 / 0.255 | 0.222 / 0.215 |
| 1×  | 2, `main`      | 12.5 → 12.6 | 0.210 / 0.200 | 0.545 / 0.285 | 0.225 / 0.203 |
| 1×  | 2, this branch | 12.6 → 11.8 | 0.195 / 0.220 | 0.355 / 0.410 | 0.201 / 0.224 |
| 4×  | 1, this branch | 11.8 → 11.3 | 0.615 / 0.620 | 1.24 / 1.13   | 0.603 / 0.590 |
| 4×  | 1, `main`      | 11.3 → 10.4 | 0.615 / 0.600 | 1.46 / 1.33   | 0.605 / 0.593 |
| 4×  | 2, `main`      | 10.4 → 8.7  | 0.595 / 0.625 | 1.38 / 1.20   | 0.619 / 0.593 |
| 4×  | 2, this branch | 11.1 → 9.5  | 0.520 / 0.515 | 1.25 / 1.14   | 0.483 / 0.477 |

- **On the M1 the frame did not get measurably faster.** Unthrottled, both sides take 0.19–0.22 ms
  at p50; the p99 of single runs (0.26–0.55 ms) varies more within a side than between them. At 4×
  the p99 of this branch was 1.13–1.25 ms against 1.20–1.46 ms on `main`, a difference of the size
  of the spread.
- **What remains is not the calls.** In a traced run ([raw](slow-device-gates-hover-traces.json))
  the chart's own JavaScript per frame fell (the dashes, 20 µs, and the drawings' loop, 11 µs, are
  gone; building and comparing the items costs 10 µs), but about 180 µs per frame of the frame
  callback is native time outside JavaScript on both sides, about 70% of the frame. The harness's
  pointer event costs about 25 µs of JavaScript per frame. Which native work that is was not
  isolated: it does not scale with the Canvas calls here.
- **At 4× throttling the M1 lands near the phone** for this case: `main` measured 1.20–1.46 ms at
  p99, the phone 1.38–1.41 ms. Throttling slows everything on the page's thread alike, so it cannot
  show what a phone's slower Canvas calls cost: whether 450 fewer calls per frame take the phone
  under 1 ms is to be measured there.

## A worker tick with 20 indicators and all 1M bars in view

### What the tick waits for

A tick submitted through the worker is applied when the main thread handles the engine's reply.
When the reply arrives during a frame, it waits for the frame's end. Frames of this case, from runs
with timing marks ([raw](slow-device-gates-tick-breakdown.json); µs, p50 / mean / p95 of the frames
that drew new data, unthrottled, load about 10, measured before the last overlay change):

| Part of a tick frame   | `main`, worker      | This branch, worker | `main`, local       | This branch, local |
| ---------------------- | ------------------- | ------------------- | ------------------- | ------------------ |
| Views and price ranges | 170 / 239 / 615     | 60 / 88 / 295       | 225 / 313 / 805     | 85 / 135 / 385     |
| Accessibility          | 75 / 70 / 120       | 60 / 50 / 85        | 80 / 83 / 150       | 85 / 83 / 160      |
| Series layer           | 95 / 510 / 3,680    | 80 / 418 / 3,600    | 110 / 539 / 3,725   | 105 / 428 / 3,580  |
| Price and time axes    | 25 / 25 / 45        | 20 / 20 / 50        | 30 / 30 / 65        | 25 / 29 / 60       |
| Overlay                | 155 / 167 / 280     | 150 / 158 / 225     | 165 / 186 / 305     | 175 / 219 / 435    |
| The whole write phase  | 535 / 1,022 / 4,685 | 380 / 742 / 4,220   | 630 / 1,166 / 4,840 | 490 / 907 / 4,320  |

- **Partial frames take about half a millisecond**: the price range of every series over all its
  merged columns (25 views, about 2,300 columns each), the 25 value labels, the accessibility
  description and the dirty columns of the series layer.
- **One frame in nine draws the series layer in full**, 3.6–3.9 ms: a tick moved the default price
  scale. A traced run counted 11 of 90 tick frames whose price mapping had changed, and no other
  reason for a full redraw. Such a frame cannot be partial: every coordinate on the scale moves.
- **The value labels all change**: of 2,808 labels and lines compared in tick frames of a traced
  run, 2,230 had a new text, about 25 per frame, so the overlay's comparison saves little here.
- **The p99 is a wait behind a frame.** Ticks come every 0–2 ms after the previous one was applied,
  frames every 16.7 ms; a tick waits when its reply lands in a frame. On the phone, where frames
  are longer, more ticks land in them and each waits longer.
- **Applying the reply without waiting for the frame** cannot shorten what is measured: the
  measurement resumes in a microtask after the frame callback in any case, so a reply applied in
  the middle of the frame (from shared memory, say) would still be seen after the frame. Only a
  shorter frame, or one off the main thread (`OffscreenCanvas`, deferred in stage 5), shortens it.

### What changed

- **A tick takes the range of the items it rebuilt** (`SeriesView.update`): the range of the items
  before them is kept from earlier frames while none of them changed, and only the rest is looked
  at. The extremes are taken with `Math.min` and `Math.max`, which give the same result in any
  grouping, the sign of zero included, so the range equals one taken over all items (tests: every
  tick against a fresh view, a high before the last bar set and given up after it was kept, and the
  existing tests of ticks and pans with both zeros and gaps). The views' part of a tick frame falls
  from 170–225 to 60–85 µs at p50.
- **Price lines and value labels that did not change are kept** (the overlay's comparison above),
  and dashed price lines are copied from their strips.

### Tick to applied

Tick to applied patch in ms, worker / local engine, two rounds, alternating:

| CPU | Round, side    | Load      | p50           | p95           | p99           | max          |
| --- | -------------- | --------- | ------------- | ------------- | ------------- | ------------ |
| 1×  | 1, this branch | 9.5 → 8.5 | 0.100 / 0.070 | 0.410 / 0.270 | 0.940 / 0.460 | 5.02 / 1.13  |
| 1×  | 1, `main`      | 8.3 → 7.8 | 0.100 / 0.065 | 0.485 / 0.270 | 0.935 / 0.400 | 4.64 / 5.42  |
| 1×  | 2, `main`      | 7.6 → 7.5 | 0.125 / 0.125 | 0.525 / 0.380 | 1.04 / 0.475  | 5.73 / 1.31  |
| 1×  | 2, this branch | 7.3 → 6.7 | 0.110 / 0.075 | 0.535 / 0.280 | 0.930 / 0.410 | 4.89 / 0.810 |
| 4×  | 1, this branch | 6.7 → 6.0 | 0.175 / 0.115 | 1.48 / 1.58   | 3.76 / 4.04   | 20.1 / 20.6  |
| 4×  | 1, `main`      | 6.0 → 5.5 | 0.450 / 0.115 | 2.12 / 1.86   | 4.75 / 4.13   | 20.9 / 20.1  |
| 4×  | 2, `main`      | 5.5 → 7.1 | 0.175 / 0.130 | 1.37 / 1.70   | 3.01 / 3.94   | 20.2 / 17.9  |
| 4×  | 2, this branch | 7.1 → 6.8 | 0.255 / 0.160 | 1.57 / 2.14   | 3.78 / 4.79   | 19.5 / 21.8  |

- **The p99 did not change beyond the spread of the runs**, unthrottled (0.93–1.04 ms through the
  worker on both sides) or at 4× (3.0–4.8 ms on both). The write phase of a tick frame is a quarter
  shorter at p50, but the p99 rests on waits behind frames, those that draw the series layer in
  full among them, which this does not touch.
- **4× throttling is no stand-in for the phone here**: it slows the engine on the main thread too,
  so the local engine's p99 rises to 3.9–4.8 ms, where the phone measured 1.0 ms.
- What a further step would take: the accessibility description is computed and written again
  whenever the visible bars change, in this view with every new bar (50–85 µs a frame); the value
  labels cost what 25 new texts cost; a full redraw after a change of scale is the series layer's.

## Pan and zoom in Chromium

The overlay of a pan or zoom frame compares its price lines and labels too. Frame JS of the ten
`frames/candles-1m` cases, one run per side ([before](slow-device-gates-frames-before.json),
[after](slow-device-gates-frames-after.json), load 6.8–8.0): p50 0.19–0.52 ms on both sides, the
worst p95 0.66 ms on `main` and 0.77 ms on this branch (zoom over 20,000 bars, local engine; the
same case through the worker 0.56 and 0.62 ms), every case within 0.1 ms of `main` at p50.

## Headless Firefox

### What it draws on

`WEBGL_debug_renderer_info` with `webgl.sanitize-unmasked-renderer` off reports `Apple` /
`Apple M1` for WebGL and WebGL2 in headless Firefox 157: WebGL runs on the GPU. Firefox has no
switch a page can read for Canvas 2D, so a probe page timed the calls the chart makes, 40 frames
each, on a 2,400 × 1,200 canvas, in Firefox's default headless configuration and with preferences
changed through Playwright ([raw](slow-device-gates-firefox-canvas.json)). Mean ms per call:

| Call (2,400 × 1,200 canvas)           | Chromium | Firefox default | accelerated off | accelerated forced | all GPU prefs forced |
| ------------------------------------- | -------: | --------------: | --------------: | -----------------: | -------------------: |
| Clear the canvas                      |    0.017 |            1.11 |            1.07 |              0.078 |                0.072 |
| Fill the canvas                       |    0.016 |           0.962 |           0.770 |              0.049 |                0.042 |
| Clear a strip across it               |    0.013 |            1.12 |            1.33 |              0.044 |                0.037 |
| Clear ten 40 × 40 boxes               |    0.016 |            1.15 |            1.16 |              0.049 |                0.049 |
| Two dashed lines, 285 rectangles      |    0.047 |            1.33 |           0.980 |              0.090 |                0.059 |
| The same two lines copied from strips |    0.080 |            1.02 |            1.04 |              0.108 |                0.092 |
| A label: rectangle and new text       |    0.116 |            1.56 |            1.48 |              0.243 |                0.221 |
| Stroke a line of 2,000 points         |    0.076 |            4.68 |            4.22 |              0.129 |                0.173 |
| 100 save and restore                  |    0.042 |           0.029 |           0.019 |              0.019 |                0.019 |
| Copy a 2D canvas of the same size     |    0.026 |            3.63 |            2.96 |              0.040 |                0.048 |
| The same, transposed                  |    0.036 |            21.2 |            8.36 |              0.058 |                0.062 |
| Copy a WebGL2 canvas of the same size |    0.033 |            14.0 |            10.8 |              0.057 |                0.060 |
| Read the pixels back                  |     4.03 |            4.09 |            4.47 |               2.74 |                 2.69 |
| Put pixels                            |    0.751 |            1.83 |            1.57 |               4.67 |                 5.85 |

- **Canvas 2D is drawn in software by default**, on the page's own thread: clearing or filling the
  canvas about 1 ms, a stroked line of 2,000 points 4 ms, a copy of a canvas of the same size 3 ms. Turning `gfx.canvas.accelerated` off
  changes nothing; forcing it on (with `gfx.canvas.accelerated.force-enabled`) makes the same calls
  cost 0.03–0.2 ms, and reading pixels back (`getImageData`) or uploading them (`putImageData`)
  dearer. So the GPU path for Canvas 2D exists in headless Firefox on this Mac, but is not used by
  default; forcing WebRender, the GPU process and layer acceleration on as well adds nothing.
- **A WebGL canvas copied into a 2D canvas costs 11–14 ms** at this size in the default
  configuration: the 2D canvas is in memory and the image has to come back from the GPU. A transposed
  copy (the matrix `0, 1, 1, 0`) of a 2D canvas cost 8–21 ms in two runs against 3–3.6 ms for a
  straight one: the software rasterizer samples a turned image pixel by pixel.
- **The first change to a canvas in a frame costs about a millisecond in software**, whatever it
  draws: clearing ten boxes of 40 × 40 pixels costs what clearing the whole canvas costs (1.1 ms), and
  so do two copies of a 2,400 × 2 strip. That is consistent with the canvas being copied before it is
  changed, while the compositor still holds the image of the last frame; it was not traced further.
- **The Gecko profiler** (`MOZ_PROFILER_STARTUP` with `MOZ_PROFILER_SHUTDOWN`, recorded while a page
  drew lines and copied a WebGL canvas) lists no GPU process, a `SwComposite` thread in the parent
  process (WebRender compositing in software) and no canvas thread in the content processes: the
  canvases are drawn on the page's main thread. Its native frames were not symbolicated.
- `about:support` cannot be opened under Playwright; the preferences, the probe and the profiler
  stand in for it.
- In Chromium (the first column) every one of these calls is recorded for the GPU process and costs
  under 0.12 ms on the page's thread, except reading pixels back.

### Where the chart's frames go

Runs of the gate cases in headless Firefox, one per side, `main`, this branch, and this branch with
`gfx.canvas.accelerated` forced on (frame JS in ms, worker / local engine):

| Side                              | Load (hover) | Hover p50     | Hover p99   | Load (pan, zoom) | Worst pan or zoom p95             |
| --------------------------------- | ------------ | ------------- | ----------- | ---------------- | --------------------------------- |
| `main`                            | 10.4 → 9.7   | 1.70 / 1.60   | 3.24 / 2.92 | 11.3 → 10.6      | 8.86 (zoom-200) / 7.98 (zoom-200) |
| This branch                       | 7.9 → 10.9   | 1.48 / 1.50   | 3.26 / 4.08 | 10.8 → 8.2       | 7.00 (pan-20k) / 6.12 (pan-all)   |
| This branch, Canvas 2D on the GPU | 9.7 → 11.0   | 0.440 / 0.460 | 1.16 / 2.44 | 7.8 → 14.1       | 3.94 (pan-all) / 2.82 (zoom-200k) |

- **At a moderate load Firefox's frames are a few milliseconds**, not the 35–342 ms of the
  [earlier rounds](firefox-frames.md#gates), which ran at load averages of 59–238: in both
  configurations the canvases are drawn on the page's own thread, so the load lengthens every frame.
  Pan and zoom frames on `main` took 2.7–4.1 ms at p50 and up to 8.9 ms at p95 at a load of about 11.
- **The overlay's share fell.** In runs with timing marks around the parts of a frame
  ([raw](slow-device-gates-firefox-breakdown.json), load 12–22), the overlay of a pan or zoom frame
  took 0.55–1.9 ms on `main` and 0.06–0.9 ms on this branch; this branch's pan and zoom frames were
  faster at p50 in 17 of the 20 cases above, by up to 2 ms. Hover took 1.5 instead of 1.6–1.7 ms at
  p50.
- **The series layer is most of a frame** (1.5–7.6 ms in those runs): grid, candles and lines drawn
  in software over 2.9 million pixels. With Canvas 2D on the GPU it takes 0.2–0.8 ms.
- **Hover gains little in software** because the overlay is changed in every hover frame, and the
  first change costs about a millisecond (above); only a frame in which nothing on the overlay moved
  now leaves it alone.
- **With Canvas 2D on the GPU, hover measured slower on this branch**: 0.44–0.46 ms at p50
  ([raw](slow-device-gates-firefox-hover-after-accelerated.json)) against 0.34–0.36 ms for `main` in
  a run made earlier at a higher load ([raw](slow-device-gates-firefox-hover-before-accelerated.json)).
  The probe does not explain it: on the GPU, two lines copied from strips cost 0.09–0.11 ms against
  0.06–0.09 ms as dashes, and small clears 0.05 ms. Single runs at different loads; not isolated.

Twenty indicators on all 1M candles (`ind-apply/candles-1m/all/20`), once per side
([before](slow-device-gates-firefox-tick-before.json), [after](slow-device-gates-firefox-tick-after.json)),
tick to applied p50 and p99 in ms:

| Side        | Load        | Worker      | Local engine |
| ----------- | ----------- | ----------- | ------------ |
| `main`      | 27.4 → 18.9 | 0.520, 11.2 | 0.400, 5.22  |
| This branch | 13.3 → 27.4 | 0.200, 5.84 | 0.380, 5.96  |

### Mark series in Firefox

Three of the [mark cases](firefox-frames.md#mark-series-frames), this branch (their renderers are
not changed here), one run each, frame JS p50 / p95 in ms, in the default configuration and with
`gfx.canvas.accelerated` forced on ([raw](slow-device-gates-firefox-marks-webgl2.json),
[GPU](slow-device-gates-firefox-marks-webgl2-accelerated.json),
[Canvas 2D](slow-device-gates-firefox-marks-canvas2d.json),
[GPU](slow-device-gates-firefox-marks-canvas2d-accelerated.json); loads 13.5–26.8):

| Case                      | WebGL2, default | WebGL2, Canvas 2D on the GPU | Canvas 2D, default | Canvas 2D on the GPU |
| ------------------------- | --------------- | ---------------------------- | ------------------ | -------------------- |
| Scatter 1M append         | 25.2 / 42.9     | 2.52 / 4.40                  | 13.5 / 29.8        | 0.56 / 1.14          |
| Heatmap 1.44M pan         | 29.5 / 56.4     | 1.50 / 5.08                  | 28.0 / 50.7        | 2.82 / 30.3          |
| Heatmap 1.44M last column | 10.8 / 18.5     | 0.54 / 1.58                  | 1.44 / 4.20        | 3.60 / 5.16          |

- **The WebGL2 path is slow in Firefox because its image is read back** into a 2D canvas held in
  memory and copied transposed twice (`marks/gl/renderer.ts`): 11–56 ms, where Chromium took
  0.4–1.8 ms at p95 ([Firefox](firefox-frames.md#mark-series-frames)). With Canvas 2D on the GPU the
  same frames take 0.5–5 ms: the shaders were never the cost.
- **The Canvas 2D path** puts its pixels into a buffer and copies it transposed as well; on the GPU
  its pan p95 (30 ms) and the column update (3.6 ms) are consistent with the upload of the buffer
  (`putImageData` costs 4.7 ms there against 1.8 ms in software), which was not traced.

### What is the browser's and what is the library's

- **The browser's**: Canvas 2D in software is Firefox's default in headless mode on this Mac, and
  with it every pixel the chart draws is drawn on the page's thread, which also makes Firefox's
  frames grow with the load. Whether a Firefox window draws Canvas 2D on the GPU here was not
  measured (headed browsers are not used for these runs); `gfx.canvas.accelerated` shows what the
  GPU path costs. The copy of a WebGL canvas into a 2D canvas reads the image back from the GPU.
- **The library's**: the overlay now draws only what changed, which removes most of the overlay's
  share of a pan or zoom frame in software (0.55–1.9 → 0.06–0.9 ms), but not the millisecond the
  first change to the canvas costs in each hover frame. The mark series composite their WebGL2
  image into the pane through a transposed 2D cache (`marks/gl/renderer.ts`): a read-back of the
  WebGL canvas and two transposed copies, 11–14 and 8–21 ms each at this size in software. The transposition was chosen so
  that Firefox rounds opacity alike on both mark paths, for byte-equal images; showing the WebGL
  canvas as a layer of its own, or copying without the transposition, would remove most of it. That
  code is being changed elsewhere and is left as it is here.

## Still open

- **The phone.** Both gates have to be measured on the Android phone again
  ([physical Android](android-physical.md#core-gates)); CPU throttling cannot show what fewer
  Canvas calls are worth there.
- **The native time of a hover frame in Chromium** (about 180 µs of 260 on the M1), which does not
  scale with the Canvas calls, is not attributed: a trace with Blink's own categories would be next.
- **Full redraws after a change of the price scale** set the tail of tick to applied with all bars
  in view; the accessibility description (50–85 µs a tick frame in this view) is the next part of a
  partial frame that could be made cheaper.
- **A Firefox window** with Canvas 2D on the GPU, on an idle machine: not measured (headless only).
- **Hover with Canvas 2D on the GPU in Firefox** measured slower on this branch in single runs; the
  cause is not isolated.

## Reproduce

```sh
# Alternating this branch and main (a checkout of main at 9ee1ef4), one invocation each:
pnpm bench --case drawings/candles-1m/1000/hover --lib lumen-worker,lumen-main --repeats 1 --budget 1.5 [--cpu-throttle 4]
pnpm bench --case drawings/candles-1m/1000/hover --lib lumen-worker,lumen-main --repeats 1 --budget 1.5 [--cpu-throttle 4] --packages <main checkout>/packages
pnpm bench --case ind-apply/candles-1m/all/20 --lib lumen-worker,lumen-main --repeats 1 --budget 1.5 [--cpu-throttle 4]
pnpm bench --case frames/candles-1m --lib lumen-worker,lumen-main --repeats 1 --budget 1.5
pnpm bench --browser firefox --case drawings/candles-1m/1000/hover,frames/candles-1m --lib lumen-worker,lumen-main --repeats 1 --budget 1.5
pnpm bench --browser firefox --firefox-pref gfx.canvas.accelerated=true,gfx.canvas.accelerated.force-enabled=true --case drawings/candles-1m/1000/hover,frames/candles-1m --lib lumen-worker,lumen-main --repeats 1 --budget 1.5
pnpm bench --browser firefox --case ind-apply/candles-1m/all/20 --lib lumen-worker,lumen-main --repeats 1 --budget 1.5 --timeout 1200
pnpm bench --browser firefox --lib lumen-worker --mark-renderer webgl2 --case heatmap/candles-4800/2400x600/pan,heatmap/candles-4800/2400x600/tick,scatter/candles-2k/cloud-1m/tick --repeats 1 --budget 1.5
pnpm bench:pixels                                     # every case, DPR 1, 2 and 1.5
pnpm bench:pixels --raster cpu --case overlay
pnpm bench --case drawings/candles-1m/1000/hover --lib lumen-main --profile <dir>   # the traced runs
```

The canvas probe and the profiler run were scripts outside the repository: a page served through a
Playwright route on `127.0.0.1` with isolation headers, timing each call over 40 animation frames
(the calls are named in the raw file), and Firefox started with `MOZ_PROFILER_STARTUP=1` and
`MOZ_PROFILER_SHUTDOWN=<file>`.
