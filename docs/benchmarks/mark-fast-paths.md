# Sparse scatter and small mark-layer updates

This follow-up targets the cases in which the previous WebGPU prototype tied or trailed another implementation. All paths render the same opaque markers or heatmap colors into a 2,400 × 1,200-device-pixel pane. The host uses a 2D composition layer. The combined prototype is selectable as `webgpuOptimized` in the benchmark harness.

In the same sparse GPU run, the 100k zoom took 0.459 ms at p95 with tiles, 0.852 ms with columns and 0.869 ms with WebGL2. At 300k the corresponding times were 0.590, 0.918 and 1.608 ms. Keep the column kernel for the measured dense burst. Translated heatmap caching and tiny 2D patches lowered JS work across backends, so the direct-patch results describe a hybrid composition path.

## Sparse scatter

- The new compute kernel assigns a 16 × 16 screen tile to 64 invocations. A source-space index holds an offset for each bin and a point ID per entry. A point appears in a neighboring price band only where its 3-pixel footprint crosses the boundary. Each workgroup scans the bins covering its tile and keeps the greatest point ID in each covered pixel with local atomics. This preserves the original overlap order and writes neighboring pixels together. A time-sorted tail supplies points appended after index construction. [Tile index and shader](../../benchmarks/prototypes/mark-backends/webgpu-tiles.js).
- A second graphics implementation shares one 16-bit index pattern per block of 4,096 squares. It batches many squares into one instance and keeps the geometry on the device. The controls are the original column compute kernel and native WebGL2 points with visible-range culling. [Indexed mesh](../../benchmarks/prototypes/mark-backends/webgpu-mesh.js).
- The fractional fixture places X coordinates on a 1/32-pixel grid. The burst puts seven eighths of one million points in 1/32 of the time range. The GPU counter covers the whole render or compute pass. The frame run separately measures JS submission and compositor events with GPU queries disabled.

GPU pass p95 in milliseconds, with independent runs for the cloud and the two input controls. [sparse-tiles-gpu.json](sparse-tiles-gpu.json) · [tiles-controls-gpu.json](tiles-controls-gpu.json)

| Zoom input                  | WebGL2 visible points | WebGPU columns | WebGPU indexed mesh | WebGPU tiles |
| --------------------------- | --------------------: | -------------: | ------------------: | -----------: |
| 25,000 points               |                 0.990 |          0.786 |               0.393 |        0.459 |
| 100,000 points              |                 0.869 |          0.852 |               0.918 |        0.459 |
| 300,000 points              |                 1.608 |          0.918 |               2.195 |        0.590 |
| 100,000 points (fractional) |                 0.950 |          0.852 |                   — |        0.459 |
| 1,000,000 points (burst)    |                 4.588 |          1.442 |                   — |        3.211 |

Index construction is paid once for this window. The byte count covers the two persistent index buffers. Setup JS includes building and queueing the index, with temporary CPU arrays in addition to those bytes. [sparse-tiles-frames.json](sparse-tiles-frames.json)

| Points  | Uploaded index bytes | Index setup JS (ms) | Tile JS p95 (ms) | Compositor p95 (ms) |
| ------- | -------------------: | ------------------: | ---------------: | ------------------: |
| 25,000  |              157,200 |               4.055 |            0.155 |              17.375 |
| 100,000 |              493,752 |               5.175 |            0.160 |              17.709 |
| 300,000 |            1,393,600 |              10.285 |            0.150 |              17.413 |

## Fixed heatmap pan

An integral horizontal pan over a fixed grid and unchanged color range can composite a translation of the canonical image. The WebGPU shader produces the canonical colors and the chart's 2D layer retains them. Matched Canvas 2D and WebGL2 sources use the same cache. An invalid cache is regenerated from current data before its next use. The changing-color-range control uses the original scalar texture and shader. [Layer compositor](../../benchmarks/prototypes/mark-backends/mark-layer.js).

A separate, GPU-only cache stores the nominal pane and a transparent 128-column guard in a GPU texture. At this size it uses 12,134,400 additional texture bytes before allocation padding. It serves integral pans in its covered range with a device-side texture copy, and falls back to the shader for other transforms. The full-pane 2D cache has 11,520,000 RGBA bytes at this DPR before browser overhead. [Transfer paths](../../benchmarks/prototypes/mark-backends/webgpu-transfer.js).

