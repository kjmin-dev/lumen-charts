# WebGPU scatter rendering with ordered points

The [first comparison](mark-backends.md) drew each square as a native WebGL2 point or a WebGPU instanced quad. The WebGPU pipeline already kept the vertex buffer resident and issued one draw for all points. A million instances still invoked four vertices apiece. WebGPU point rasterization covers a single pixel, so the quad was one way to obtain the required 3 × 3 footprint. [WebGPU point rasterization](https://www.w3.org/TR/webgpu/#point-rasterization).

This follow-up changes the WebGPU algorithm, gives both original graphics pipelines the same visible-range optimization and compares all outputs to Canvas 2D.

## Experiment

- The WebGL2 and WebGPU graphics controls use the original shaders and point buffer. Each also runs with CPU-side culling. Two binary searches find the first and last visible centers on the sorted time axis. The draw retains the original point IDs. The tick control still updates a single point.
- The WebGPU compute shader dispatches one workgroup per output column. The group reads the points centered in that column and its immediate neighbors, using two binary searches in the sorted buffer. For each center row it keeps the greatest input index in workgroup memory with `atomicMax`. Each output pixel picks the greatest index among three adjacent rows. The combination covers exactly the same 3 × 3 square as the reference, including which color wins when squares overlap. The shader writes transparent pixels and colors directly to a storage-capable canvas texture. The measured compute pass covers both finding the points and writing the complete target. [Compute shader](../../benchmarks/prototypes/mark-backends/webgpu-columns.js).
- All paths use resident coordinates, identical updates, clipping rules, marker sizes and the same final 2D composition. The five GPU paths run in rotating order across five repetitions. Each row summarizes 60 measured frames per run following 12 warm-up frames. Each reported p95 is the median of the within-run p95s. Separate runs with GPU timers disabled measure JavaScript and Chromium compositor intervals.
- The cloud distributes timestamps evenly. In the burst, 87.5% of a million points fall within the middle 3.125% of the time range. Both fixtures contain tied timestamps and overlapping markers. The runner compares full-frame RGBA hashes with the Canvas 2D reference for initialization and 16 consecutive updates in all six cases before collecting timings. [Fixtures](../../benchmarks/prototypes/mark-backends/scene.js).
- WebGL2 timers enclose the clear and draw. WebGPU timestamps enclose the render or compute pass. Uploads and the 2D composition fall outside these GPU counters. The JS and compositor results include the shared composition path. Chromium's virtual display has no physical scanout.

## GPU time per frame

Median GPU p95 in milliseconds across five runs on Apple M1, Metal, headless Chromium 156.0.8078.4.

| Input                          | WebGL2 points | WebGL2 visible points | WebGPU quads | WebGPU visible quads | WebGPU columns |
| ------------------------------ | ------------: | --------------------: | -----------: | -------------------: | -------------: |
| 100,000 points, zoom           |         0.874 |                 0.876 |        1.376 |                1.311 |          0.852 |
| 300,000 points, zoom           |         1.756 |                 1.392 |        3.604 |                3.473 |          1.049 |
| 1,000,000 points, pan          |         3.635 |                 3.303 |        8.913 |                8.913 |          1.114 |
| 1,000,000 points, zoom         |         3.220 |                 3.216 |        9.306 |               10.486 |          1.114 |
| 1,000,000 points, tick         |         0.527 |                 0.464 |        0.459 |                0.459 |          0.066 |
| 1,000,000 points, zoom (burst) |         4.511 |                 4.380 |        9.372 |                9.044 |          1.311 |

For the one-million-point cloud zoom, the column kernel took 1.114 ms, a factor of 8.4 below the original WebGPU quad and 2.9 below the measured WebGL2 point path. The fixed cost of resolving the output pane matters more at 100,000 points.

The compute shader had the lowest GPU p95 in every run of the one-million-point cloud zoom. Its p95 ranged from 1.114 to 1.311 ms. Native WebGL2 points with visible-range culling ranged from 3.077 to 3.304 ms and the original WebGPU quads from 8.978 to 9.896 ms. On the shared host, the one-minute load average rose from 3.4 to 28.0 during the timed GPU run. At 100k points the 0.02 ms difference between the median WebGL2 points and compute results is within the run-to-run variation.

## Frame measurements

Each cell gives the median JS p95 / compositor display-interval p95 in milliseconds from three runs without GPU timers.

| Input                          |      Canvas 2D | WebGL2 points |  WebGPU quads | WebGPU columns |
| ------------------------------ | -------------: | ------------: | ------------: | -------------: |
| 100,000 points, zoom           |  2.975 / 17.48 | 0.135 / 17.51 | 0.225 / 17.10 |  0.280 / 17.55 |
| 300,000 points, zoom           |  5.685 / 18.48 | 0.145 / 17.40 | 0.295 / 18.38 |  0.365 / 17.74 |
| 1,000,000 points, pan          | 14.810 / 17.61 | 0.170 / 17.55 | 0.310 / 17.37 |  0.310 / 17.21 |
| 1,000,000 points, zoom         | 15.985 / 17.69 | 0.155 / 17.75 | 0.215 / 19.01 |  0.285 / 17.11 |
| 1,000,000 points, tick         |  0.130 / 18.20 | 0.150 / 17.63 | 0.225 / 18.89 |  0.290 / 17.55 |
| 1,000,000 points, zoom (burst) | 15.290 / 17.77 | 0.085 / 17.34 | 0.205 / 17.60 |  0.250 / 17.33 |

## Applicability

The dense scatter integration trial should include the compute shader and WebGL2 native points. The observed difference belongs to these algorithms, device and workloads. A backend-wide ranking would require more algorithms and hardware.

The column implementation uses the scatter store's stable time ordering, opaque 3 × 3 square markers and last-point-wins semantics. Its workgroup scratch area is sized for the 1,200-device-pixel-high benchmark pane. Source coordinates are already projected and the zoom is horizontal. An end-to-end chart comparison must cover real window changes, time and price projection, point shapes, palette handling and interaction with the other layers. [Scatter store and rendering contract](../design/stage-5-heatmap-scatter.md).

```sh
node benchmarks/runner/mark-backends.mjs --scatter-paths --check-only
node benchmarks/runner/mark-backends.mjs --scatter-paths --gpu-timers --repeats 5 --out /tmp/scatter-paths-gpu.json
node benchmarks/runner/mark-backends.mjs --scatter-paths --repeats 3 --out /tmp/scatter-paths-frames.json
```

[GPU timer runs](scatter-paths-gpu.json) · [Frame runs](scatter-paths-frames.json)