| Fixed-range pan implementation    | JS p95 (ms) | Compositor p95 (ms) |
| --------------------------------- | ----------: | ------------------: |
| Original Canvas 2D                |       0.090 |              17.320 |
| WebGPU draw and composite         |       0.157 |              17.542 |
| WebGPU texture copy and composite |       0.130 |              17.479 |
| Retained Canvas 2D image          |       0.053 |              17.525 |
| Retained WebGL2 image             |       0.040 |              17.281 |
| Retained WebGPU image             |       0.045 |              17.634 |

The translated image cuts repeated work for each backend. Its per-frame cost mostly belongs to their shared compositor. [heat-pan-cache.json](heat-pan-cache.json)

## Live updates

- A fully covered 3 × 3 scatter update has only two possible opaque colors in this fixture. The native WebGPU queue path writes the matching 36-byte stamp to the dirty drawable. A heatmap update expands the latest 600 scalar values into one 1,200-pixel output column. The renderer merges pending scatter uploads into one contiguous range and keeps only the latest replacement heatmap column. The next full draw synchronizes the source. No readback is required.
- A dedicated 3 × 3 or 1 × 1,200 WebGPU surface also runs on the same device. This variant can alternate dirty updates and full frames with the original full-pane surface still allocated.
- The combined path can paint these exact opaque patches directly in the chart's 2D composition layer. It still records the pending model update for WebGPU. The matched Canvas 2D control uses the same final-layer patch shortcut. The shortcut requires ownership of the affected pixels at the correct layer order. A translucent mark or an overlapping foreground drawing requires the normal composition or invalidation path. Other draws use the full renderer. The mixed case performs seven updates followed by one full redraw and includes that redraw in the timing. Its separate redraw distribution exposes the cost of flushing deferred work.

Median JS p95 per frame in milliseconds. The Canvas 2D comparison also uses the translated layer and final-layer patch optimizations. [optimized-marks-frames.json](optimized-marks-frames.json)

| Input                      | Canvas 2D optimized | WebGL2 | Previous WebGPU | Combined WebGPU |
| -------------------------- | ------------------: | -----: | --------------: | --------------: |
| Scatter 100k zoom          |               4.275 |  0.088 |           0.185 |           0.200 |
| Heatmap pan, fixed gain    |               0.045 |  0.093 |           0.165 |           0.043 |
| Heatmap pan, changing gain |               1.867 |  0.110 |           0.148 |           0.160 |
| Heatmap tick               |               0.040 |  0.125 |           0.235 |           0.035 |
| Scatter tick               |               0.023 |  0.100 |           0.170 |           0.030 |
| Scatter 7 ticks + redraw   |              16.190 |  3.487 |           0.230 |           0.155 |
| Heatmap 7 ticks + redraw   |               0.120 |  3.033 |           0.210 |           0.202 |

The queue-write and copy alternatives were measured separately. [mark-transfer-frames.json](mark-transfer-frames.json) · [mark-patch-surfaces.json](mark-patch-surfaces.json)

| Input                    | Original-size switch | Dedicated patch drawable | 2D-layer patch + WebGPU |
| ------------------------ | -------------------: | -----------------------: | ----------------------: |
| Scatter tick             |                0.120 |                    0.145 |                   0.033 |
| Heatmap tick             |                0.130 |                    0.148 |                   0.045 |
| Scatter 7 ticks + redraw |                0.195 |                    0.163 |                   0.160 |
| Heatmap 7 ticks + redraw |                0.222 |                    0.180 |                   0.197 |

JS p95 of only the full redraws in the seven-updates-per-redraw run, including the deferred upload.

| Full redraws only        | Canvas 2D optimized | Previous WebGPU | Combined WebGPU |
| ------------------------ | ------------------: | --------------: | --------------: |
| Scatter 7 ticks + redraw |              20.185 |           0.265 |           0.220 |
| Heatmap 7 ticks + redraw |               0.170 |           0.990 |           0.280 |

## WebGPU immediate data

The device and shader language are checked for immediate data support. On a supporting device, the optional path places the 24-byte heatmap view or 32-byte tiled scatter view directly in the pass. The matched path uses a uniform buffer and a queue write. Both retain their textures, point buffers and pipeline and use the same compositor. [WebGPU immediate data](https://developer.chrome.com/blog/new-in-webgpu-149-150#immediates).

| Input                      | Uniform JS | Immediate JS | Uniform GPU | Immediate GPU | Uniform display interval | Immediate display interval |
| -------------------------- | ---------: | -----------: | ----------: | ------------: | -----------------------: | -------------------------: |
| Scatter 100k zoom          |      0.173 |        0.207 |       0.459 |         0.459 |                   17.814 |                     17.451 |
| Heatmap pan, changing gain |      0.162 |        0.180 |       1.507 |         0.393 |                   17.601 |                     17.670 |

Times are milliseconds. [mark-immediates-frames.json](mark-immediates-frames.json) · [mark-immediates-gpu.json](mark-immediates-gpu.json)

The scatter GPU p95 was identical with both view bindings. For heatmaps the median GPU p50 was 0.328 ms with either. The immediate path had a within-run GPU p95 of 0.393, 0.393 and 1.376 ms, while uniform buffers gave 1.114, 1.638 and 1.507 ms. Tail timings varied on the busy host and the immediate path did not lower JS p95. Uniform buffers remain the combined baseline and immediate data is a separately selectable trial on supported devices.

## Reproducibility and scope

The output checks compare full-frame RGBA hashes against the other backends before timing. They cover initialization, 16 successive motions or updates, plus sequences that update the source and return to a full view, change gain, pan in and out of the cache and zoom again. Each timed case warms up for 12 frames. The tables report medians of within-run p95s in milliseconds. Setup includes device acquisition, pipeline creation and the first submission. It does not wait for display. GPU timestamp queries on this machine are quantized to about 0.066 ms. Pass timestamps cannot measure standalone queue writes or texture copies, so update and cached-pan comparisons use JS and compositor measurements.

These are isolated prototype layers on Apple M1 and hardware Metal in headless Chromium. The input window already has projected coordinates. The tile price bands assume a stable vertical projection and the scatter color rule is last opaque square wins. A change of vertical projection needs a new index or the existing fallback. The combined trial uses tiles up to the largest tested sparse cloud (300k) and columns for the tested million-point data. In the 100k zoom, the combined WebGPU and WebGL2 paths had compositor p95s of 17.19 and 17.21 ms. Reduced GPU time leaves headroom on this virtual display. Redrawing the same image after seven patches can also leave Chromium without a new display event for that callback. The switching point, memory budget, arbitrary marker colors and opacity, nonlinear projection, multi-layer behavior and mobile performance require chart-level validation. The shared host had one-minute load averages of about 175–457 at run boundaries, and the JSON files record the load at both ends. Headless compositor intervals measure the virtual display.

```sh
node benchmarks/runner/mark-backends.mjs --study sparse --gpu-timers --repeats 4 --out /tmp/sparse-tiles-gpu.json
node benchmarks/runner/mark-backends.mjs --study sparse --repeats 3 --out /tmp/sparse-tiles-frames.json
node benchmarks/runner/mark-backends.mjs --study tile-control --gpu-timers --repeats 3 --out /tmp/tiles-controls-gpu.json
node benchmarks/runner/mark-backends.mjs --study pan-cache --repeats 6 --out /tmp/heat-pan-cache.json
node benchmarks/runner/mark-backends.mjs --study retained --frames 64 --repeats 4 --out /tmp/mark-transfer-frames.json
node benchmarks/runner/mark-backends.mjs --study patches --frames 64 --repeats 4 --out /tmp/mark-patch-surfaces.json
node benchmarks/runner/mark-backends.mjs --study optimized --frames 64 --repeats 4 --out /tmp/optimized-marks-frames.json
node benchmarks/runner/mark-backends.mjs --study immediates --repeats 4 --out /tmp/mark-immediates-frames.json
node benchmarks/runner/mark-backends.mjs --study immediates --gpu-timers --repeats 3 --out /tmp/mark-immediates-gpu.json
```
